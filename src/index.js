/**
 * Memory Engine — HTTP API.
 *
 * Storage (Step 1): D1, read by /v1/graph and /v1/status.
 * Extraction (Step 2): /v1/ingest routes each user's messages through their
 * UserMemory Durable Object, which holds/batches and (on fire) runs the
 * extraction pipeline in the background.
 */

import { createMcpHandler } from "agents/mcp";

import { getConfig } from "./config.js";
import { recall } from "./pipeline/recall.js";
import { ingestMessages } from "./pipeline/ingest.js";
import { saveMemory, saveConversation } from "./pipeline/manual.js";
import { getUserReceipts } from "./lib/db.js";
import {
	archiveObject,
	clearFailedReceipts,
	deleteAllMemories,
	deleteLastExtraction,
	deleteObject,
} from "./pipeline/cleanup.js";
import { buildClusterPayload, organizeUserClusters, withCluster } from "./pipeline/clusters.js";
import { buildMemoryServer, decodeMcpToken } from "./mcp/server.js";

export { UserMemory } from "./durable/user-memory.js";

// Extraction models offered in the dev/model panel dropdown. The ACTIVE one is
// config.llm.model (a one-line switch via LLM_MODEL); these are the candidates
// from the Priority 2 bake-off so the UI can show what's available.
const EXTRACTION_MODELS = [
	"@cf/meta/llama-3.1-8b-instruct-fp8",
	"@cf/google/gemma-4-26b-a4b-it",
	"@cf/qwen/qwen3-30b-a3b-fp8",
	"@cf/openai/gpt-oss-120b",
	"@cf/moonshotai/kimi-k2.6",
];

function json(data, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function isAuthorized(request, env) {
	const key = request.headers.get("x-api-key");
	return Boolean(env.API_KEY) && key === env.API_KEY;
}

const routes = {
	"GET /health": () => json({ ok: true, service: "memory-engine", version: "0.1.0" }),

	"POST /v1/ingest": async (request, env, ctx) => {
		const body = await request.json().catch(() => ({}));
		const { userId, messages, flush } = body;
		if (!userId || !Array.isArray(messages)) {
			return json({ error: "userId and messages[] are required" }, 400);
		}

		// Route through the shared ingest path. Extraction runs in the background
		// (wait:false) so the caller isn't blocked. `_test` is an injection hook
		// for deterministic tests (canned LLM output); production never sends it.
		const { fired } = await ingestMessages(env, ctx, userId, messages, {
			flush: Boolean(flush),
			overrides: body._test ?? {},
		});

		return json({ received: true, fired: Boolean(fired) });
	},

	"GET /v1/graph": async (request, env) => {
		const userId = new URL(request.url).searchParams.get("userId");
		if (!userId) return json({ error: "userId is required" }, 400);

		// The whole brain for one user: nodes with ALL their slices (current + old,
		// each carrying is_current) and their events newest-first, plus edges and
		// the loose "maybe" candidates. The graph page renders all of it.
		const [nodesResult, pagesResult, slicesResult, eventsResult, edgesResult, candidatesResult] = await env.DB.batch([
			env.DB.prepare("SELECT * FROM nodes WHERE user_id = ? AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL").bind(userId),
			env.DB.prepare("SELECT * FROM memory_pages WHERE user_id = ? AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL ORDER BY updated_at DESC").bind(userId),
			env.DB.prepare("SELECT * FROM slices WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC").bind(userId),
			env.DB.prepare("SELECT * FROM events WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC").bind(userId),
			env.DB.prepare("SELECT * FROM edges WHERE user_id = ? AND deleted_at IS NULL").bind(userId),
			env.DB.prepare("SELECT * FROM candidates WHERE user_id = ? AND deleted_at IS NULL AND suppressed_at IS NULL ORDER BY created_at DESC").bind(userId),
		]);

		const slicesByNode = new Map();
		for (const slice of slicesResult.results) {
			if (!slicesByNode.has(slice.node_id)) slicesByNode.set(slice.node_id, []);
			slicesByNode.get(slice.node_id).push(slice);
		}

		const eventsByNode = new Map();
		for (const event of eventsResult.results) {
			if (!eventsByNode.has(event.node_id)) eventsByNode.set(event.node_id, []);
			eventsByNode.get(event.node_id).push(event);
		}

		const nodes = nodesResult.results.map((node) => withCluster({
			...node,
			slices: slicesByNode.get(node.id) ?? [],
			events: eventsByNode.get(node.id) ?? [],
		}));
		const pages = pagesResult.results.map((page) => withCluster({
			...page,
			title: page.title,
			category: page.topic_filter ?? "interest",
			summary: page.short_summary,
		}));
		const clusters = buildClusterPayload(nodes, pages);

		const config = getConfig(env);
		const stats = {
			nodes: nodes.length,
			pages: pages.length,
			clusters: clusters.length,
			slices: slicesResult.results.length,
			events: eventsResult.results.length,
			edges: edgesResult.results.length,
			candidates: candidatesResult.results.length,
		};

		return json({
			nodes,
			pages,
			clusters,
			edges: edgesResult.results,
			candidates: candidatesResult.results,
			stats,
			model: config.llm.model,
			models: EXTRACTION_MODELS,
		});
	},

	"POST /v1/save": async (request, env, ctx) => {
		// Manual Path A for the UI test buttons (and any direct caller). Mirrors the
		// MCP save tools through the SAME engine. `_test` injects canned LLM/digest
		// output for deterministic tests; production never sends it.
		const body = await request.json().catch(() => ({}));
		const { userId, mode, content, messages, scope, n, topic, conversationId, recentContext } = body;
		if (!userId) return json({ error: "userId is required" }, 400);

		const t = body._test ?? {};
		const overrides = {};
		if (t.llmResponse !== undefined) overrides.llmResponse = t.llmResponse;
		if (t.settings !== undefined) overrides.settings = t.settings;

		let res;
		if (mode === "conversation") {
			if (!Array.isArray(messages)) return json({ error: "messages[] is required for conversation" }, 400);
			res = await saveConversation(env, ctx, userId, messages, {
				scope,
				n,
				topic,
				conversationId,
				overrides,
				digestResponse: t.digestResponse,
			});
		} else {
			if (typeof content !== "string" || !content.trim()) {
				return json({ error: "content is required for a memory save" }, 400);
			}
			res = await saveMemory(env, ctx, userId, content, { recentContext, overrides });
		}
		return json({ fired: res.fired, processing: res.processing, summary: res.summary, receipt: res.receipt });
	},

	"GET /v1/receipts": async (request, env) => {
		const url = new URL(request.url);
		const userId = url.searchParams.get("userId");
		if (!userId) return json({ error: "userId is required" }, 400);
		const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
		const receipts = await getUserReceipts(env, userId, limit);
		return json({ receipts });
	},

	"POST /v1/actions/delete-last-extraction": async (request, env) => {
		const body = await request.json().catch(() => ({}));
		if (!body.userId) return json({ error: "userId is required" }, 400);
		return json(await deleteLastExtraction(env, body.userId));
	},

	"POST /v1/actions/delete-object": async (request, env) => {
		const body = await request.json().catch(() => ({}));
		if (!body.userId || !body.kind || !body.id) return json({ error: "userId, kind and id are required" }, 400);
		return json(await deleteObject(env, body.userId, body));
	},

	"POST /v1/actions/archive-object": async (request, env) => {
		const body = await request.json().catch(() => ({}));
		if (!body.userId || !body.kind || !body.id) return json({ error: "userId, kind and id are required" }, 400);
		return json(await archiveObject(env, body.userId, body));
	},

	"POST /v1/actions/delete-all": async (request, env) => {
		const body = await request.json().catch(() => ({}));
		if (!body.userId) return json({ error: "userId is required" }, 400);
		const result = await deleteAllMemories(env, body.userId, body.confirm);
		return json(result, result.deleted ? 200 : 400);
	},

	"POST /v1/actions/clear-failed-receipts": async (request, env) => {
		const body = await request.json().catch(() => ({}));
		if (!body.userId) return json({ error: "userId is required" }, 400);
		return json(await clearFailedReceipts(env, body.userId));
	},

	"POST /v1/actions/organize-clusters": async (request, env) => {
		const body = await request.json().catch(() => ({}));
		if (!body.userId) return json({ error: "userId is required" }, 400);
		return json(await organizeUserClusters(env, body.userId));
	},

	"POST /v1/recall": async (request, env) => {
		const body = await request.json().catch(() => ({}));
		const { userId, query } = body;
		if (!userId || typeof query !== "string") {
			return json({ error: "userId and query are required" }, 400);
		}

		const result = await recall(env, getConfig(env), userId, query);
		return json(result);
	},

	"GET /v1/status": async (request, env) => {
		const userId = new URL(request.url).searchParams.get("userId");
		if (!userId) return json({ error: "userId is required" }, 400);

		const [nodesCount, pagesCount, slicesCount, eventsCount, candidatesCount, checkpoint] = await env.DB.batch([
			env.DB.prepare("SELECT COUNT(*) AS count FROM nodes WHERE user_id = ? AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL").bind(userId),
			env.DB.prepare("SELECT COUNT(*) AS count FROM memory_pages WHERE user_id = ? AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL").bind(userId),
			env.DB.prepare("SELECT COUNT(*) AS count FROM slices WHERE user_id = ? AND deleted_at IS NULL").bind(userId),
			env.DB.prepare("SELECT COUNT(*) AS count FROM events WHERE user_id = ? AND deleted_at IS NULL").bind(userId),
			env.DB.prepare("SELECT COUNT(*) AS count FROM candidates WHERE user_id = ? AND deleted_at IS NULL AND suppressed_at IS NULL").bind(userId),
			env.DB.prepare("SELECT last_processed_msg_id FROM checkpoints WHERE user_id = ?").bind(userId),
		]);

		return json({
			nodes: nodesCount.results[0].count,
			pages: pagesCount.results[0].count,
			slices: slicesCount.results[0].count,
			events: eventsCount.results[0].count,
			candidates: candidatesCount.results[0].count,
			lastCheckpoint: checkpoint.results[0]?.last_processed_msg_id ?? null,
		});
	},
};

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);

		// MCP door (ChatGPT / Claude). Identity + auth live in the URL path token,
		// so this bypasses the x-api-key gate and authenticates the token itself.
		if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
			return handleMcp(request, env, ctx, url);
		}

		const handler = routes[`${request.method} ${url.pathname}`];

		if (!handler) {
			return json({ error: "not found" }, 404);
		}

		if (url.pathname !== "/health" && !isAuthorized(request, env)) {
			return json({ error: "unauthorized" }, 401);
		}

		return handler(request, env, ctx);
	},
};

/** Authenticate the path token, then serve the MCP Streamable HTTP endpoint. */
function handleMcp(request, env, ctx, url) {
	const token = url.pathname.slice("/mcp/".length).split("/")[0];
	const id = decodeMcpToken(token);
	if (!id || !env.API_KEY || id.key !== env.API_KEY) {
		return json({ error: "unauthorized mcp token" }, 401);
	}

	const server = buildMemoryServer(env, ctx, id.userId);
	// Normalize the path to /mcp so the transport never depends on the token suffix.
	const normalized = new Request(new URL("/mcp", url).toString(), request);
	return createMcpHandler(server)(normalized, env, ctx);
}
