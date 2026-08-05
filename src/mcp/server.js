/**
 * The MCP server — the door supported MCP clients and custom agents connect through.
 *
 * Three manual tools:
 *   - save_memory       → isolated manual direct engine
 *   - save_conversation → isolated manual conversation engine
 *   - recall_memory     → existing recall engine
 *
 * Preferred identity is a connection token in `Authorization: Bearer` at
 * `/mcp`. Generated `/mcp/<token>` links remain for headerless clients and
 * legacy base64url path tokens remain compatible with existing connectors.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { MEMORY_READ_SCOPE, MEMORY_WRITE_SCOPE, tokenAllowsScope } from "../lib/scopes.js";
import { normalizeProjectScope, ProjectScopeError } from "../lib/project_scope.js";
import { runDirectSaveCommand, runRecallCommand } from "../pipeline/commands.js";
import { stageMcpConversation } from "../pipeline/mcp_engine.js";
import { tokens } from "../lib/text.js";

/**
 * Compatibility filters for the old tool schema. lastN and topic narrowing
 * were promises of the previous door; both are cheap and deterministic, so
 * they are honored at the door before staging.
 */
function applyScopeFilters(messages, { scope, n, topic }) {
	let out = messages ?? [];
	if (scope === "lastN" && Number(n) > 0) out = out.slice(-Number(n));
	const topicText = scope === "topic" || topic ? String(topic ?? "").trim() : "";
	if (topicText) {
		const wanted = tokens(topicText).filter((t) => t.length > 2);
		if (wanted.length) {
			out = out.filter((m) =>
				(m?.role ?? "user") !== "user" ||
				wanted.some((t) => String(m?.content ?? "").toLowerCase().includes(t)));
		}
	}
	return out;
}

const SAVE_MEMORY_DESC =
	"Save a single durable fact about the user. Call this whenever the user states a preference, decision, personal detail, relationship, date, or anything worth remembering in future conversations — including when they say \"remember that…\". Send one clear fact per call, in the user's own words.";

const SAVE_CONVERSATION_DESC =
	"Save the important parts of the current conversation to long-term memory. Call this when the discussion has produced durable new information — decisions, plans, facts, preferences — that should persist. Send the relevant turns verbatim; do not pre-summarize. The memory service will extract the facts and relationships itself.";

const RECALL_MEMORY_DESC =
	"Search the user's saved memories. Call this at the START of a conversation, and whenever the user references anything personal, past, or context-dependent.";

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

// MCP callers may attribute content to a project/application, but tenant
// ownership is always derived from the authenticated connection. Keeping this
// strict prevents forged owner/memory/external-user ids from entering source
// provenance, webhook routing, or legacy-project inventory.
const publicMemoryScopeSchema = z.object({
	projectId: z.string().describe("Stable opaque project id. Required for project_only and project_then_global recall.").optional(),
	projectName: z.string().describe("Optional human-readable project name; display metadata only.").optional(),
	workspaceId: z.string().describe("Optional caller workspace attribution.").optional(),
	appId: z.string().describe("Optional application attribution.").optional(),
	agentId: z.string().describe("Optional agent attribution.").optional(),
	sessionId: z.string().describe("Optional host session attribution.").optional(),
	threadId: z.string().describe("Optional host thread attribution.").optional(),
	topic: z.string().describe("Optional topic attribution.").optional(),
	sourceScope: z.string().describe("Optional caller-defined source grouping.").optional(),
}).strict().optional();
const messageSchema = z.object({
	id: z.string().optional(),
	role: z.enum(["user", "assistant"]).optional().describe("Defaults to 'user'."),
	content: z.string().trim().min(1),
	ts: z.number().optional(),
});
const contentScopeSchema = z.object({
	subject: z.string().trim().min(1).optional().describe("Optional strict primary subject, for example 'Ziyad'."),
	speakerScope: z.literal("user_only").optional().describe("Only user_only is supported in this patch."),
	includeAssistantFacts: z.boolean().optional().describe("Assistant facts stay excluded unless a later user explicitly adopts a specific proposal."),
	excludeOtherPeople: z.boolean().optional().describe("Unrelated people are excluded; grounded relationship targets may remain supporting entities."),
	includeContextForReferenceResolution: z.boolean().optional().describe("Assistant turns may resolve references but are not themselves memorized."),
}).optional();

function mcpResult(payload) {
	// Recall must return the memory ITSELF in the content block. The recalled
	// text lives in payload.context; most MCP clients surface only `content` to
	// the model, so returning just a summary ("Found relevant memory.") handed
	// the caller a receipt with nothing to read — recall looked broken even when
	// the lookup succeeded. structuredContent still carries the full payload.
	if (payload?.ok === false) {
		return {
			isError: true,
			structuredContent: payload,
			content: [{ type: "text", text: payload.summary || "The memory request was rejected." }],
		};
	}
	if (payload.command_mode === "recall") {
		const context = String(payload.context ?? "").trim();
		const text = context
			? `Relevant memory for this user:\n\n${context}`
			: (payload.summary || "No relevant memory found.");
		return {
			structuredContent: payload,
			content: [{ type: "text", text }],
		};
	}
	return {
		structuredContent: payload,
		content: [{ type: "text", text: payload.summary || "Done." }],
	};
}

function invalidProjectScope(memoryScope, mode, source) {
	try {
		normalizeProjectScope(memoryScope);
		return null;
	} catch (error) {
		if (!(error instanceof ProjectScopeError) && error?.name !== "ProjectScopeError") throw error;
		return mcpResult({
			ok: false,
			command_mode: mode,
			mode,
			source,
			fired: false,
			processing: false,
			error: error.code ?? "invalid_project_id",
			code: error.code ?? "invalid_project_id",
			http_status: Number(error.status ?? 400),
			summary: String(error.message ?? "Invalid project scope."),
			source_packet_id: null,
			receipt_id: null,
			receipt: null,
			counts: { savedTotal: 0 },
		});
	}
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
	const server = new McpServer(
		{ name: "itsuki-memory", version: "0.6.0" },
		{
			instructions: "Itsuki gives this user persistent memory across conversations. Call recall_memory at the start of a conversation to load what is already known. Call save_memory the moment the user states one durable fact, and save_conversation when a discussion has produced lasting decisions, plans, or facts — send the relevant turns verbatim, oldest first; do not pre-summarize. Saves are staged instantly and finish processing in the background: report exactly what the receipt says, and never claim something was saved without a receipt. Assistant claims are context unless the user explicitly adopts one.",
		},
	);

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
			memoryScope: publicMemoryScopeSchema,
		},
		async ({ content, recentContext, conversationId, threadId, sourceId, idempotencyKey, memoryScope }) => {
			const forbidden = ensureScope(authz, "direct_save", "save_memory", MEMORY_WRITE_SCOPE);
			if (forbidden) return forbidden;
			const invalidScope = invalidProjectScope(memoryScope, "direct_save", "save_memory");
			if (invalidScope) return invalidScope;
			// The same Engine v2 lane every other door uses — with the MCP lens
			// (stricter gate floor) and the light path: a single atomic fact
			// skips the edge and reflexion passes it has nothing to feed.
			const res = await runDirectSaveCommand(env, ctx, userId, {
				content,
				recentContext,
				conversationId,
				threadId,
				sourceId,
				idempotencyKey,
				memoryScope,
				overrides: { profile: "mcp", lightPath: true },
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
			contentScope: contentScopeSchema.describe("Optional strict content selection, separate from tenancy metadata."),
			memoryScope: publicMemoryScopeSchema,
		},
		async ({ messages, conversationId, threadId, sourceId, idempotencyKey, scope, n, topic, contentScope, memoryScope }) => {
			const forbidden = ensureScope(authz, "conversation_collect", "save_conversation", MEMORY_WRITE_SCOPE);
			if (forbidden) return forbidden;
			const invalidScope = invalidProjectScope(memoryScope, "conversation_collect", "save_conversation");
			if (invalidScope) return invalidScope;
			// Receipt-first: stage deterministically (no model calls), answer in
			// under a second, and let the user's Durable Object run the full
			// Engine v2 extraction in the background. contentScope is accepted
			// for schema compatibility; subject narrowing now happens inside the
			// shared engine's gates rather than a second extraction lane.
			void contentScope;
			const res = await stageMcpConversation(env, ctx, userId, {
				messages: applyScopeFilters(messages ?? [], { scope, n, topic }),
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
		"recall_memory",
		RECALL_MEMORY_DESC,
		{
			query: z.string().describe("What to look up about the user, e.g. 'boxing' or 'what are my projects'."),
			conversationId: z.string().optional().describe("Optional stable conversation id for source tracking."),
			threadId: z.string().optional().describe("Optional host/client thread id for source tracking."),
			sourceId: z.string().optional().describe("Optional caller source id for source tracking."),
			idempotencyKey: z.string().optional().describe("Optional idempotency key for safe retries."),
			topic: z.string().optional().describe("Optional topic hint for source tracking."),
			recallScope: z
				.enum(["global", "project_only", "project_then_global"])
				.optional()
				.describe("Optional recall coverage: global, project_only, or project_then_global. Project modes require memoryScope.projectId."),
			memoryScope: publicMemoryScopeSchema,
		},
		async ({ query, conversationId, threadId, sourceId, idempotencyKey, topic, recallScope, memoryScope }) => {
			const forbidden = ensureScope(authz, "recall", "recall", MEMORY_READ_SCOPE);
			if (forbidden) return forbidden;
			const invalidScope = invalidProjectScope(memoryScope, "recall", "recall");
			if (invalidScope) return invalidScope;
			const res = await runRecallCommand(env, userId, query, {
				conversationId,
				threadId,
				sourceId,
				idempotencyKey,
				topic,
				recallScope,
				memoryScope,
			});
			return mcpResult(res);
		},
	);

	return server;
}
