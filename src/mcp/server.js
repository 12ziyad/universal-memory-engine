/**
 * The MCP server — the door supported MCP clients and custom agents connect through.
 *
 * Write/recall tools (the engine lanes):
 *   - save_memory         → isolated manual direct engine
 *   - save_conversation   → isolated manual conversation engine
 *   - recall_memory       → existing recall engine
 *
 * Management tools (read-only inventory + guarded deletion — the half every
 * client needs to inspect and clean up its own memory without a dashboard):
 *   - list_memories       → lib/memory_inventory listMemories
 *   - get_memory          → lib/memory_inventory getMemory
 *   - delete_memory       → pipeline/cleanup deleteObject (+ tombstone)
 *   - delete_all_memories → pipeline/cleanup bulkDeleteBySource (dry-run first)
 *   - whoami              → identity, scopes, project binding, live counts
 *
 * Preferred identity is a connection token in `Authorization: Bearer` at
 * `/mcp`. Generated `/mcp/<token>` links remain for headerless clients and
 * legacy base64url path tokens remain compatible with existing connectors.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { MEMORY_READ_SCOPE, MEMORY_WRITE_SCOPE, tokenAllowsScope } from "../lib/scopes.js";
import { allowRate, managedActorRateKey } from "../lib/rate.js";
import { checkAiBudget } from "../lib/ai_budget.js";
import { normalizeProjectScope, ProjectScopeError } from "../lib/project_scope.js";
import { runDirectSaveCommand, runRecallCommand } from "../pipeline/commands.js";
import { stageMcpConversation } from "../pipeline/mcp_engine.js";
import { getMemory, listMemories, memoryCounts, parseInventoryListOptions } from "../lib/memory_inventory.js";
import {
	applyMemoryChange, listMemoryHistory, safeUpdatesEnabled, versionErrorResponse,
} from "../lib/memory_versions.js";
import { bulkDeleteBySource, deleteObject, storeDeletionTombstone } from "../pipeline/cleanup.js";
import { cleanClientSource } from "../pipeline/source.js";
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

function projectBoundMemoryScope(authz, publicScope) {
	if (!authz?.memoryScope) return publicScope;
	// Public fields remain source/repository attribution inside a managed
	// project. Tenant ownership comes last from the authenticated server scope.
	return {
		...(publicScope ?? {}),
		...authz.memoryScope,
	};
}

/**
 * Build a fresh McpServer for this request, closing over env + the authenticated
 * userId. A new instance per request is required by the MCP SDK (a server cannot
 * be reconnected to a new transport).
 */
export function buildMemoryServer(env, ctx, userId, authz = {}) {
	const server = new McpServer(
		{ name: "itsuki-memory", version: "0.7.0" },
		{
			instructions: "Itsuki gives this user persistent memory across conversations. Call recall_memory at the start of a conversation to load what is already known. Call save_memory the moment the user states one durable fact, and save_conversation when a discussion has produced lasting decisions, plans, or facts — send the relevant turns verbatim, oldest first; do not pre-summarize. Saves are staged instantly and finish processing in the background: report exactly what the receipt says, and never claim something was saved without a receipt. Assistant claims are context unless the user explicitly adopts one. Use list_memories/get_memory to browse what is stored, whoami to check identity and connection health, and delete_memory/delete_all_memories only when the user explicitly asks to remove something — delete_all_memories previews first and destroys nothing without confirm=true.",
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
			const limited = await rateLimited("mcp-save", env.SAVE_LIMITER, "direct_save", "save_memory");
			if (limited) return limited;
			const capped = await aiCapped("direct_save", "save_memory");
			if (capped) return capped;
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
				memoryScope: projectBoundMemoryScope(authz, memoryScope),
				overrides: {
					profile: "mcp",
					lightPath: true,
					...(authz.rules ? { rules: authz.rules } : {}),
				},
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
			const limited = await rateLimited("mcp-save", env.SAVE_LIMITER, "conversation_collect", "save_conversation");
			if (limited) return limited;
			const capped = await aiCapped("conversation_collect", "save_conversation");
			if (capped) return capped;
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
				memoryScope: projectBoundMemoryScope(authz, memoryScope),
				...(authz.rules ? { rules: authz.rules } : {}),
				...(authz.managedPolicy ? {
					managedPolicy: true,
					credentialRules: authz.credentialRules ?? null,
					projectCategories: authz.projectCategories ?? [],
				} : {}),
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
				memoryScope: projectBoundMemoryScope(authz, memoryScope),
			});
			return mcpResult(res);
		},
	);

	// ——— Management tools ———————————————————————————————————————————————
	// Read-only inventory plus guarded deletion. These wrap the same REST
	// surface (GET/DELETE /v1/memories) — nothing here enters the extraction
	// pipeline. Text blocks carry the payload itself, mirroring recall: most
	// clients surface only `content` to the model.

	const managementResult = (payload, text) => ({
		structuredContent: payload,
		content: [{ type: "text", text }],
	});

	// Managed projects grant deletion as its own capability
	// (project.memory.delete). serveProjectBoundMcp resolves it per request;
	// only an explicit false blocks, so owner-lane doors keep full power.
	const deleteForbidden = (mode, source) => (authz.allowDelete === false
		? mcpResult({
			ok: false,
			command_mode: mode,
			mode,
			source,
			fired: false,
			processing: false,
			summary: "Forbidden: your project role does not allow deleting memories.",
			error: "forbidden",
			code: "insufficient_capability",
			required_capability: "project.memory.delete",
			source_packet_id: null,
			receipt_id: null,
			receipt: null,
			counts: { savedTotal: 0 },
		})
		: null);

	// Rate refusals are tool RESULTS, not transport 429s: an HTTP error tears
	// down the MCP connection and the model never sees why. ok:false maps to
	// isError with the summary as readable text — the same shape queue_full
	// already uses on this door. The key comes from the authenticated
	// credential + bound project (never the caller-supplied memoryScope), so
	// rotating userId does not buy a fresh bucket. The legacy operator door
	// passes no rateContext and deliberately shares one "legacy:configured"
	// bucket — one master key IS one actor.
	const rateLimited = async (bucket, binding, mode, source) => {
		if (await allowRate(binding, managedActorRateKey(bucket, authz.rateContext ?? {}))) return null;
		return mcpResult({
			ok: false,
			command_mode: mode,
			mode,
			source,
			fired: false,
			processing: false,
			error: "rate_limited",
			code: "rate_limited",
			http_status: 429,
			retry_after_s: 60,
			summary: "You're sending requests very quickly — wait a few seconds and try again.",
			source_packet_id: null,
			receipt_id: null,
			receipt: null,
			counts: { savedTotal: 0 },
		});
	};

	// The monthly AI-write quota, in the same soft shape as rateLimited: the
	// refusal must be a readable sentence the model can relay, and it must be
	// impossible to mistake for a successful save. Identity is the ACCOUNT
	// behind the credential — the same column the meter attributes — so a
	// rotated memoryScope cannot reset the budget. Fail CLOSED on an unreadable
	// quota, matching the REST doors.
	const aiCapped = async (mode, source) => {
		let refusal;
		try {
			refusal = await checkAiBudget(env, {
				accountUserId: authz.rateContext?.accountUserId
					?? authz.memoryScope?.accountUserId
					?? authz.rateContext?.auth?.userId
					?? null,
				userId,
			});
		} catch (error) {
			console.warn(JSON.stringify({ event: "ai_quota_unavailable", door: "mcp", error: String(error?.message ?? error) }));
			refusal = {
				error: "ai_quota_unavailable",
				retryAfterSeconds: 60,
				message: "Itsuki could not verify the AI quota just now — nothing was saved. Try again shortly.",
			};
		}
		if (!refusal) return null;
		return mcpResult({
			ok: false,
			command_mode: mode,
			mode,
			source,
			fired: false,
			processing: false,
			error: refusal.error,
			code: refusal.error,
			http_status: 429,
			retry_after_s: refusal.retryAfterSeconds ?? 60,
			...(refusal.reason === "monthly"
				? { usage: { used: refusal.used, limit: refusal.limit, unit: "ai_writes", resets_at: refusal.resetsAt } }
				: {}),
			summary: refusal.message,
			source_packet_id: null,
			receipt_id: null,
			receipt: null,
			counts: { savedTotal: 0 },
		});
	};

	const describeItem = (item) => {
		const label = item.label ?? item.title ?? "(untitled)";
		const summary = item.summary ? ` — ${String(item.summary).slice(0, 160)}` : "";
		return `${item.id} [${item.kind}${item.category ? `/${item.category}` : ""}] ${label}${summary}`;
	};

	server.tool(
		"list_memories",
		"Browse this user's stored memories, newest first. Use for \"what do you remember\", audits, and cleanup — for meaning-based lookup use recall_memory instead. Returns ids that get_memory and delete_memory accept.",
		{
			kind: z.enum(["all", "node", "page"]).optional().describe("all (default): atomic facts and memory pages; node: facts only; page: pages only."),
			limit: z.number().optional().describe("Items per page, 1-200. Default 50."),
			cursor: z.string().optional().describe("Opaque cursor from a previous call's next_cursor."),
			q: z.string().optional().describe("Optional substring filter on labels and summaries. Not semantic search."),
			memoryScope: publicMemoryScopeSchema,
		},
		async ({ kind, limit, cursor, q, memoryScope }) => {
			const forbidden = ensureScope(authz, "list", "list_memories", MEMORY_READ_SCOPE);
			if (forbidden) return forbidden;
			const limited = await rateLimited("mcp-read", env.READ_LIMITER, "list", "list_memories");
			if (limited) return limited;
			const invalidScope = invalidProjectScope(memoryScope, "list", "list_memories");
			if (invalidScope) return invalidScope;
			const options = parseInventoryListOptions({
				kind,
				limit,
				cursor,
				q,
				projectId: normalizeProjectScope(memoryScope)?.projectId ?? null,
			});
			if (options.error) {
				return mcpResult({
					ok: false,
					command_mode: "list",
					source: "list_memories",
					error: options.error,
					summary: options.message,
				});
			}
			const page = await listMemories(env, userId, options);
			const payload = { ok: true, command_mode: "list", source: "list_memories", ...page };
			const lines = page.items.map((item, i) => `${i + 1}. ${describeItem(item)}`);
			const text = page.count === 0
				? "No stored memories match."
				: `${page.count} memor${page.count === 1 ? "y" : "ies"}${page.next_cursor ? " (more available — pass cursor to continue)" : ""}:\n\n${lines.join("\n")}`;
			return managementResult(payload, text);
		},
	);

	server.tool(
		"get_memory",
		"Fetch one stored memory by id (node_, page_, slice_, or candidate id), including its current text, history slices, and dated events.",
		{
			id: z.string().trim().min(1).describe("The memory id, e.g. node_abc123 — as returned by list_memories, receipts, or recall."),
		},
		async ({ id }) => {
			const forbidden = ensureScope(authz, "get", "get_memory", MEMORY_READ_SCOPE);
			if (forbidden) return forbidden;
			const limited = await rateLimited("mcp-read", env.READ_LIMITER, "get", "get_memory");
			if (limited) return limited;
			const found = await getMemory(env, userId, id);
			if (found?.error === "unrecognized_id") {
				return mcpResult({
					ok: false,
					command_mode: "get",
					source: "get_memory",
					error: "unrecognized_id",
					summary: "Unrecognized memory id — expected a node_, page_, slice_, or candidate id.",
				});
			}
			if (!found) {
				return mcpResult({
					ok: false,
					command_mode: "get",
					source: "get_memory",
					error: "not_found",
					summary: `No live memory with id ${id}.`,
				});
			}
			const memory = found.memory;
			const payload = { ok: true, command_mode: "get", source: "get_memory", kind: found.kind, memory };
			const parts = [describeItem(memory)];
			const currentSlice = (memory.slices ?? []).find((slice) => slice.is_current);
			if (currentSlice?.text) parts.push(`Current: ${currentSlice.text}`);
			if (memory.full_markdown) parts.push(String(memory.full_markdown).slice(0, 2_000));
			if (memory.events?.length) parts.push(`${memory.events.length} dated event(s); newest: ${memory.events[0].text ?? memory.events[0].action}`);
			return managementResult(payload, parts.join("\n\n"));
		},
	);

	// Safe memory updates — registered only when the deployment has the doors
	// enabled AND this connection's scopes permit the operation, so a
	// read-only connection is never shown a tool it cannot call.
	const updatesOn = safeUpdatesEnabled(env);
	const connectionCanWrite = !authz?.scopes || tokenAllowsScope(authz.scopes, MEMORY_WRITE_SCOPE);
	const connectionCanRead = !authz?.scopes || tokenAllowsScope(authz.scopes, MEMORY_READ_SCOPE);
	const versionFailure = (mode, source, error) => {
		const mapped = versionErrorResponse(error);
		if (!mapped) throw error;
		return mcpResult({
			ok: false, command_mode: mode, source,
			error: mapped.body.error, summary: mapped.body.message,
			...(mapped.body.current_revision ? { current_revision: mapped.body.current_revision } : {}),
		});
	};
	const mcpActor = (capability = "project.memory.write") => ({
		actorClass: authz?.rateContext?.auth?.type === "token" ? "token" : "user",
		actorRef: authz?.rateContext?.auth?.token?.id ?? userId,
		project: authz?.memoryScope?.managedProjectId ? { id: authz.memoryScope.managedProjectId } : null,
		// The MCP door resolved permissions during preflight; this identity makes
		// the COMMIT re-check them atomically, so a role downgrade or a revoked
		// credential between the two cannot land a write.
		actor: authz?.rateContext?.auth?.userId
			? {
				userId: authz.rateContext.auth.userId,
				type: authz.rateContext.auth.type ?? "token",
				capability,
				orgId: authz?.rateContext?.managedProject?.effective_organization_id
					?? authz?.rateContext?.managedProject?.organization_id ?? null,
				// Same commit-time credential proof as REST: an MCP connection whose
				// key is revoked mid-request must not land a write.
				credential: authz?.rateContext?.auth?.type === "token" && authz?.rateContext?.auth?.token?.id
					? {
						kind: "token",
						id: authz.rateContext.auth.token.id,
						requiredScope: MEMORY_WRITE_SCOPE,
						projectId: authz?.memoryScope?.managedProjectId ?? null,
					}
					: authz?.rateContext?.auth?.session?.id
						? { kind: "session", id: authz.rateContext.auth.session.id }
						: null,
			}
			: null,
	});

	if (updatesOn && connectionCanWrite) {
		server.tool(
			"update_memory",
			"Correct one stored memory deterministically. Requires the exact current revision (from get_memory/memory_history) — a stale revision is refused, never overwritten. Editable fields depend on kind: node label/category/summary; page title/short_summary/full_markdown; slice text/kind; event text/importance/happened_at.",
			{
				id: z.string().trim().min(1).describe("The memory id (node_, page_, slice_, or event_)."),
				expectedRevision: z.number().int().min(1).describe("The current revision you read. Refused with the fresh revision if stale."),
				fields: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).describe("The editable fields to change, e.g. {\"summary\": \"corrected text\"}."),
				reason: z.string().optional().describe("Optional short correction reason, kept in the revision history."),
				idempotencyKey: z.string().min(8).max(120).describe("Required idempotency key for safe retries."),
			},
			async ({ id, expectedRevision, fields, reason, idempotencyKey }) => {
				const forbidden = ensureScope(authz, "update", "update_memory", MEMORY_WRITE_SCOPE);
				if (forbidden) return forbidden;
				const limited = await rateLimited("mcp-save", env.SAVE_LIMITER, "update", "update_memory");
				if (limited) return limited;
				try {
					const result = await applyMemoryChange(env, ctx, {
						userId, ...mcpActor(), id, mode: "update",
						patch: fields, reason, idempotencyKey, expectedRevision,
					});
					const payload = { ok: true, command_mode: "update", source: "update_memory", ...result };
					const text = result.noop
						? `No change — the memory already reads exactly like that (revision ${result.revision}).`
						: `Updated. The memory is now revision ${result.revision}; the previous content is retained as history.`;
					return managementResult(payload, text);
				} catch (error) {
					return versionFailure("update", "update_memory", error);
				}
			},
		);

		server.tool(
			"rollback_memory",
			"Restore one memory to the content of an earlier revision. Creates a NEW forward revision from the retained snapshot — history is never rewound or deleted.",
			{
				id: z.string().trim().min(1).describe("The memory id."),
				toRevision: z.number().int().min(1).describe("The historical revision to restore (from memory_history)."),
				expectedRevision: z.number().int().min(1).describe("The CURRENT head revision — a stale value is refused."),
				reason: z.string().optional().describe("Optional reason, kept in the revision history."),
				idempotencyKey: z.string().min(8).max(120).describe("Required idempotency key for safe retries."),
			},
			async ({ id, toRevision, expectedRevision, reason, idempotencyKey }) => {
				const forbidden = ensureScope(authz, "rollback", "rollback_memory", MEMORY_WRITE_SCOPE);
				if (forbidden) return forbidden;
				const limited = await rateLimited("mcp-save", env.SAVE_LIMITER, "rollback", "rollback_memory");
				if (limited) return limited;
				try {
					const result = await applyMemoryChange(env, ctx, {
						userId, ...mcpActor(), id, mode: "rollback",
						toRevision, reason, idempotencyKey, expectedRevision,
					});
					const payload = { ok: true, command_mode: "rollback", source: "rollback_memory", ...result };
					return managementResult(payload,
						`Restored revision ${result.rolled_back_to} as new revision ${result.revision}. Nothing was deleted.`);
				} catch (error) {
					return versionFailure("rollback", "rollback_memory", error);
				}
			},
		);
	}

	if (updatesOn && connectionCanRead) {
		server.tool(
			"memory_history",
			"Read one memory's bounded revision history: every recorded baseline, system capture, update, and rollback, newest first, with snapshots.",
			{
				id: z.string().trim().min(1).describe("The memory id."),
				limit: z.number().int().min(1).max(50).optional().describe("Revisions per page (default 20, max 50)."),
				cursor: z.string().optional().describe("Cursor from a previous call's next_cursor."),
			},
			async ({ id, limit, cursor }) => {
				const forbidden = ensureScope(authz, "history", "memory_history", MEMORY_READ_SCOPE);
				if (forbidden) return forbidden;
				const limited = await rateLimited("mcp-read", env.READ_LIMITER, "history", "memory_history");
				if (limited) return limited;
				try {
					const result = await listMemoryHistory(env, userId, id, { cursor, limit });
					const payload = { ok: true, command_mode: "history", source: "memory_history", ...result };
					const lines = result.revisions.map((r) =>
						`r${r.revision} ${r.action}${r.captured ? " (captured)" : ""}${r.reason ? ` — ${r.reason}` : ""}`);
					return managementResult(payload,
						`Revision ${result.current_revision} is current. ${result.revisions.length} recorded:\n${lines.join("\n")}`);
				} catch (error) {
					return versionFailure("history", "memory_history", error);
				}
			},
		);
	}

	server.tool(
		"delete_memory",
		"Permanently delete ONE stored memory by id. Only call when the user explicitly asks to forget or remove something specific — confirm which memory first via list_memories or get_memory.",
		{
			id: z.string().trim().min(1).describe("The exact id to delete (node_, page_, slice_, or candidate id)."),
		},
		async ({ id }) => {
			const forbidden = ensureScope(authz, "delete", "delete_memory", MEMORY_WRITE_SCOPE);
			if (forbidden) return forbidden;
			const notAllowed = deleteForbidden("delete", "delete_memory");
			if (notAllowed) return notAllowed;
			const limited = await rateLimited("mcp-del", env.DELETE_LIMITER, "delete", "delete_memory");
			if (limited) return limited;
			const kind = id.startsWith("node_") ? "node"
				: id.startsWith("page_") ? "page"
					: id.startsWith("slice_") ? "slice"
						: id.startsWith("cand") ? "candidate"
							: null;
			if (!kind) {
				return mcpResult({
					ok: false,
					command_mode: "delete",
					source: "delete_memory",
					error: "unrecognized_id",
					summary: "Unrecognized memory id — expected a node_, page_, slice_, or candidate id.",
				});
			}
			const table = kind === "page" ? "memory_pages"
				: kind === "node" ? "nodes"
					: kind === "slice" ? "slices"
						: "candidates";
			const exists = await env.DB.prepare(
				`SELECT id, project_id, project_name FROM ${table} WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
			).bind(id, userId).first();
			if (!exists) {
				return mcpResult({
					ok: false,
					command_mode: "delete",
					source: "delete_memory",
					error: "not_found",
					summary: `No live memory with id ${id}.`,
				});
			}
			const result = await deleteObject(env, userId, { kind, id, suppress: true });
			await storeDeletionTombstone(env, userId, {
				kind,
				ids: [id],
				by: "mcp:delete_memory",
				source: "delete_memory",
				projectScopes: [{ project_id: exists.project_id ?? null, project_name: exists.project_name ?? null }],
			});
			const payload = { ok: true, command_mode: "delete", source: "delete_memory", id, kind, ...result };
			return managementResult(payload, `Deleted ${id}. This memory will no longer be recalled.`);
		},
	);

	server.tool(
		"delete_all_memories",
		"Erase this user's stored memories. SAFE BY DEFAULT: without confirm=true it only previews what would be deleted. Never pass confirm=true unless the user has explicitly confirmed full erasure in this conversation.",
		{
			confirm: z.boolean().optional().describe("false/absent: dry-run preview only. true: irreversible erasure."),
			source: z.string().optional().describe("Optional: restrict to memories created by one source/tool instead of everything."),
		},
		async ({ confirm, source }) => {
			const forbidden = ensureScope(authz, "delete_all", "delete_all_memories", MEMORY_WRITE_SCOPE);
			if (forbidden) return forbidden;
			const notAllowed = deleteForbidden("delete_all", "delete_all_memories");
			if (notAllowed) return notAllowed;
			const limited = await rateLimited("mcp-del", env.DELETE_LIMITER, "delete_all", "delete_all_memories");
			if (limited) return limited;
			const confirmed = confirm === true;
			// SRV-01 parity with the REST door: a source filter no write stamp
			// could ever equal must be refused loudly, not silently match nothing.
			if (source != null && source !== "" && !cleanClientSource(source)) {
				return managementResult(
					{ ok: false, command_mode: "delete_all", source: "delete_all_memories", error: "invalid_source" },
					"That source filter is not a valid label (1-64 characters, no control characters). Nothing was deleted.",
				);
			}
			const result = await bulkDeleteBySource(env, userId, {
				source: cleanClientSource(source),
				dryRun: !confirmed,
				confirm: confirmed,
				by: "mcp:delete_all_memories",
			});
			const payload = { ok: result.ok !== false, command_mode: "delete_all", source: "delete_all_memories", confirmed, ...result };
			const counts = result.would_delete ?? result.deleted ?? {};
			const total = ["nodes", "pages", "slices", "events", "candidates"]
				.reduce((sum, key) => sum + Number(counts[key] ?? 0), 0);
			const text = result.dry_run
				? `Dry run only — nothing deleted. ${total} object(s) would be removed${result.note ? ` (${result.note})` : ""}. Ask the user to confirm, then call again with confirm=true.`
				: `Erasure complete: ${total} object(s) removed.`;
			return managementResult(payload, text);
		},
	);

	server.tool(
		"whoami",
		"Report this connection's identity and health: which memory space it writes to, its scopes, any bound project, and live memory counts. Call when the user asks \"is memory working\", or to diagnose setup.",
		{},
		async () => {
			const forbidden = ensureScope(authz, "whoami", "whoami", MEMORY_READ_SCOPE);
			if (forbidden) return forbidden;
			const limited = await rateLimited("mcp-read", env.READ_LIMITER, "whoami", "whoami");
			if (limited) return limited;
			const counts = await memoryCounts(env, userId);
			const scope = authz.memoryScope ?? null;
			const payload = {
				ok: true,
				command_mode: "whoami",
				source: "whoami",
				server: { name: "itsuki-memory", version: "0.7.0" },
				user_id: userId,
				scopes: authz.scopes ?? [MEMORY_READ_SCOPE, MEMORY_WRITE_SCOPE],
				can_delete: authz.allowDelete !== false,
				project: scope?.managedProjectId
					? { id: scope.managedProjectId, name: scope.managedProjectName ?? null }
					: null,
				counts,
			};
			const projectLine = payload.project ? `Project: ${payload.project.name ?? payload.project.id}. ` : "";
			const text = `Connected to Itsuki memory (server 0.7.0). ${projectLine}Scopes: ${payload.scopes.join(", ")}. `
				+ `Stored: ${counts.memories} memories (${counts.nodes} facts, ${counts.pages} pages), ${counts.events} events, ${counts.candidates} pending candidates.`;
			return managementResult(payload, text);
		},
	);

	return server;
}
