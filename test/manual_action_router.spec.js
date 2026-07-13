import { describe, expect, it, vi } from "vitest";

import {
	buildManualActionModelPayload,
	MANUAL_ACTIONS,
	routeManualAction,
	runManualActionRouter,
	scoreManualActionIntents,
} from "../src/pipeline/manual_action_router.js";

const SAFE_SCOPE = {
	subject: null,
	speakerScope: "user_only",
	includeAssistantFacts: false,
	excludeOtherPeople: true,
	includeContextForReferenceResolution: true,
};

describe("manual MCP action router", () => {
	it("routes one explicit grounded fact to save_memory and builds only existing tool arguments", async () => {
		const result = await routeManualAction({
			request: "Remember that I prefer dark mode.",
			recentContext: "We were discussing interface themes.",
			conversationId: "conversation-1",
			threadId: "thread-1",
			sourceId: "source-1",
			idempotencyKey: "retry-1",
			memoryScope: { workspaceId: "workspace-1" },
		});

		expect(result).toMatchObject({
			chosen_action: "save_memory",
			confidence: 0.99,
			reason_codes: ["explicit_save_request", "direct_content_present"],
			scope: SAFE_SCOPE,
			tool_arguments: {
				content: "I prefer dark mode.",
				recentContext: "We were discussing interface themes.",
				conversationId: "conversation-1",
				threadId: "thread-1",
				sourceId: "source-1",
				idempotencyKey: "retry-1",
				memoryScope: { workspaceId: "workspace-1" },
			},
		});
		expect(Object.keys(result.tool_arguments).sort()).toEqual([
			"content", "conversationId", "idempotencyKey", "memoryScope", "recentContext", "sourceId", "threadId",
		]);
		await expect(routeManualAction({ request: "Could you make a note that Atlas uses D1?" })).resolves.toMatchObject({
			chosen_action: "save_memory",
			tool_arguments: { content: "Atlas uses D1?" },
		});
		const directAbout = await routeManualAction({ request: "Remember that I prefer concise answers about code." });
		expect(directAbout.scope.subject).toBeNull();
	});

	it("routes a scoped chat request to save_conversation with the safe resolved scope", async () => {
		const result = await routeManualAction({
			request: "Save only what this chat says about Ziyad.",
			messages: [
				{ id: "u1", role: "user", content: "Ziyad is building UML.", ts: 10 },
				{ id: "a1", role: "assistant", content: "UML can use D1.", ts: 11 },
			],
			conversationId: "conversation-2",
			memoryScope: { appId: "host-app" },
		});

		expect(result.chosen_action).toBe("save_conversation");
		expect(result.reason_codes).toEqual(expect.arrayContaining([
			"explicit_save_request",
			"conversation_scope",
		]));
		expect(result.scope).toEqual({ ...SAFE_SCOPE, subject: "Ziyad" });
		expect(result.tool_arguments).toEqual({
			messages: [
				{ id: "u1", role: "user", content: "Ziyad is building UML.", ts: 10 },
				{ id: "a1", role: "assistant", content: "UML can use D1.", ts: 11 },
			],
			contentScope: { ...SAFE_SCOPE, subject: "Ziyad" },
			conversationId: "conversation-2",
			memoryScope: { appId: "host-app" },
		});
	});

	it("routes explicit and personal-context queries to recall_memory", async () => {
		const explicit = await routeManualAction({
			request: "What do you remember about my boxing training?",
			conversationId: "conversation-3",
		});
		const profile = await routeManualAction({ request: "What are my current projects?" });

		expect(explicit).toMatchObject({
			chosen_action: "recall_memory",
			reason_codes: ["explicit_recall_request"],
			tool_arguments: {
				query: "What do you remember about my boxing training?",
				conversationId: "conversation-3",
			},
		});
		expect(profile).toMatchObject({
			chosen_action: "recall_memory",
			tool_arguments: { query: "What are my current projects?" },
		});
		await expect(routeManualAction({ request: "What do you remember about me?" })).resolves.toMatchObject({
			chosen_action: "recall_memory",
		});
		await expect(routeManualAction({ request: "Could you remember my boxing history?" })).resolves.toMatchObject({
			chosen_action: "recall_memory",
		});
		await expect(routeManualAction({ request: "Could you remember that I started boxing?" })).resolves.toMatchObject({
			chosen_action: "save_memory",
			tool_arguments: { content: "I started boxing?" },
		});
	});

	it("returns no_action for ordinary requests and explicit memory opt-out", async () => {
		await expect(routeManualAction({ request: "Explain how D1 transactions work." })).resolves.toMatchObject({
			chosen_action: "no_action",
			reason_codes: ["no_memory_intent"],
			tool_arguments: {},
		});
		await expect(routeManualAction({ request: "Don't save this in memory." })).resolves.toMatchObject({
			chosen_action: "no_action",
			reason_codes: ["user_declined_memory_write"],
			tool_arguments: {},
		});
		await expect(routeManualAction({ request: "Save this file to disk." })).resolves.toMatchObject({
			chosen_action: "no_action",
			reason_codes: ["unrelated_save_request"],
		});
		await expect(routeManualAction({ request: "Keep working on the code." })).resolves.toMatchObject({
			chosen_action: "no_action",
			reason_codes: ["unrelated_save_request"],
		});
	});

	it("treats explicit recall opt-out as no_action without weakening positive recall", async () => {
		const vectorIntent = vi.fn();
		const callLlm = vi.fn();
		const declined = await routeManualAction(
			{ request: "Do not recall my memories." },
			{ getVectorIntentScores: vectorIntent, callLlm },
		);

		expect(declined).toMatchObject({
			chosen_action: "no_action",
			confidence: 1,
			reason_codes: ["user_declined_memory_recall"],
			tool_arguments: {},
		});
		expect(vectorIntent).not.toHaveBeenCalled();
		expect(callLlm).not.toHaveBeenCalled();
		await expect(routeManualAction({ request: "Don't search my memory for Atlas." })).resolves.toMatchObject({
			chosen_action: "no_action",
			reason_codes: ["user_declined_memory_recall"],
		});
		await expect(routeManualAction({ request: "Recall my memories about Atlas." })).resolves.toMatchObject({
			chosen_action: "recall_memory",
			reason_codes: ["explicit_recall_request"],
			tool_arguments: { query: "Recall my memories about Atlas." },
		});
	});

	it("clarifies missing content, missing messages, conflicting actions, and unsupported deletion", async () => {
		const referential = await routeManualAction({ request: "Save this." });
		const emptyDetail = await routeManualAction({ request: "Keep this detail for later." });
		const unresolvedSubject = await routeManualAction({ request: "Remember it changed yesterday." });
		const missingMessages = await routeManualAction({ request: "Save this conversation about Atlas." });
		const conflict = await routeManualAction({ request: "Save this fact and recall my memory about Atlas." });
		const deletion = await routeManualAction({ request: "Forget everything about Atlas." });

		expect(referential).toMatchObject({
			chosen_action: "clarify",
			reason_codes: ["explicit_save_request", "missing_direct_content"],
		});
		expect(emptyDetail).toMatchObject({ chosen_action: "clarify", tool_arguments: {} });
		expect(unresolvedSubject).toMatchObject({ chosen_action: "clarify" });
		expect(unresolvedSubject.reason_codes).toContain("missing_direct_content");
		expect(missingMessages).toMatchObject({ chosen_action: "clarify" });
		expect(missingMessages.reason_codes).toContain("missing_conversation_messages");
		expect(conflict).toMatchObject({
			chosen_action: "clarify",
			reason_codes: ["conflicting_memory_actions"],
		});
		expect(deletion).toMatchObject({
			chosen_action: "clarify",
			reason_codes: ["unsupported_memory_action"],
		});
		for (const result of [referential, emptyDetail, unresolvedSubject, missingMessages, conflict, deletion]) {
			expect(result.tool_arguments).toEqual({});
		}
	});

	it("fails closed on conflicting supplied and request-derived conversation subjects", async () => {
		const result = await routeManualAction({
			request: "Save only what this chat says about Ziyad.",
			messages: [{ role: "user", content: "Ziyad uses D1." }],
			contentScope: { subject: "Atlas" },
		});

		expect(result).toMatchObject({ chosen_action: "clarify", tool_arguments: {} });
		expect(result.reason_codes).toContain("subject_scope_conflict");
	});

	it("uses in-memory BM25 for a natural save paraphrase without any I/O", async () => {
		const request = "Stash this preference in memory: I prefer dark mode.";
		const scores = scoreManualActionIntents(request);
		const result = await routeManualAction({ request });

		expect(scores.save_memory).toBeGreaterThan(scores.recall_memory);
		expect(scores.save_memory).toBeGreaterThan(scores.clarify);
		expect(result).toMatchObject({
			chosen_action: "save_memory",
			reason_codes: ["bm25_intent_match"],
			tool_arguments: { content: "I prefer dark mode." },
		});
	});

	it("accepts an optional read-only vector score hook and keeps identity scores separate by action", async () => {
		const vectorIntent = vi.fn(async (payload) => {
			expect(payload).toMatchObject({
				request: "Use memory zqxv for Atlas.",
				message_count: 0,
				actions: MANUAL_ACTIONS,
			});
			return { recall_memory: 0.99, save_memory: 0.1, clarify: 0.1 };
		});
		const result = await routeManualAction(
			{ request: "Use memory zqxv for Atlas." },
			{ getVectorIntentScores: vectorIntent },
		);

		expect(vectorIntent).toHaveBeenCalledOnce();
		expect(result).toMatchObject({ chosen_action: "recall_memory" });
		expect(result.reason_codes).toContain("vector_intent_match");
		expect(result.tool_arguments.query).toBe("Use memory zqxv for Atlas.");
	});

	it("calls the LLM only after deterministic, BM25, and vector policy remain unresolved", async () => {
		const callLlm = vi.fn(async () => ({
			chosen_action: "recall_memory",
			confidence: 0.96,
			reason_codes: ["personal_context_request"],
		}));
		const unresolved = await routeManualAction(
			{ request: "Bring Atlas through my memory." },
			{ callLlm },
		);
		const deterministic = await routeManualAction(
			{ request: "Remember that Atlas uses D1." },
			{ callLlm },
		);

		expect(unresolved).toMatchObject({
			chosen_action: "recall_memory",
			confidence: 0.96,
			reason_codes: ["llm_fallback", "personal_context_request"],
		});
		expect(deterministic.chosen_action).toBe("save_memory");
		expect(callLlm).toHaveBeenCalledOnce();
	});

	it("supports a deterministic LLM response while backend validation rejects missing tool inputs", async () => {
		const result = await routeManualAction(
			{ request: "Bring zqxv through my memory." },
			{
				llmResponse: JSON.stringify({
					chosen_action: "save_conversation",
					confidence: 0.98,
					reason_codes: ["conversation_context"],
				}),
			},
		);

		expect(result).toMatchObject({ chosen_action: "clarify", tool_arguments: {} });
		expect(result.reason_codes).toEqual(expect.arrayContaining([
			"llm_fallback",
			"conversation_context",
			"missing_conversation_messages",
		]));
	});

	it("does not execute a low-confidence LLM tool recommendation", async () => {
		const result = await routeManualAction(
			{ request: "Bring Atlas through my memory." },
			{
				llmResponse: {
					chosen_action: "recall_memory",
					confidence: 0.61,
					reason_codes: ["uncertain"],
				},
			},
		);

		expect(result).toMatchObject({ chosen_action: "clarify", tool_arguments: {} });
		expect(result.reason_codes).toEqual([
			"llm_fallback",
			"llm_low_confidence",
			"uncertain",
		]);
	});

	it("sends the model a bounded payload without source, conversation, or message identifiers", async () => {
		let captured;
		const result = await routeManualAction({
			request: "Bring Atlas through my memory.",
			messages: [{ id: "secret-message-id", role: "user", content: "Atlas uses D1." }],
			conversationId: "secret-conversation-id",
			threadId: "secret-thread-id",
			sourceId: "secret-source-id",
			memoryScope: { externalUserId: "secret-user-id" },
		}, {
			callLlm: async (payload) => {
				captured = payload;
				return { chosen_action: "recall_memory", confidence: 0.97, reason_codes: [] };
			},
		});
		const serialized = JSON.stringify(captured);

		expect(result.chosen_action).toBe("recall_memory");
		expect(serialized).toContain("Atlas uses D1.");
		expect(serialized).not.toMatch(/secret-(?:message|conversation|thread|source|user)-id/);
		expect(Object.keys(captured)).toEqual([
			"request",
			"message_shape",
			"message_excerpts",
			"recent_context_present",
			"requested_subject",
			"bm25_scores",
			"vector_scores",
			"available_actions",
		]);
	});

	it("bounds model excerpts and exposes no caller metadata in the direct payload helper", () => {
		const payload = buildManualActionModelPayload({
			request: "x".repeat(2_000),
			messages: Array.from({ length: 20 }, (_, index) => ({
				id: `message-${index}`,
				role: index % 2 ? "assistant" : "user",
				content: `${index}-${"y".repeat(600)}`,
			})),
			conversationId: "conversation-secret",
			memoryScope: { workspaceId: "workspace-secret" },
		});
		const serialized = JSON.stringify(payload);

		expect(payload.request).toHaveLength(1200);
		expect(payload.message_excerpts).toHaveLength(8);
		expect(payload.message_excerpts.every((message) => message.content.length <= 360)).toBe(true);
		expect(serialized).not.toMatch(/message-\d+|conversation-secret|workspace-secret/);
	});

	it("uses the existing Workers AI binding pattern without requiring it", async () => {
		const run = vi.fn(async () => ({
			response: JSON.stringify({
				chosen_action: "recall_memory",
				confidence: 0.95,
				reason_codes: ["model_router"],
			}),
		}));
		const result = await runManualActionRouter(
			{ AI: { run } },
			{
				llm: {
					summaryModel: "test-summary-model",
					summaryMaxTokens: 256,
					gatewayId: "gateway-1",
				},
			},
			{ request: "Apply my memory when answering Atlas." },
		);

		expect(result).toMatchObject({
			chosen_action: "recall_memory",
			reason_codes: ["llm_fallback", "model_router"],
		});
		expect(run).toHaveBeenCalledOnce();
		expect(run).toHaveBeenCalledWith(
			"test-summary-model",
			expect.objectContaining({
				messages: expect.any(Array),
				temperature: 0,
				max_tokens: 256,
			}),
			{ gateway: { id: "gateway-1" } },
		);
	});

	it("never invokes external routing hooks for a deterministic no-action request", async () => {
		const vectorIntent = vi.fn();
		const callLlm = vi.fn();
		const result = await routeManualAction(
			{ request: "Thanks!" },
			{ getVectorIntentScores: vectorIntent, callLlm },
		);

		expect(result).toMatchObject({ chosen_action: "no_action" });
		expect(vectorIntent).not.toHaveBeenCalled();
		expect(callLlm).not.toHaveBeenCalled();
	});
});
