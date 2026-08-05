/**
 * Stage 5 adversarial context-isolation contract.
 *
 * These cases deliberately cover migration and identity edges that the primary
 * snapshot suite does not. All inference is supplied through deterministic
 * hooks; this file must never spend Workers AI.
 */

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createMemoryJob } from "../src/lib/db.js";

const MAX_CONTEXT_BYTES = 16 * 1024;
const MAX_ACTIVE_CONTEXTS = 32;
const T0 = Date.now();

function stubFor(userId) {
	return env.USER_MEMORY.get(env.USER_MEMORY.idFromName(userId));
}

function assistant(id, content, offset = 0) {
	return { id, role: "assistant", content, ts: T0 + offset };
}

function user(id, probe, offset = 0) {
	return {
		id,
		role: "user",
		content: `${probe} is the durable architecture decision for this coding session.`,
		ts: T0 + offset,
	};
}

function extractionOptions({
	projectId = "stage5-shared-project",
	conversationId,
	threadId,
	sessionId,
	agentId,
} = {}, { flush = true, jobId = null } = {}) {
	const scope = {
		workspace_id: "stage5-adversarial-workspace",
		app_id: "stage5-adversarial-agent",
		...(agentId ? { agent_id: agentId } : {}),
		...(conversationId ? { conversation_id: conversationId } : {}),
		...(threadId ? { thread_id: threadId } : {}),
		...(sessionId ? { session_id: sessionId } : {}),
		source_scope: "stage5-adversarial",
		project_id: projectId,
		project_name: `Project ${projectId}`,
	};
	return {
		flush,
		...(jobId ? { jobId } : {}),
		scopeKey: `project:${projectId}`,
		overrides: {
			source: "plugin",
			profile: "plugin",
			lightPath: true,
			edgeResponse: { edges: [] },
			reflexionResponse: { entities: [], facts: [], edges: [], notes: "" },
			meta: {
				project_id: projectId,
				project_name: `Project ${projectId}`,
				source_mode: "plugin_auto",
				scope_json: JSON.stringify(scope),
			},
		},
	};
}

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

function proposalFor(packet) {
	// A parsed, empty proposal exercises the complete extraction/settlement path
	// without creating graph rows. That keeps shortlist empty on later entries,
	// so neither embeddings nor pass-2 can fall through to an AI binding.
	void packet;
	return {
		objects: [],
		notes: "deterministic Stage 5 adversarial probe",
	};
}

async function drainAndCapture(instance, userId, maxJobs = 10, extra = {}) {
	const packets = [];
	const drained = await instance.drain({
		userId,
		maxJobs,
		ignoreBackoff: true,
		inlineOverrides: {
			...extra,
			llmResponse: ({ packet }) => {
				packets.push(clone(packet));
				return proposalFor(packet);
			},
		},
	});
	return { drained, packets };
}

async function extractEntries(state) {
	return [...(await state.storage.list({ prefix: "q:" })).entries()]
		.filter(([, entry]) => entry.kind === "extract");
}

function contextIds(packet, field) {
	return (packet?.[field] ?? []).map((message) => message.id);
}

function modelContextBytes(packet) {
	return new TextEncoder().encode(JSON.stringify({
		bridge_context: packet?.bridge_context ?? [],
		assistant_context: packet?.assistant_context ?? [],
	})).byteLength;
}

function contextTrace(entryOrReceipt) {
	return entryOrReceipt?.contextTrace
		?? entryOrReceipt?.context_trace
		?? entryOrReceipt?.extraction_context
		?? null;
}

describe("Stage 5 adversarial identity boundaries", () => {
	it("isolates two agents even when they reuse the same conversation id", async () => {
		const userId = `stage5-same-conversation-agents-${crypto.randomUUID()}`;
		const stub = stubFor(userId);
		const packets = await runInDurableObject(stub, async (instance) => {
			await instance.addMessages(userId, [
				assistant("same-conversation-agent-a-context", "Only agent A knows the amber scheduler."),
				user("same-conversation-agent-a-target", "AdversarialProbeSameConversationA", 1),
			], extractionOptions({ conversationId: "shared-conversation", agentId: "agent-a" }));
			await instance.addMessages(userId, [
				assistant("same-conversation-agent-b-context", "Only agent B knows the blue renderer.", 2),
				user("same-conversation-agent-b-target", "AdversarialProbeSameConversationB", 3),
			], extractionOptions({ conversationId: "shared-conversation", agentId: "agent-b" }));
			return (await drainAndCapture(instance, userId, 2)).packets;
		});

		const byTarget = new Map(packets.map((packet) => [packet.new_slice[0]?.id, packet]));
		expect(contextIds(byTarget.get("same-conversation-agent-a-target"), "assistant_context"))
			.toEqual(["same-conversation-agent-a-context"]);
		expect(contextIds(byTarget.get("same-conversation-agent-b-target"), "assistant_context"))
			.toEqual(["same-conversation-agent-b-context"]);
		await stub.resetAll();
	}, 30_000);

	it("uses thread id as the boundary when conversation id is absent", async () => {
		const userId = `stage5-thread-fallback-${crypto.randomUUID()}`;
		const stub = stubFor(userId);
		const packets = await runInDurableObject(stub, async (instance) => {
			await instance.addMessages(userId, [
				assistant("thread-a-context", "Thread A selected the amber queue."),
				user("thread-a-target", "AdversarialProbeThreadA", 1),
			], extractionOptions({ threadId: "thread-a", agentId: "shared-agent" }));
			await instance.addMessages(userId, [
				assistant("thread-b-context", "Thread B selected the blue queue.", 2),
				user("thread-b-target", "AdversarialProbeThreadB", 3),
			], extractionOptions({ threadId: "thread-b", agentId: "shared-agent" }));
			return (await drainAndCapture(instance, userId, 2)).packets;
		});

		const byTarget = new Map(packets.map((packet) => [packet.new_slice[0]?.id, packet]));
		expect(contextIds(byTarget.get("thread-a-target"), "assistant_context")).toEqual(["thread-a-context"]);
		expect(contextIds(byTarget.get("thread-b-target"), "assistant_context")).toEqual(["thread-b-context"]);
		await stub.resetAll();
	}, 30_000);

	it("uses an explicitly supplied session id only when conversation and thread are absent", async () => {
		const userId = `stage5-session-fallback-${crypto.randomUUID()}`;
		const stub = stubFor(userId);
		const packets = await runInDurableObject(stub, async (instance) => {
			await instance.addMessages(userId, [
				assistant("session-a-context", "Session A selected an amber cache."),
				user("session-a-target", "AdversarialProbeSessionA", 1),
			], extractionOptions({ sessionId: "session-a", agentId: "shared-agent" }));
			await instance.addMessages(userId, [
				assistant("session-b-context", "Session B selected a blue cache.", 2),
				user("session-b-target", "AdversarialProbeSessionB", 3),
			], extractionOptions({ sessionId: "session-b", agentId: "shared-agent" }));
			return (await drainAndCapture(instance, userId, 2)).packets;
		});

		const byTarget = new Map(packets.map((packet) => [packet.new_slice[0]?.id, packet]));
		expect(contextIds(byTarget.get("session-a-target"), "assistant_context")).toEqual(["session-a-context"]);
		expect(contextIds(byTarget.get("session-b-target"), "assistant_context")).toEqual(["session-b-context"]);
		await stub.resetAll();
	}, 30_000);

	it("falls back to the handoff identity for jobless calls with no conversation metadata", async () => {
		const userId = `stage5-jobless-fallback-${crypto.randomUUID()}`;
		const stub = stubFor(userId);
		const packets = await runInDurableObject(stub, async (instance) => {
			const base = extractionOptions({ agentId: null });
			await instance.acceptMessagesOnce(userId, [
				assistant("jobless-a-context", "Jobless handoff A selected amber."),
				user("jobless-a-target", "AdversarialProbeJoblessA", 1),
			], {
				...base,
				handoffId: `stage5-jobless-a-${crypto.randomUUID()}`,
				requestHash: "a".repeat(64),
			});
			await instance.acceptMessagesOnce(userId, [
				assistant("jobless-b-context", "Jobless handoff B selected blue.", 2),
				user("jobless-b-target", "AdversarialProbeJoblessB", 3),
			], {
				...base,
				handoffId: `stage5-jobless-b-${crypto.randomUUID()}`,
				requestHash: "b".repeat(64),
			});
			return (await drainAndCapture(instance, userId, 2)).packets;
		});

		const byTarget = new Map(packets.map((packet) => [packet.new_slice[0]?.id, packet]));
		expect(contextIds(byTarget.get("jobless-a-target"), "assistant_context")).toEqual(["jobless-a-context"]);
		expect(contextIds(byTarget.get("jobless-b-target"), "assistant_context")).toEqual(["jobless-b-context"]);
		await stub.resetAll();
	}, 30_000);
});

describe("Stage 5 adversarial migration behavior", () => {
	it("drains a legacy queue entry with empty context instead of mutable live recent", async () => {
		const userId = `stage5-legacy-empty-${crypto.randomUUID()}`;
		const stub = stubFor(userId);
		const packet = await runInDurableObject(stub, async (instance, state) => {
			await state.storage.put("userId", userId);
			await state.storage.put("recent", [assistant(
				"legacy-live-contaminant",
				"This mutable project-wide context arrived after the legacy job was queued.",
			)]);
			await state.storage.put("q:0000000001-legacy", {
				kind: "extract",
				messages: [user("legacy-target", "AdversarialProbeLegacyEmpty", 1)],
				jobByMessage: {},
				dedupeByMessage: {},
				overrides: extractionOptions().overrides,
				scopeKey: "global",
				attempts: 0,
				runAfter: 0,
				enqueuedAt: T0,
			});
			return (await drainAndCapture(instance, userId, 1)).packets[0];
		});

		expect(packet.bridge_context).toEqual([]);
		expect(packet.assistant_context).toEqual([]);
		expect(JSON.stringify(packet)).not.toContain("legacy-live-contaminant");
		await stub.resetAll();
	}, 30_000);

	it("fails a corrupt snapshot hash closed to empty context", async () => {
		const userId = `stage5-corrupt-snapshot-${crypto.randomUUID()}`;
		const stub = stubFor(userId);
		const observed = await runInDurableObject(stub, async (instance, state) => {
			await state.storage.put("userId", userId);
			await state.storage.put("recent", [assistant(
				"corrupt-live-contaminant",
				"Live recent must not be a fallback for a corrupt immutable snapshot.",
			)]);
			await state.storage.put("q:0000000001-corrupt", {
				kind: "extract",
				messages: [user("corrupt-target", "AdversarialProbeCorruptEmpty", 1)],
				jobByMessage: {},
				dedupeByMessage: {},
				overrides: extractionOptions().overrides,
				scopeKey: "global",
				contextKey: `context:v1:${"1".repeat(64)}`,
				contextSnapshot: {
					schema: "itsuki.extract-context/v1",
					messages: [assistant("corrupt-snapshot-secret", "This corrupt snapshot must never reach inference.")],
				},
				contextTrace: {
					schema: "itsuki.extract-context-trace/v1",
					mode: "accepted_snapshot",
					context_hash: "1".repeat(64),
					snapshot_hash: "0".repeat(64),
					messages: 1,
					user_messages: 0,
					assistant_messages: 1,
					serialized_bytes: 100,
					omitted_messages: 0,
					truncated_messages: 0,
					captured_at: T0,
				},
				attempts: 0,
				runAfter: 0,
				enqueuedAt: T0,
			});
			const result = await drainAndCapture(instance, userId, 1);
			return { packet: result.packets[0], result: result.drained.results[0] };
		});

		expect(observed.packet.bridge_context).toEqual([]);
		expect(observed.packet.assistant_context).toEqual([]);
		expect(JSON.stringify(observed.packet)).not.toContain("corrupt-snapshot-secret");
		expect(JSON.stringify(observed.packet)).not.toContain("corrupt-live-contaminant");
		expect(contextTrace(observed.result?.receipt)?.mode).toBe("invalid_empty");
		await stub.resetAll();
	}, 30_000);
});

describe("Stage 5 adversarial bounds and retention", () => {
	it("reserves the five-user bridge budget for earlier messages, not the current new slice", async () => {
		const userId = `stage5-bridge-budget-${crypto.randomUUID()}`;
		const stub = stubFor(userId);
		const options = extractionOptions({ conversationId: "bridge-budget", agentId: "bridge-agent" }, { flush: false });
		const packet = await runInDurableObject(stub, async (instance) => {
			await instance.addMessages(userId, Array.from({ length: 4 }, (_, index) => ({
				id: `bridge-earlier-${index}`,
				role: "user",
				content: `Earlier bridge context ${index} describes the stable amber parser module.`,
				ts: T0 + index,
			})), options);
			await instance.addMessages(userId, Array.from({ length: 5 }, (_, index) => ({
				id: `bridge-current-${index}`,
				role: "user",
				content: `Current slice ${index} records the stable amber parser implementation outcome.`,
				ts: T0 + 100 + index,
			})), { ...options, flush: true });
			const packets = (await drainAndCapture(instance, userId, 2)).packets;
			return packets.find((candidate) => candidate.new_slice[0]?.id === "bridge-current-0");
		});

		expect(contextIds(packet, "bridge_context")).toEqual([
			"bridge-earlier-0",
			"bridge-earlier-1",
			"bridge-earlier-2",
			"bridge-earlier-3",
		]);
		expect(contextIds(packet, "bridge_context").some((id) => id.startsWith("bridge-current-"))).toBe(false);
		await stub.resetAll();
	}, 30_000);

	it("captures before a large current slice can evict earlier rolling context", async () => {
		const userId = `stage5-large-current-${crypto.randomUUID()}`;
		const stub = stubFor(userId);
		const options = extractionOptions({ conversationId: "large-current", agentId: "large-current-agent" });
		await runInDurableObject(stub, async (instance, state) => {
			await instance.addMessages(userId, [
				assistant("large-current-earlier-assistant", "The earlier assistant selected the amber parser."),
				user("large-current-earlier-user", "AdversarialProbeLargeCurrentEarlier", 1),
			], options);
			const difficult = `\"\\\n終😀${"x".repeat(9_990)}`;
			await instance.addMessages(userId, Array.from({ length: 3 }, (_, index) => ({
				id: `large-current-target-${index}`,
				role: "user",
				content: `${index}:${difficult}`,
				ts: T0 + 100 + index,
			})), options);

			const currentEntries = (await extractEntries(state))
				.map(([, entry]) => entry)
				.filter((entry) => entry.messages[0]?.id?.startsWith("large-current-target-"));
			expect(currentEntries.length).toBeGreaterThan(0);
			for (const entry of currentEntries) {
				expect(entry.contextSnapshot.map((message) => message.id)).toEqual([
					"large-current-earlier-assistant",
					"large-current-earlier-user",
				]);
				expect(modelContextBytes({
					bridge_context: entry.contextSnapshot.filter((message) => message.role === "user"),
					assistant_context: entry.contextSnapshot.filter((message) => message.role === "assistant"),
				})).toBeLessThanOrEqual(MAX_CONTEXT_BYTES);
			}
		});
		await stub.resetAll();
	}, 30_000);

	it("never coerces system or tool records into user bridge context", async () => {
		const userId = `stage5-role-filter-${crypto.randomUUID()}`;
		const stub = stubFor(userId);
		const packet = await runInDurableObject(stub, async (instance) => {
			await instance.addMessages(userId, [
				{ id: "private-system", role: "system", content: "PRIVATE_SYSTEM_SENTINEL", ts: T0 },
				{ id: "raw-tool", role: "tool", content: "RAW_TOOL_SENTINEL", ts: T0 + 1 },
				assistant("role-filter-assistant", "The public assistant context is allowed.", 2),
				user("role-filter-target", "AdversarialProbeRoleFilter", 3),
			], extractionOptions({ conversationId: "role-filter", agentId: "role-filter-agent" }));
			return (await drainAndCapture(instance, userId, 1)).packets[0];
		});

		expect(packet.bridge_context).toEqual([]);
		expect(contextIds(packet, "assistant_context")).toEqual(["role-filter-assistant"]);
		expect(JSON.stringify(packet)).not.toContain("PRIVATE_SYSTEM_SENTINEL");
		expect(JSON.stringify(packet)).not.toContain("RAW_TOOL_SENTINEL");
		await stub.resetAll();
	}, 30_000);

	it("bounds multibyte and JSON-escape-heavy model context to 16 KiB", async () => {
		const userId = `stage5-escaped-bound-${crypto.randomUUID()}`;
		const stub = stubFor(userId);
		const rawSentinel = "RAW_ESCAPED_CONTEXT_SENTINEL";
		const difficult = `${rawSentinel}\u0000\\\"😀終`.repeat(700);
		const observed = await runInDurableObject(stub, async (instance, state) => {
			await instance.addMessages(userId, [
				...Array.from({ length: 8 }, (_, index) => assistant(
					`escaped-assistant-${index}`,
					`${index}:${difficult}`,
					index,
				)),
				user("escaped-target", "AdversarialProbeEscapedBound", 100),
			], extractionOptions({ conversationId: "escaped-context", agentId: "escaped-agent" }));
			const entry = (await extractEntries(state))[0]?.[1];
			const packet = (await drainAndCapture(instance, userId, 1)).packets[0];
			return { packet, trace: contextTrace(entry) };
		});

		expect(modelContextBytes(observed.packet)).toBeLessThanOrEqual(MAX_CONTEXT_BYTES);
		expect(observed.packet.assistant_context.length).toBeLessThanOrEqual(5);
		expect(observed.trace).toBeTruthy();
		expect(JSON.stringify(observed.trace)).not.toContain(rawSentinel);
		expect(observed.trace.serialized_bytes).toBeLessThanOrEqual(MAX_CONTEXT_BYTES);
		await stub.resetAll();
	}, 30_000);

	it("evicts raw recent state beyond 32 contexts without changing a queued snapshot", async () => {
		const userId = `stage5-context-lru-${crypto.randomUUID()}`;
		const stub = stubFor(userId);
		const observed = await runInDurableObject(stub, async (instance, state) => {
			await instance.addMessages(userId, [
				assistant("lru-original-context", "The queued job captured the original amber context."),
				user("lru-original-target", "AdversarialProbeLruSnapshot", 1),
			], extractionOptions({ conversationId: "lru-original", agentId: "lru-agent" }));
			const originalEntry = (await extractEntries(state))[0]?.[1];
			expect(originalEntry?.contextKey).toMatch(/^context:v1:[a-f0-9]{64}$/);

			for (let index = 0; index < MAX_ACTIVE_CONTEXTS + 1; index++) {
				await instance.addMessages(userId, [assistant(
					`lru-context-${index}`,
					`Unrelated context ${index} must not mutate the queued snapshot.`,
					100 + index,
				)], extractionOptions({
					conversationId: `lru-conversation-${index}`,
					agentId: "lru-agent",
				}, { flush: false }));
			}

			const index = await state.storage.get("contextIndex:v1");
			expect(Array.isArray(index)).toBe(true);
			expect(index).toHaveLength(MAX_ACTIVE_CONTEXTS);
			expect(await state.storage.get(`recent:${originalEntry.contextKey}`)).toBeUndefined();
			const packet = (await drainAndCapture(instance, userId, 1)).packets[0];
			return { packet, originalTrace: contextTrace(originalEntry) };
		});

		expect(contextIds(observed.packet, "assistant_context")).toEqual(["lru-original-context"]);
		expect(observed.originalTrace).toBeTruthy();
		expect(JSON.stringify(observed.originalTrace)).not.toContain("original amber context");
		await stub.resetAll();
	}, 30_000);
});

describe("Stage 5 trace durability", () => {
	it("reconsiders a deliberate real-job rescue with its original snapshot instead of discarding it", async () => {
		const userId = `stage5-real-rescue-${crypto.randomUUID()}`;
		const stub = stubFor(userId);
		const jobId = `job_${crypto.randomUUID()}`;
		const messageId = "real-rescue-target";
		await createMemoryJob(env, userId, {
			id: jobId,
			type: "extract",
			status: "queued",
			idempotencyKey: `stage5-real-rescue-${crypto.randomUUID()}`,
			payload: { message_ids: [messageId], remaining: [messageId] },
		});

		const observed = await runInDurableObject(stub, async (instance, state) => {
			const context = { conversationId: "real-rescue-conversation", agentId: "real-rescue-agent" };
			await instance.addMessages(userId, [
				assistant("real-rescue-context", "The original rescue context selected the amber parser."),
				user(messageId, "AdversarialProbeRealRescue", 1),
			], extractionOptions(context, { jobId }));
			const originalEntry = (await extractEntries(state))[0]?.[1];
			const originalTrace = clone(contextTrace(originalEntry));
			const first = await drainAndCapture(instance, userId, 1);
			expect(first.drained.results[0]?.outcome).toBe("meaningful_no_write");
			expect((await state.storage.get("chunk"))?.[0]?._settled).toBe(true);

			await instance.addMessages(userId, [user(
				"real-rescue-future",
				"AdversarialProbeRealRescueFuture",
				2,
			)], extractionOptions(context, { jobId: `job_future_${crypto.randomUUID()}` }));
			const rescuedEntry = (await extractEntries(state))
				.map(([, entry]) => entry)
				.find((entry) => entry.messages[0]?.id === messageId);
			expect(rescuedEntry).toMatchObject({ rescuedFromNoWrite: true });
			expect(contextTrace(rescuedEntry)).toEqual(originalTrace);

			let rescueCalls = 0;
			const second = await instance.drain({
				userId,
				maxJobs: 1,
				ignoreBackoff: true,
				inlineOverrides: {
					llmResponse: ({ packet }) => {
						rescueCalls++;
						return proposalFor(packet);
					},
				},
			});
			return { originalTrace, rescueCalls, result: second.results[0] };
		});

		expect(observed.rescueCalls).toBe(1);
		expect(observed.result?.outcome).not.toBe("recovered_terminal");
		expect(contextTrace(observed.result?.receipt)).toEqual(observed.originalTrace);
		await stub.resetAll();
	}, 30_000);

	it("retains the same content-free trace through settlement-only retry", async () => {
		const userId = `stage5-trace-settlement-${crypto.randomUUID()}`;
		const stub = stubFor(userId);
		const jobId = `job_${crypto.randomUUID()}`;
		const messageId = "trace-settlement-target";
		await createMemoryJob(env, userId, {
			id: jobId,
			type: "extract",
			status: "queued",
			idempotencyKey: `stage5-trace-${crypto.randomUUID()}`,
			payload: { message_ids: [messageId], remaining: [messageId] },
		});

		const observed = await runInDurableObject(stub, async (instance, state) => {
			await instance.addMessages(userId, [
				assistant("trace-settlement-context", "The accepted trace belongs to the amber context."),
				user(messageId, "AdversarialProbeTraceSettlement", 1),
			], extractionOptions({
				conversationId: "trace-settlement-conversation",
				agentId: "trace-settlement-agent",
			}, { jobId }));
			const accepted = (await extractEntries(state))[0]?.[1];
			const acceptedTrace = clone(contextTrace(accepted));

			let modelCalls = 0;
			const interrupted = await instance.drain({
				userId,
				maxJobs: 1,
				ignoreBackoff: true,
				inlineOverrides: {
					llmResponse: ({ packet }) => {
						modelCalls++;
						return proposalFor(packet);
					},
					_testBeforeJobSettlement: () => {
						throw new Error("intentional Stage 5 settlement interruption");
					},
				},
			});
			expect(interrupted.results[0]).toMatchObject({ outcome: "settlement_pending", retry: true });
			const pending = (await extractEntries(state))[0]?.[1];
			expect(contextTrace(pending)).toEqual(acceptedTrace);

			const settled = await instance.drain({
				userId,
				maxJobs: 1,
				ignoreBackoff: true,
				inlineOverrides: {
					llmResponse: () => {
						throw new Error("settlement retry must not invoke the model");
					},
				},
			});
			return { acceptedTrace, settled: settled.results[0], modelCalls };
		});

		expect(observed.modelCalls).toBe(1);
		expect(contextTrace(observed.settled?.receipt)).toEqual(observed.acceptedTrace);
		expect(JSON.stringify(observed.acceptedTrace)).not.toContain("amber context");
		await stub.resetAll();
	}, 30_000);
});
