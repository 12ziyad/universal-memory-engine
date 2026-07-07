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
	cleanJunkMemories,
	clearFailedReceipts,
	deleteAllMemories,
	deleteLastExtraction,
	deleteObject,
	repairGraph,
} from "./pipeline/cleanup.js";
import { organizeUserClusters, withCluster } from "./pipeline/clusters.js";
import { buildGraphLayout } from "./pipeline/layout.js";
import { listCandidates, mergeCandidate, promoteCandidate, rejectCandidate } from "./pipeline/candidates.js";
import { buildMemoryServer, decodeMcpToken } from "./mcp/server.js";
import {
	clearSessionCookie,
	createConnectionToken,
	getSessionUser,
	listConnectionTokens,
	login,
	logout,
	logoutAll,
	resolveConnectionToken,
	revokeConnectionToken,
	sha256Hex,
	signup,
	timingSafeEqualString,
} from "./auth.js";
import { emptyReceipt, formatReceipt } from "./pipeline/receipt.js";
import { normalizeSourcePacket, sourceMeta, storeSourcePacket } from "./pipeline/source.js";
import { storeReceipt } from "./lib/db.js";

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

function json(data, status = 200, extraHeaders = {}) {
	const headers = new Headers(extraHeaders);
	headers.set("content-type", "application/json");
	return new Response(JSON.stringify(data), {
		status,
		headers,
	});
}

async function isAuthorized(request, env) {
	const key = request.headers.get("x-api-key");
	return Boolean(env.API_KEY) && Boolean(key) && await timingSafeEqualString(key, env.API_KEY);
}

function bearerToken(request) {
	const auth = request.headers.get("authorization") || "";
	const match = auth.match(/^Bearer\s+(.+)$/i);
	return match?.[1]?.trim() || request.headers.get("x-uml-token") || "";
}

async function resolveMemoryUser(request, env, explicitUserId, { allowLegacy = true, allowedTokenTypes = ["api", "mcp"] } = {}) {
	const session = await getSessionUser(env, request);
	if (session) return session;

	const token = bearerToken(request);
	if (token) {
		const tokenUser = await resolveConnectionToken(env, token, { allowedTypes: allowedTokenTypes });
		if (tokenUser) return tokenUser;
		return null;
	}

	if (allowLegacy && explicitUserId && await isAuthorized(request, env)) {
		return { type: "legacy", userId: explicitUserId, user: null };
	}
	return null;
}

async function requireMemoryUser(request, env, explicitUserId, options = {}) {
	const auth = await resolveMemoryUser(request, env, explicitUserId, options);
	if (auth) {
		const scoped = await resolveScopedMemory(auth, explicitUserId, options.scopeInput);
		return { auth, userId: scoped.userId, memoryScope: scoped.memoryScope };
	}
	if (await isAuthorized(request, env)) {
		return { response: json({ error: "userId is required" }, 400) };
	}
	return { response: json({ error: "unauthorized" }, 401) };
}

function cleanScopeValue(value, fallback = null) {
	const text = String(value ?? "").trim();
	return text || fallback;
}

async function scopedMemoryUserId(ownerUserId, externalUserId) {
	if (!externalUserId || externalUserId === ownerUserId) return ownerUserId;
	const digest = await sha256Hex(`uml-memory-scope:v1:${ownerUserId}:${externalUserId}`);
	return `mem_${digest.slice(0, 32)}`;
}

async function resolveScopedMemory(auth, explicitUserId, scopeInput = {}) {
	const input = scopeInput && typeof scopeInput === "object" ? scopeInput : {};
	if (auth.type === "legacy") {
		const externalUserId = cleanScopeValue(explicitUserId, auth.userId);
		return {
			userId: externalUserId,
			memoryScope: {
				...input,
				authType: "legacy",
				memoryUserId: externalUserId,
				ownerUserId: "legacy",
				externalUserId,
			},
		};
	}
	const ownerUserId = auth.userId;
	const externalUserId = cleanScopeValue(explicitUserId ?? input.externalUserId ?? input.userId, ownerUserId);
	const memoryUserId = await scopedMemoryUserId(ownerUserId, externalUserId);
	return {
		userId: memoryUserId,
		memoryScope: {
			...input,
			authType: auth.type,
			memoryUserId,
			ownerUserId,
			externalUserId,
		},
	};
}

async function storeRouteReceipt(env, userId, sourcePacket, outcome, reason, source = "recall") {
	const meta = sourceMeta(sourcePacket);
	const receipt = emptyReceipt(outcome, reason, {
		source,
		source_mode: sourcePacket?.source_mode ?? null,
		...meta,
	});
	const summary = formatReceipt(receipt);
	const receiptId = await storeReceipt(env, userId, source, receipt, summary);
	return { ...receipt, id: receiptId ?? null };
}

function redirectTo(request, path) {
	return Response.redirect(new URL(path, request.url), 302);
}

function authPayload(auth) {
	return {
		authenticated: true,
		user: auth.user,
		session: auth.session ?? null,
	};
}

function authFailureResponse(mode, error) {
	console.error(`auth.${mode} failed`, { message: error?.message || String(error || "") });
	const message = mode === "signup"
		? "Could not create account. Please try again."
		: "Could not log in. Please try again.";
	return json({ error: message }, 500);
}

const routes = {
	"GET /health": () => json({ ok: true, service: "memory-engine", version: "0.1.0" }),

	"GET /auth/me": async (request, env) => {
		const auth = await getSessionUser(env, request);
		if (!auth) return json({ authenticated: false, user: null });
		return json(authPayload(auth));
	},

	"POST /auth/signup": async (request, env) => {
		try {
			const body = await request.json().catch(() => ({}));
			const result = await signup(env, request, body);
			if (result.error) return json({ error: result.error }, result.status);
			return json(
				{ authenticated: true, user: result.user, session: { id: result.session.id, expires_at: result.session.expiresAt } },
				result.status,
				{ "set-cookie": result.session.cookie },
			);
		} catch (error) {
			return authFailureResponse("signup", error);
		}
	},

	"POST /auth/login": async (request, env) => {
		try {
			const body = await request.json().catch(() => ({}));
			const result = await login(env, request, body);
			if (result.error) return json({ error: result.error }, result.status);
			return json(
				{ authenticated: true, user: result.user, session: { id: result.session.id, expires_at: result.session.expiresAt } },
				result.status,
				{ "set-cookie": result.session.cookie },
			);
		} catch (error) {
			return authFailureResponse("login", error);
		}
	},

	"POST /auth/logout": async (request, env) => {
		const result = await logout(env, request);
		return json({ ok: true }, 200, { "set-cookie": result.cookie });
	},

	"POST /auth/logout-all": async (request, env) => {
		const auth = await getSessionUser(env, request);
		if (!auth) return json({ error: "unauthorized" }, 401, { "set-cookie": clearSessionCookie(request) });
		await logoutAll(env, auth.userId);
		return json({ ok: true }, 200, { "set-cookie": clearSessionCookie(request) });
	},

	"GET /auth/tokens": async (request, env) => {
		const auth = await getSessionUser(env, request);
		if (!auth) return json({ error: "unauthorized" }, 401);
		return json({ tokens: await listConnectionTokens(env, auth.userId) });
	},

	"POST /auth/tokens": async (request, env) => {
		const auth = await getSessionUser(env, request);
		if (!auth) return json({ error: "unauthorized" }, 401);
		const body = await request.json().catch(() => ({}));
		const result = await createConnectionToken(env, auth.userId, body);
		return json(result, 201);
	},

	"POST /v1/ingest": async (request, env, ctx) => {
		const body = await request.json().catch(() => ({}));
		const auth = await requireMemoryUser(request, env, body.userId, {
			scopeInput: body.memoryScope ?? body.sourceScope,
		});
		if (auth.response) return auth.response;
		const { messages, flush } = body;
		if (!Array.isArray(messages)) return json({ error: "messages[] is required" }, 400);

		// Route through the shared ingest path. Extraction runs in the background
		// (wait:false) so the caller isn't blocked. `_test` is an injection hook
		// for deterministic tests (canned LLM output); production never sends it.
		const { fired, held, skipped, sourcePacket, receipt: pipelineReceipt } = await ingestMessages(env, ctx, auth.userId, messages, {
			flush: Boolean(flush),
			conversationId: body.conversationId,
			threadId: body.threadId,
			sourceId: body.sourceId,
			idempotencyKey: body.idempotencyKey,
			memoryScope: auth.memoryScope,
			overrides: body._test ?? {},
		});

		let receipt = pipelineReceipt ?? null;
		if (!fired) {
			if (!receipt) {
				const outcome = held > 0 ? "accumulating" : "ignored";
				const reason = held > 0
					? "learning trigger is accumulating more context"
					: "no durable learning signal found";
				receipt = await storeRouteReceipt(env, auth.userId, sourcePacket, outcome, reason, "ingest");
			}
		}

		return json({
			received: true,
			fired: Boolean(fired),
			held,
			skipped,
			source_packet_id: sourcePacket?.id ?? null,
			receipt_id: receipt?.id ?? null,
			receipt,
		});
	},

	"GET /v1/graph": async (request, env) => {
		const requestedUserId = new URL(request.url).searchParams.get("userId");
		const auth = await requireMemoryUser(request, env, requestedUserId);
		if (auth.response) return auth.response;
		const userId = auth.userId;

		// The whole brain for one user: nodes with ALL their slices (current + old,
		// each carrying is_current) and their events newest-first, plus edges and
		// the loose "maybe" candidates. The graph page renders all of it.
		const [nodesResult, pagesResult, slicesResult, eventsResult, edgesResult, candidatesResult] = await env.DB.batch([
			env.DB.prepare("SELECT * FROM nodes WHERE user_id = ? AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL").bind(userId),
			env.DB.prepare("SELECT * FROM memory_pages WHERE user_id = ? AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL ORDER BY updated_at DESC").bind(userId),
			env.DB.prepare("SELECT * FROM slices WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC").bind(userId),
			env.DB.prepare("SELECT * FROM events WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC").bind(userId),
			env.DB.prepare("SELECT * FROM edges WHERE user_id = ? AND deleted_at IS NULL").bind(userId),
			env.DB.prepare(
				`SELECT * FROM candidates
				 WHERE user_id = ? AND deleted_at IS NULL AND suppressed_at IS NULL
				   AND COALESCE(status, 'pending') = 'pending'
				 ORDER BY COALESCE(last_seen_at, created_at) DESC`,
			).bind(userId),
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
		const candidates = candidatesResult.results.map((candidate) => withCluster({
			...candidate,
			label: candidate.label_guess ?? candidate.label,
			category: candidate.role_guess ?? candidate.cluster_guess ?? candidate.cluster_hint ?? "interest",
			cluster: candidate.cluster_guess ?? candidate.cluster_hint,
			summary: null,
		}));
		const layout = buildGraphLayout(nodes, pages, candidates);

		const config = getConfig(env);
		const stats = {
			nodes: layout.nodes.length,
			pages: layout.pages.length,
			clusters: layout.clusters.length,
			slices: slicesResult.results.length,
			events: eventsResult.results.length,
			edges: edgesResult.results.length,
			candidates: layout.candidates.length,
		};

		return json({
			nodes: layout.nodes,
			pages: layout.pages,
			clusters: layout.clusters,
			edges: edgesResult.results,
			candidates: layout.candidates,
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
		const auth = await requireMemoryUser(request, env, body.userId, {
			scopeInput: body.memoryScope ?? body.sourceScope,
		});
		if (auth.response) return auth.response;
		const userId = auth.userId;
		const { mode, content, messages, scope, n, topic, conversationId, recentContext } = body;

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
				threadId: body.threadId,
				sourceId: body.sourceId,
				idempotencyKey: body.idempotencyKey,
				memoryScope: auth.memoryScope,
				overrides,
				digestResponse: t.digestResponse,
			});
		} else {
			if (typeof content !== "string" || !content.trim()) {
				return json({ error: "content is required for a memory save" }, 400);
			}
			res = await saveMemory(env, ctx, userId, content, {
				recentContext,
				sourceId: body.sourceId,
				idempotencyKey: body.idempotencyKey,
				memoryScope: auth.memoryScope,
				overrides,
			});
		}
		return json({ fired: res.fired, processing: res.processing, summary: res.summary, receipt: res.receipt });
	},

	"GET /v1/receipts": async (request, env) => {
		const url = new URL(request.url);
		const auth = await requireMemoryUser(request, env, url.searchParams.get("userId"));
		if (auth.response) return auth.response;
		const userId = auth.userId;
		const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
		const receipts = await getUserReceipts(env, userId, limit);
		return json({ receipts });
	},

	"POST /v1/actions/delete-last-extraction": async (request, env) => {
		const body = await request.json().catch(() => ({}));
		const auth = await requireMemoryUser(request, env, body.userId);
		if (auth.response) return auth.response;
		return json(await deleteLastExtraction(env, auth.userId));
	},

	"POST /v1/actions/delete-object": async (request, env) => {
		const body = await request.json().catch(() => ({}));
		const auth = await requireMemoryUser(request, env, body.userId);
		if (auth.response) return auth.response;
		if (!body.kind || !body.id) return json({ error: "kind and id are required" }, 400);
		return json(await deleteObject(env, auth.userId, body));
	},

	"POST /v1/actions/archive-object": async (request, env) => {
		const body = await request.json().catch(() => ({}));
		const auth = await requireMemoryUser(request, env, body.userId);
		if (auth.response) return auth.response;
		if (!body.kind || !body.id) return json({ error: "kind and id are required" }, 400);
		return json(await archiveObject(env, auth.userId, body));
	},

	"POST /v1/actions/delete-all": async (request, env) => {
		const body = await request.json().catch(() => ({}));
		const auth = await requireMemoryUser(request, env, body.userId);
		if (auth.response) return auth.response;
		const result = await deleteAllMemories(env, auth.userId, body.confirm);
		return json(result, result.deleted ? 200 : 400);
	},

	"POST /v1/actions/clean-junk": async (request, env) => {
		const body = await request.json().catch(() => ({}));
		const auth = await requireMemoryUser(request, env, body.userId);
		if (auth.response) return auth.response;
		return json(await cleanJunkMemories(env, auth.userId, { confirm: body.confirm }));
	},

	"POST /v1/actions/clear-failed-receipts": async (request, env) => {
		const body = await request.json().catch(() => ({}));
		const auth = await requireMemoryUser(request, env, body.userId);
		if (auth.response) return auth.response;
		return json(await clearFailedReceipts(env, auth.userId));
	},

	"POST /v1/actions/organize-clusters": async (request, env) => {
		const body = await request.json().catch(() => ({}));
		const auth = await requireMemoryUser(request, env, body.userId);
		if (auth.response) return auth.response;
		return json(await organizeUserClusters(env, auth.userId));
	},

	"POST /v1/actions/repair-graph": async (request, env) => {
		const body = await request.json().catch(() => ({}));
		const auth = await requireMemoryUser(request, env, body.userId);
		if (auth.response) return auth.response;
		return json(await repairGraph(env, auth.userId, body));
	},

	"POST /v1/recall": async (request, env) => {
		const body = await request.json().catch(() => ({}));
		const auth = await requireMemoryUser(request, env, body.userId, {
			scopeInput: body.memoryScope ?? body.sourceScope,
		});
		if (auth.response) return auth.response;
		const { query } = body;
		if (typeof query !== "string") return json({ error: "query is required" }, 400);

		const normalized = await normalizeSourcePacket(auth.userId, {
			type: "query",
			sourceMode: "recall",
			content: query,
			sourceId: body.sourceId,
			idempotencyKey: body.idempotencyKey,
			threadId: body.threadId,
			conversationId: body.conversationId,
			topic: body.topic,
			scope: auth.memoryScope,
		});
		const sourcePacket = await storeSourcePacket(env, normalized.packet);
		const result = await recall(env, getConfig(env), auth.userId, query, {
			memoryScope: auth.memoryScope,
		});
		const receipt = await storeRouteReceipt(
			env,
			auth.userId,
			sourcePacket,
			result.recall_mode === "no_recall" ? "no_recall" : "recalled",
			result.recall_mode === "no_recall" ? "recall gate skipped memory lookup" : "bounded recall completed",
			"recall",
		);
		result.receipt_id = receipt.id;
		result.source_packet_id = sourcePacket?.id ?? null;
		return json(result);
	},

	"GET /v1/status": async (request, env) => {
		const auth = await requireMemoryUser(request, env, new URL(request.url).searchParams.get("userId"));
		if (auth.response) return auth.response;
		const userId = auth.userId;

		const [nodesCount, pagesCount, slicesCount, eventsCount, candidatesCount, checkpoint] = await env.DB.batch([
			env.DB.prepare("SELECT COUNT(*) AS count FROM nodes WHERE user_id = ? AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL").bind(userId),
			env.DB.prepare("SELECT COUNT(*) AS count FROM memory_pages WHERE user_id = ? AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL").bind(userId),
			env.DB.prepare("SELECT COUNT(*) AS count FROM slices WHERE user_id = ? AND deleted_at IS NULL").bind(userId),
			env.DB.prepare("SELECT COUNT(*) AS count FROM events WHERE user_id = ? AND deleted_at IS NULL").bind(userId),
			env.DB.prepare(
				`SELECT COUNT(*) AS count FROM candidates
				 WHERE user_id = ? AND deleted_at IS NULL AND suppressed_at IS NULL
				   AND COALESCE(status, 'pending') = 'pending'`,
			).bind(userId),
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

		if ((request.method === "GET" || request.method === "HEAD") && ["/app", "/login", "/signup"].includes(url.pathname)) {
			const auth = await getSessionUser(env, request);
			if (url.pathname === "/app") return redirectTo(request, auth ? "/?app=1" : "/?view=login");
			return redirectTo(request, auth ? "/?app=1" : `/?view=${url.pathname.slice(1)}`);
		}

		// MCP door for supported clients. Identity + auth live in the URL path token,
		// so this bypasses the x-api-key gate and authenticates the token itself.
		if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
			return handleMcp(request, env, ctx, url);
		}

		if (request.method === "POST" && url.pathname.startsWith("/auth/tokens/") && url.pathname.endsWith("/revoke")) {
			const auth = await getSessionUser(env, request);
			if (!auth) return json({ error: "unauthorized" }, 401);
			const id = url.pathname.slice("/auth/tokens/".length).replace(/\/revoke$/, "");
			return json(await revokeConnectionToken(env, auth.userId, id));
		}

		if (url.pathname === "/v1/candidates" || url.pathname.startsWith("/v1/candidates/")) {
			return handleCandidateRoutes(request, env, url);
		}

		const handler = routes[`${request.method} ${url.pathname}`];

		if (!handler) {
			return json({ error: "not found" }, 404);
		}

		return handler(request, env, ctx);
	},
};

/** Authenticate the path token, then serve the MCP Streamable HTTP endpoint. */
async function handleMcp(request, env, ctx, url) {
	const token = url.pathname.slice("/mcp/".length).split("/")[0];
	if (token?.startsWith("uml_live_")) {
		const auth = await resolveConnectionToken(env, token, { allowedTypes: ["mcp"] });
		if (!auth) return json({ error: "unauthorized mcp token" }, 401);
		const server = buildMemoryServer(env, ctx, auth.userId);
		const normalized = new Request(new URL("/mcp", url).toString(), request);
		return createMcpHandler(server)(normalized, env, ctx);
	}

	const id = decodeMcpToken(token);
	if (!id || !env.API_KEY || !(await timingSafeEqualString(id.key, env.API_KEY))) {
		return json({ error: "unauthorized mcp token" }, 401);
	}

	const server = buildMemoryServer(env, ctx, id.userId);
	// Normalize the path to /mcp so the transport never depends on the token suffix.
	const normalized = new Request(new URL("/mcp", url).toString(), request);
	return createMcpHandler(server)(normalized, env, ctx);
}

async function handleCandidateRoutes(request, env, url) {
	if (request.method === "GET" && url.pathname === "/v1/candidates") {
		const auth = await requireMemoryUser(request, env, url.searchParams.get("userId"));
		if (auth.response) return auth.response;
		const status = url.searchParams.get("status") || "pending";
		const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 250);
		return json({ candidates: await listCandidates(env, auth.userId, { status, limit }) });
	}

	if (request.method !== "POST") return json({ error: "not found" }, 404);
	const match = url.pathname.match(/^\/v1\/candidates\/([^/]+)\/(promote|reject|merge)$/);
	if (!match) return json({ error: "not found" }, 404);
	const body = await request.json().catch(() => ({}));
	const auth = await requireMemoryUser(request, env, body.userId, {
		scopeInput: body.memoryScope ?? body.sourceScope,
	});
	if (auth.response) return auth.response;

	const id = decodeURIComponent(match[1]);
	const action = match[2];
	const result = action === "promote"
		? await promoteCandidate(env, auth.userId, id, body)
		: action === "merge"
			? await mergeCandidate(env, auth.userId, id, body)
			: await rejectCandidate(env, auth.userId, id, body);
	if (result?.ok === false) return json({ error: result.error }, result.status ?? 400);
	return json(result);
}
