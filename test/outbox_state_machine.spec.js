/**
 * A12 — closing the two A4 residuals the campaign carried to the end
 * (a4-failure-matrix.md lines "disk-full / read-only / permission → PARTIAL …
 * NOT_RUN" and "Long randomized state-machine sequences remain queued", plus
 * the "clock jumps → NOT_RUN" host-lifecycle item folded into the op set).
 *
 * Part 1 — hostile filesystem: a read-only queue directory and a queue at its
 * designed byte bound must FAIL CLOSED (structured error, no partial files,
 * no corrupted queue) and RECOVER once the condition clears. OS-level ENOSPC
 * is NOT simulated here — this machine has no admin/quota tooling — but a
 * denied write and a full write land in the same catch-and-refuse path, and
 * the byte-cap guard (outbox_full) is the DESIGNED disk-pressure behavior.
 *
 * Part 2 — long randomized operation sequences over the protected queue's
 * state machine, driven by a SEEDED PRNG so any failure replays exactly.
 * Each envelope carries a fate the mock server honors (accept / permanent
 * reject / retryable-N-then-accept), so after EVERY operation four invariants
 * are checkable without knowing drain order:
 *
 *   CONSERVATION  every enqueued envelope is in exactly one of
 *                 staged ∪ quarantined ∪ delivered — never lost, never in two.
 *   ONCE          no envelope is ACCEPTED by the server more than once.
 *   BINDING       no envelope is ever delivered under a credential binding
 *                 other than the one it was captured with.
 *   RECOVERABLE   inspect never throws and the queue always remains drainable
 *                 — no operation sequence wedges it.
 *
 * Ops: enqueue (incl. clock-jumped far-future/far-past createdAt), drain,
 * key rotation, explicit rebind, corrupt-a-staged-file, inspect.
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

const run = promisify(execFile);
const KEY_A = "itsuki_live_state_machine_key_A1";
const KEY_B = "itsuki_live_state_machine_key_B2";
const BASE_URL = "http://localhost:8787";
const SECURITY = {
	platform: "win32",
	securityRunner: async () => ({ ok: true, protected: true }),
};
const roots = [];
let pluginData;
let scope;

beforeEach(async () => {
	pluginData = await mkdtemp(join(tmpdir(), "itsuki-state-machine-"));
	roots.push(pluginData);
	scope = await resolveCodexProjectScope(pluginData, { platform: "win32", realpathFn: async () => pluginData });
});

afterEach(async () => {
	await Promise.all(roots.splice(0).map(async (path) => {
		// A test may have left a deny ACE behind; clear it before removal.
		await run("icacls", [join(path, "codex-outbox", "v1", "tmp"), "/remove:d", userInfo().username], { windowsHide: true }).catch(() => {});
		await rm(path, { recursive: true, force: true }).catch(() => {});
	}));
});

function captureFor(sessionId, text) {
	const transcript = [
		JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `Implement ${text}` }], id: "user" } }),
		JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: `Implemented and verified ${text}` }], id: "assistant" } }),
	].join("\n");
	return parseCodexTranscriptText(transcript, { sessionId });
}

async function enqueue(sessionId, text, { apiKey = KEY_A, now } = {}) {
	const parsed = captureFor(sessionId, text);
	return enqueueCodexCapture({
		pluginData,
		messages: parsed.messages,
		sessionId,
		memoryScope: scope,
		capture: parsed.metadata,
		apiKey,
		baseUrl: BASE_URL,
		...(now ? { now } : {}),
		...SECURITY,
	});
}

const jsonResponse = (body, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const stagedDir = () => join(pluginData, "codex-outbox", "v1", "staged");
const failedDir = () => join(pluginData, "codex-outbox", "v1", "failed");
const listIds = async (dir) => (await readdir(dir).catch(() => []))
	.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5));

describe("A4 residual — hostile filesystem (read-only dir, byte bound)", () => {
	it("fails closed when the queue tmp directory is read-only, then recovers when permission returns", async () => {
		// Prime the queue structure, then deny AD/WD (create file / write data)
		// on tmp/ — the first directory every atomic enqueue must write into.
		await enqueue("prime-session", "Prime the queue before the ACL flips.");
		const tmpDir = join(pluginData, "codex-outbox", "v1", "tmp");
		const user = userInfo().username;
		await run("icacls", [tmpDir, "/deny", `${user}:(AD,WD)`], { windowsHide: true });

		let failure = null;
		try {
			await enqueue("denied-session", "This capture must be refused, not half-written.");
		} catch (error) {
			failure = error;
		} finally {
			await run("icacls", [tmpDir, "/remove:d", user], { windowsHide: true });
		}

		// Fail closed: a structured refusal, not a silent success and not a throw
		// of raw fs internals wrapped in a claim of queuing.
		expect(failure, "enqueue into a read-only directory must not report success").toBeTruthy();
		expect(String(failure.code ?? failure.name)).toMatch(/outbox|EPERM|EACCES/i);

		// No partial state: no stray tmp files, exactly the primed envelope staged.
		expect((await readdir(tmpDir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
		expect(await listIds(stagedDir())).toHaveLength(1);

		// Recovery: permission restored → the same capture enqueues cleanly.
		const recovered = await enqueue("denied-session", "This capture must be refused, not half-written.");
		expect(recovered.queued).toBe(true);
		expect(await listIds(stagedDir())).toHaveLength(2);
	}, 30_000);

	it("refuses the envelope that would cross the byte bound and keeps the queue intact", async () => {
		// The designed disk-pressure guard: a queue at maxBytes refuses new work
		// with outbox_full rather than corrupting or evicting. Reaching the real
		// 16 MiB cap through the enqueue API is not possible in-budget (envelopes
		// are capped far smaller), so the bound is exercised the way disk
		// pressure actually presents: pre-existing bulk in the protected
		// directory counted by the guard.
		await enqueue("base-session", "Baseline envelope before pressure.");
		const filler = join(stagedDir(), `codex_${"f".repeat(64)}.json`);
		await writeFile(filler, `${JSON.stringify({ pad: "x".repeat(CODEX_OUTBOX_LIMITS.maxBytes) })}\n`);

		let failure = null;
		try {
			await enqueue("pressure-session", "This capture must be refused by the byte bound.");
		} catch (error) {
			failure = error;
		}
		expect(failure?.code).toBe("outbox_full");

		// Fail closed: nothing evicted, nothing partially written.
		const staged = await listIds(stagedDir());
		expect(staged).toHaveLength(2); // baseline + filler
		expect((await readdir(join(pluginData, "codex-outbox", "v1", "tmp"))).filter((f) => f.endsWith(".tmp"))).toEqual([]);

		// Recovery: pressure released → enqueue works again.
		await rm(filler);
		const recovered = await enqueue("pressure-session", "This capture must be refused by the byte bound.");
		expect(recovered.queued).toBe(true);
	}, 30_000);
});

describe("CDX-09 — a corrupt envelope quarantines instead of wedging the drain", () => {
	it("quarantines the corrupt oldest entry and still delivers the valid one behind it", async () => {
		// Found BY the randomized sequences below on their first run: the drain's
		// snapshot loop read every staged envelope with no per-entry catch, so a
		// single corrupt file made every subsequent drain throw outbox_corrupt —
		// valid work behind it could never deliver again, while inspect kept
		// reporting a healthy-looking queue. CDX-01's class, on the read path.
		const bad = await enqueue("corrupt-session", "This envelope will be truncated on disk.", { now: new Date("2026-01-01T00:00:00.000Z") });
		const good = await enqueue("healthy-session", "This later valid capture must still deliver.", { now: new Date("2026-01-02T00:00:00.000Z") });
		await writeFile(join(stagedDir(), `${bad.queueId}.json`), "{\"truncated\":");

		let accepted = 0;
		const drained = await drainCodexOutbox({
			pluginData, apiKey: KEY_A, baseUrl: BASE_URL, maxEntries: 4, maxDurationMs: 5_000,
			fetchImpl: async () => { accepted += 1; return jsonResponse({ ok: true, source_packet_id: "src_x", job_id: "job_x", receipt_id: "rcpt_x" }, 202); },
			...SECURITY,
		});

		expect(drained.quarantined).toBe(1);
		expect(drained.delivered).toBe(1);
		expect(accepted).toBe(1);
		// The corrupt bytes are preserved for review, never deleted.
		expect(await listIds(failedDir())).toEqual([bad.queueId]);
		expect(await readFile(join(failedDir(), `${bad.queueId}.json`), "utf8")).toBe("{\"truncated\":");
		expect(await listIds(stagedDir())).toEqual([]);
		void good;
	}, 30_000);
});

describe("A4 residual — long randomized state-machine sequences (seeded)", () => {
	// mulberry32 — tiny deterministic PRNG; a failing seed replays exactly.
	function prng(seed) {
		let a = seed >>> 0;
		return () => {
			a |= 0; a = (a + 0x6D2B79F5) | 0;
			let t = Math.imul(a ^ (a >>> 15), 1 | a);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	for (const seed of [0xA12001, 0xA12002, 0xA12003]) {
		it(`holds all four invariants across 40 random operations (seed 0x${seed.toString(16)})`, async () => {
			const rand = prng(seed);
			const pick = (list) => list[Math.floor(rand() * list.length)];

			// Model state.
			const fates = new Map();        // queueId -> "accept" | "reject" | "flaky"
			const bindings = new Map();     // queueId -> key it was captured under
			const markerToId = new Map();   // content marker -> queueId
			const acceptedBy = new Map();   // queueId -> count of server 202s
			const flakyFailures = new Map();// queueId -> 500s served so far
			const bindingViolations = [];   // asserted OUTSIDE the mock — a throw
			                                // inside fetchImpl would read as a
			                                // network error to the drain and hide
			                                // the very defect it found
			const corrupted = new Set();
			let activeKey = KEY_A;
			let sequence = 0;

			// Fate-scripted server: behavior derives from a marker in the request
			// body, mapped back to the queueId recorded at enqueue time — so the
			// model never needs to know drain order and never mutates envelopes.
			const fetchImpl = async (url, init) => {
				const body = JSON.parse(init.body);
				const auth = init.headers?.authorization ?? init.headers?.Authorization ?? "";
				const text = body.messages.map((m) => m.content).join(" ");
				const marker = /step marker ([a-z0-9]+)/.exec(text)?.[1];
				const id = marker ? markerToId.get(marker) : undefined;
				// BINDING: the drain must never send an envelope with a key other
				// than the one it was captured under.
				if (id && bindings.has(id) && auth !== `Bearer ${bindings.get(id)}`) {
					bindingViolations.push(`envelope ${id} sent as ${auth.slice(0, 24)}… expected binding ${bindings.get(id).slice(-4)}`);
				}
				const fate = id ? fates.get(id) : "accept";
				if (fate === "reject") return jsonResponse({ error: "unprocessable" }, 422);
				if (fate === "flaky") {
					const failures = flakyFailures.get(id) ?? 0;
					if (failures < 3) { flakyFailures.set(id, failures + 1); return jsonResponse({ error: "transient" }, 500); }
				}
				if (id) acceptedBy.set(id, (acceptedBy.get(id) ?? 0) + 1);
				return jsonResponse({ ok: true, source_packet_id: `src_${sequence}`, job_id: `job_${sequence}`, receipt_id: `rcpt_${sequence++}` }, 202);
			};

			const checkInvariants = async (opIndex, opName) => {
				const staged = await listIds(stagedDir());
				const failed = await listIds(failedDir());
				const delivered = [...acceptedBy.keys()].filter(Boolean);
				const label = `op ${opIndex} (${opName}) seed 0x${seed.toString(16)}`;

				// BINDING — collected by the mock, asserted here.
				expect(bindingViolations, `${label}: ${bindingViolations.join("; ")}`).toEqual([]);
				// ONCE — an envelope is never accepted twice.
				for (const [id, count] of acceptedBy) {
					expect(count, `${label}: ${id} accepted ${count} times`).toBeLessThanOrEqual(1);
				}
				// CONSERVATION — every enqueued id in exactly one bucket.
				for (const id of fates.keys()) {
					const places = [staged.includes(id), failed.includes(id), delivered.includes(id)].filter(Boolean).length;
					expect(places, `${label}: ${id} (fate ${fates.get(id)}) found in ${places} buckets`).toBe(1);
				}
				// No foreign ids appeared from nowhere.
				for (const id of [...staged, ...failed]) {
					expect(fates.has(id), `${label}: unknown entry ${id}`).toBe(true);
				}
				// RECOVERABLE — inspect answers on whatever state this is.
				const health = await inspectCodexOutbox({ pluginData, apiKey: activeKey, baseUrl: BASE_URL, ...SECURITY });
				expect(health.count).toBe(staged.length);
			};

			const ops = [
				async (i) => { // enqueue under the active key (occasionally clock-jumped)
					const jump = rand();
					const now = jump < 0.15 ? new Date("2035-06-01T00:00:00.000Z")
						: jump < 0.3 ? new Date("2001-01-01T00:00:00.000Z") : undefined;
					const fate = pick(["accept", "accept", "accept", "reject", "flaky"]);
					const marker = `s${seed.toString(16)}x${i}`;
					const result = await enqueue(`sm-${seed}-${i}`, `the queue sequencer, step marker ${marker}, in this run`, { apiKey: activeKey, now });
					if (result?.queued && result.queueId) {
						fates.set(result.queueId, fate);
						bindings.set(result.queueId, activeKey);
						markerToId.set(marker, result.queueId);
					}
					return "enqueue";
				},
				async () => { // drain
					await drainCodexOutbox({ pluginData, apiKey: activeKey, baseUrl: BASE_URL, maxEntries: 4, maxDurationMs: 5_000, fetchImpl, ...SECURITY });
					return "drain";
				},
				async () => { // rotate the active credential
					activeKey = activeKey === KEY_A ? KEY_B : KEY_A;
					return "rotate-key";
				},
				async () => { // explicit rebind — the ONLY path that may change bindings
					const outcome = await rebindCodexOutbox({ pluginData, apiKey: activeKey, baseUrl: BASE_URL, ...SECURITY }).catch(() => null);
					if (outcome) for (const id of await listIds(stagedDir())) if (!corrupted.has(id)) bindings.set(id, activeKey);
					return "rebind";
				},
				async () => { // corrupt one staged envelope (truncation)
					const staged = (await listIds(stagedDir())).filter((id) => !corrupted.has(id));
					if (staged.length) {
						const id = pick(staged);
						await writeFile(join(stagedDir(), `${id}.json`), "{\"truncated\":");
						corrupted.add(id);
						fates.set(id, "reject"); // a corrupt envelope must end quarantined, never delivered
					}
					return "corrupt";
				},
			];

			for (let i = 0; i < 40; i += 1) {
				const weights = [0.4, 0.75, 0.85, 0.92, 1]; // enqueue-heavy, drains often
				const roll = rand();
				const op = ops[weights.findIndex((w) => roll < w)];
				const name = await op(i);
				await checkInvariants(i, name);
			}

			// Terminal expectations after a final full drain under each key:
			await drainCodexOutbox({ pluginData, apiKey: KEY_A, baseUrl: BASE_URL, maxEntries: 64, maxDurationMs: 10_000, fetchImpl, ...SECURITY });
			await drainCodexOutbox({ pluginData, apiKey: KEY_B, baseUrl: BASE_URL, maxEntries: 64, maxDurationMs: 10_000, fetchImpl, ...SECURITY });
			await checkInvariants("final", "full-drain");

			// Every corrupt envelope must be quarantined or still staged — never accepted.
			for (const id of corrupted) {
				expect(acceptedBy.has(id), `corrupt ${id} was delivered`).toBe(false);
			}
			// Retry bound: flaky envelopes never exceeded the quarantine attempt cap.
			for (const [id, failures] of flakyFailures) {
				expect(failures).toBeLessThanOrEqual(CODEX_RETRY_QUARANTINE_ATTEMPTS);
			}
		}, 120_000);
	}
});
