/**
 * The MCP server — the "door" official ChatGPT and Claude connect through.
 *
 * Three tools, each routed through the EXISTING engine (no duplicated logic):
 *   - save_memory       → ingest path (single durable statement)
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

import { getConfig } from "../config.js";
import { recall } from "../pipeline/recall.js";
import { saveMemory, saveConversation } from "../pipeline/manual.js";

const SAVE_MEMORY_DESC =
	"Call when the user shares something durable to remember long-term — starting/stopping/finishing/launching something, a health update, a family or life event, a project update, a decision, a goal, a preference, or a skill. Examples: 'I started boxing', 'my grandmother died', \"I'm building an app called Kaka\", 'I decided to use Supabase'. Do NOT call for jokes, thanks, casual chat, questions, translations, or calculations. Returns immediately with a receipt; the memory is processed in the background.";

const SAVE_CONVERSATION_DESC =
	"Call when the conversation is wrapping up or going idle, periodically during a long chat, or when the user says 'save this chat / remember this'. Send the recent messages (mark each role 'user' or 'assistant'); they are digested into clean facts before saving, so a messy chat still captures correctly. Safe to re-send overlapping messages — already-saved ones are skipped. Use scope to limit what is saved.";

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

const text = (s) => ({ content: [{ type: "text", text: s }] });

/**
 * Build a fresh McpServer for this request, closing over env + the authenticated
 * userId. A new instance per request is required by the MCP SDK (a server cannot
 * be reconnected to a new transport).
 */
export function buildMemoryServer(env, ctx, userId) {
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
		},
		async ({ content, recentContext }) => {
			const res = await saveMemory(env, ctx, userId, content, { recentContext });
			return text(res.summary);
		},
	);

	server.tool(
		"save_conversation",
		SAVE_CONVERSATION_DESC,
		{
			messages: z
				.array(
					z.object({
						id: z.string().optional(),
						role: z.enum(["user", "assistant"]).optional().describe("Defaults to 'user'."),
						content: z.string(),
						ts: z.number().optional(),
					}),
				)
				.describe("Recent chat messages, oldest first. Include assistant turns for context; only user facts are saved."),
			conversationId: z.string().optional().describe("Stable id for this chat, used to de-duplicate re-sends."),
			scope: z
				.enum(["full", "lastN", "topic", "summary"])
				.optional()
				.describe("full (default), lastN (last n), topic (filter by `topic`), or summary (payload is already condensed)."),
			n: z.number().optional().describe("With scope=lastN: how many of the most recent messages to digest."),
			topic: z.string().optional().describe("With scope=topic: keep only messages mentioning this."),
		},
		async ({ messages, conversationId, scope, n, topic }) => {
			const res = await saveConversation(env, ctx, userId, messages ?? [], { conversationId, scope, n, topic });
			return text(res.summary);
		},
	);

	server.tool(
		"recall_memory",
		RECALL_MEMORY_DESC,
		{
			query: z.string().describe("What to look up about the user, e.g. 'boxing' or 'what are my projects'."),
		},
		async ({ query }) => {
			const res = await recall(env, getConfig(env), userId, query);
			if (!res.nodes.length) return text("No relevant memory found for that.");
			return text(res.context);
		},
	);

	return server;
}
