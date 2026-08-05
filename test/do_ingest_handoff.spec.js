import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { claimIngestMemoryJob } from "../src/lib/db.js";

const hash = (character) => character.repeat(64);
const message = (id, content) => ({ id, role: "user", content, ts: Date.now() });
const stubFor = (userId) => env.USER_MEMORY.get(env.USER_MEMORY.idFromName(userId));

function codePoints(value) {
	let count = 0;
	for (const _ of String(value ?? "")) count++;
	return count;
}

async function storedHandoffMarkers(stub) {
	return runInDurableObject(stub, async (_instance, state) => {
		const markers = await state.storage.list({ prefix: "handoff:v1:" });
		return [...markers.values()];
	});
}

async function queueEntries(stub) {
	return runInDurableObject(stub, async (_instance, state) => {
		const entries = await state.storage.list({ prefix: "q:" });
		return [...entries.values()];
	});
}

describe("Durable Object ingest handoff", () => {
	it("serializes concurrent exact calls, stores the original result, and rejects a hash conflict", async () => {
		const userId = `handoff-concurrent-${crypto.randomUUID()}`;
		const stub = stubFor(userId);
		const handoffId = `job_${crypto.randomUUID()}`;
		const messages = [message("m1", "My preferred database for this project is SQLite")];
		const opts = {
			handoffId,
			requestHash: hash("a"),
			jobId: handoffId,
			flush: false,
		};

		const replies = await Promise.all(
			Array.from({ length: 8 }, () => stub.acceptMessagesOnce(userId, messages, opts)),
		);
		expect(replies.filter((reply) => !reply.handoffDuplicate)).toHaveLength(1);
		expect(replies.every((reply) => reply.handoffAccepted)).toBe(true);
		for (const reply of replies) {
			expect({
				fired: reply.fired,
				held: reply.held,
				skipped: reply.skipped,
				queued: reply.queued,
			}).toEqual({ fired: false, held: 1, skipped: 0, queued: 0 });
		}
		expect((await stub.getDebugState()).heldSize).toBe(1);

		const replay = await stub.acceptMessagesOnce(userId, messages, opts);
		expect(replay).toMatchObject({
			fired: false,
			held: 1,
			skipped: 0,
			queued: 0,
			handoffAccepted: true,
			handoffDuplicate: true,
		});
		const markers = await storedHandoffMarkers(stub);
		expect(markers).toHaveLength(1);
		expect(markers[0]).toMatchObject({
			state: "accepted",
			requestHash: hash("a"),
			result: { fired: false, held: 1, skipped: 0, queued: 0 },
		});

		await runInDurableObject(stub, async (instance, state) => {
			let conflict = null;
			try {
				await instance.acceptMessagesOnce(userId, messages, {
					...opts,
					requestHash: hash("b"),
				});
			} catch (error) {
				conflict = error;
			}
			expect(conflict?.message).toMatch(/already bound to different content/);
		});
		expect((await stub.getDebugState()).heldSize).toBe(1);
		await stub.resetAll();
	}, 30_000);

	it("recovers a pending marker written before addMessages", async () => {
		const userId = `handoff-pending-${crypto.randomUUID()}`;
		const stub = stubFor(userId);
		const handoffId = `job_${crypto.randomUUID()}`;
		const messages = [message("m-pending", "My current focus is a reliable retry protocol")];
		const opts = {
			handoffId,
			requestHash: hash("c"),
			jobId: handoffId,
			flush: false,
		};

		await runInDurableObject(stub, async (instance, state) => {
			await expect(instance.acceptMessagesOnce(userId, messages, {
				...opts,
				_testHandoffFault: "after_pending",
			})).rejects.toThrow(/injected handoff interruption/);
		});
		expect((await storedHandoffMarkers(stub))[0].state).toBe("pending");
		expect((await stub.getDebugState()).chunkSize).toBe(0);

		const recovered = await stub.acceptMessagesOnce(userId, messages, { ...opts, flush: true });
		expect(recovered).toMatchObject({
			fired: false,
			held: 1,
			queued: 0,
			handoffAccepted: true,
			handoffDuplicate: false,
		});
		expect((await stub.getDebugState()).heldSize).toBe(1);
		expect((await storedHandoffMarkers(stub))[0].state).toBe("accepted");
		await stub.resetAll();
	}, 30_000);

	it("reports marker-only noise recovery as the first real application", async () => {
		const userId = `handoff-pending-noise-${crypto.randomUUID()}`;
		const stub = stubFor(userId);
		const handoffId = `manual_${crypto.randomUUID()}`;
		const messages = [message("m-pending-noise", "ok thanks")];
		const opts = {
			handoffId,
			requestHash: hash("3"),
			flush: true,
		};
		await runInDurableObject(stub, async (instance) => {
			await expect(instance.acceptMessagesOnce(userId, messages, {
				...opts,
				_testHandoffFault: "after_pending",
			})).rejects.toThrow(/injected handoff interruption/);
		});

		const recovered = await stub.acceptMessagesOnce(userId, messages, opts);
		expect(recovered).toMatchObject({
			fired: false,
			held: 0,
			skipped: 1,
			handoffAccepted: true,
			handoffDuplicate: false,
		});
		expect((await storedHandoffMarkers(stub))[0].state).toBe("accepted");
		await stub.resetAll();
	}, 30_000);

	it("adopts queue ownership after a crash before the terminal marker without appending twice", async () => {
		const userId = `handoff-queue-${crypto.randomUUID()}`;
		const stub = stubFor(userId);
		const handoffId = `job_${crypto.randomUUID()}`;
		const messages = [message("m-queue", "I am building a crash-safe handoff this week")];
		const opts = {
			handoffId,
			requestHash: hash("d"),
			jobId: handoffId,
			flush: true,
		};

		await runInDurableObject(stub, async (instance, state) => {
			await expect(instance.acceptMessagesOnce(userId, messages, {
				...opts,
				_testHandoffFault: "after_pending",
			})).rejects.toThrow(/injected handoff interruption/);
			// Stand in for an older deployment (or an interruption inside the
			// legacy add path) that reached the queue but could not update the new
			// marker. Recovery must adopt this ownership, never call add twice.
			await instance.addMessages(userId, messages, {
				jobId: handoffId,
				flush: true,
			});
			// Simulate the legacy multi-write crash window too: the queue write
			// landed but clearing the same held message did not.
			await state.storage.put("chunk", [{
				...messages[0],
				_cls: "signal",
				_job: handoffId,
			}]);
		});
		expect((await storedHandoffMarkers(stub))[0].state).toBe("pending");
		expect(await queueEntries(stub)).toHaveLength(1);

		const recovered = await stub.acceptMessagesOnce(userId, messages, opts);
		expect(recovered).toMatchObject({
			fired: true,
			held: 1,
			queued: 1,
			handoffAccepted: true,
			handoffDuplicate: true,
		});
		const entries = await queueEntries(stub);
		expect(entries).toHaveLength(1);
		expect(entries[0].messages.map((item) => item.id)).toEqual(["m-queue"]);
		expect(Object.values(entries[0].jobByMessage)).toEqual([handoffId]);
		expect((await stub.getDebugState()).heldSize).toBe(0);

		await stub.acceptMessagesOnce(userId, messages, opts);
		expect(await queueEntries(stub)).toHaveLength(1);
		await stub.resetAll();
	}, 30_000);

	it("returns the stored add result after interruption at the applied marker", async () => {
		const userId = `handoff-applied-${crypto.randomUUID()}`;
		const stub = stubFor(userId);
		const handoffId = `job_${crypto.randomUUID()}`;
		const messages = [message("m-applied", "My release checklist now includes fault injection")];
		const opts = {
			handoffId,
			requestHash: hash("e"),
			jobId: handoffId,
			flush: false,
		};

		await runInDurableObject(stub, async (instance) => {
			await expect(instance.acceptMessagesOnce(userId, messages, {
				...opts,
				_testHandoffFault: "after_applied",
			})).rejects.toThrow(/injected handoff interruption/);
		});
		const applied = (await storedHandoffMarkers(stub))[0];
		expect(applied.state).toBe("applied");

		const replay = await stub.acceptMessagesOnce(userId, messages, opts);
		expect({
			fired: replay.fired,
			held: replay.held,
			skipped: replay.skipped,
			queued: replay.queued,
		}).toEqual(applied.result);
		expect(replay.handoffDuplicate).toBe(true);
		expect((await storedHandoffMarkers(stub))[0].state).toBe("accepted");
		await stub.resetAll();
	}, 30_000);

	it("replays effects idempotently after interruption immediately before acceptance", async () => {
		const userId = `handoff-before-accepted-${crypto.randomUUID()}`;
		const stub = stubFor(userId);
		const handoffId = `manual_${crypto.randomUUID()}`;
		const messages = [message("m-before-accepted", "My handoff now has a final acceptance gate")];
		const opts = {
			handoffId,
			requestHash: hash("4"),
			flush: false,
		};

		await runInDurableObject(stub, async (instance) => {
			await expect(instance.acceptMessagesOnce(userId, messages, {
				...opts,
				_testHandoffFault: "before_accepted",
			})).rejects.toThrow(/injected handoff interruption/);
		});
		expect((await storedHandoffMarkers(stub))[0].state).toBe("applied");
		expect((await stub.getDebugState()).heldSize).toBe(1);

		const replay = await stub.acceptMessagesOnce(userId, messages, opts);
		expect(replay).toMatchObject({
			fired: false,
			held: 1,
			queued: 0,
			handoffAccepted: true,
			handoffDuplicate: true,
		});
		expect((await stub.getDebugState()).heldSize).toBe(1);
		expect((await storedHandoffMarkers(stub))[0].state).toBe("accepted");
		await stub.resetAll();
	}, 30_000);

	it("recovers noise-only settlement from the terminal D1 job without settling twice", async () => {
		const userId = `handoff-noise-${crypto.randomUUID()}`;
		const stub = stubFor(userId);
		const idempotencyKey = `noise-${crypto.randomUUID()}`;
		const claim = await claimIngestMemoryJob(env, userId, {
			type: "extract",
			status: "queued",
			idempotencyKey,
			payload: { message_ids: ["m-noise"], remaining: ["m-noise"] },
		});
		expect(claim.claimed).toBe(true);
		const messages = [message("m-noise", "ok")];
		const opts = {
			handoffId: claim.id,
			requestHash: hash("f"),
			jobId: claim.id,
			flush: true,
		};

		await runInDurableObject(stub, async (instance) => {
			await expect(instance.acceptMessagesOnce(userId, messages, {
				...opts,
				_testHandoffFault: "after_pending",
			})).rejects.toThrow(/injected handoff interruption/);
			// Noise has no local ownership to inspect. Simulate the old call
			// settling D1 before it could write the terminal handoff marker.
			await instance.addMessages(userId, messages, {
				jobId: claim.id,
				flush: true,
			});
		});
		const terminal = await env.DB.prepare(
			"SELECT status FROM memory_jobs WHERE id = ? AND user_id = ?",
		).bind(claim.id, userId).first();
		expect(terminal.status).toBe("enriched");
		expect((await storedHandoffMarkers(stub))[0].state).toBe("pending");

		const replay = await stub.acceptMessagesOnce(userId, messages, opts);
		expect(replay).toMatchObject({
			fired: false,
			held: 0,
			skipped: 1,
			queued: 0,
			handoffAccepted: true,
			handoffDuplicate: true,
		});
		const after = await env.DB.prepare(
			"SELECT status, attempts FROM memory_jobs WHERE id = ? AND user_id = ?",
		).bind(claim.id, userId).first();
		expect(after).toEqual({ status: "enriched", attempts: 0 });
		expect((await stub.getDebugState()).chunkSize).toBe(0);
		await stub.resetAll();
	}, 30_000);

	it.each(["after_chunk_write", "after_recent_write", "after_overrides_write"])(
		"rolls back the entire local handoff transaction at %s",
		async (phase) => {
			const userId = `handoff-atomic-${phase}-${crypto.randomUUID()}`;
			const stub = stubFor(userId);
			const handoffId = `job_${crypto.randomUUID()}`;
			const messages = [
				{ id: "a-context", role: "assistant", content: "The prior design used a queue.", ts: Date.now() },
				message("m-atomic", "I decided to make the handoff transaction atomic"),
			];
			const overrides = {
				meta: { source_packet_id: "src_atomic", delivery: { groupId: "delivery_atomic", batchIndex: 0 } },
				rules: { mode: "strict" },
			};
			const opts = {
				handoffId,
				requestHash: hash("1"),
				jobId: handoffId,
				flush: true,
				overrides,
			};

			await runInDurableObject(stub, async (instance) => {
				await expect(instance.acceptMessagesOnce(userId, messages, {
					...opts,
					_testHandoffFault: phase,
				})).rejects.toThrow(/injected handoff interruption/);
			});
			const rolledBack = await runInDurableObject(stub, async (_instance, state) => ({
				chunk: (await state.storage.get("chunk")) ?? [],
				recent: [...(await state.storage.list({ prefix: "recent:context:v1:" })).values()],
				pendingOverrides: await state.storage.get("pendingOverrides"),
				queueSize: (await state.storage.list({ prefix: "q:" })).size,
			}));
			expect(rolledBack).toEqual({ chunk: [], recent: [], pendingOverrides: undefined, queueSize: 0 });
			expect((await storedHandoffMarkers(stub))[0].state).toBe("pending");

			const recovered = await stub.acceptMessagesOnce(userId, messages, opts);
			expect(recovered).toMatchObject({ fired: true, held: 1, queued: 1, handoffDuplicate: false });
			const entries = await queueEntries(stub);
			expect(entries).toHaveLength(1);
			expect(entries[0].messages.map((item) => item.id)).toEqual(["m-atomic"]);
			expect(entries[0].overrides).toEqual(overrides);
			const recent = await runInDurableObject(stub, async (_instance, state) => {
				const contexts = [...(await state.storage.list({ prefix: "recent:context:v1:" })).values()];
				expect(contexts).toHaveLength(1);
				return contexts[0];
			});
			expect(recent.map((item) => item.id)).toEqual(["a-context", "m-atomic"]);
			expect((await storedHandoffMarkers(stub))[0].state).toBe("accepted");
			await stub.resetAll();
		},
		30_000,
	);

	it("adopts the complete local commit after a crash before D1 effects", async () => {
		const userId = `handoff-local-commit-${crypto.randomUUID()}`;
		const stub = stubFor(userId);
		const idempotencyKey = `local-commit-${crypto.randomUUID()}`;
		const claim = await claimIngestMemoryJob(env, userId, {
			type: "extract",
			status: "queued",
			idempotencyKey,
			payload: { message_ids: ["m-signal", "m-noise"], remaining: ["m-signal", "m-noise"] },
		});
		const messages = [
			{ id: "a-tail", role: "assistant", content: "This context must survive the crash.", ts: Date.now() },
			message("m-signal", "I started testing mixed crash recovery every morning"),
			message("m-noise", "ok thanks"),
		];
		const overrides = {
			meta: { source_packet_id: "src_local_commit", delivery: { groupId: "delivery_local", batchIndex: 1 } },
			llmResponse: { objects: [], notes: "nothing extractable" },
		};
		const opts = {
			handoffId: claim.id,
			requestHash: hash("2"),
			jobId: claim.id,
			flush: true,
			overrides,
		};

		await runInDurableObject(stub, async (instance) => {
			await expect(instance.acceptMessagesOnce(userId, messages, {
				...opts,
				_testHandoffFault: "after_local_commit",
			})).rejects.toThrow(/injected handoff interruption/);
		});
		expect((await storedHandoffMarkers(stub))[0]).toMatchObject({
			state: "applied",
			settledMessageIds: ["m-noise"],
		});
		expect(await queueEntries(stub)).toHaveLength(1);
		const beforeRetry = await env.DB.prepare("SELECT status, payload_json FROM memory_jobs WHERE id = ? AND user_id = ?")
			.bind(claim.id, userId).first();
		expect(JSON.parse(beforeRetry.payload_json).remaining).toEqual(["m-signal", "m-noise"]);

		const recovered = await stub.acceptMessagesOnce(userId, messages, opts);
		expect(recovered).toMatchObject({ fired: true, held: 1, skipped: 1, queued: 1, handoffDuplicate: true });
		expect(await queueEntries(stub)).toHaveLength(1);
		const afterRetry = await env.DB.prepare("SELECT status, payload_json FROM memory_jobs WHERE id = ? AND user_id = ?")
			.bind(claim.id, userId).first();
		expect(afterRetry.status).toBe("processing");
		expect(JSON.parse(afterRetry.payload_json).remaining).toEqual(["m-signal"]);

		await stub.drain({ userId, maxJobs: 8, inlineOverrides: overrides });
		const terminal = await env.DB.prepare("SELECT status, payload_json FROM memory_jobs WHERE id = ? AND user_id = ?")
			.bind(claim.id, userId).first();
		expect(terminal.status).toBe("enriched");
		expect(JSON.parse(terminal.payload_json).remaining).toEqual([]);
		expect(await storedHandoffMarkers(stub)).toHaveLength(0);
		await stub.resetAll();
	}, 30_000);

	it("counts Unicode code points and never queues a first oversized message", async () => {
		const userId = `handoff-unicode-${crypto.randomUUID()}`;
		const stub = stubFor(userId);
		const prefix = "My durable preference is ";
		const exact = `${prefix}${"🚀".repeat(12_000 - codePoints(prefix))}`;
		expect(codePoints(exact)).toBe(12_000);

		const accepted = await stub.addMessages(userId, [message("m-exact", exact)], { flush: true });
		expect(accepted).toMatchObject({ fired: true, held: 1, queued: 1 });
		const entries = await queueEntries(stub);
		expect(entries).toHaveLength(1);
		expect(entries[0].messages).toHaveLength(1);
		expect(codePoints(entries[0].messages[0].content)).toBe(12_000);
		expect(entries.every((entry) => (
			entry.messages.reduce((sum, item) => sum + codePoints(item.content), 0) <= 12_000
		))).toBe(true);

		const oversized = `${prefix}${"🚀".repeat(12_001 - codePoints(prefix))}`;
		await runInDurableObject(stub, async (instance) => {
			let rejection = null;
			try {
				await instance.addMessages(userId, [message("m-oversized", oversized)], { flush: true });
			} catch (error) {
				rejection = error;
			}
			expect(rejection?.message).toMatch(/queue-entry limit/);
		});
		const after = await queueEntries(stub);
		expect(after).toHaveLength(1);
		expect(after.flatMap((entry) => entry.messages).map((item) => item.id)).toEqual(["m-exact"]);
		await stub.resetAll();
	}, 30_000);
});
