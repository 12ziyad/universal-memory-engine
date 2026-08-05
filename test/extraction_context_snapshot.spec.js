/**
 * Stage 5 — extraction context is an immutable property of queued work.
 *
 * One account intentionally maps to one UserMemory Durable Object. That makes
 * the object the right coordination atom, but not the right context boundary:
 * project, agent, and conversation identity still have to follow each job.
 * These tests inspect the packet handed to the deterministic model hook. They
 * never invoke Workers AI and never assert against raw production data.
 */

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const MAX_CONTEXT_BYTES = 16 * 1024;
const MAX_QUEUE_ENTRY_BYTES = 96 * 1024;
// Keep held-message tests inside the idle window. A fixed timestamp from even
// earlier today can accidentally turn a `flush: false` assertion into an idle
// fire when the suite is run hours later.
const T0 = Date.now();

function stubFor(userId) {
	return env.USER_MEMORY.get(env.USER_MEMORY.idFromName(userId));
}

function identity({ projectId = "shared-project", conversationId, agentId }) {
	return {
		projectId,
		conversationId,
		agentId,
		scopeKey: `project:${projectId}`,
	};
}

function extractionOptions(context, { flush = true } = {}) {
	const scope = {
		workspace_id: "stage5-workspace",
		app_id: "claude-code",
		agent_id: context.agentId,
		conversation_id: context.conversationId,
		session_id: context.conversationId,
		source_scope: "claude-plugin",
		project_id: context.projectId,
		project_name: `Project ${context.projectId}`,
	};
	return {
		flush,
		scopeKey: context.scopeKey,
		overrides: {
			source: "plugin",
			profile: "plugin",
			lightPath: true,
			edgeResponse: { edges: [] },
			reflexionResponse: { entities: [], facts: [], edges: [], notes: "" },
			meta: {
				project_id: context.projectId,
				project_name: `Project ${context.projectId}`,
				source_mode: "plugin_auto",
				scope_json: JSON.stringify(scope),
			},
		},
	};
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

function clonePacket(packet) {
	return JSON.parse(JSON.stringify(packet));
}

function probeResponse(packet) {
	const content = String(packet.new_slice?.[0]?.content ?? "");
	const label = content.match(/\bContextProbe[A-Za-z0-9_-]+\b/)?.[0] ?? "ContextProbeFallback";
	return {
		objects: [
			{ kind: "node", label, category: "project", matches_existing: null, confidence: 0.98 },
			{ kind: "slice", on: label, text: content, kind_detail: "decision", confidence: 0.97 },
		],
		notes: "stage5 deterministic context probe",
	};
}

async function drainAndCapture(instance, userId, maxJobs = 10) {
	const packets = [];
	const drained = await instance.drain({
		userId,
		maxJobs,
		ignoreBackoff: true,
		inlineOverrides: {
			llmResponse: ({ packet }) => {
				packets.push(clonePacket(packet));
				return probeResponse(packet);
			},
		},
	});
	return { drained, packets };
}

function contextIds(packet, field) {
	return (packet?.[field] ?? []).map((message) => message.id);
}

function jsonBytes(value) {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

async function extractEntries(state) {
	return [...(await state.storage.list({ prefix: "q:" })).entries()]
		.filter(([, entry]) => entry.kind === "extract");
}

describe("Stage 5 extraction-context snapshots", () => {
	it("uses a hard held-chunk boundary for two conversations in one project", async () => {
		const userId = `stage5-conversation-boundary-${crypto.randomUUID()}`;
		const stub = stubFor(userId);
		const conversationA = identity({ conversationId: "conversation-a", agentId: "agent-shared" });
		const conversationB = identity({ conversationId: "conversation-b", agentId: "agent-shared" });

		await runInDurableObject(stub, async (instance, state) => {
			await instance.addMessages(
				userId,
				[user("conversation-a-message", "ContextProbeConversationA")],
				extractionOptions(conversationA, { flush: false }),
			);
			await instance.addMessages(
				userId,
				[user("conversation-b-message", "ContextProbeConversationB", 1_000)],
				extractionOptions(conversationB, { flush: false }),
			);

			const queued = await extractEntries(state);
			expect(queued).toHaveLength(1);
			expect(queued[0][1].messages.map((message) => message.id)).toEqual(["conversation-a-message"]);
			expect((await state.storage.get("chunk")).map((message) => message.id)).toEqual([
				"conversation-b-message",
			]);
		});

		await stub.resetAll();
	}, 30_000);

	it("keeps two simultaneously accepted agents' model packets mutually isolated", async () => {
		const userId = `stage5-two-agents-${crypto.randomUUID()}`;
		const stub = stubFor(userId);
		const agentA = identity({ conversationId: "agent-a-conversation", agentId: "agent-a" });
		const agentB = identity({ conversationId: "agent-b-conversation", agentId: "agent-b" });

		const packets = await runInDurableObject(stub, async (instance, state) => {
			await Promise.all([
				instance.addMessages(userId, [
					assistant("agent-a-assistant-context", "Only agent A observed the amber compiler decision."),
					user("agent-a-target", "ContextProbeAgentA", 1_000),
				], extractionOptions(agentA)),
				instance.addMessages(userId, [
					assistant("agent-b-assistant-context", "Only agent B observed the blue renderer decision.", 2_000),
					user("agent-b-target", "ContextProbeAgentB", 3_000),
				], extractionOptions(agentB)),
			]);

			expect(await extractEntries(state)).toHaveLength(2);
			return (await drainAndCapture(instance, userId, 2)).packets;
		});

		const byTarget = new Map(packets.map((packet) => [packet.new_slice[0].id, packet]));
		expect(contextIds(byTarget.get("agent-a-target"), "assistant_context")).toEqual([
			"agent-a-assistant-context",
		]);
		expect(contextIds(byTarget.get("agent-b-target"), "assistant_context")).toEqual([
			"agent-b-assistant-context",
		]);

		await stub.resetAll();
	}, 30_000);

	it("does not let B's later recent update change A after A was accepted", async () => {
		const userId = `stage5-accepted-then-updated-${crypto.randomUUID()}`;
		const stub = stubFor(userId);
		const agentA = identity({ conversationId: "accepted-a", agentId: "agent-a" });
		const agentB = identity({ conversationId: "later-b", agentId: "agent-b" });

		const packet = await runInDurableObject(stub, async (instance) => {
			await instance.addMessages(userId, [
				assistant("accepted-a-context", "A's private context existed when its job was accepted."),
				user("accepted-a-target", "ContextProbeAcceptedA", 1_000),
			], extractionOptions(agentA));
			// No B extraction is needed: merely accepting newer context used to
			// mutate the project-wide `recent` value read by A at drain time.
			await instance.addMessages(userId, [
				assistant("later-b-context", "B arrived after A and must not enter A's packet.", 2_000),
			], extractionOptions(agentB, { flush: false }));
			return (await drainAndCapture(instance, userId, 1)).packets[0];
		});

		expect(contextIds(packet, "assistant_context")).toEqual(["accepted-a-context"]);
		expect(JSON.stringify(packet)).not.toContain("later-b-context");

		await stub.resetAll();
	}, 30_000);

	it("keeps projects isolated while retaining one account-level coordinator", async () => {
		const userId = `stage5-projects-${crypto.randomUUID()}`;
		const stub = stubFor(userId);
		const projectA = identity({ projectId: "project-a", conversationId: "project-a-conversation", agentId: "agent" });
		const projectB = identity({ projectId: "project-b", conversationId: "project-b-conversation", agentId: "agent" });

		const packet = await runInDurableObject(stub, async (instance) => {
			await instance.addMessages(userId, [
				assistant("project-a-context", "Project A uses the amber deployment plan."),
				user("project-a-target", "ContextProbeProjectA", 1_000),
			], extractionOptions(projectA));
			await instance.addMessages(userId, [
				assistant("project-b-context", "Project B uses the blue deployment plan.", 2_000),
			], extractionOptions(projectB, { flush: false }));
			return (await drainAndCapture(instance, userId, 1)).packets[0];
		});

		expect(contextIds(packet, "assistant_context")).toEqual(["project-a-context"]);
		expect(JSON.stringify(packet)).not.toContain("project-b-context");

		await stub.resetAll();
	}, 30_000);

	it("retries with the exact original snapshot after newer same-conversation messages arrive", async () => {
		const userId = `stage5-delayed-retry-${crypto.randomUUID()}`;
		const stub = stubFor(userId);
		const context = identity({ conversationId: "retry-conversation", agentId: "retry-agent" });

		const observed = await runInDurableObject(stub, async (instance) => {
			await instance.addMessages(userId, [
				assistant("retry-original-context", "The original retry context chose the amber queue policy."),
				user("retry-original-target", "ContextProbeRetryOriginal", 1_000),
			], extractionOptions(context));

			let firstPacket = null;
			const failed = await instance.drain({
				userId,
				maxJobs: 1,
				ignoreBackoff: true,
				inlineOverrides: {
					llmResponse: ({ packet }) => {
						firstPacket = clonePacket(packet);
						return "%%% deliberately unparseable stage5 response %%%";
					},
				},
			});
			expect(failed.results[0]).toMatchObject({ outcome: "llm_failed", retry: true, attempts: 1 });

			await instance.addMessages(userId, [
				assistant("retry-newer-context", "This assistant turn arrived only after the failed attempt.", 2_000),
				user("retry-newer-user", "ContextProbeRetryNewer", 3_000),
			], extractionOptions(context, { flush: false }));

			const retried = await drainAndCapture(instance, userId, 1);
			return { firstPacket, retryPacket: retried.packets[0] };
		});

		expect(observed.retryPacket).toEqual(observed.firstPacket);
		expect(JSON.stringify(observed.retryPacket)).not.toContain("retry-newer-context");
		expect(JSON.stringify(observed.retryPacket)).not.toContain("retry-newer-user");

		await stub.resetAll();
	}, 30_000);

	it("survives deletion of mutable recent state because the accepted entry owns its snapshot", async () => {
		const userId = `stage5-deleted-recent-${crypto.randomUUID()}`;
		const stub = stubFor(userId);
		const context = identity({ conversationId: "deleted-recent", agentId: "snapshot-agent" });

		const packet = await runInDurableObject(stub, async (instance, state) => {
			await instance.addMessages(userId, [
				assistant("deleted-recent-context", "This accepted context must survive later recent-state deletion."),
				user("deleted-recent-target", "ContextProbeDeletedRecent", 1_000),
			], extractionOptions(context));

			for (const key of (await state.storage.list({ prefix: "recent" })).keys()) {
				await state.storage.delete(key);
			}
			return (await drainAndCapture(instance, userId, 1)).packets[0];
		});

		expect(contextIds(packet, "assistant_context")).toEqual(["deleted-recent-context"]);

		await stub.resetAll();
	}, 30_000);

	it("bounds the stored snapshot and records content-free context tracing", async () => {
		const userId = `stage5-bounds-${crypto.randomUUID()}`;
		const stub = stubFor(userId);
		const context = identity({ conversationId: "bounded-context", agentId: "bounded-agent" });
		const secretSentinel = "RAW_TRACE_SENTINEL_MUST_NOT_APPEAR";
		const largeContext = Array.from({ length: 12 }, (_, index) => assistant(
			`bounded-assistant-${index}`,
			`${secretSentinel}-${index}-${"x".repeat(5_000)}`,
			index * 100,
		));

		const observed = await runInDurableObject(stub, async (instance, state) => {
			await instance.addMessages(userId, [
				...largeContext,
				user("bounded-target", "ContextProbeBounded", 2_000),
			], extractionOptions(context));

			const queued = await extractEntries(state);
			expect(queued).toHaveLength(1);
			const entry = queued[0][1];
			const trace = entry.contextTrace ?? entry.context_trace;
			const queueEntryBytes = jsonBytes(entry);
			const packet = (await drainAndCapture(instance, userId, 1)).packets[0];
			return { trace, queueEntryBytes, packet };
		});

		const modelContext = {
			bridge_context: observed.packet.bridge_context,
			assistant_context: observed.packet.assistant_context,
		};
		expect(observed.packet.bridge_context).toHaveLength(0);
		expect(observed.packet.assistant_context.length).toBeLessThanOrEqual(5);
		expect(jsonBytes(modelContext)).toBeLessThanOrEqual(MAX_CONTEXT_BYTES);
		expect(observed.queueEntryBytes).toBeLessThanOrEqual(MAX_QUEUE_ENTRY_BYTES);

		expect(observed.trace).toBeTruthy();
		const traceText = JSON.stringify(observed.trace);
		expect(traceText).not.toContain(secretSentinel);
		// One hash identifies the logical context, another the immutable snapshot.
		expect(traceText.match(/\b[a-f0-9]{64}\b/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
	}, 30_000);

	it("keeps an exact handoff replay on one immutable snapshot and one queue entry", async () => {
		const userId = `stage5-exact-replay-${crypto.randomUUID()}`;
		const stub = stubFor(userId);
		const original = identity({ conversationId: "replay-original", agentId: "replay-agent-a" });
		const unrelated = identity({ conversationId: "replay-unrelated", agentId: "replay-agent-b" });
		const messages = [
			assistant("replay-original-context", "The original exact replay context uses the amber scheduler."),
			user("replay-original-target", "ContextProbeExactReplay", 1_000),
		];
		const handoff = {
			...extractionOptions(original),
			handoffId: `stage5-handoff-${crypto.randomUUID()}`,
			requestHash: "a".repeat(64),
		};

		const observed = await runInDurableObject(stub, async (instance, state) => {
			const accepted = await instance.acceptMessagesOnce(userId, messages, handoff);
			const before = await extractEntries(state);
			expect(before).toHaveLength(1);
			const beforeEntry = JSON.parse(JSON.stringify(before[0][1]));

			await instance.addMessages(userId, [
				assistant("replay-unrelated-context", "An unrelated agent arrived after the original acceptance.", 2_000),
			], extractionOptions(unrelated, { flush: false }));
			const replay = await instance.acceptMessagesOnce(userId, messages, handoff);
			const after = await extractEntries(state);
			const packet = (await drainAndCapture(instance, userId, 1)).packets[0];
			return { accepted, replay, beforeEntry, afterEntries: after.map(([, entry]) => entry), packet };
		});

		expect(observed.accepted).toMatchObject({ handoffAccepted: true, handoffDuplicate: false });
		expect(observed.replay).toMatchObject({ handoffAccepted: true, handoffDuplicate: true });
		expect(observed.afterEntries).toHaveLength(1);
		expect(observed.afterEntries[0]).toEqual(observed.beforeEntry);
		expect(contextIds(observed.packet, "assistant_context")).toEqual(["replay-original-context"]);
		expect(JSON.stringify(observed.packet)).not.toContain("replay-unrelated-context");

		await stub.resetAll();
	}, 30_000);
});
