/**
 * Memory Engine — HTTP API.
 *
 * Storage (Step 1): D1, read by /v1/graph and /v1/status.
 * Extraction (Step 2): /v1/ingest routes each user's messages through their
 * UserMemory Durable Object, which holds/batches and (on fire) runs the
 * extraction pipeline in the background.
 */

import { createMcpHandler } from "agents/mcp";

import { getConfig, LEGACY_HOSTS, PUBLIC_ORIGIN } from "./config.js";
import { responseText } from "./pipeline/llm.js";
import { runAi } from "./lib/ai_meter.js";
import { getUserReceipts } from "./lib/db.js";
import {
	INGEST_DELIVERY_SCHEMA,
	INGEST_LIMITS,
	LEGACY_CLAUDE_OUTBOX_LIMITS,
	isLegacyClaudeOutboxBody,
	normalizeDeliveryMetadata,
	validateIngestBody,
} from "./lib/ingest_contract.mjs";
import { MEMORY_READ_SCOPE, MEMORY_WRITE_SCOPE, tokenAllowsScope } from "./lib/scopes.js";
import { normalizeProjectScope, ProjectScopeError } from "./lib/project_scope.js";
import {
	archiveObject,
	bulkDeleteBySource,
	cleanJunkMemories,
	clearFailedReceipts,
	deleteAccountCompletely,
	deleteAllMemories,
	deleteLastExtraction,
	deleteObject,
	repairGraph,
	storeDeletionTombstone,
} from "./pipeline/cleanup.js";
import { organizeUserClusters, withCluster } from "./pipeline/clusters.js";
import { buildGraphLayout } from "./pipeline/layout.js";
import { listCandidates, mergeCandidate, promoteCandidate, rejectCandidate } from "./pipeline/candidates.js";
import { buildMemoryServer, decodeMcpToken } from "./mcp/server.js";
import { reportServerError } from "./lib/report.js";
import { runManualActionRouter } from "./pipeline/manual_action_router.js";
import {
	runConversationCollectCommand,
	runDirectSaveCommand,
	runObserveMessagesCommand,
	runRecallCommand,
} from "./pipeline/commands.js";
import { getMemoryRules, mergeRuleOverride, saveMemoryRules } from "./pipeline/rules.js";
import { credentialShapeHint, validateBody } from "./lib/params.js";
import { createWebhook, deleteWebhook, emitWebhookEvent, listDeliveries, listWebhooks, webhookDataFromReceipt } from "./pipeline/webhooks.js";
import { listJobs, packetStatus, queueCounters } from "./pipeline/jobs_api.js";
import {
	createThread,
	deleteThread,
	countMessagesToday,
	getThread,
	getThreadMessages,
	listThreads,
	playgroundLimits,
	playgroundTurn,
	reconcileExtractions,
} from "./pipeline/playground.js";
import { normalizeThreadSettings } from "./pipeline/playground_settings.js";
import {
	createExport,
	EXPORT_TABLES,
	exportFileName,
	getExport,
	listExports,
	prepareExportRows,
} from "./pipeline/exports.js";
import {
	changePassword,
	ACCEPTED_TOKEN_PREFIXES,
	clearSessionCookie,
	createConnectionToken,
	deleteConnectionToken,
	getSessionUser,
	googleAuthCallback,
	googleAuthStart,
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

/**
 * Workers rate limiting. No-ops when the binding is absent (tests, local dev
 * without unsafe bindings), fails open on errors — protection, not a gate.
 */
async function allowRate(binding, key) {
	if (!binding?.limit) return true;
	try {
		const { success } = await binding.limit({ key: String(key ?? "anon") });
		return success !== false;
	} catch (error) {
		// Fail open — rate limiting is protection, not a gate — but never silently.
		console.warn("rate limiter unavailable:", error?.message ?? error);
		return true;
	}
}

function clientIp(request) {
	return request.headers.get("cf-connecting-ip") ?? "local";
}

/**
 * The door decides the lens. Bearer-key callers are the SDK profile (their own
 * rules take priority); a caller declaring source:"plugin" gets the coding
 * lens. Effective rules layer account < API key < request body — resolved
 * here once so the engine and the gates enforce the same object.
 */
async function doorOverrides(env, auth, body = {}) {
	const out = {};
	const isToken = auth.auth?.type === "token";
	if (body.source === "plugin") out.profile = "plugin";
	else if (isToken) out.profile = "sdk";

	// Rules belong to the ACCOUNT, not to the memory space being written to.
	// A sub-tenant id (mem_…) is derived and owns no configuration, so looking
	// rules up under it silently returned defaults — an integrator's
	// excludes:["salary"] applied to their own memory and to none of their
	// end users', which is the only place it actually matters.
	const ownerUserId = auth.auth?.userId ?? auth.userId;
	const keyRules = isToken ? auth.auth.token?.rules : null;
	const bodyRules = body.rules && typeof body.rules === "object" ? body.rules : null;
	const scoped = ownerUserId !== auth.userId;
	if (keyRules || bodyRules || scoped) {
		const account = await getMemoryRules(env, ownerUserId);
		out.rules = mergeRuleOverride(mergeRuleOverride(account, keyRules), bodyRules);
	}
	return out;
}

function tooMany() {
	return json({ error: "too_many_requests", message: "Slow down a little — try again in a minute." }, 429);
}

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

/**
 * Parse a memory-endpoint body and refuse unknown parameters. Returns
 * { body } or { response } — an unrecognised key never reaches the engine,
 * because a silently dropped `user_id` is a tenancy leak wearing an ok:true.
 */
async function readBoundedBytes(request, path, { maxBytes = INGEST_LIMITS.maxRequestBytes } = {}) {
	const declaredLength = Number(request.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		return { response: bodyLimitResponse(path, declaredLength, maxBytes) };
	}

	const chunks = [];
	let totalBytes = 0;
	if (request.body) {
		const reader = request.body.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				totalBytes += value.byteLength;
				if (totalBytes > maxBytes) {
					await reader.cancel("request body limit exceeded").catch(() => {});
					return { response: bodyLimitResponse(path, totalBytes, maxBytes) };
				}
				chunks.push(value);
			}
		} finally {
			reader.releaseLock();
		}
	}

	const bytes = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { bytes, requestBytes: totalBytes };
}

async function readBody(request, path, { maxBytes = INGEST_LIMITS.maxRequestBytes } = {}) {
	const bounded = await readBoundedBytes(request, path, { maxBytes });
	if (bounded.response) return bounded;
	const { bytes, requestBytes: totalBytes } = bounded;
	let raw;
	try {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		raw = text ? JSON.parse(text) : {};
	} catch {
		return { response: json({ error: "invalid_json", message: "The request body must be valid UTF-8 JSON." }, 400) };
	}
	const checked = validateBody(path, raw);
	if (checked.error) {
		return { response: json({ error: checked.error, message: checked.message }, 400) };
	}
	return { body: checked.body, requestBytes: totalBytes };
}

function testOnlyOverrides(env, value) {
	if (String(env?.ENABLE_TEST_OVERRIDES ?? "false") !== "true") return {};
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function bodyLimitResponse(path, actual, limit) {
	if (path === "/v1/ingest") {
		const issue = validateIngestBody(null, { requestBytes: actual });
		const { status, ...payload } = issue;
		return json(payload, status);
	}
	if (path === "/mcp") {
		return json({
			jsonrpc: "2.0",
			id: null,
			error: {
				code: -32001,
				message: `The MCP request exceeds ${limit} UTF-8 bytes.`,
				data: { error: "request_too_large", limit, actual, unit: "bytes" },
			},
		}, 413);
	}
	return json({
		error: "request_too_large",
		message: `The serialized request exceeds ${limit} UTF-8 bytes.`,
		limit,
		actual,
		unit: "bytes",
	}, 413);
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

/** True when the request carries an Origin from a different site. */
function isCrossOrigin(request) {
	const origin = request.headers.get("origin");
	if (!origin) return false;
	try { return new URL(origin).origin !== new URL(request.url).origin; }
	catch { return true; }
}

async function resolveMemoryUser(request, env, explicitUserId, { allowLegacy = true, allowedTokenTypes = ["api", "mcp"] } = {}) {
	// Cross-origin browser calls (possible only when CORS is enabled) may
	// authenticate ONLY with a Bearer token: sessions are skipped so a cookie
	// can never act cross-site, and the legacy admin key is refused outright.
	const crossOrigin = env.ENABLE_CORS === "true" && isCrossOrigin(request);

	if (!crossOrigin) {
		const session = await getSessionUser(env, request);
		if (session) return session;
	}

	const token = bearerToken(request);
	if (token) {
		const tokenUser = await resolveConnectionToken(env, token, { allowedTypes: allowedTokenTypes });
		if (tokenUser) return tokenUser;
		return null;
	}

	if (!crossOrigin && allowLegacy && explicitUserId && await isAuthorized(request, env)) {
		return { type: "legacy", userId: explicitUserId, user: null };
	}
	return null;
}

async function requireMemoryUser(request, env, explicitUserId, options = {}) {
	const auth = await resolveMemoryUser(request, env, explicitUserId, options);
	if (auth) {
		if (auth.type === "token") {
			if (options.allowTokenAuth === false) {
				return { response: json({ error: "forbidden", code: "token_not_allowed" }, 403) };
			}
			if (!tokenAllowsScope(auth.token?.scopes, options.requiredScope)) {
				return { response: json({ error: "forbidden", code: "insufficient_scope" }, 403) };
			}
		}
		try {
			const scoped = await resolveScopedMemory(auth, explicitUserId, options.scopeInput);
			const project = normalizeProjectScope(scoped.memoryScope);
			return {
				auth,
				userId: scoped.userId,
				memoryScope: {
					...scoped.memoryScope,
					projectId: project.projectId,
					projectName: project.projectName,
				},
			};
		} catch (error) {
			if (error instanceof ProjectScopeError || error?.name === "ProjectScopeError") {
				return { response: json({
					error: error.code ?? "invalid_project_id",
					code: error.code ?? "invalid_project_id",
					message: String(error.message ?? "Invalid project scope."),
				}, Number(error.status ?? 400)) };
			}
			throw error;
		}
	}
	if (await isAuthorized(request, env)) {
		return { response: json({ error: "userId is required" }, 400) };
	}
	// Say what is actually wrong with the credential. A bare "unauthorized"
	// sends someone hunting a permissions problem when they pasted the wrong
	// KIND of secret entirely.
	const hint = credentialShapeHint(bearerToken(request) ?? request.headers.get("x-api-key"));
	return { response: json({ error: "unauthorized", ...(hint ? { message: hint } : {}) }, 401) };
}

function requireControlUser(request, env, explicitUserId, options = {}) {
	return requireMemoryUser(request, env, explicitUserId, {
		...options,
		allowTokenAuth: false,
	});
}

function cleanScopeValue(value, fallback = null) {
	const text = String(value ?? "").trim();
	return text || fallback;
}

export async function scopedMemoryUserId(ownerUserId, externalUserId) {
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

// Known crawlers/automation. Checked against the visit beacon's user-agent and
// then discarded — the UA itself is never stored anywhere.
const BOT_UA_PATTERN = /bot|crawl|spider|slurp|headless|phantom|selenium|playwright|puppeteer|lighthouse|pingdom|uptime|monitor|scrap|curl|wget|python-requests|httpx|axios|go-http|okhttp|java\/|libwww|facebookexternalhit|preview|prerender|embedly|vkshare|qwantify|bitlybot|telegrambot|whatsapp|discordbot|slackbot|twitterbot|linkedinbot|semrush|ahrefs|mj12|dotbot|petalbot|bytespider|gptbot|claudebot|ccbot|amazonbot|applebot|yandex|baidu|duckduck/i;

const routes = {
	"GET /health": () => json({ ok: true, service: "memory-engine", version: "0.1.0" }),
	"GET /v1/ingest/limits": () => json({
		ok: true,
		schema: "itsuki.ingest-limits/v1",
		limits: INGEST_LIMITS,
		character_unit: "unicode_code_points",
		request_encoding: "utf-8-json",
		delivery_schema: INGEST_DELIVERY_SCHEMA,
	}),

	"GET /auth/me": async (request, env) => {
		const auth = await getSessionUser(env, request);
		if (!auth) return json({ authenticated: false, user: null });
		return json(authPayload(auth));
	},

	"POST /auth/signup": async (request, env) => {
		if (!(await allowRate(env.AUTH_LIMITER, clientIp(request)))) return tooMany();
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
		if (!(await allowRate(env.AUTH_LIMITER, clientIp(request)))) return tooMany();
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

	"GET /auth/google/start": async (request, env) => {
		if (!(await allowRate(env.AUTH_LIMITER, clientIp(request)))) return tooMany();
		const result = googleAuthStart(env, request);
		const headers = new Headers({ location: new URL(result.redirect, request.url).toString() });
		if (result.cookie) headers.append("set-cookie", result.cookie);
		return new Response(null, { status: 302, headers });
	},

	"GET /auth/google/callback": async (request, env) => {
		if (!(await allowRate(env.AUTH_LIMITER, clientIp(request)))) return tooMany();
		const result = await googleAuthCallback(env, request);
		const headers = new Headers({ location: new URL(result.redirect, request.url).toString() });
		for (const cookie of result.cookies ?? []) headers.append("set-cookie", cookie);
		return new Response(null, { status: 302, headers });
	},

	// Benchmark-only LLM pass-through (answerer/judge for evals/locomo). Exists
	// ONLY when EVAL_MODE=1 is set in local .dev.vars — never in production, and
	// deliberately not part of the product: UML's recall path has no generative
	// model; the benchmark answerer lives outside UML and this endpoint is how
	// the harness reaches Workers AI without separate REST credentials.
	"POST /eval/llm": async (request, env) => {
		if (env.EVAL_MODE !== "1") return json({ error: "not_found" }, 404);
		if (request.headers.get("x-api-key") !== env.API_KEY) return json({ error: "unauthorized" }, 401);
		const body = await request.json().catch(() => ({}));
		if (!Array.isArray(body.messages) || body.messages.length === 0) {
			return json({ error: "messages_required" }, 400);
		}
		const model = body.model || env.LLM_MODEL || "@cf/meta/llama-3.1-8b-instruct-fp8";
		const res = await runAi(env, model, {
			messages: body.messages,
			temperature: body.temperature ?? 0,
			max_tokens: body.max_tokens ?? 512,
			// Pass-through for the 6.3 structured-output verification (and any
			// future eval that needs schema-constrained decoding).
			...(body.response_format ? { response_format: body.response_format } : {}),
			...(body.guided_json ? { guided_json: body.guided_json } : {}),
		}, undefined, { task: "eval" });
		return json({ text: responseText(res), model, raw_keys: Object.keys(res ?? {}), ...(body.debug_raw ? { raw: res } : {}) });
	},

	"POST /v1/ingest": async (request, env, ctx) => {
		const parsed = await readBody(request, "/v1/ingest", {
			maxBytes: LEGACY_CLAUDE_OUTBOX_LIMITS.maxRequestBytes,
		});
		if (parsed.response) return parsed.response;
		const body = parsed.body;
		const legacyClaudeOutbox = isLegacyClaudeOutboxBody(body);
		const contractHeaders = legacyClaudeOutbox
			? { "x-itsuki-ingest-contract": "legacy-claude-outbox-v1" }
			: {};
		if (legacyClaudeOutbox) {
			// Content-free migration telemetry. Never log transcript, tenant, key,
			// or packet identifiers from a protected local spool.
			console.warn("legacy_claude_outbox_contract accepted_for_migration");
		}
		const contractViolation = validateIngestBody(body, { requestBytes: parsed.requestBytes });
		if (contractViolation) {
			const { status, ...payload } = contractViolation;
			return json(payload, status, contractHeaders);
		}
		const auth = await requireMemoryUser(request, env, body.userId, {
			scopeInput: body.memoryScope ?? body.sourceScope,
			requiredScope: MEMORY_WRITE_SCOPE,
		});
		if (auth.response) return auth.response;
		if (!(await allowRate(env.SAVE_LIMITER, auth.userId))) return tooMany();
		const { messages, flush } = body;
		if (!Array.isArray(messages)) return json({ error: "messages[] is required" }, 400);

		// Route through the shared command facade. Extraction runs in the
		// background, so fired async requests return an accepted/processing receipt.
		const door = await doorOverrides(env, auth, body);
		const test = testOnlyOverrides(env, body._test);
		const result = await runObserveMessagesCommand(env, ctx, auth.userId, messages, {
			flush: Boolean(flush),
			conversationId: body.conversationId,
			threadId: body.threadId,
			sourceId: body.sourceId,
			idempotencyKey: body.idempotencyKey,
			delivery: normalizeDeliveryMetadata(body.delivery),
			memoryScope: auth.memoryScope,
			source: body.source === "plugin" ? "plugin" : "ingest",
			sourceMode: "ingest",
			overrides: {
				...door,
				...test,
				...(["dense", "standard"].includes(body.captureDensity)
					? { settings: { ...(test.settings ?? {}), captureDensity: body.captureDensity } }
					: {}),
			},
		});
		if (result.backpressure) {
			return json(
				{ error: "queue_full", message: result.summary, retry_after_s: result.retry_after_s, queue_depth: result.queue_depth },
				429,
				{ ...contractHeaders, "retry-after": String(result.retry_after_s ?? 30) },
			);
		}
		if (result.idempotencyConflict) {
			return json({
				error: "idempotency_conflict",
				code: "idempotency_conflict",
				message: result.summary,
				idempotency_key: result.idempotency_key,
				source_packet_id: result.source_packet_id,
			}, 409, contractHeaders);
		}
		return json(result, 200, contractHeaders);
	},

	"POST /v1/mcp/choose": async (request, env) => {
		const body = await request.json().catch(() => ({}));
		const auth = await requireMemoryUser(request, env, body.userId, {
			scopeInput: body.memoryScope ?? body.sourceScope,
		});
		if (auth.response) return auth.response;

		// AutoChoose is a read-only host adapter. It selects and validates an
		// action, but the selected MCP tool remains responsible for its own
		// memory:read or memory:write authorization and all durable work.
		return json(await runManualActionRouter(env, getConfig(env), {
			...body,
			memoryScope: auth.memoryScope,
		}));
	},

	"GET /v1/graph": async (request, env) => {
		const requestedUserId = new URL(request.url).searchParams.get("userId");
		const auth = await requireMemoryUser(request, env, requestedUserId, {
			requiredScope: MEMORY_READ_SCOPE,
		});
		if (auth.response) return auth.response;
		const userId = auth.userId;

		// The whole brain for one user: nodes with ALL their slices (current + old,
		// each carrying is_current) and their events newest-first, plus edges and
		// the loose "maybe" candidates. The graph page renders all of it.
		const [nodesResult, pagesResult, slicesResult, eventsResult, edgesResult, candidatesResult, legacyProjectsResult] = await env.DB.batch([
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
			env.DB.prepare(
				`SELECT sp.memory_user_id, sp.external_user_id, MAX(sp.project_name) AS project_name,
					COUNT(*) AS source_packets, MAX(sp.updated_at) AS last_seen_at,
					(SELECT COUNT(*) FROM nodes n WHERE n.user_id = sp.memory_user_id AND n.deleted_at IS NULL) AS nodes,
					(SELECT COUNT(*) FROM memory_pages p WHERE p.user_id = sp.memory_user_id AND p.deleted_at IS NULL) AS pages
				 FROM source_packets sp
				 WHERE sp.owner_user_id = ? AND sp.memory_user_id != ?
				   AND sp.external_user_id LIKE 'project:%'
				 GROUP BY sp.memory_user_id, sp.external_user_id
				 ORDER BY last_seen_at DESC
				 LIMIT 100`,
			).bind(userId, userId),
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
		const projectMap = new Map();
		const addProjectRows = (kind, rows) => {
			for (const row of rows ?? []) {
				if (!row.project_id) continue;
				const nameAt = Number(row.updated_at ?? row.last_seen_at ?? row.created_at ?? 0);
				const current = projectMap.get(row.project_id) ?? {
					project_id: row.project_id,
					project_name: null,
					_name_at: -1,
					nodes: 0,
					pages: 0,
					slices: 0,
					events: 0,
					edges: 0,
					candidates: 0,
				};
				if (row.project_name && (
					nameAt > current._name_at
					|| (nameAt === current._name_at && String(row.project_name).localeCompare(String(current.project_name ?? "")) > 0)
				)) {
					current.project_name = row.project_name;
					current._name_at = nameAt;
				}
				current[kind] += 1;
				projectMap.set(row.project_id, current);
			}
		};
		addProjectRows("nodes", nodesResult.results);
		addProjectRows("pages", pagesResult.results);
		addProjectRows("slices", slicesResult.results);
		addProjectRows("events", eventsResult.results);
		addProjectRows("edges", edgesResult.results);
		addProjectRows("candidates", candidatesResult.results);
		const projects = [...projectMap.values()]
			.map(({ _name_at, ...project }) => project)
			.sort((a, b) => String(a.project_name ?? a.project_id).localeCompare(String(b.project_name ?? b.project_id)));
		const legacyProjects = [];
		for (const row of legacyProjectsResult.results ?? []) {
			// Source provenance was historically client-extensible. Verify the
			// deterministic subtenant id before using it to expose aggregate counts,
			// so a forged pre-fix row cannot point inventory at another account.
			if (row.memory_user_id !== await scopedMemoryUserId(userId, row.external_user_id)) continue;
			legacyProjects.push(row);
		}

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
			projects,
			legacy_project_scopes: legacyProjects.map((row) => ({
				external_user_id: row.external_user_id,
				project_name: row.project_name ?? (String(row.external_user_id ?? "").replace(/^project:/, "") || null),
				source_packets: row.source_packets ?? 0,
				nodes: row.nodes ?? 0,
				pages: row.pages ?? 0,
				last_seen_at: row.last_seen_at ?? null,
				migration_status: "legacy_subtenant_read_only",
			})),
			scope_model: {
				default_recall: "global",
				project_recall: ["project_only", "project_then_global"],
				global_rows_use_null_project_id: true,
			},
			stats,
			model: config.llm.model,
			models: EXTRACTION_MODELS,
		});
	},

	"POST /v1/save": async (request, env, ctx) => {
		// Manual Path A compatibility lane for the UI test buttons (and direct API
		// callers). MCP saves use pipeline/mcp_engine.js. `_test` injects canned LLM/digest
		// output for deterministic tests; production never sends it.
		const parsed = await readBody(request, "/v1/save");
		if (parsed.response) return parsed.response;
		const body = parsed.body;
		const auth = await requireMemoryUser(request, env, body.userId, {
			scopeInput: body.memoryScope ?? body.sourceScope,
			requiredScope: MEMORY_WRITE_SCOPE,
		});
		if (auth.response) return auth.response;
		if (!(await allowRate(env.SAVE_LIMITER, auth.userId))) return tooMany();
		const { mode, content, messages, scope, n, topic, conversationId, recentContext } = body;

		const t = testOnlyOverrides(env, body._test);
		const overrides = await doorOverrides(env, auth, body);
		if (t.llmResponse !== undefined) overrides.llmResponse = t.llmResponse;
		if (t.settings !== undefined) overrides.settings = t.settings;

		let res;
		if (mode === "conversation") {
			if (!Array.isArray(messages)) return json({ error: "messages[] is required for conversation" }, 400);
			// Engine-path test hooks (edge/reflexion responses) ride through like
			// /v1/ingest's; digestResponse alone selects the legacy digest lane.
			const { digestResponse, ...engineHooks } = t;
			res = await runConversationCollectCommand(env, ctx, auth.userId, {
				messages,
				scope,
				n,
				topic,
				conversationId,
				threadId: body.threadId,
				sourceId: body.sourceId,
				idempotencyKey: body.idempotencyKey,
				memoryScope: auth.memoryScope,
				overrides: { ...overrides, ...engineHooks },
				digestResponse,
			});
			if (res.backpressure) {
				return json(
					{ error: "queue_full", message: res.summary, retry_after_s: res.retry_after_s, queue_depth: res.queue_depth },
					429,
					{ "retry-after": String(res.retry_after_s ?? 30) },
				);
			}
			if (res.idempotencyConflict) {
				return json({
					error: "idempotency_conflict",
					code: "idempotency_conflict",
					message: res.summary,
					idempotency_key: res.idempotency_key,
					source_packet_id: res.source_packet_id,
				}, 409);
			}
		} else {
			if (typeof content !== "string" || !content.trim()) {
				return json({ error: "content is required for a memory save" }, 400);
			}
			res = await runDirectSaveCommand(env, ctx, auth.userId, {
				content,
				recentContext,
				conversationId,
				threadId: body.threadId,
				sourceId: body.sourceId,
				idempotencyKey: body.idempotencyKey,
				memoryScope: auth.memoryScope,
				overrides,
				waitBudgetMs: t.waitBudgetMs,
			});
		}
		return json(res, res?.ok === false ? (res.http_status ?? 400) : 200);
	},

	"POST /v1/beacon": async (request, env) => {
		// First-party visit counting: aggregate counters only — no cookies, no
		// IPs, no identifiers stored. Public by design; lightly rate limited.
		if (!(await allowRate(env.AUTH_LIMITER, `beacon:${clientIp(request)}`))) return json({ ok: true });
		const body = await request.json().catch(() => ({}));
		const kind = ["landing", "app", "legal"].includes(body.kind) ? body.kind : "other";
		const day = new Date().toISOString().slice(0, 10);

		// Bot filter: obvious crawler user-agents and automation flags are
		// counted nowhere. The UA is inspected here and discarded — never stored.
		const userAgent = request.headers.get("user-agent") ?? "";
		if (BOT_UA_PATTERN.test(userAgent) || body.webdriver === true) return json({ ok: true });

		// Admin accounts don't count as product usage: "app" visits should mean
		// real users, not the operator refreshing the console.
		if (kind === "app") {
			const viewer = await getSessionUser(env, request).catch(() => null);
			if (viewer?.user?.role === "admin") return json({ ok: true });
		}

		try {
			const statements = [
				env.DB.prepare(
					`INSERT INTO site_visits (day, kind, count) VALUES (?, ?, 1)
					 ON CONFLICT(day, kind) DO UPDATE SET count = count + 1`,
				).bind(day, kind),
			];

			// Approximate uniques: hash(ip + ua + daily salt), truncated, held in a
			// bounded per-day sketch. Raw ip/ua are never written; the salt dies
			// with the day, so the hash is meaningless tomorrow.
			const dailySalt = `${env.API_KEY}:${day}`;
			const digest = await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(`${clientIp(request)}|${userAgent}|${dailySalt}`),
			);
			const visitorHash = [...new Uint8Array(digest).slice(0, 6)]
				.map((b) => b.toString(16).padStart(2, "0")).join("");
			const row = await env.DB.prepare(
				"SELECT sketch FROM visit_uniques WHERE day = ? AND kind = ?",
			).bind(day, kind).first();
			const seen = new Set((row?.sketch ?? "").split(",").filter(Boolean));
			if (!seen.has(visitorHash) && seen.size < 5000) {
				seen.add(visitorHash);
				statements.push(env.DB.prepare(
					`INSERT INTO visit_uniques (day, kind, sketch, count) VALUES (?, ?, ?, ?)
					 ON CONFLICT(day, kind) DO UPDATE SET sketch = excluded.sketch, count = excluded.count`,
				).bind(day, kind, [...seen].join(","), seen.size));
			}

			// Aggregate dimensions: referrer domain, country, device class.
			const dims = [];
			const referrer = String(body.ref ?? "").slice(0, 200);
			if (referrer) {
				try {
					const domain = new URL(referrer).hostname.replace(/^www\./, "");
					if (domain && !domain.endsWith("workers.dev")) dims.push(["ref", domain]);
				} catch {}
			} else if (kind === "landing") {
				dims.push(["ref", "direct"]);
			}
			const country = request.cf?.country;
			if (country) dims.push(["country", String(country)]);
			dims.push(["device", /mobile|android|iphone|ipad/i.test(userAgent) ? "mobile" : "desktop"]);
			for (const [dim, value] of dims) {
				statements.push(env.DB.prepare(
					`INSERT INTO visit_dims (day, dim, value, count) VALUES (?, ?, ?, 1)
					 ON CONFLICT(day, dim, value) DO UPDATE SET count = count + 1`,
				).bind(day, dim, value.slice(0, 80)));
			}

			await env.DB.batch(statements);
		} catch (error) {
			console.warn("beacon write failed:", error?.message ?? error);
		}
		return json({ ok: true });
	},

	"POST /v1/funnel": async (request, env) => {
		// Funnel step counters (aggregate only): signup_view, signup_done,
		// first_memory. Same privacy shape as the beacon.
		if (!(await allowRate(env.AUTH_LIMITER, `funnel:${clientIp(request)}`))) return json({ ok: true });
		const body = await request.json().catch(() => ({}));
		const step = ["signup_view", "signup_done", "first_memory"].includes(body.step) ? body.step : null;
		if (!step) return json({ ok: true });
		const day = new Date().toISOString().slice(0, 10);
		try {
			await env.DB.prepare(
				`INSERT INTO visit_dims (day, dim, value, count) VALUES (?, 'funnel', ?, 1)
				 ON CONFLICT(day, dim, value) DO UPDATE SET count = count + 1`,
			).bind(day, step).run();
		} catch (error) {
			console.warn("funnel write failed:", error?.message ?? error);
		}
		return json({ ok: true });
	},

	"POST /v1/error-report": async (request, env) => {
		// Automatic client-side error reporting. Public, rate limited, minimal.
		if (!(await allowRate(env.AUTH_LIMITER, `errrep:${clientIp(request)}`))) return json({ ok: true });
		const body = await request.json().catch(() => ({}));
		const auth = await getSessionUser(env, request).catch(() => null);
		try {
			await env.DB.prepare(
				"INSERT INTO error_reports (id, user_id, side, scope, message, created_at) VALUES (?, ?, 'client', ?, ?, ?)",
			).bind(
				`err_${crypto.randomUUID()}`,
				auth?.userId ?? null,
				String(body.scope ?? "client").slice(0, 120),
				String(body.message ?? "").slice(0, 400),
				Date.now(),
			).run();
		} catch (error) {
			console.warn("client error report failed:", error?.message ?? error);
		}
		return json({ ok: true });
	},

	"POST /auth/password": async (request, env) => {
		if (!(await allowRate(env.AUTH_LIMITER, clientIp(request)))) return tooMany();
		const body = await request.json().catch(() => ({}));
		const result = await changePassword(env, request, body);
		if (result.error) return json({ error: result.error }, result.status);
		return json({ ok: true });
	},

	"GET /v1/admin/users": async (request, env) => {
		const auth = await getSessionUser(env, request);
		if (!auth) return json({ error: "unauthorized" }, 401);
		if (auth.user?.role !== "admin") return json({ error: "forbidden" }, 403);
		const query = String(new URL(request.url).searchParams.get("query") ?? "").trim().toLocaleLowerCase("en-US");
		const like = `%${query.replace(/[%_]/g, "")}%`;
		const { results } = await env.DB.prepare(
			`SELECT u.id, u.email, u.name, u.role, u.status, u.created_at, u.terms_accepted_at,
				u.email_verified_at, (u.google_sub IS NOT NULL) AS google_linked,
				(SELECT COUNT(*) FROM nodes n WHERE n.user_id = u.id AND n.deleted_at IS NULL) AS nodes,
				(SELECT COUNT(*) FROM memory_pages p WHERE p.user_id = u.id AND p.deleted_at IS NULL) AS pages,
				(SELECT COUNT(*) FROM receipts r WHERE r.user_id = u.id) AS receipts,
				(SELECT COUNT(*) FROM connection_tokens t WHERE t.user_id = u.id AND t.revoked_at IS NULL) AS tokens,
				(SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen_at
			 FROM users u
			 WHERE (? = '' OR lower(u.email) LIKE ? OR lower(COALESCE(u.name,'')) LIKE ?)
			 ORDER BY u.created_at DESC LIMIT 100`,
		).bind(query, like, like).all();
		return json({ ok: true, users: results ?? [] });
	},

	"POST /v1/admin/users/action": async (request, env) => {
		const auth = await getSessionUser(env, request);
		if (!auth) return json({ error: "unauthorized" }, 401);
		if (auth.user?.role !== "admin") return json({ error: "forbidden" }, 403);
		const body = await request.json().catch(() => ({}));
		const targetId = String(body.userId ?? "").trim();
		const action = String(body.action ?? "").trim();
		if (!targetId) return json({ error: "userId is required" }, 400);
		const target = await env.DB.prepare("SELECT id, email, role, status FROM users WHERE id = ?").bind(targetId).first();
		if (!target) return json({ error: "user not found" }, 404);
		// Lockout protection: the admin cannot delete or demote their own account.
		if (target.id === auth.userId && ["delete", "demote", "disable"].includes(action)) {
			return json({ error: "You cannot do that to your own admin account." }, 400);
		}
		const now = Date.now();
		switch (action) {
			case "disable":
				await env.DB.batch([
					env.DB.prepare("UPDATE users SET status = 'disabled', updated_at = ? WHERE id = ?").bind(now, target.id),
					env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").bind(now, target.id),
				]);
				return json({ ok: true, action, status: "disabled" });
			case "enable":
				await env.DB.prepare("UPDATE users SET status = 'active', updated_at = ? WHERE id = ?").bind(now, target.id).run();
				return json({ ok: true, action, status: "active" });
			case "revoke_sessions":
				await env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").bind(now, target.id).run();
				return json({ ok: true, action });
			case "promote":
				await env.DB.prepare("UPDATE users SET role = 'admin', updated_at = ? WHERE id = ?").bind(now, target.id).run();
				return json({ ok: true, action, role: "admin" });
			case "demote":
				await env.DB.prepare("UPDATE users SET role = 'user', updated_at = ? WHERE id = ?").bind(now, target.id).run();
				return json({ ok: true, action, role: "user" });
			case "delete": {
				const result = await deleteAccountCompletely(env, target.id);
				return json({ ok: true, action, deleted: result.deleted });
			}
			default:
				return json({ error: "unknown action" }, 400);
		}
	},

	"GET /v1/export": async (request, env) => {
		// Data portability: everything the user owns, one JSON download.
		const requestedUserId = new URL(request.url).searchParams.get("userId");
		const auth = await requireMemoryUser(request, env, requestedUserId, {
			requiredScope: MEMORY_READ_SCOPE,
		});
		if (auth.response) return auth.response;
		const userId = auth.userId;
		const tables = EXPORT_TABLES;
		const results = await env.DB.batch(tables.map((table) => prepareExportRows(env, userId, table)));
		const payload = {
			format: "uml-export",
			version: 1,
			exported_at: new Date().toISOString(),
			user_id: userId,
		};
		tables.forEach((table, index) => { payload[table] = results[index].results ?? []; });
		return new Response(JSON.stringify(payload, null, 2), {
			headers: {
				"content-type": "application/json; charset=utf-8",
				"content-disposition": `attachment; filename="uml-export-${new Date().toISOString().slice(0, 10)}.json"`,
			},
		});
	},

	"GET /v1/admin/stats": async (request, env) => {
		// Operator dashboard. Session-only (no token auth) and role-gated.
		const auth = await getSessionUser(env, request);
		if (!auth) return json({ error: "unauthorized" }, 401);
		if (auth.user?.role !== "admin") return json({ error: "forbidden" }, 403);
		const now = Date.now();
		const dayMs = 24 * 60 * 60 * 1000;
		const since14 = now - 14 * dayMs;
		const [users, verifiedUsers, sessionsActive, logins14, signups14, totals, topUsers, visits14, receipts14, failures, activity] = await env.DB.batch([
			env.DB.prepare("SELECT COUNT(*) AS n FROM users"),
			env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE terms_accepted_at IS NOT NULL"),
			env.DB.prepare("SELECT COUNT(DISTINCT user_id) AS n FROM sessions WHERE revoked_at IS NULL AND expires_at > ?").bind(now),
			// Logins = successes only. Failures are a security signal, not logins,
			// and are reported separately below.
			env.DB.prepare(
				`SELECT date(created_at / 1000, 'unixepoch') AS day, COUNT(*) AS n
				 FROM login_events
				 WHERE created_at > ? AND outcome IN ('password_login', 'google_login', 'google_signup', 'signup')
				 GROUP BY day ORDER BY day`,
			).bind(since14),
			env.DB.prepare(
				`SELECT date(created_at / 1000, 'unixepoch') AS day, COUNT(*) AS n
				 FROM users WHERE created_at > ? GROUP BY day ORDER BY day`,
			).bind(since14),
			env.DB.prepare(
				`SELECT
					(SELECT COUNT(*) FROM nodes WHERE deleted_at IS NULL) AS nodes,
					(SELECT COUNT(*) FROM memory_pages WHERE deleted_at IS NULL) AS pages,
					(SELECT COUNT(*) FROM slices WHERE deleted_at IS NULL) AS slices,
					(SELECT COUNT(*) FROM events WHERE deleted_at IS NULL) AS events,
					(SELECT COUNT(*) FROM receipts) AS receipts,
					(SELECT COUNT(*) FROM connection_tokens WHERE revoked_at IS NULL) AS active_tokens`,
			),
			env.DB.prepare(
				`SELECT u.id, u.email, u.name, u.created_at,
					(SELECT COUNT(*) FROM nodes n WHERE n.user_id = u.id AND n.deleted_at IS NULL) AS nodes,
					(SELECT COUNT(*) FROM receipts r WHERE r.user_id = u.id) AS receipts,
					(SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen_at
				 FROM users u ORDER BY receipts DESC LIMIT 20`,
			),
			env.DB.prepare("SELECT day, kind, count FROM site_visits WHERE day >= date('now', '-14 days') ORDER BY day"),
			env.DB.prepare(
				`SELECT date(created_at / 1000, 'unixepoch') AS day, source, COUNT(*) AS n
				 FROM receipts WHERE created_at > ? GROUP BY day, source ORDER BY day`,
			).bind(since14),
			env.DB.prepare(
				`SELECT er.id, er.tool_name, er.status, er.error, er.created_at, u.email
				 FROM extraction_runs er LEFT JOIN users u ON u.id = er.user_id
				 WHERE er.status = 'failed' ORDER BY er.created_at DESC LIMIT 12`,
			),
			env.DB.prepare(
				`SELECT r.created_at, r.source, r.summary, u.email
				 FROM receipts r LEFT JOIN users u ON u.id = r.user_id
				 WHERE COALESCE(r.source, '') != 'recall'
				 ORDER BY r.created_at DESC LIMIT 30`,
			),
		]);
		const runStatuses = await env.DB.prepare(
			"SELECT status, COUNT(*) AS n FROM extraction_runs WHERE created_at > ? GROUP BY status",
		).bind(since14).all().catch(() => ({ results: [] }));
		// Real failures only. Benign browser noise (blocked autoplay, extension
		// "Script error.", ResizeObserver) is aggregated separately so it can
		// never bury an actual problem during a traffic spike.
		const errorReports = await env.DB.prepare(
			`SELECT er.side, er.scope, er.message, er.created_at, u.email
			 FROM error_reports er LEFT JOIN users u ON u.id = er.user_id
			 WHERE COALESCE(er.scope, '') NOT LIKE 'noise:%'
			 ORDER BY er.created_at DESC LIMIT 20`,
		).all().catch(() => ({ results: [] }));
		const noiseSummary = await env.DB.prepare(
			`SELECT CASE
				WHEN message LIKE '%play method is not allowed%' OR message LIKE '%play()%' THEN 'autoplay blocked (browser preference)'
				WHEN message LIKE 'Script error.%' THEN 'cross-origin script (usually a browser extension)'
				WHEN message LIKE '%ResizeObserver loop%' THEN 'ResizeObserver loop notice'
				ELSE 'other benign' END AS kind,
				COUNT(*) AS n, MAX(created_at) AS last_at
			 FROM error_reports
			 WHERE scope LIKE 'noise:%' AND created_at > ?
			 GROUP BY kind ORDER BY n DESC`,
		).bind(since14).all().catch(() => ({ results: [] }));
		const uniques = await env.DB.prepare(
			"SELECT day, kind, count FROM visit_uniques WHERE day >= date('now', '-14 days') ORDER BY day",
		).all().catch(() => ({ results: [] }));
		const dims = await env.DB.prepare(
			`SELECT day, dim, value, count FROM visit_dims
			 WHERE day >= date('now', '-14 days') ORDER BY dim, count DESC`,
		).all().catch(() => ({ results: [] }));
		const failedLogins = await env.DB.prepare(
			`SELECT date(created_at / 1000, 'unixepoch') AS day, COUNT(*) AS n
			 FROM login_events WHERE created_at > ? AND outcome = 'password_failed'
			 GROUP BY day ORDER BY day`,
		).bind(since14).all().catch(() => ({ results: [] }));
		const activation = await env.DB.prepare(
			`SELECT
				(SELECT COUNT(*) FROM users) AS accounts,
				(SELECT COUNT(DISTINCT user_id) FROM nodes WHERE deleted_at IS NULL) AS with_memories`,
		).all().catch(() => ({ results: [{}] }));
		// Part 2.4 — the queue-health numbers the cron sweep alerts on.
		const queue = await queueCounters(env).catch((error) => {
			console.warn("queue counters failed:", error?.message ?? error);
			return null;
		});
		return json({
			ok: true,
			generated_at: now,
			queue,
			users: Number(users.results?.[0]?.n ?? 0),
			consented_users: Number(verifiedUsers.results?.[0]?.n ?? 0),
			active_sessions_users: Number(sessionsActive.results?.[0]?.n ?? 0),
			logins_by_day: logins14.results ?? [],
			signups_by_day: signups14.results ?? [],
			visits_by_day: visits14.results ?? [],
			receipts_by_day: receipts14.results ?? [],
			run_statuses: runStatuses.results ?? [],
			error_reports: errorReports.results ?? [],
			noise_summary: noiseSummary.results ?? [],
			recent_failures: failures.results ?? [],
			activity: activity.results ?? [],
			totals: totals.results?.[0] ?? {},
			top_users: topUsers.results ?? [],
			uniques_by_day: uniques.results ?? [],
			dims: dims.results ?? [],
			failed_logins_by_day: failedLogins.results ?? [],
			activation: activation.results?.[0] ?? {},
		});
	},

	"GET /v1/admin/user-journey": async (request, env) => {
		// Per-user operational timeline: events and metadata ONLY — never memory
		// content. The operator sees what an account did and what broke for it,
		// not what it stored.
		const auth = await getSessionUser(env, request);
		if (!auth) return json({ error: "unauthorized" }, 401);
		if (auth.user?.role !== "admin") return json({ error: "forbidden" }, 403);
		const targetId = new URL(request.url).searchParams.get("id");
		if (!targetId) return json({ error: "id_required" }, 400);
		const target = await env.DB.prepare(
			"SELECT id, email, name, role, status, created_at, terms_accepted_at, google_sub IS NOT NULL AS has_google FROM users WHERE id = ?",
		).bind(targetId).first();
		if (!target) return json({ error: "not_found" }, 404);
		const [logins, receipts, errors, tokens, sessions] = await env.DB.batch([
			env.DB.prepare(
				`SELECT created_at AS at, 'login' AS type, outcome AS detail, reason
				 FROM login_events
				 WHERE user_id = ?1 OR email_normalized = (SELECT lower(email) FROM users WHERE id = ?1)
				 ORDER BY created_at DESC LIMIT 40`,
			).bind(targetId),
			env.DB.prepare(
				`SELECT date(created_at / 1000, 'unixepoch') AS day, source, outcome, COUNT(*) AS n
				 FROM receipts WHERE user_id = ? GROUP BY day, source, outcome ORDER BY day DESC LIMIT 60`,
			).bind(targetId),
			env.DB.prepare(
				"SELECT created_at AS at, side, scope, substr(message, 1, 200) AS message FROM error_reports WHERE user_id = ? ORDER BY created_at DESC LIMIT 25",
			).bind(targetId),
			env.DB.prepare(
				"SELECT label, type, created_at, last_used_at, revoked_at FROM connection_tokens WHERE user_id = ? ORDER BY created_at DESC LIMIT 20",
			).bind(targetId),
			env.DB.prepare(
				"SELECT COUNT(*) AS active, MAX(last_seen_at) AS last_seen FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?",
			).bind(targetId, Date.now()),
		]);
		return json({
			user: target,
			logins: logins.results ?? [],
			usage_by_day: receipts.results ?? [],
			errors: errors.results ?? [],
			tokens: tokens.results ?? [],
			sessions: sessions.results?.[0] ?? {},
		});
	},

	"GET /v1/rules": async (request, env) => {
		const requestedUserId = new URL(request.url).searchParams.get("userId");
		const auth = await requireMemoryUser(request, env, requestedUserId, {
			requiredScope: MEMORY_READ_SCOPE,
		});
		if (auth.response) return auth.response;
		const ownerUserId = auth.auth?.userId ?? auth.userId;
		return json({ ok: true, rules: await getMemoryRules(env, ownerUserId) });
	},

	"PUT /v1/rules": async (request, env) => {
		const body = await request.json().catch(() => ({}));
		const auth = await requireMemoryUser(request, env, body.userId, {
			requiredScope: MEMORY_WRITE_SCOPE,
		});
		if (auth.response) return auth.response;
		const ownerUserId = auth.auth?.userId ?? auth.userId;
		const rules = await saveMemoryRules(env, ownerUserId, body.rules ?? body);
		return json({ ok: true, rules });
	},

	"POST /v1/rules": async (request, env) => {
		// Alias for clients that cannot send PUT.
		const body = await request.json().catch(() => ({}));
		const auth = await requireMemoryUser(request, env, body.userId, {
			requiredScope: MEMORY_WRITE_SCOPE,
		});
		if (auth.response) return auth.response;
		const ownerUserId = auth.auth?.userId ?? auth.userId;
		const rules = await saveMemoryRules(env, ownerUserId, body.rules ?? body);
		return json({ ok: true, rules });
	},

	"POST /v1/turn": async (request, env, ctx) => {
		// One round trip for app builders: recall relevant memory for the newest
		// user message, and (per rules.autoCollect) feed the turn into the
		// auto-collect lane in the background. Auto-recall + auto-capture.
		const parsed = await readBody(request, "/v1/turn");
		if (parsed.response) return parsed.response;
		const body = parsed.body;
		const auth = await requireMemoryUser(request, env, body.userId, {
			scopeInput: body.memoryScope ?? body.sourceScope,
			requiredScope: MEMORY_WRITE_SCOPE,
		});
		if (auth.response) return auth.response;
		if (!(await allowRate(env.SAVE_LIMITER, auth.userId))) return tooMany();
		const messages = Array.isArray(body.messages) ? body.messages : [];
		if (!messages.length && !body.query) {
			return json({ error: "messages[] or query is required" }, 400);
		}
		const lastUser = [...messages].reverse().find((m) => (m?.role ?? "user") === "user");
		const query = String(body.query ?? lastUser?.content ?? "").trim();
		const door = await doorOverrides(env, auth, body);
		// The SDK profile's layered rules govern this door end to end — the
		// autoCollect decision included, so a key's rules can turn capture off.
		const rules = door.rules ?? await getMemoryRules(env, auth.userId);

		const recall = query
			? await runRecallCommand(env, auth.userId, query, {
				conversationId: body.conversationId,
				threadId: body.threadId,
				memoryScope: auth.memoryScope,
				recallScope: body.recallScope,
			})
			: { count: 0, summary: "No query.", packet: null };
		if (recall?.ok === false) return json(recall, recall.http_status ?? 400);

		let collect = { enabled: false };
		if (rules.autoCollect && messages.length) {
			const test = testOnlyOverrides(env, body._test);
			const result = await runObserveMessagesCommand(env, ctx, auth.userId, messages, {
				conversationId: body.conversationId,
				threadId: body.threadId,
				sourceId: body.sourceId,
				idempotencyKey: body.idempotencyKey,
				memoryScope: auth.memoryScope,
				source: body.source === "plugin" ? "plugin" : "ingest",
				sourceMode: "turn",
				overrides: {
					...door,
					rules,
					...test,
					...(["dense", "standard"].includes(body.captureDensity)
						? { settings: { ...(test.settings ?? {}), captureDensity: body.captureDensity } }
						: {}),
			},
			});
			collect = { enabled: true, ...result };
		}
		const ok = collect.ok !== false;
		return json({
			ok,
			recall,
			collect,
			rules: { autoCollect: rules.autoCollect, captureDefault: rules.captureDefault },
		}, ok ? 200 : (collect.backpressure ? 429 : (collect.idempotencyConflict ? 409 : 400)));
	},

	// ---- Playground -------------------------------------------------------
	// Session auth ONLY. An API key or MCP token must not be able to spend a
	// free model call: those doors reach memory, not the chat model.
	"GET /v1/playground": async (request, env) => {
		const auth = await getSessionUser(env, request);
		if (!auth) return json({ error: "unauthorized" }, 401);
		const url = new URL(request.url);
		const threads = await listThreads(env, auth.userId);
		const requested = url.searchParams.get("thread");
		const active = (await getThread(env, auth.userId, requested)) ?? (threads[0]
			? await getThread(env, auth.userId, threads[0].id)
			: null);
		const limits = playgroundLimits(env);
		return json({
			ok: true,
			threads,
			thread: active
				? {
					id: active.id,
					title: active.title,
					settings: normalizeThreadSettings(JSON.parse(active.settings_json || "{}")),
					// Extraction that outran the turn's wait budget lands here.
					messages: await reconcileExtractions(env, auth.userId, await getThreadMessages(env, auth.userId, active.id)),
				}
				: null,
			limits: {
				...limits,
				threadsUsed: threads.length,
				usedToday: await countMessagesToday(env, auth.userId),
			},
		});
	},

	"POST /v1/playground/chat": async (request, env, ctx) => {
		const auth = await getSessionUser(env, request);
		if (!auth) return json({ error: "unauthorized" }, 401);
		if (!(await allowRate(env.SAVE_LIMITER, `pg:${auth.userId}`))) return tooMany();
		const body = await request.json().catch(() => ({}));
		return json(await playgroundTurn(env, ctx, auth.userId, {
			message: body.message,
			threadId: body.threadId,
			overrides: testOnlyOverrides(env, body._test),
		}));
	},

	"POST /v1/playground/thread": async (request, env) => {
		const auth = await getSessionUser(env, request);
		if (!auth) return json({ error: "unauthorized" }, 401);
		const body = await request.json().catch(() => ({}));
		if (body.delete) return json(await deleteThread(env, auth.userId, body.threadId));
		return json(await createThread(env, auth.userId, body.title || "New chat"));
	},

	"PUT /v1/playground/settings": async (request, env) => {
		const auth = await getSessionUser(env, request);
		if (!auth) return json({ error: "unauthorized" }, 401);
		const body = await request.json().catch(() => ({}));
		const thread = await getThread(env, auth.userId, body.threadId);
		if (!thread) return json({ ok: false, message: "Open a chat first, then apply settings to it." }, 404);
		const settings = normalizeThreadSettings(body.settings ?? body);
		await env.DB.prepare("UPDATE playground_threads SET settings_json = ?, updated_at = ? WHERE id = ? AND user_id = ?")
			.bind(JSON.stringify(settings), Date.now(), thread.id, auth.userId).run();
		return json({ ok: true, settings });
	},

	// ---- Memory exports ---------------------------------------------------
	"GET /v1/exports": async (request, env) => {
		const auth = await requireMemoryUser(request, env, new URL(request.url).searchParams.get("userId"), {
			requiredScope: MEMORY_READ_SCOPE,
		});
		if (auth.response) return auth.response;
		return json({ ok: true, exports: await listExports(env, auth.userId) });
	},

	"POST /v1/exports": async (request, env, ctx) => {
		const body = await request.json().catch(() => ({}));
		const auth = await requireMemoryUser(request, env, body.userId, {
			requiredScope: MEMORY_READ_SCOPE,
		});
		if (auth.response) return auth.response;
		const job = await createExport(env, auth.userId, { entity: body.entity });
		// The work happens in the user's Durable Object so a large graph cannot
		// hold this response open. The page polls for the finished row.
		const stub = env.USER_MEMORY.get(env.USER_MEMORY.idFromName(auth.userId));
		const run = stub.runExport(auth.userId, job.id).catch((error) => {
			console.warn(`export dispatch failed user=${auth.userId}:`, error?.message ?? error);
		});
		if (ctx?.waitUntil) ctx.waitUntil(run); else await run;
		return json({ ok: true, export: job }, 201);
	},

	"GET /v1/exports/download": async (request, env) => {
		const url = new URL(request.url);
		const auth = await requireMemoryUser(request, env, url.searchParams.get("userId"), {
			requiredScope: MEMORY_READ_SCOPE,
		});
		if (auth.response) return auth.response;
		const row = await getExport(env, auth.userId, url.searchParams.get("id"));
		if (!row) return json({ error: "not_found", message: "That export is gone. Create a new one." }, 404);
		if (row.status !== "complete" || !row.data) {
			return json({ error: "not_ready", message: "This export is still being built. Refresh in a moment." }, 409);
		}
		return new Response(row.data, {
			headers: {
				"content-type": "application/json; charset=utf-8",
				"content-disposition": `attachment; filename="${exportFileName(row)}"`,
			},
		});
	},

	"GET /v1/requests": async (request, env) => {
		// The Requests page. METADATA ONLY — this query deliberately never
		// selects `summary` or `detail` wholesale, because both can contain the
		// person's own words. The single json_extract below pulls one NUMBER
		// out of detail (rescue call count) — never text. What went through,
		// how long it took, whether it worked, what it cost.
		const url = new URL(request.url);
		const auth = await requireMemoryUser(request, env, url.searchParams.get("userId"), {
			requiredScope: MEMORY_READ_SCOPE,
		});
		if (auth.response) return auth.response;

		const dayMs = 24 * 60 * 60 * 1000;
		const rangeDays = { "1d": 1, "7d": 7, "30d": 30, "90d": 90 }[url.searchParams.get("range") ?? "7d"] ?? 7;
		const fromMs = Date.now() - rangeDays * dayMs;
		const limit = Math.min(Number(url.searchParams.get("limit") ?? 300), 1000);

		const { results } = await env.DB.prepare(
			`SELECT id, source, source_mode, outcome, saved_total, saved_nodes, saved_pages,
				updated_nodes, skipped, latency_ms, matched, created_at, extraction_run_id,
				json_extract(detail, '$.split_rescue_calls') AS split_rescue_calls
			 FROM receipts WHERE user_id = ? AND created_at >= ?
			 ORDER BY created_at DESC LIMIT ?`,
		).bind(auth.userId, fromMs, limit).all();

		return json({
			ok: true,
			range: { days: rangeDays, from: fromMs, to: Date.now() },
			requests: results ?? [],
		});
	},

	"GET /v1/jobs": async (request, env) => {
		// Part 2.2 — the jobs ledger for integrators, scoped to the caller.
		const url = new URL(request.url);
		const auth = await requireMemoryUser(request, env, url.searchParams.get("userId"), {
			requiredScope: MEMORY_READ_SCOPE,
		});
		if (auth.response) return auth.response;
		const jobs = await listJobs(env, auth.userId, {
			status: url.searchParams.get("status") || undefined,
			since: url.searchParams.get("since") || undefined,
			limit: url.searchParams.get("limit") || undefined,
		});
		return json({ ok: true, jobs, count: jobs.length });
	},

	"GET /v1/receipts": async (request, env) => {
		const url = new URL(request.url);
		const auth = await requireMemoryUser(request, env, url.searchParams.get("userId"), {
			requiredScope: MEMORY_READ_SCOPE,
		});
		if (auth.response) return auth.response;
		const userId = auth.userId;
		const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
		const receipts = await getUserReceipts(env, userId, limit);
		return json({ receipts });
	},

	"POST /v1/actions/delete-last-extraction": async (request, env) => {
		const body = await request.json().catch(() => ({}));
		const auth = await requireControlUser(request, env, body.userId);
		if (auth.response) return auth.response;
		return json(await deleteLastExtraction(env, auth.userId));
	},

	"POST /v1/actions/delete-object": async (request, env, ctx) => {
		const body = await request.json().catch(() => ({}));
		const auth = await requireControlUser(request, env, body.userId);
		if (auth.response) return auth.response;
		if (!body.kind || !body.id) return json({ error: "kind and id are required" }, 400);
		const result = await deleteObject(env, auth.userId, body);
		ctx.waitUntil(emitWebhookEvent(env, (p) => ctx.waitUntil(p), auth.userId, "memory.deleted", {
			source: "delete_object",
			counts: { deleted: 1 },
			kind: body.kind,
		}));
		return json(result);
	},

	"POST /v1/actions/archive-object": async (request, env) => {
		const body = await request.json().catch(() => ({}));
		const auth = await requireControlUser(request, env, body.userId);
		if (auth.response) return auth.response;
		if (!body.kind || !body.id) return json({ error: "kind and id are required" }, 400);
		return json(await archiveObject(env, auth.userId, body));
	},

	"POST /v1/actions/delete-all": async (request, env, ctx) => {
		const body = await request.json().catch(() => ({}));
		const auth = await requireControlUser(request, env, body.userId);
		if (auth.response) return auth.response;
		const result = await deleteAllMemories(env, auth.userId, body.confirm);
		if (result.deleted) {
			ctx.waitUntil(emitWebhookEvent(env, (p) => ctx.waitUntil(p), auth.userId, "memory.deleted", {
				source: "delete_all",
				counts: { deleted_all: true },
			}));
		}
		return json(result, result.deleted ? 200 : 400);
	},

	"POST /v1/actions/clean-junk": async (request, env) => {
		const body = await request.json().catch(() => ({}));
		const auth = await requireControlUser(request, env, body.userId);
		if (auth.response) return auth.response;
		return json(await cleanJunkMemories(env, auth.userId, { confirm: body.confirm }));
	},

	"POST /v1/actions/clear-failed-receipts": async (request, env) => {
		const body = await request.json().catch(() => ({}));
		const auth = await requireControlUser(request, env, body.userId);
		if (auth.response) return auth.response;
		return json(await clearFailedReceipts(env, auth.userId));
	},

	"POST /v1/actions/organize-clusters": async (request, env) => {
		const body = await request.json().catch(() => ({}));
		const auth = await requireControlUser(request, env, body.userId);
		if (auth.response) return auth.response;
		return json(await organizeUserClusters(env, auth.userId));
	},

	"POST /v1/actions/repair-graph": async (request, env) => {
		const body = await request.json().catch(() => ({}));
		const auth = await requireControlUser(request, env, body.userId);
		if (auth.response) return auth.response;
		return json(await repairGraph(env, auth.userId, body));
	},

	"POST /v1/recall": async (request, env) => {
		const parsed = await readBody(request, "/v1/recall");
		if (parsed.response) return parsed.response;
		const body = parsed.body;
		const auth = await requireMemoryUser(request, env, body.userId, {
			scopeInput: body.memoryScope ?? body.sourceScope,
			requiredScope: MEMORY_READ_SCOPE,
		});
		if (auth.response) return auth.response;
		const { query } = body;
		if (typeof query !== "string") return json({ error: "query is required" }, 400);

		const result = await runRecallCommand(env, auth.userId, query, {
			sourceId: body.sourceId,
			idempotencyKey: body.idempotencyKey,
			threadId: body.threadId,
			conversationId: body.conversationId,
			topic: body.topic,
			memoryScope: auth.memoryScope,
			recallScope: body.recallScope,
		});
		return json(result, result?.ok === false ? (result.http_status ?? 400) : 200);
	},

	"GET /v1/usage": async (request, env) => {
		// Per-user activity rollups for the dashboard and SDK. Read scope; the
		// caller sees only their own (or their sub-tenant's) numbers. Computed
		// live from receipts + content tables — nothing new is tracked.
		const url = new URL(request.url);
		const auth = await requireMemoryUser(request, env, url.searchParams.get("userId"), {
			requiredScope: MEMORY_READ_SCOPE,
		});
		if (auth.response) return auth.response;
		const userId = auth.userId;

		const dayMs = 24 * 60 * 60 * 1000;
		const rangeParam = String(url.searchParams.get("range") ?? "30d");
		const rangeDays = { "1d": 1, "7d": 7, "30d": 30, all: 366 }[rangeParam] ?? 30;
		let fromMs = Date.now() - rangeDays * dayMs;
		let toMs = Date.now();
		const fromParam = url.searchParams.get("from");
		const toParam = url.searchParams.get("to");
		if (!url.searchParams.get("range") && fromParam && toParam) {
			const from = Date.parse(`${fromParam}T00:00:00Z`);
			const to = Date.parse(`${toParam}T23:59:59Z`);
			if (Number.isFinite(from) && Number.isFinite(to) && to > from && to - from <= 366 * dayMs) {
				fromMs = from;
				toMs = to;
			}
		}

		const [byDay, bySource, memoriesByDay, totals, lastActivity] = await env.DB.batch([
			env.DB.prepare(
				`SELECT date(created_at / 1000, 'unixepoch') AS day,
					SUM(source = 'recall') AS recalls,
					SUM(source != 'recall') AS saves,
					SUM(CASE WHEN source != 'recall' THEN COALESCE(saved_total, 0) ELSE 0 END) AS saved,
					SUM(COALESCE(skipped, 0)) AS skipped
				 FROM receipts WHERE user_id = ? AND created_at BETWEEN ? AND ?
				 GROUP BY day ORDER BY day`,
			).bind(userId, fromMs, toMs),
			env.DB.prepare(
				`SELECT source, COUNT(*) AS count, SUM(COALESCE(saved_total, 0)) AS saved_total
				 FROM receipts WHERE user_id = ? AND created_at BETWEEN ? AND ?
				 GROUP BY source ORDER BY count DESC`,
			).bind(userId, fromMs, toMs),
			env.DB.prepare(
				`SELECT day, SUM(n) AS memories_added FROM (
					SELECT date(created_at / 1000, 'unixepoch') AS day, COUNT(*) AS n
					 FROM nodes WHERE user_id = ? AND created_at BETWEEN ? AND ? AND deleted_at IS NULL GROUP BY day
					UNION ALL
					SELECT date(created_at / 1000, 'unixepoch') AS day, COUNT(*) AS n
					 FROM memory_pages WHERE user_id = ? AND created_at BETWEEN ? AND ? AND deleted_at IS NULL GROUP BY day
				 ) GROUP BY day ORDER BY day`,
			).bind(userId, fromMs, toMs, userId, fromMs, toMs),
			env.DB.prepare(
				`SELECT
					(SELECT COUNT(*) FROM nodes WHERE user_id = ?1 AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL) AS nodes,
					(SELECT COUNT(*) FROM memory_pages WHERE user_id = ?1 AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL) AS pages,
					(SELECT COUNT(*) FROM slices WHERE user_id = ?1 AND deleted_at IS NULL) AS slices,
					(SELECT COUNT(*) FROM events WHERE user_id = ?1 AND deleted_at IS NULL) AS events,
					(SELECT COUNT(*) FROM receipts WHERE user_id = ?1 AND source = 'recall' AND created_at BETWEEN ?2 AND ?3) AS recalls,
					(SELECT COUNT(*) FROM receipts WHERE user_id = ?1 AND source != 'recall' AND created_at BETWEEN ?2 AND ?3) AS saves`,
			).bind(userId, fromMs, toMs),
			env.DB.prepare("SELECT MAX(created_at) AS at FROM receipts WHERE user_id = ?").bind(userId),
		]);

		const memoriesMap = new Map((memoriesByDay.results ?? []).map((row) => [row.day, row.memories_added]));
		const days = (byDay.results ?? []).map((row) => ({ ...row, memories_added: memoriesMap.get(row.day) ?? 0 }));
		for (const [day, added] of memoriesMap) {
			if (!days.some((row) => row.day === day)) days.push({ day, saves: 0, recalls: 0, saved: 0, skipped: 0, memories_added: added });
		}
		days.sort((a, b) => a.day.localeCompare(b.day));
		const t = totals.results?.[0] ?? {};
		return json({
			ok: true,
			range: {
				from: new Date(fromMs).toISOString().slice(0, 10),
				to: new Date(toMs).toISOString().slice(0, 10),
				days: Math.round((toMs - fromMs) / dayMs),
			},
			totals: {
				memories: (t.nodes ?? 0) + (t.pages ?? 0),
				nodes: t.nodes ?? 0, pages: t.pages ?? 0, slices: t.slices ?? 0, events: t.events ?? 0,
				saves: t.saves ?? 0, recalls: t.recalls ?? 0,
				requests: (t.saves ?? 0) + (t.recalls ?? 0),
			},
			by_day: days,
			by_source: bySource.results ?? [],
			last_activity_at: lastActivity.results?.[0]?.at ?? null,
		});
	},

	"GET /v1/status": async (request, env) => {
		const auth = await requireMemoryUser(request, env, new URL(request.url).searchParams.get("userId"), {
			requiredScope: MEMORY_READ_SCOPE,
		});
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

const FRIENDLY_FAILURE = "Something went wrong on our side. It has been reported automatically — please try again in a moment.";

export default {
	/**
	 * Workers Cron Trigger — the reconciliation sweep (Part 1.8). Runs on its
	 * own clock, independent of the Durable Object alarm chains it audits.
	 */
	async scheduled(controller, env, ctx) {
		const { runReconciliationSweep } = await import("./pipeline/sweep.js");
		const { retryPendingWebhookDeliveries } = await import("./pipeline/webhooks.js");
		ctx.waitUntil(runReconciliationSweep(env));
		ctx.waitUntil(retryPendingWebhookDeliveries(env, (promise) => ctx.waitUntil(promise)));
	},

	async fetch(request, env, ctx) {
		// Users must never see a raw exception or an infrastructure error page:
		// every unhandled failure is reported for the admin and answered with one
		// calm, generic message.
		try {
			return await handleRequest(request, env, ctx);
		} catch (error) {
			const scope = (() => { try { return new URL(request.url).pathname; } catch { return "unknown"; } })();
			ctx.waitUntil(reportServerError(env, scope, error));
			return json({ error: "something_went_wrong", message: FRIENDLY_FAILURE }, 500);
		}
	},
};

// CORS is opt-in (ENABLE_CORS="true") and applies ONLY to /v1/*: browser apps
// authenticate with Bearer tokens, never cookies (allow-credentials is never
// sent, and resolveMemoryUser skips sessions cross-origin). /auth, /mcp,
// admin, and control routes stay same-origin.
const CORS_HEADERS = {
	"access-control-allow-methods": "GET,POST,PUT,OPTIONS",
	"access-control-allow-headers": "authorization, content-type, x-uml-token",
	"access-control-max-age": "86400",
};

function withCors(response, origin) {
	const headers = new Headers(response.headers);
	headers.set("access-control-allow-origin", origin);
	headers.append("vary", "origin");
	for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
	return new Response(response.body, { status: response.status, headers });
}

async function handleRequest(request, env, ctx) {
		const url = new URL(request.url);

		const corsOrigin = env.ENABLE_CORS === "true" && url.pathname.startsWith("/v1/")
			? request.headers.get("origin") : null;
		if (corsOrigin && request.method === "OPTIONS") {
			return withCors(new Response(null, { status: 204 }), corsOrigin);
		}
		if (corsOrigin) {
			const response = await handleRequestInner(request, env, ctx, url);
			return withCors(response, corsOrigin);
		}
		return handleRequestInner(request, env, ctx, url);
}

// HTML paths a legacy host 301s to the canonical origin. API and MCP paths are
// deliberately absent: both hosts serve those natively, forever.
const REDIRECT_EXACT_PATHS = new Set(["/", "/terms", "/privacy", "/app", "/login", "/signup"]);

function isRedirectableHtmlPath(pathname) {
	return REDIRECT_EXACT_PATHS.has(pathname) || pathname === "/docs" || pathname.startsWith("/docs/");
}

async function handleRequestInner(request, env, ctx, url) {
		if (
			(request.method === "GET" || request.method === "HEAD") &&
			LEGACY_HOSTS.includes(url.hostname) &&
			isRedirectableHtmlPath(url.pathname)
		) {
			return Response.redirect(`${PUBLIC_ORIGIN}${url.pathname}${url.search}`, 301);
		}

		if ((request.method === "GET" || request.method === "HEAD") && ["/terms", "/privacy"].includes(url.pathname)) {
			// Legal pages must resolve on a direct visit (directory listings,
			// payment-provider reviews) — serve the shell; the client routes it.
			return redirectTo(request, `/?view=${url.pathname.slice(1)}`);
		}

		if ((request.method === "GET" || request.method === "HEAD") && ["/app", "/login", "/signup"].includes(url.pathname)) {
			const auth = await getSessionUser(env, request);
			if (url.pathname === "/app") return redirectTo(request, auth ? "/?app=1" : "/?view=login");
			return redirectTo(request, auth ? "/?app=1" : `/?view=${url.pathname.slice(1)}`);
		}

		// MCP door for supported clients. Prefer Bearer auth on /mcp; generated
		// connector links and legacy clients may carry identity in the path token.
		// This bypasses the x-api-key gate and authenticates the token itself.
		if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
			return handleMcp(request, env, ctx, url);
		}

		if (request.method === "POST" && url.pathname.startsWith("/auth/tokens/") && url.pathname.endsWith("/revoke")) {
			const auth = await getSessionUser(env, request);
			if (!auth) return json({ error: "unauthorized" }, 401);
			const id = url.pathname.slice("/auth/tokens/".length).replace(/\/revoke$/, "");
			return json(await revokeConnectionToken(env, auth.userId, id));
		}

		// The app offers one action per key now: delete. Revoke stays reachable
		// above for anything already scripted against it.
		if (request.method === "DELETE" && url.pathname.startsWith("/auth/tokens/")) {
			const auth = await getSessionUser(env, request);
			if (!auth) return json({ error: "unauthorized" }, 401);
			const id = url.pathname.slice("/auth/tokens/".length);
			if (!id) return json({ error: "not found" }, 404);
			return json(await deleteConnectionToken(env, auth.userId, decodeURIComponent(id)));
		}

		if (url.pathname === "/v1/candidates" || url.pathname.startsWith("/v1/candidates/")) {
			return handleCandidateRoutes(request, env, url, ctx);
		}

		// Real delete for API keys (Part 3). Sessions keep full power; Bearer
		// keys are scoped to their account (and sub-tenant when userId given).
		if (request.method === "DELETE" && (url.pathname === "/v1/memories" || url.pathname.startsWith("/v1/memories/"))) {
			return handleMemoryDeleteRoutes(request, env, url, ctx);
		}

		// Packet status (Part 2.1): the public handle every receipt carries.
		{
			const match = url.pathname.match(/^\/v1\/packets\/([^/]+)\/status$/);
			if (match && request.method === "GET") {
				const auth = await requireMemoryUser(request, env, url.searchParams.get("userId"), {
					requiredScope: MEMORY_READ_SCOPE,
				});
				if (auth.response) return auth.response;
				const status = await packetStatus(env, auth.userId, decodeURIComponent(match[1]));
				if (!status) return json({ error: "not_found", message: "No accepted write with that source_packet_id." }, 404);
				return json({ ok: true, ...status });
			}
		}

		if (url.pathname === "/v1/webhooks" || url.pathname.startsWith("/v1/webhooks/")) {
			return handleWebhookRoutes(request, env, ctx, url);
		}

		const handler = routes[`${request.method} ${url.pathname}`];

		if (!handler) {
			// run_worker_first hands the HTML paths to the worker on every host so
			// the legacy redirect above can see them; on the canonical host they
			// fall through here to the static assets they always were.
			if (
				(request.method === "GET" || request.method === "HEAD") &&
				env.ASSETS &&
				(url.pathname === "/" || url.pathname === "/docs" || url.pathname.startsWith("/docs/"))
			) {
				return env.ASSETS.fetch(request);
			}
			return json({ error: "not found" }, 404);
		}

		return handler(request, env, ctx);
}

/** Read `Authorization: Bearer <token>`, or "" when the header is absent. */
function bearerFromRequest(request) {
	const match = /^Bearer\s+(.+)$/i.exec((request.headers.get("authorization") || "").trim());
	return match ? match[1].trim() : "";
}

/**
 * 401 with a reason. MCP clients surface the body when a connection fails, and
 * "unauthorized" on its own has cost people an afternoon of guessing.
 */
function unauthorizedMcp(message) {
	return json({ error: "unauthorized mcp token", message }, 401, {
		"www-authenticate": 'Bearer realm="itsuki", error="invalid_token"',
	});
}

/** Build the server for an identity and hand a bounded request to the transport. */
async function serveMcp(request, env, ctx, url, userId, scopes) {
	const server = buildMemoryServer(env, ctx, userId, scopes ? { scopes } : undefined);
	// Normalize the path to /mcp so the transport never depends on the token suffix.
	let normalized;
	if (!["GET", "HEAD"].includes(request.method) && request.body) {
		// The transport parses JSON internally, so bound the raw stream first and
		// rebuild the Request. This protects chunked and lying-Content-Length
		// requests without buffering more than one accepted MCP envelope.
		const bounded = await readBoundedBytes(request, "/mcp", {
			maxBytes: INGEST_LIMITS.maxRequestBytes,
		});
		if (bounded.response) return bounded.response;
		const headers = new Headers(request.headers);
		headers.delete("content-length");
		normalized = new Request(new URL("/mcp", url).toString(), {
			method: request.method,
			headers,
			body: bounded.bytes,
			redirect: request.redirect,
			signal: request.signal,
		});
	} else {
		normalized = new Request(new URL("/mcp", url).toString(), request);
	}
	return createMcpHandler(server)(normalized, env, ctx);
}

/**
 * Authenticate the caller, then serve the MCP Streamable HTTP endpoint. Two
 * doors reach the same server:
 *
 *   POST /mcp/<token>  — identity in the path, which is what an MCP link is
 *   POST /mcp          — identity in `Authorization: Bearer <key>`
 *
 * The header door exists so a client can ship a fixed URL and still be
 * per-user: the plugin hardcodes https://itsuki.app/mcp and sends the same
 * sensitive plugin userConfig key its hooks receive, instead of asking for a
 * second per-account URL that only the app can mint.
 */
async function handleMcp(request, env, ctx, url) {
	const pathToken = url.pathname.slice("/mcp/".length).split("/")[0];

	if (ACCEPTED_TOKEN_PREFIXES.some((prefix) => pathToken?.startsWith(prefix))) {
		const auth = await resolveConnectionToken(env, pathToken, { allowedTypes: ["mcp"] });
		if (!auth) {
			// The most common way to land here is pasting an API key where an
			// MCP link belongs. Name that precisely — the generic message sends
			// people off to regenerate a link that was never the problem.
			const asApiKey = await resolveConnectionToken(env, pathToken, { allowedTypes: ["api"] });
			if (asApiKey) {
				return unauthorizedMcp(
					"That is an API key, not an MCP link. API keys authenticate at POST /mcp with an 'Authorization: Bearer <key>' header — only MCP links (created as MCP in the app) go in the URL.",
				);
			}
			return unauthorizedMcp("That MCP link is revoked, expired, or not an MCP token.");
		}
		return serveMcp(request, env, ctx, url, auth.userId, auth.token?.scopes ?? []);
	}

	// Header door. `api` is allowed as well as `mcp`; clients keep the credential
	// in their own protected configuration (Claude uses sensitive userConfig).
	const bearer = bearerFromRequest(request);
	if (!pathToken && bearer) {
		const auth = await resolveConnectionToken(env, bearer, { allowedTypes: ["api", "mcp"] });
		if (!auth) {
			return unauthorizedMcp(
				"That key is revoked or not valid. Create one at https://itsuki.app under API keys, then configure it in your client (Claude plugin users: use /plugin).",
			);
		}
		return serveMcp(request, env, ctx, url, auth.userId, auth.token?.scopes ?? []);
	}

	const id = decodeMcpToken(pathToken);
	if (!id || !env.API_KEY || !(await timingSafeEqualString(id.key, env.API_KEY))) {
		return unauthorizedMcp(
			pathToken || bearer
				? "That credential is not valid for MCP."
				: "No credential. Send Authorization: Bearer <your API key> to /mcp, or connect an MCP link URL.",
		);
	}

	return serveMcp(request, env, ctx, url, id.userId, null);
}

/**
 * Webhooks are standing configuration, so they authenticate like keys do:
 * session only, never a bearer token (a leaked API key must not be able to
 * silently point a user's memory events somewhere new).
 */
async function handleWebhookRoutes(request, env, ctx, url) {
	const auth = await getSessionUser(env, request);
	if (!auth) return json({ error: "unauthorized" }, 401);
	const userId = auth.userId;

	if (request.method === "GET" && url.pathname === "/v1/webhooks") {
		return json({ webhooks: await listWebhooks(env, userId) });
	}
	if (request.method === "POST" && url.pathname === "/v1/webhooks") {
		const body = await request.json().catch(() => ({}));
		const result = await createWebhook(env, userId, body);
		if (result.error) return json({ error: "invalid_webhook", message: result.error }, 400);
		return json(result, 201);
	}

	const rest = url.pathname.slice("/v1/webhooks/".length);
	const [id, sub] = rest.split("/");
	if (!id) return json({ error: "not found" }, 404);

	if (request.method === "DELETE" && !sub) {
		return json(await deleteWebhook(env, userId, decodeURIComponent(id)));
	}
	if (request.method === "GET" && sub === "deliveries") {
		return json({ deliveries: await listDeliveries(env, userId, decodeURIComponent(id)) });
	}
	if (request.method === "POST" && sub === "test") {
		// A synthetic event so a receiver can be verified before anything real
		// flows. Uses the exact signing and delivery path.
		await emitWebhookEvent(env, (p) => ctx.waitUntil(p), userId, "memory.added", {
			source: "webhook_test",
			receipt_id: null,
			counts: { nodes: 1, updated_nodes: 0, slices: 1, events: 0, edges: 0 },
			new_node_labels: ["Webhook test"],
		});
		return json({ ok: true, sent: true });
	}
	return json({ error: "not found" }, 404);
}

/**
 * DELETE /v1/memories/:id and DELETE /v1/memories?source=&before=&after=
 * (fix round 1, Part 3). API keys are first-class here — the old blanket
 * token_not_allowed on delete routes meant key holders could write forever
 * and remove nothing. Bulk defaults to dry_run; destruction needs confirm.
 */
async function handleMemoryDeleteRoutes(request, env, url) {
	const auth = await requireMemoryUser(request, env, url.searchParams.get("userId"), {
		requiredScope: MEMORY_WRITE_SCOPE,
	});
	if (auth.response) return auth.response;
	if (!(await allowRate(env.SAVE_LIMITER, `del:${auth.userId}`))) return tooMany();
	const by = auth.auth?.type === "token" ? `token:${auth.auth.token?.id ?? "unknown"}` : auth.auth?.type ?? "session";

	const id = url.pathname === "/v1/memories" ? null : decodeURIComponent(url.pathname.slice("/v1/memories/".length));
	if (id) {
		const kind = id.startsWith("node_") ? "node"
			: id.startsWith("page_") ? "page"
				: id.startsWith("slice_") ? "slice"
					: id.startsWith("cand") ? "candidate"
						: null;
		if (!kind) {
			return json({ error: "bad_request", message: "Unrecognized memory id — expected a node_, page_, slice_, or candidate id." }, 400);
		}
		const table = kind === "page" ? "memory_pages"
			: kind === "node" ? "nodes"
				: kind === "slice" ? "slices"
					: "candidates";
		const exists = await env.DB.prepare(
			`SELECT id, project_id, project_name FROM ${table} WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
		).bind(id, auth.userId).first();
		if (!exists) return json({ error: "not_found" }, 404);
		const result = await deleteObject(env, auth.userId, { kind, id, suppress: url.searchParams.get("suppress") !== "false" });
		await storeDeletionTombstone(env, auth.userId, {
			kind,
			ids: [id],
			by,
			source: "delete_memory",
			projectScopes: [{ project_id: exists.project_id ?? null, project_name: exists.project_name ?? null }],
		});
		return json({ ok: true, ...result });
	}

	// Bulk by source/time. dry_run defaults TRUE; only confirm=true destroys.
	const dryRunParam = url.searchParams.get("dry_run");
	const confirm = url.searchParams.get("confirm") === "true";
	const result = await bulkDeleteBySource(env, auth.userId, {
		source: url.searchParams.get("source") || null,
		before: url.searchParams.get("before") || null,
		after: url.searchParams.get("after") || null,
		dryRun: dryRunParam === null ? !confirm : dryRunParam !== "false",
		confirm,
		by,
	});
	return json(result);
}

async function handleCandidateRoutes(request, env, url, ctx) {
	if (request.method === "GET" && url.pathname === "/v1/candidates") {
		const auth = await requireControlUser(request, env, url.searchParams.get("userId"));
		if (auth.response) return auth.response;
		const status = url.searchParams.get("status") || "pending";
		const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 250);
		return json({ candidates: await listCandidates(env, auth.userId, { status, limit }) });
	}

	if (request.method !== "POST") return json({ error: "not found" }, 404);
	const match = url.pathname.match(/^\/v1\/candidates\/([^/]+)\/(promote|reject|merge)$/);
	if (!match) return json({ error: "not found" }, 404);
	const body = await request.json().catch(() => ({}));
	const auth = await requireControlUser(request, env, body.userId, {
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
	if (["promote", "merge"].includes(action) && ctx) {
		// A candidate becoming a real memory is the "categorised" moment.
		ctx.waitUntil(emitWebhookEvent(env, (p) => ctx.waitUntil(p), auth.userId, "memory.categorized", {
			source: `candidate_${action}`,
			counts: { categorized: 1 },
		}));
	}
	return json(result);
}
