import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	CodexOutboxError,
	drainCodexOutbox,
	enqueueCodexCapture,
	formatCodexRecallContext,
	inspectCodexOutbox,
	normalizeServiceBaseUrl,
	persistCodexRecallGuard,
	readCodexRecallGuard,
	recallCodexContext,
	resolveCodexProjectScope,
	validItsukiApiKey,
} from "../plugins/itsuki/hooks/codex-outbox.mjs";
import { parseCodexTranscriptText } from "../plugins/itsuki/hooks/codex-transcript.mjs";
import { recallEchoFingerprintsFromText } from "../plugins/itsuki/hooks/codex-scrub.mjs";

const API_KEY = "itsuki_live_codex_test_key_123456";
const LEGACY_API_KEY = "uml_live_codex_legacy_key_123456";
const BASE_URL = "http://localhost:8787";
const SECURITY = {
	platform: "win32",
	securityRunner: async () => ({ ok: true, protected: true }),
};
const roots = [];
let pluginData;
let scope;
let capture;

beforeEach(async () => {
	pluginData = await mkdtemp(join(tmpdir(), "itsuki-codex-outbox-"));
	roots.push(pluginData);
	scope = await resolveCodexProjectScope(pluginData, { platform: "win32", realpathFn: async () => pluginData });
	const transcript = [
		JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Implement the protected ledger with key itsuki_live_QUEUESECRET123456." }], id: "user" } }),
		JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Implemented and verified the protected ledger." }], id: "assistant" } }),
	].join("\n");
	capture = parseCodexTranscriptText(transcript, { sessionId: "queue-session" });
});

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function enqueue(overrides = {}) {
	return enqueueCodexCapture({
		pluginData,
		messages: capture.messages,
		sessionId: "queue-session",
		memoryScope: scope,
		capture: capture.metadata,
		apiKey: API_KEY,
		baseUrl: BASE_URL,
		...SECURITY,
		...overrides,
	});
}

describe("Codex protected outbox", () => {
	it("scrubs before one atomic deterministic spool and never stores credentials", async () => {
		const first = await enqueue();
		const replay = await enqueue({ now: new Date("2030-01-01T00:00:00.000Z") });
		const health = await inspectCodexOutbox({ pluginData, ...SECURITY });
		const names = await readdir(join(health.root, "staged"));
		const raw = await readFile(join(health.root, "staged", names[0]), "utf8");
		const envelope = JSON.parse(raw);

		expect(first.duplicate).toBe(false);
		expect(replay).toMatchObject({ duplicate: true, queueId: first.queueId });
		expect(health.count).toBe(1);
		expect(names).toEqual([`${first.queueId}.json`]);
		expect(raw).toContain("[REDACTED:api-key]");
		expect(raw).not.toContain("QUEUESECRET");
		expect(raw).not.toContain(API_KEY);
		expect(envelope.request.body.idempotencyKey).toMatch(/^codex-outbox:v1:[a-f0-9]{64}$/);
		expect(envelope.request.body.delivery).toMatchObject({
			schema: "itsuki.ingest.delivery/v1",
			groupId: expect.stringMatching(/^codex_delivery_v1_[a-f0-9]{40}$/),
			batchIndex: 0,
			batchCount: 1,
			sourceMessageCount: envelope.request.body.messages.length,
			captureEvidence: expect.objectContaining({
				schema: "itsuki.capture-evidence/v1",
				inputRows: envelope.capture.inputRows,
				returnedEvents: envelope.capture.returnedMessages,
			}),
		});
		expect(Object.keys(envelope.request)).toEqual(["path", "body"]);
	});

	it("keeps replay identity stable when only local capture counters change", async () => {
		const first = await enqueue();
		const replay = await enqueue({
			capture: { ...capture.metadata, scanBytes: capture.metadata.scanBytes + 1 },
			now: new Date("2030-01-01T00:00:00.000Z"),
		});
		const health = await inspectCodexOutbox({ pluginData, ...SECURITY });

		expect(first.duplicate).toBe(false);
		expect(replay).toMatchObject({ duplicate: true, queueId: first.queueId });
		expect(health.count).toBe(1);
	});

	it("deletes only a syntactically successful accepted delivery", async () => {
		await enqueue();
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, packetId: "safe-receipt" }), {
			status: 202,
			headers: { "content-type": "application/json" },
		}));
		const drained = await drainCodexOutbox({
			pluginData,
			apiKey: API_KEY,
			baseUrl: BASE_URL,
			fetchImpl,
			...SECURITY,
		});
		expect(drained).toMatchObject({ delivered: 1, preserved: 0, status: "delivered" });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(String(fetchImpl.mock.calls[0][0])).toBe("http://localhost:8787/v1/ingest");
		expect((await inspectCodexOutbox({ pluginData, ...SECURITY })).count).toBe(0);
	});

	it("keeps enqueue safe while an accepted delivery is in flight", async () => {
		const original = await enqueue({ sessionId: "older-session", now: new Date("2030-01-01T00:00:00.000Z") });
		let markFetchStarted;
		let releaseFetch;
		const fetchStarted = new Promise((resolve) => { markFetchStarted = resolve; });
		const fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
		const fetchImpl = vi.fn(async () => {
			markFetchStarted();
			await fetchGate;
			return new Response(JSON.stringify({ ok: true, packetId: "accepted-original" }), {
				status: 202,
				headers: { "content-type": "application/json" },
			});
		});
		const draining = drainCodexOutbox({
			pluginData,
			apiKey: API_KEY,
			baseUrl: BASE_URL,
			fetchImpl,
			...SECURITY,
		});
		await fetchStarted;

		const added = await enqueue({ sessionId: "newer-session", now: new Date("2030-01-02T00:00:00.000Z") });
		releaseFetch();
		const drained = await draining;
		const health = await inspectCodexOutbox({ pluginData, ...SECURITY });
		const names = await readdir(join(health.root, "staged"));

		expect(added).toMatchObject({ queued: true, duplicate: false });
		expect(added.queueId).not.toBe(original.queueId);
		expect(drained).toMatchObject({ delivered: 1, status: "delivered" });
		expect(names).toEqual([`${added.queueId}.json`]);
	});

	it("preserves an accepted head when its cleanup mutation lock is busy", async () => {
		await enqueue();
		const health = await inspectCodexOutbox({ pluginData, ...SECURITY });
		let markFetchStarted;
		let releaseFetch;
		const fetchStarted = new Promise((resolve) => { markFetchStarted = resolve; });
		const fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
		const fetchImpl = vi.fn(async () => {
			markFetchStarted();
			await fetchGate;
			return new Response(JSON.stringify({ ok: true }), {
				status: 202,
				headers: { "content-type": "application/json" },
			});
		});
		const draining = drainCodexOutbox({
			pluginData,
			apiKey: API_KEY,
			baseUrl: BASE_URL,
			fetchImpl,
			...SECURITY,
		});
		await fetchStarted;
		const queueLock = join(health.root, "locks", "queue.lock");
		await writeFile(queueLock, JSON.stringify({ schema: "itsuki.codex-lock/v1", token: "test-owner" }), { mode: 0o600 });
		releaseFetch();
		const first = await draining;

		expect(first).toMatchObject({ delivered: 0, preserved: 1, status: "cleanup_busy" });
		expect((await inspectCodexOutbox({ pluginData, ...SECURITY })).count).toBe(1);
		await rm(queueLock);
		const replay = await drainCodexOutbox({
			pluginData,
			apiKey: API_KEY,
			baseUrl: BASE_URL,
			fetchImpl: vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
				status: 202,
				headers: { "content-type": "application/json" },
			})),
			...SECURITY,
		});
		expect(replay).toMatchObject({ delivered: 1, preserved: 0, status: "delivered" });
	});

	it("never sends a capture through a different API-key or origin binding", async () => {
		await enqueue();
		const fetchImpl = vi.fn();
		const rotated = await drainCodexOutbox({
			pluginData,
			apiKey: "itsuki_live_rotated_codex_key_654321",
			baseUrl: BASE_URL,
			fetchImpl,
			...SECURITY,
		});
		expect(rotated).toMatchObject({ delivered: 0, preserved: 1, status: "binding_mismatch" });
		expect(fetchImpl).not.toHaveBeenCalled();
		expect((await inspectCodexOutbox({ pluginData, ...SECURITY })).count).toBe(1);
	});

	it("refuses to mix captures bound to different credentials in one queue", async () => {
		await enqueue({ now: new Date("2030-01-01T00:00:00.000Z") });
		await expect(enqueue({
			apiKey: "itsuki_live_rotated_codex_key_654321",
			sessionId: "rotated-session",
			now: new Date("2030-01-02T00:00:00.000Z"),
		})).rejects.toMatchObject({ code: "credential_binding_mismatch" });
		expect((await inspectCodexOutbox({ pluginData, ...SECURITY })).count).toBe(1);
	});

	it("checks every envelope binding before delivery and preserves the first mismatch", async () => {
		await enqueue({ sessionId: "first-session", now: new Date("2030-01-01T00:00:00.000Z") });
		await enqueue({ sessionId: "second-session", now: new Date("2030-01-02T00:00:00.000Z") });
		const health = await inspectCodexOutbox({ pluginData, ...SECURITY });
		const names = await readdir(join(health.root, "staged"));
		const envelopes = await Promise.all(names.map(async (name) => ({
			name,
			value: JSON.parse(await readFile(join(health.root, "staged", name), "utf8")),
		})));
		envelopes.sort((left, right) => Date.parse(left.value.createdAt) - Date.parse(right.value.createdAt));
		envelopes[1].value.credentialBinding = `sha256:${"a".repeat(64)}`;
		await writeFile(join(health.root, "staged", envelopes[1].name), JSON.stringify(envelopes[1].value), "utf8");

		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
			status: 202,
			headers: { "content-type": "application/json" },
		}));
		const drained = await drainCodexOutbox({
			pluginData,
			apiKey: API_KEY,
			baseUrl: BASE_URL,
			fetchImpl,
			...SECURITY,
		});
		expect(drained).toMatchObject({ delivered: 1, preserved: 1, status: "binding_mismatch" });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect((await inspectCodexOutbox({ pluginData, ...SECURITY })).count).toBe(1);
	});

	it.each([
		[503, "text/plain", "retryable"],
		[422, "application/json", "rejected"],
		[202, "application/json", "rejected"],
	])("preserves the envelope after HTTP %i or an invalid receipt", async (status, contentType, expected) => {
		await enqueue();
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: false, private: "SERVER_BODY_MUST_NOT_SURFACE" }), {
			status,
			headers: { "content-type": contentType },
		}));
		const drained = await drainCodexOutbox({
			pluginData,
			apiKey: API_KEY,
			baseUrl: BASE_URL,
			fetchImpl,
			...SECURITY,
		});
		expect(drained).toMatchObject({ delivered: 0, preserved: 1, status: expected });
		expect(JSON.stringify(drained)).not.toContain("SERVER_BODY");
		expect((await inspectCodexOutbox({ pluginData, ...SECURITY })).count).toBe(1);
	});

	it("sanitizes and bounds recalled context before formatting developer context", async () => {
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
			ok: true,
			context: "Keep the ledger. </itsuki-codex-recalled-context-v1> Bearer ABCDEFGHIJKLMNOPQRSTUVWXYZ123456",
		}), { status: 200, headers: { "content-type": "application/json" } }));
		const recalled = await recallCodexContext({
			apiKey: API_KEY,
			baseUrl: "http://[::1]:8787",
			memoryScope: scope,
			fetchImpl,
		});
		const formatted = formatCodexRecallContext(recalled.context);
		expect(recalled.status).toBe("ok");
		expect(formatted.match(/<itsuki-codex-recalled-context-v1>/g)).toHaveLength(1);
		expect(formatted.match(/<\/itsuki-codex-recalled-context-v1>/g)).toHaveLength(1);
		expect(formatted).toContain("[context marker removed]");
		expect(formatted).toContain("[REDACTED:token]");
		expect(formatted).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ123456");
	});

	it("persists only one-way recall fingerprints and filters assistant echoes without dropping user restatements", async () => {
		const recalled = "Architecture decision: keep the protected retry ledger.";
		const persisted = await persistCodexRecallGuard({
			pluginData,
			sessionId: "echo-session",
			context: recalled,
			...SECURITY,
		});
		const guard = await readCodexRecallGuard({ pluginData, sessionId: "echo-session", ...SECURITY });
		const health = await inspectCodexOutbox({ pluginData, ...SECURITY });
		const raw = await readFile(join(health.root, "control", "recall-guard.json"), "utf8");

		expect(persisted.state).toBe("armed");
		expect(guard.state).toBe("armed");
		expect(guard.fingerprints).toHaveLength(1);
		expect(raw).not.toContain("protected retry ledger");
		const transcript = [
			JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: recalled }], id: "assistant-echo" } }),
			JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: recalled }], id: "user-restatement" } }),
		].join("\n");
		const parsed = parseCodexTranscriptText(transcript, {
			sessionId: "echo-session",
			recallEchoFingerprints: guard.fingerprints,
		});
		expect(parsed.messages.map((message) => message.role)).toEqual(["user"]);
		expect(parsed.metadata.ignoredRecallEchoRows).toBe(1);
	});

	it("records explicit no-context state and lets SessionEnd fail closed when a guard is absent", async () => {
		await persistCodexRecallGuard({ pluginData, sessionId: "empty-recall", context: "", ...SECURITY });
		expect(await readCodexRecallGuard({ pluginData, sessionId: "empty-recall", ...SECURITY })).toEqual({ state: "no_context", fingerprints: [] });
		expect(await readCodexRecallGuard({ pluginData, sessionId: "missing-session", ...SECURITY })).toEqual({ state: "missing", fingerprints: [] });
		const transcript = JSON.stringify({
			type: "response_item",
			payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Implemented the private fix." }], id: "assistant" },
		});
		const parsed = parseCodexTranscriptText(transcript, { sessionId: "missing-session", suppressAssistantProse: true });
		expect(parsed.messages).toEqual([]);
		expect(parsed.metadata.ignoredUnprotectedAssistantRows).toBe(1);
	});

	it("keeps the newest recall fingerprints when a session exceeds the guard bound", async () => {
		const oldContext = Array.from({ length: 100 }, (_, index) => `Old recalled fact ${index}: keep the basalt ledger.`).join("\n");
		const newContext = Array.from({ length: 100 }, (_, index) => `New recalled fact ${index}: keep the cedar ledger.`).join("\n");
		await persistCodexRecallGuard({ pluginData, sessionId: "overflow-session", context: oldContext, ...SECURITY });
		await persistCodexRecallGuard({ pluginData, sessionId: "overflow-session", context: newContext, ...SECURITY });
		const guard = await readCodexRecallGuard({ pluginData, sessionId: "overflow-session", ...SECURITY });
		const newest = recallEchoFingerprintsFromText(newContext);
		const oldest = recallEchoFingerprintsFromText(oldContext);
		expect(guard.fingerprints).toHaveLength(128);
		expect(newest.every((fingerprint) => guard.fingerprints.includes(fingerprint))).toBe(true);
		expect(oldest.some((fingerprint) => !guard.fingerprints.includes(fingerprint))).toBe(true);
	});

	it("allows only HTTPS or exact loopback HTTP service origins", () => {
		expect(normalizeServiceBaseUrl("https://itsuki.app/")).toBe("https://itsuki.app");
		expect(normalizeServiceBaseUrl("http://localhost:8787")).toBe("http://localhost:8787");
		expect(() => normalizeServiceBaseUrl("https://itsuki.app/private/")).toThrow(CodexOutboxError);
		expect(() => normalizeServiceBaseUrl("http://itsuki.app")).toThrow(CodexOutboxError);
		expect(() => normalizeServiceBaseUrl("https://user:pass@itsuki.app")).toThrow(CodexOutboxError);
		expect(() => normalizeServiceBaseUrl("https://itsuki.app?token=private")).toThrow(CodexOutboxError);
	});

	it("uses every backend-valid explicit project ID and rejects invalid overrides without fallback", async () => {
		const spaced = await resolveCodexProjectScope(pluginData, {
			projectId: "team project",
			platform: "win32",
			realpathFn: async () => pluginData,
		});
		const maximum = await resolveCodexProjectScope(pluginData, {
			projectId: "π".repeat(160),
			platform: "win32",
			realpathFn: async () => pluginData,
		});
		expect(spaced.projectId).toBe("team project");
		expect(maximum.projectId).toBe("π".repeat(160));
		await expect(enqueue({ sessionId: "spaced-project", memoryScope: spaced })).resolves.toMatchObject({ queued: true });
		for (const projectId of ["", " leading", "trailing ", "control\nvalue", "x".repeat(161), 42]) {
			await expect(resolveCodexProjectScope(pluginData, { projectId })).rejects.toMatchObject({ code: "invalid_project_id" });
		}
	});

	it("accepts current and legacy bounded printable Itsuki API-key prefixes", () => {
		expect(validItsukiApiKey("itsuki_live_current_12345678")).toBe(true);
		expect(validItsukiApiKey("uml_live_legacy_12345678")).toBe(true);
		expect(validItsukiApiKey("uml_live_short")).toBe(false);
		expect(validItsukiApiKey("uml_live_legacy_12345678\nInjected: true")).toBe(false);
		expect(validItsukiApiKey("sk-not-an-itsuki-key-12345678")).toBe(false);
	});

	it("delivers and recalls with a legacy uml_live key", async () => {
		await enqueue({ apiKey: LEGACY_API_KEY });
		const fetchImpl = vi.fn(async (url) => new Response(JSON.stringify(
			String(url).endsWith("/v1/recall") ? { ok: true, context: "Legacy-key recall works." } : { ok: true },
		), { status: String(url).endsWith("/v1/recall") ? 200 : 202, headers: { "content-type": "application/json" } }));
		const drained = await drainCodexOutbox({
			pluginData,
			apiKey: LEGACY_API_KEY,
			baseUrl: BASE_URL,
			fetchImpl,
			...SECURITY,
		});
		const recalled = await recallCodexContext({
			apiKey: LEGACY_API_KEY,
			baseUrl: BASE_URL,
			memoryScope: scope,
			fetchImpl,
		});
		expect(drained.delivered).toBe(1);
		expect(recalled).toMatchObject({ status: "ok", context: "Legacy-key recall works." });
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("fails closed before writing when platform protection is unavailable", async () => {
		await expect(enqueueCodexCapture({
			pluginData,
			messages: capture.messages,
			sessionId: "queue-session",
			memoryScope: scope,
			capture: capture.metadata,
			apiKey: API_KEY,
			baseUrl: BASE_URL,
			platform: "win32",
			securityRunner: async () => { throw new Error("ACL unavailable"); },
		})).rejects.toThrow("ACL unavailable");
		const staged = join(pluginData, "codex-outbox", "v1", "staged");
		expect(await readdir(staged)).toEqual([]);
	});

	it("recovers a stale partial lock left by forced hook termination", async () => {
		const health = await inspectCodexOutbox({ pluginData, ...SECURITY });
		const lock = join(health.root, "locks", "queue.lock");
		await writeFile(lock, "", { mode: 0o600 });
		const stale = new Date(Date.now() - 120_000);
		await utimes(lock, stale, stale);
		await expect(enqueue()).resolves.toMatchObject({ queued: true, duplicate: false });
		expect(await readdir(join(health.root, "locks"))).toEqual([]);
	});

	it("waits through brief queue mutation contention instead of dropping a capture", async () => {
		const health = await inspectCodexOutbox({ pluginData, ...SECURITY });
		const lock = join(health.root, "locks", "queue.lock");
		await writeFile(lock, JSON.stringify({ schema: "itsuki.codex-lock/v1", token: "brief-owner" }), { mode: 0o600 });
		const released = new Promise((resolve, reject) => {
			setTimeout(() => rm(lock).then(resolve, reject), 40);
		});

		const queued = await enqueue();
		await released;
		expect(queued).toMatchObject({ queued: true, duplicate: false });
		expect((await inspectCodexOutbox({ pluginData, ...SECURITY })).count).toBe(1);
	});

	it("reaps bounded stale atomic-write remnants before they exhaust the queue", async () => {
		const health = await inspectCodexOutbox({ pluginData, ...SECURITY });
		const stale = new Date(Date.now() - 120_000);
		for (let index = 0; index < 9; index += 1) {
			const suffix = `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`;
			const path = join(health.root, "tmp", `.codex-${suffix}.tmp`);
			await writeFile(path, "partial", { mode: 0o600 });
			await utimes(path, stale, stale);
		}
		await expect(enqueue()).resolves.toMatchObject({ queued: true, duplicate: false });
		expect(await readdir(join(health.root, "tmp"))).toEqual([]);
	});

	it("does not deliver a tampered or unsanitized protected envelope", async () => {
		const queued = await enqueue();
		const health = await inspectCodexOutbox({ pluginData, ...SECURITY });
		const path = join(health.root, "staged", `${queued.queueId}.json`);
		const envelope = JSON.parse(await readFile(path, "utf8"));
		envelope.request.body.messages[0].content = "Bearer ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";
		await writeFile(path, JSON.stringify(envelope), "utf8");
		const fetchImpl = vi.fn();
		await expect(drainCodexOutbox({
			pluginData,
			apiKey: API_KEY,
			baseUrl: BASE_URL,
			fetchImpl,
			...SECURITY,
		})).rejects.toMatchObject({ code: "outbox_corrupt" });
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(await readFile(path, "utf8")).toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ123456");
	});
});
