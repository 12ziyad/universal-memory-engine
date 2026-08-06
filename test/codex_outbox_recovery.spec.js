/**
 * Codex outbox poison/rotation recovery (campaign 2026-08-07, defects CDX-01/02/04/05).
 *
 * Contract under test (invariants I13/I14 of the hardening campaign):
 *  - A permanently rejected envelope is quarantined to failed/ — durable and
 *    observable, never silently discarded — and NEVER blocks later valid work.
 *  - Retryable failures carry persisted attempt counts with a deterministic
 *    backoff; attempts beyond the bound quarantine instead of retrying forever.
 *  - A credential-binding mismatch skips exactly the mismatched envelopes;
 *    other bindings' work continues, and new captures can always be queued.
 *  - Accepted deliveries retain server packet/job/receipt identity.
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	CODEX_OUTBOX_LIMITS,
	CODEX_RETRY_QUARANTINE_ATTEMPTS,
	drainCodexOutbox,
	enqueueCodexCapture,
	inspectCodexOutbox,
	rebindCodexOutbox,
	resolveCodexProjectScope,
} from "../plugins/itsuki/hooks/codex-outbox.mjs";
import { parseCodexTranscriptText } from "../plugins/itsuki/hooks/codex-transcript.mjs";

const KEY_A = "itsuki_live_codex_recovery_key_A1";
const KEY_B = "itsuki_live_codex_recovery_key_B2";
const BASE_URL = "http://localhost:8787";
const SECURITY = {
	platform: "win32",
	securityRunner: async () => ({ ok: true, protected: true }),
};
const roots = [];
let pluginData;
let scope;

function captureFor(sessionId, text) {
	// Capture eligibility keeps only durable coding outcomes; phrase the fixture
	// as an implemented instruction so the parser returns a non-empty batch.
	const transcript = [
		JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `Implement ${text}` }], id: "user" } }),
		JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: `Implemented and verified ${text}` }], id: "assistant" } }),
	].join("\n");
	return parseCodexTranscriptText(transcript, { sessionId });
}

async function enqueueUnique(sessionId, text, overrides = {}) {
	const parsed = captureFor(sessionId, text);
	return enqueueCodexCapture({
		pluginData,
		messages: parsed.messages,
		sessionId,
		memoryScope: scope,
		capture: parsed.metadata,
		apiKey: KEY_A,
		baseUrl: BASE_URL,
		...SECURITY,
		...overrides,
	});
}

function drain(overrides = {}) {
	return drainCodexOutbox({
		pluginData,
		apiKey: KEY_A,
		baseUrl: BASE_URL,
		maxEntries: 4,
		maxDurationMs: 5_000,
		...SECURITY,
		...overrides,
	});
}

function jsonResponse(body, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const ACCEPTANCE = { ok: true, source_packet_id: "src_recovery", job_id: "job_recovery", receipt_id: "receipt_recovery" };

beforeEach(async () => {
	pluginData = await mkdtemp(join(tmpdir(), "itsuki-codex-recovery-"));
	roots.push(pluginData);
	scope = await resolveCodexProjectScope(pluginData, { platform: "win32", realpathFn: async () => pluginData });
});

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("poison-oldest quarantine (CDX-01)", () => {
	it("quarantines a permanently rejected oldest envelope and still delivers later valid work in the same drain", async () => {
		const bad = await enqueueUnique("poison-session", "Poison capture that the server permanently rejects.", { now: new Date("2026-01-01T00:00:00.000Z") });
		const good = await enqueueUnique("good-session", "Valid later capture that must still deliver.", { now: new Date("2026-01-02T00:00:00.000Z") });
		const fetchImpl = vi.fn(async (url, init) => {
			const body = JSON.parse(init.body);
			return body.messages.some((m) => m.content.includes("Poison"))
				? jsonResponse({ error: "unprocessable" }, 422)
				: jsonResponse(ACCEPTANCE, 202);
		});

		const drained = await drain({ fetchImpl });

		expect(drained.quarantined).toBe(1);
		expect(drained.delivered).toBe(1);
		expect(drained.status).toBe("delivered");
		const failedNames = await readdir(join(pluginData, "codex-outbox", "v1", "failed"));
		expect(failedNames).toEqual([`${bad.queueId}.json`]);
		const stagedNames = await readdir(join(pluginData, "codex-outbox", "v1", "staged"));
		expect(stagedNames).not.toContain(`${good.queueId}.json`);
	});

	it("preserves the quarantined envelope verbatim with a durable machine-readable reason", async () => {
		const bad = await enqueueUnique("poison-session", "Poison capture preserved for review.");
		const stagedPath = join(pluginData, "codex-outbox", "v1", "staged", `${bad.queueId}.json`);
		const original = await readFile(stagedPath, "utf8");
		const fetchImpl = vi.fn(async () => jsonResponse({ error: "too large" }, 413));

		await drain({ fetchImpl });

		const failedPath = join(pluginData, "codex-outbox", "v1", "failed", `${bad.queueId}.json`);
		expect(await readFile(failedPath, "utf8")).toBe(original);
		const state = JSON.parse(await readFile(join(pluginData, "codex-outbox", "v1", "state", `${bad.queueId}.json`), "utf8"));
		expect(state).toMatchObject({
			schema: "itsuki.codex-outbox-state/v1",
			quarantined_reason: "http_413",
			last_http_status: 413,
		});
		const health = await inspectCodexOutbox({ pluginData, ...SECURITY });
		expect(health.quarantined).toBe(1);
	});

	it("treats an acceptance-shaped 200 without durable identity as permanent and quarantines it", async () => {
		await enqueueUnique("hollow-session", "Server answers ok true with no packet identity.");
		const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }, 200));

		const drained = await drain({ fetchImpl });

		expect(drained.quarantined).toBe(1);
		expect(drained.delivered).toBe(0);
	});
});

describe("retryable failures (CDX-05)", () => {
	it("persists attempt counts across drains and respects the backoff window", async () => {
		const item = await enqueueUnique("retry-session", "Capture behind a transient server error.");
		const fetchImpl = vi.fn(async () => jsonResponse({ error: "boom" }, 500));

		const first = await drain({ fetchImpl });
		expect(first.retried).toBe(1);
		const statePath = join(pluginData, "codex-outbox", "v1", "state", `${item.queueId}.json`);
		const state = JSON.parse(await readFile(statePath, "utf8"));
		expect(state.attempts).toBe(1);
		expect(state.next_attempt_at).toBeGreaterThan(Date.now());

		// Within the backoff window the envelope is skipped, not re-sent.
		const second = await drain({ fetchImpl });
		expect(second.backoffSkipped).toBe(1);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("continues past a retrying envelope to deliver later valid work in the same drain", async () => {
		await enqueueUnique("retry-session", "Head capture on a flaky endpoint.", { now: new Date("2026-01-01T00:00:00.000Z") });
		await enqueueUnique("good-session", "Later capture that must not wait for the head.", { now: new Date("2026-01-02T00:00:00.000Z") });
		const fetchImpl = vi.fn(async (url, init) => JSON.parse(init.body).messages.some((m) => m.content.includes("flaky"))
			? jsonResponse({ error: "boom" }, 500)
			: jsonResponse(ACCEPTANCE, 202));

		const drained = await drain({ fetchImpl });

		expect(drained.retried).toBe(1);
		expect(drained.delivered).toBe(1);
	});

	it("quarantines an envelope whose retries exhaust the attempt bound", async () => {
		const item = await enqueueUnique("exhausted-session", "Capture that fails transiently forever.");
		const statePath = join(pluginData, "codex-outbox", "v1", "state", `${item.queueId}.json`);
		await writeFile(statePath, JSON.stringify({
			schema: "itsuki.codex-outbox-state/v1",
			attempts: CODEX_RETRY_QUARANTINE_ATTEMPTS - 1,
			next_attempt_at: 0,
			updated_at: Date.now(),
		}), "utf8");
		const fetchImpl = vi.fn(async () => jsonResponse({ error: "boom" }, 500));

		const drained = await drain({ fetchImpl });

		expect(drained.quarantined).toBe(1);
		const state = JSON.parse(await readFile(statePath, "utf8"));
		expect(state.quarantined_reason).toBe("retry_exhausted");
	});

	it("treats a corrupt state sidecar as fresh instead of failing the drain", async () => {
		const item = await enqueueUnique("corrupt-state-session", "Capture with a mangled sidecar.");
		await writeFile(join(pluginData, "codex-outbox", "v1", "state", `${item.queueId}.json`), "{not json", "utf8");
		const fetchImpl = vi.fn(async () => jsonResponse(ACCEPTANCE, 202));

		const drained = await drain({ fetchImpl });

		expect(drained.delivered).toBe(1);
	});
});

describe("credential rotation (CDX-02)", () => {
	it("skips mismatched-binding envelopes and delivers active-binding work behind them", async () => {
		await enqueueUnique("old-key-session", "Capture bound to the previous key.", { apiKey: KEY_B, now: new Date("2026-01-01T00:00:00.000Z") });
		await enqueueUnique("new-key-session", "Capture bound to the active key.", { now: new Date("2026-01-02T00:00:00.000Z") });
		const fetchImpl = vi.fn(async () => jsonResponse(ACCEPTANCE, 202));

		const drained = await drain({ fetchImpl });

		expect(drained.delivered).toBe(1);
		expect(drained.bindingMismatch).toBe(1);
		expect(drained.preserved).toBe(1);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("queues new captures even while old-binding captures remain protected", async () => {
		await enqueueUnique("old-key-session", "Old capture from before rotation.", { apiKey: KEY_B });
		const queued = await enqueueUnique("new-key-session", "New capture after rotation must queue.");
		expect(queued).toMatchObject({ queued: true, duplicate: false });
		const health = await inspectCodexOutbox({ pluginData, apiKey: KEY_A, baseUrl: BASE_URL, ...SECURITY });
		expect(health.count).toBe(2);
		expect(health.bindingMismatch).toBe(1);
	});

	it("rebinds identical re-captured content to the active key instead of stranding it", async () => {
		const text = "Identical durable outcome captured before and after rotation.";
		const before = await enqueueUnique("same-session", text, { apiKey: KEY_B });
		const again = await enqueueUnique("same-session", text);
		expect(again).toMatchObject({ duplicate: true, queueId: before.queueId, rebound: true });
		const fetchImpl = vi.fn(async () => jsonResponse(ACCEPTANCE, 202));
		const drained = await drain({ fetchImpl });
		expect(drained.delivered).toBe(1);
	});

	it("rebindCodexOutbox is an explicit operator action that re-keys preserved envelopes", async () => {
		await enqueueUnique("old-key-session", "Stranded capture awaiting explicit rebind.", { apiKey: KEY_B });
		const blocked = await drain({ fetchImpl: vi.fn(async () => jsonResponse(ACCEPTANCE, 202)) });
		expect(blocked.delivered).toBe(0);
		expect(blocked.bindingMismatch).toBe(1);

		const rebound = await rebindCodexOutbox({ pluginData, apiKey: KEY_A, baseUrl: BASE_URL, ...SECURITY });
		expect(rebound.rebound).toBe(1);

		const drained = await drain({ fetchImpl: vi.fn(async () => jsonResponse(ACCEPTANCE, 202)) });
		expect(drained.delivered).toBe(1);
		expect(drained.bindingMismatch).toBe(0);
	});
});

describe("acceptance provenance (CDX-04)", () => {
	it("returns packet, job, and receipt identity for every accepted delivery", async () => {
		const item = await enqueueUnique("provenance-session", "Capture whose acceptance identity must be retained.");
		const fetchImpl = vi.fn(async () => jsonResponse(ACCEPTANCE, 202));

		const drained = await drain({ fetchImpl });

		expect(drained.accepted).toEqual([{
			queueId: item.queueId,
			sourcePacketId: "src_recovery",
			jobId: "job_recovery",
			receiptId: "receipt_recovery",
		}]);
	});
});

describe("capacity accounting", () => {
	it("counts quarantined envelopes toward the enqueue entry bound", async () => {
		const bad = await enqueueUnique("poison-session", "Poison filling one slot.");
		await drain({ fetchImpl: vi.fn(async () => jsonResponse({ error: "no" }, 422)) });
		const failedNames = await readdir(join(pluginData, "codex-outbox", "v1", "failed"));
		expect(failedNames).toEqual([`${bad.queueId}.json`]);

		// Fill staged to one below the combined bound, then expect outbox_full.
		for (let index = 0; index < CODEX_OUTBOX_LIMITS.maxEntries - 1; index += 1) {
			await enqueueUnique(`filler-${index}`, `Filler capture number ${index}.`);
		}
		await expect(enqueueUnique("overflow-session", "One capture past the combined bound."))
			.rejects.toMatchObject({ code: "outbox_full" });
	});
});
