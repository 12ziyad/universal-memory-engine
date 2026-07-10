/**
 * The MCP server — the door supported MCP clients and custom agents connect through.
 *
 * Three manual tools:
 *   - save_memory       → isolated manual direct engine
 *   - save_conversation → isolated manual conversation engine
 *   - recall_memory     → existing recall engine
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
import { runRecallCommand } from "../pipeline/commands.js";
import { runMcpConversationCollectCommand, runMcpDirectSaveCommand } from "../pipeline/manual_mcp.js";

const SAVE_MEMORY_DESC =
	"Manually save one durable fact from the user's submitted words — for example a life or health event, project update, decision, goal, preference, or skill. Do not use for jokes, thanks, casual chat, questions, translations, or calculations. Returns a final receipt after manual extraction and the atomic memory write complete.";

const SAVE_CONVERSATION_DESC =
	"Manually save a submitted conversation. Send recent messages in order and mark each role 'user' or 'assistant'; durable user facts are digested into one memory page and the memory graph. Assistant messages are context only. Safe to re-send overlapping messages. Returns a final combined page-and-graph receipt after writes complete; use scope to limit what is saved.";

const RECALL_MEMORY_DESC =
	"Call when the user asks what you know about them, or when answering needs their personal context (their projects, health, skills, goals, family, preferences). Returns a compact block of what is already known.";

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
	content: z.string().trim().min(1),
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
	const server = new McpServer({ name: "uml-memory", version: "0.4.0" });

	server.tool(
		"save_memory",
		SAVE_MEMORY_DESC,
		{
			content: z.string().trim().min(1).describe("The durable fact, in the user's words. e.g. 'I started boxing'."),
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
			const res = await runMcpDirectSaveCommand(env, ctx, userId, {
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
		"save_conversation",
		SAVE_CONVERSATION_DESC,
		{
			messages: z
				.array(messageSchema)
				.min(1)
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
			const res = await runMcpConversationCollectCommand(env, ctx, userId, {
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
