/**
 * The MCP server — the door supported MCP clients and custom agents connect through.
 *
 * Four tools, each routed through the EXISTING engine (no duplicated logic):
 *   - save_memory       → ingest path (single durable statement)
 *   - observe_messages  → ingest path (auto-observed chat messages)
 *   - save_conversation → ingest path (a de-duplicated batch of chat messages)
 *   - recall_memory     → recall path (compact personal context)
 *
 * Identity rides in the connector URL: /mcp/<token>, token = base64url("userId:key").
 * Both Claude and ChatGPT support no-auth (URL-only) remote MCP connectors, and
 * Claude rejects static bearer headers and ?query= tokens — so a per-user secret
 * in the path is the portable choice. The embedded key is the same global API_KEY
 * the HTTP routes use, so the MCP door is exactly as trusted as /v1/*.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { MEMORY_READ_SCOPE, MEMORY_WRITE_SCOPE, tokenAllowsScope } from "../lib/scopes.js";
import {
	runConversationCollectCommand,
	runDirectSaveCommand,
	runObserveMessagesCommand,
	runRecallCommand,
} from "../pipeline/commands.js";

const SAVE_MEMORY_DESC =
	"Call when the user shares something durable to remember long-term — starting/stopping/finishing/launching something, a health update, a family or life event, a project update, a decision, a goal, a preference, or a skill. Examples: 'I started boxing', 'my grandmother died', \"I'm building an app called Kaka\", 'I decided to use Supabase'. Do NOT call for jokes, thanks, casual chat, questions, translations, or calculations. Returns immediately with a receipt; the memory is processed in the background.";

const SAVE_CONVERSATION_DESC =
	"Call when the conversation is wrapping up or going idle, periodically during a long chat, or when the user says 'save this chat / remember this'. Send the recent messages (mark each role 'user' or 'assistant'); they are digested into clean facts before saving, so a messy chat still captures correctly. Safe to re-send overlapping messages — already-saved ones are skipped. Use scope to limit what is saved.";

const RECALL_MEMORY_DESC =
	"Call when the user asks what you know about them, or when answering needs their personal context (their projects, health, skills, goals, family, preferences). Returns a compact block of what is already known.";

const OBSERVE_MESSAGES_DESC =
	"Call when an MCP-capable client wants UML to observe recent user/assistant messages for automatic memory capture. This is the auto-observe door: it may hold, ignore, or asynchronously process the messages through the shared engine. Do not call for a single trivial greeting when no memory capture is desired.";

/** base64url helpers (no '+', '/', or '=' so the token is URL-path-safe). */
export function encodeMcpToken(userId, key) {
	return btoa(`${userId}:${key}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeMcpToken(token) {
	try {
		const b64 = String(token).replace(/-/g, "+").replace(/_/g, "/");
		const raw = atob(b64);
		const i = raw.indexOf(":");
		if (i === -1) return null;
		const userId = raw.slice(0, i);
		const key = raw.slice(i + 1);
		if (!userId || !key) return null;
		return { userId, key };
	} catch {
		return null;
	}
}

const looseScope = z.object({}).passthrough().optional();
const messageSchema = z.object({
	id: z.string().optional(),
	role: z.enum(["user", "assistant"]).optional().describe("Defaults to 'user'."),
	content: z.string(),
	ts: z.number().optional(),
});

function mcpResult(payload) {
	const summary = payload.command_mode === "recall"
		? (payload.summary || (payload.count ? "Found relevant memory." : "No relevant memory found."))
		: (payload.summary || "Done.");
	return {
		structuredContent: payload,
		content: [{ type: "text", text: summary }],
	};
}

function mcpForbidden(mode, source, requiredScope) {
	return mcpResult({
		ok: false,
		command_mode: mode,
		mode,
		source,
		fired: false,
		processing: false,
		summary: "Forbidden: token lacks required scope.",
		error: "forbidden",
		code: "insufficient_scope",
		required_scope: requiredScope,
		source_packet_id: null,
		receipt_id: null,
		receipt: null,
		counts: { savedTotal: 0 },
	});
}

function ensureScope(authz, mode, source, requiredScope) {
	if (!authz?.scopes || tokenAllowsScope(authz.scopes, requiredScope)) return null;
	return mcpForbidden(mode, source, requiredScope);
}

/**
 * Build a fresh McpServer for this request, closing over env + the authenticated
 * userId. A new instance per request is required by the MCP SDK (a server cannot
 * be reconnected to a new transport).
 */
export function buildMemoryServer(env, ctx, userId, authz = {}) {
	const server = new McpServer({ name: "uml-memory", version: "0.3.0" });

	server.tool(
		"save_memory",
		SAVE_MEMORY_DESC,
		{
			content: z.string().describe("The durable fact, in the user's words. e.g. 'I started boxing'."),
			recentContext: z
				.string()
				.optional()
				.describe("Optional surrounding conversation to resolve references like 'it' or 'that'. Not itself memorized."),
			conversationId: z.string().optional().describe("Optional stable conversation id for source tracking."),
			threadId: z.string().optional().describe("Optional host/client thread id for source tracking."),
			sourceId: z.string().optional().describe("Optional caller source id for idempotency/source tracking."),
			idempotencyKey: z.string().optional().describe("Optional idempotency key for safe retries."),
			memoryScope: looseScope.describe("Optional memory scope metadata such as appId, workspaceId, agentId, or externalUserId."),
		},
		async ({ content, recentContext, conversationId, threadId, sourceId, idempotencyKey, memoryScope }) => {
			const forbidden = ensureScope(authz, "direct_save", "save_memory", MEMORY_WRITE_SCOPE);
			if (forbidden) return forbidden;
			const res = await runDirectSaveCommand(env, ctx, userId, {
				content,
				recentContext,
				conversationId,
				threadId,
				sourceId,
				idempotencyKey,
				memoryScope,
			});
			return mcpResult(res);
		},
	);

	server.tool(
		"observe_messages",
		OBSERVE_MESSAGES_DESC,
		{
			messages: z
				.array(messageSchema)
				.describe("Recent chat messages, oldest first. User messages may become memory; assistant messages are context."),
			flush: z.boolean().optional().describe("Force trigger evaluation now. Defaults to false."),
			conversationId: z.string().optional().describe("Stable conversation id for de-duplication/source tracking."),
			threadId: z.string().optional().describe("Host/client thread id for source tracking."),
			sourceId: z.string().optional().describe("Optional caller source id for idempotency/source tracking."),
			idempotencyKey: z.string().optional().describe("Optional idempotency key for safe retries."),
			memoryScope: looseScope.describe("Optional memory scope metadata such as appId, workspaceId, agentId, or externalUserId."),
		},
		async ({ messages, flush, conversationId, threadId, sourceId, idempotencyKey, memoryScope }) => {
			const forbidden = ensureScope(authz, "observe_messages", "observe_messages", MEMORY_WRITE_SCOPE);
			if (forbidden) return forbidden;
			const res = await runObserveMessagesCommand(env, ctx, userId, messages ?? [], {
				flush: Boolean(flush),
				conversationId,
				threadId,
				sourceId,
				idempotencyKey,
				memoryScope,
				source: "observe_messages",
				sourceMode: "auto_observe",
			});
			return mcpResult(res);
		},
	);

	server.tool(
		"save_conversation",
		SAVE_CONVERSATION_DESC,
		{
			messages: z
				.array(messageSchema)
				.describe("Recent chat messages, oldest first. Include assistant turns for context; only user facts are saved."),
			conversationId: z.string().optional().describe("Stable id for this chat, used to de-duplicate re-sends."),
			threadId: z.string().optional().describe("Optional host/client thread id for source tracking."),
			sourceId: z.string().optional().describe("Optional caller source id for idempotency/source tracking."),
			idempotencyKey: z.string().optional().describe("Optional idempotency key for safe retries."),
			scope: z
				.enum(["full", "lastN", "topic", "summary"])
				.optional()
				.describe("full (default), lastN (last n), topic (filter by `topic`), or summary (payload is already condensed)."),
			n: z.number().optional().describe("With scope=lastN: how many of the most recent messages to digest."),
			topic: z.string().optional().describe("With scope=topic: keep only messages mentioning this."),
			memoryScope: looseScope.describe("Optional memory scope metadata such as appId, workspaceId, agentId, or externalUserId."),
		},
		async ({ messages, conversationId, threadId, sourceId, idempotencyKey, scope, n, topic, memoryScope }) => {
			const forbidden = ensureScope(authz, "conversation_collect", "save_conversation", MEMORY_WRITE_SCOPE);
			if (forbidden) return forbidden;
			const res = await runConversationCollectCommand(env, ctx, userId, {
				messages: messages ?? [],
				conversationId,
				threadId,
				sourceId,
				idempotencyKey,
				scope,
				n,
				topic,
				memoryScope,
			});
			return mcpResult(res);
		},
	);

	server.tool(
		"recall_memory",
		RECALL_MEMORY_DESC,
		{
			query: z.string().describe("What to look up about the user, e.g. 'boxing' or 'what are my projects'."),
			conversationId: z.string().optional().describe("Optional stable conversation id for source tracking."),
			threadId: z.string().optional().describe("Optional host/client thread id for source tracking."),
			sourceId: z.string().optional().describe("Optional caller source id for source tracking."),
			idempotencyKey: z.string().optional().describe("Optional idempotency key for safe retries."),
			topic: z.string().optional().describe("Optional topic hint for source tracking."),
			memoryScope: looseScope.describe("Optional memory scope metadata such as appId, workspaceId, agentId, or externalUserId."),
		},
		async ({ query, conversationId, threadId, sourceId, idempotencyKey, topic, memoryScope }) => {
			const forbidden = ensureScope(authz, "recall", "recall", MEMORY_READ_SCOPE);
			if (forbidden) return forbidden;
			const res = await runRecallCommand(env, userId, query, {
				conversationId,
				threadId,
				sourceId,
				idempotencyKey,
				topic,
				memoryScope,
			});
			return mcpResult(res);
		},
	);

	return server;
}
