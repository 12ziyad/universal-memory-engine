/**
 * Memory Engine — HTTP API.
 *
 * Storage (Step 1): D1, read by /v1/graph and /v1/status.
 * Extraction (Step 2): /v1/ingest routes each user's messages through their
 * UserMemory Durable Object, which holds/batches and (on fire) runs the
 * extraction pipeline in the background.
 */

import { createMcpHandler } from "agents/mcp";

import { CATEGORIES, getConfig, LEGACY_HOSTS, PUBLIC_ORIGIN } from "./config.js";
import { responseText } from "./pipeline/llm.js";
import { runAi } from "./lib/ai_meter.js";
import { previewMemoryRules } from "./lib/rules_preview.js";
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
import { memoryV3Enabled, memoryV3Status } from "./lib/memory_v3.js";
import { normalizeProjectScope, ProjectScopeError } from "./lib/project_scope.js";
import {
	createManagedProject,
	getManagedProjectForUser,
	listManagedProjects,
	ManagedProjectError,
	managedProjectMemoryOwnerId,
	registerProjectMemorySpace,
	resolveManagedProject,
	updateManagedProject,
} from "./lib/managed_projects.js";
import {
	can,
	capabilityGuardStatement,
	capabilitiesFor,
	createOrganization,
	ensureDefaultOrganization,
	getOrganization,
	listOrganizations,
	listOrganizationMembers,
	listProjectMembers,
	OrgError,
	removeOrganizationMember,
	removeProjectMember,
	resolveMembership,
	setOrganizationRole,
	setProjectRole,
	updateProjectRole,
	updateOrganization,
} from "./lib/organizations.js";
import {
	acceptInvitation,
	createInvitation,
	describeInvitation,
	listInvitations,
	resendInvitation,
	revokeInvitation,
} from "./lib/invitations.js";
import { processInvitationEmailOutbox } from "./lib/invitation_email.js";
import {
	AuditReplayError,
	AuditUnavailableError,
	auditedMutationResult,
	auditInvariantStatement,
	auditRequestId,
	auditDiff,
	commitAuditedAccess,
	decodeAuditCursor,
	deriveRequestId,
	commitAuditedBatch,
	drainAuditCompletions,
	emailDomain,
	exportAuditCsv,
	listAuditEvents,
	reconcileStaleAuditIntents,
	runAuditedMutation,
	systemRequestId,
	withAuditRequestId,
	withResponseRequestId,
} from "./lib/audit.js";
import {
	activeCategoryRules,
	activeCategoryRulesReadOnly,
	CATEGORY_COLOR_TOKENS,
	createProjectCategory,
	deleteProjectCategory,
	listProjectCategories,
	projectCategoryMetadata,
	reassignProjectCategory,
	setProjectCategoryStatus,
	updateProjectCategory,
} from "./lib/project_categories.js";
import {
	RetentionError,
	activateRetentionPolicy,
	listRetentionPolicies,
	listRetentionRuns,
	previewRetentionChange,
	processQueuedRetentionRuns,
	processRetentionRun,
	scheduleRetentionRuns,
} from "./lib/retention.js";
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
import { cleanClientSource } from "./pipeline/source.js";
import { getMemory, listMemories, parseInventoryListOptions } from "./lib/memory_inventory.js";
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
import { resolveAdmissionRules } from "./pipeline/admission.js";
import {
	getMemoryRules,
	getMemoryRulesState,
	MemoryRulesConflictError,
	mergeRuleOverride,
	narrowManagedMemoryRules,
	rulesRejection,
	saveMemoryRulesIfCurrent,
} from "./pipeline/rules.js";
import { credentialShapeHint, validateBody } from "./lib/params.js";
import {
	createWebhook,
	deleteWebhook,
	emitWebhookEvent,
	listDeliveries,
	listWebhooks,
	queueAuditedWebhookTest,
	webhookDataFromReceipt,
} from "./pipeline/webhooks.js";
import { listJobs, packetStatus, queueCounters } from "./pipeline/jobs_api.js";
import { operatorOverview } from "./pipeline/ops.js";
import { DashboardRangeError, projectDashboard } from "./pipeline/dashboard.js";
import {
	createThread,
	deleteThread,
	countMessagesToday,
	getThread,
	getThreadMessages,
	listThreads,
	playgroundLimits,
	playgroundPreviewExtract,
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
import { allowRate, managedActorRateKey, RATE_BUCKETS } from "./lib/rate.js";
import { LIMITS_SCHEMA, RATE_LIMITS_DOC } from "./lib/limits_contract.mjs";
import { aiBudget, aiLimitsDocument, checkAiBudget, countWritesThisMonth, derivedNeurons, startOfNextUtcMonth } from "./lib/ai_budget.js";

function clientIp(request) {
	return request.headers.get("cf-connecting-ip") ?? "local";
}

function configurationOwnerUserId(auth) {
	// The legacy operator door already receives the exact target identity; it
	// has no managed-project context. Session/token callers use the managed
	// project's root so configuration is shared by that project's sub-tenants.
	if (auth.auth?.type === "legacy") return auth.userId;
	return auth.memoryScope?.ownerUserId ?? auth.auth?.userId ?? auth.userId;
}

/**
 * SRV-01: `source` on a write is the caller's own label — the identity that
 * `DELETE /v1/memories?source=X` later filters on. A value the deletion
 * filter could never match must be refused at the door, not silently
 * dropped: dropping it is exactly how rows became undeletable by name.
 */
function clientSourceFromBody(body = {}) {
	if (body.source == null) return { clientSource: null };
	const clientSource = cleanClientSource(body.source);
	if (!clientSource) {
		return {
			response: json({
				error: "source must be a 1-64 character string with no control characters",
				field: "source",
			}, 400),
		};
	}
	return { clientSource };
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
	const ownerUserId = configurationOwnerUserId(auth);
	const keyRules = isToken ? auth.auth.token?.rules : null;
	const bodyRules = body.rules && typeof body.rules === "object" ? body.rules : null;
	const scoped = ownerUserId !== auth.userId;
	if (auth.managedProject) {
		// Organization-managed projects are governed by a parent policy. API-key
		// and per-request rules may make that policy narrower, but can never erase
		// an account/project deny or broaden an include allow-list.
		const account = await getMemoryRules(env, ownerUserId, { failClosed: true });
		out.rules = narrowManagedMemoryRules(
			narrowManagedMemoryRules(account, keyRules),
			bodyRules,
		);
		out.rules.projectCategories = await activeCategoryRules(env, {
			projectId: auth.managedProject.id,
			memoryOwnerUserId: ownerUserId,
			legacy: account.customCategories ?? [],
		});
		out.rulePolicy = {
			schema: "itsuki.admission-policy/v1",
			mode: "managed_narrow",
			layers: [keyRules, bodyRules].filter(Boolean),
			refresh_project_categories: true,
		};
	} else if (keyRules || bodyRules || scoped) {
		const account = await getMemoryRules(env, ownerUserId);
		out.rules = mergeRuleOverride(mergeRuleOverride(account, keyRules), bodyRules);
		out.rulePolicy = {
			schema: "itsuki.admission-policy/v1",
			mode: "legacy_replace",
			layers: [keyRules, bodyRules].filter(Boolean),
			refresh_project_categories: false,
		};
	}
	return out;
}

/**
 * 429 for rate limiting. The headers matter: our own SDKs read `retry-after`
 * to pace their backoff (sdk/js retryAfterMilliseconds), and every 503 on this
 * worker already sends it — a bare 429 left the client guessing.
 *
 * `ratelimit-remaining`/`reset` are deliberately absent: the Workers rate
 * limiting binding reports only success/failure, and Cloudflare documents it as
 * "eventually consistent … not an accurate accounting system". Publishing a
 * remaining count we cannot compute would be a lie. Accurate remaining figures
 * come from the AI budget, which is counted in D1 and reported by /v1/limits.
 */
/**
 * Identity for the AI budget: the authenticated ACCOUNT, never the
 * caller-rotatable memory subject. userId rides along only as the legacy
 * fallback for operator-door rows that carry no account attribution.
 */
function aiBudgetIdentity(auth) {
	return {
		accountUserId: auth.memoryScope?.accountUserId ?? auth.auth?.userId ?? null,
		userId: auth.userId,
	};
}

/**
 * The AI-write admission decision for REST doors. null = allowed. A refused
 * REST write is HTTP 429 — every SDK treats 200+ok:true as success, so a
 * soft-200 refusal here would let callers believe the memory was stored (the
 * one claim this product forbids). /v1/turn does NOT use this: it degrades to
 * recall-only instead, because refusing the whole request over a WRITE quota
 * would break the caller's chat loop for no saving.
 */
async function refuseWriteOverAiBudget(env, auth) {
	let refusal;
	try {
		refusal = await checkAiBudget(env, aiBudgetIdentity(auth));
	} catch (error) {
		// Fail CLOSED: an unreadable quota means unbounded spend of unknown size.
		console.warn(JSON.stringify({ event: "ai_quota_unavailable", error: String(error?.message ?? error) }));
		return json({
			error: "ai_quota_unavailable",
			message: "Itsuki could not verify the AI quota just now — nothing was saved. Try again shortly.",
			retry_after_s: 60,
		}, 503, { "retry-after": "60" });
	}
	if (!refusal) return null;
	const budget = aiBudget(env);
	return json({
		error: refusal.error,
		...(refusal.capped ? { capped: refusal.capped } : {}),
		message: refusal.message,
		retry_after_s: refusal.retryAfterSeconds,
		...(refusal.reason === "monthly"
			? { usage: { used: refusal.used, limit: refusal.limit, unit: "ai_writes", resets_at: refusal.resetsAt } }
			: {}),
	}, 429, {
		"retry-after": String(refusal.retryAfterSeconds),
		"ratelimit-limit": String(budget.monthlyWrites),
	});
}

function tooManyFor(bucket) {
	// One name, both surfaces: the header limit and the /v1/limits document
	// read the same RATE_BUCKETS row, so the published number cannot drift
	// from the enforced one.
	return tooMany({ limit: RATE_BUCKETS[bucket].limit, bucket });
}

function tooMany({ retryAfterSeconds = 60, limit = null, bucket = null } = {}) {
	return json({
		error: "too_many_requests",
		message: "Slow down a little — try again in a minute.",
		retry_after_s: retryAfterSeconds,
		...(bucket ? { bucket } : {}),
	}, 429, {
		"retry-after": String(retryAfterSeconds),
		...(limit ? { "ratelimit-limit": String(limit) } : {}),
	});
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

async function readSmallJsonObject(request, path, maxBytes = 16 * 1024) {
	const bounded = await readBoundedBytes(request, path, { maxBytes });
	if (bounded.response) return bounded;
	try {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bounded.bytes);
		const body = text ? JSON.parse(text) : {};
		if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("object required");
		return { body };
	} catch {
		return { response: json({ error: "invalid_json", message: "The request body must be one JSON object." }, 400) };
	}
}

/**
 * BF-1 gate. `sourceTime` is allowlisted at every memory door so a caller who
 * sends it gets a semantic answer instead of "unknown_parameter" — but honouring
 * it is Memory V3 behaviour, and V3 is off for everyone who was not explicitly
 * selected. Refuse by name rather than accepting a timestamp we will not use:
 * a caller who believes their write times landed and finds "now" instead is the
 * BF-2 failure repeated in a more damaging place.
 *
 * Returns a Response to send, or null when the request may proceed.
 */
function refuseUngatedSourceTime(env, userId, body, memoryScope = null) {
	const onBody = body && Object.prototype.hasOwnProperty.call(body, "sourceTime");
	const onMessage = Array.isArray(body?.messages) && body.messages.some(
		(message) => message && typeof message === "object" && !Array.isArray(message)
			&& Object.prototype.hasOwnProperty.call(message, "sourceTime"),
	);
	if (!onBody && !onMessage) return null;
	if (memoryV3Enabled(env, userId, memoryScope)) return null;
	return json({
		error: "source_time_not_enabled",
		code: "source_time_not_enabled",
		message: "sourceTime is part of the Memory V3 timestamp contract, which is not enabled for this account. Remove it and the write is accepted as before, or ask for V3 access.",
		field: onBody ? "sourceTime" : "messages[].sourceTime",
	}, 400);
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
			const managedProject = await resolveManagedProject(env, request, auth);
			// Bearer tokens retain their declared scope contract, then intersect it
			// with the creator's current project role. Browser sessions use the same
			// fresh role check. The legacy API keeps its historical owner-selected
			// boundary because it has no managed-project membership identity.
			const requiredCapability = options.requiredCapability
				?? (options.requiredScope === MEMORY_READ_SCOPE
					? "project.memory.read"
					: options.requiredScope === MEMORY_WRITE_SCOPE
						? "project.memory.write"
						: null);
			let membership = null;
			if (["session", "token"].includes(auth.type) && requiredCapability) {
				membership = await resolveMembership(env, {
					userId: auth.userId,
					project: managedProject?.project ?? null,
				});
				if (!can(requiredCapability, membership)) {
					return { response: forbidden(requiredCapability) };
				}
			}
			const scoped = await resolveScopedMemory(auth, explicitUserId, options.scopeInput, managedProject);
			if (managedProject && options.registerSpace !== false) {
				await registerProjectMemorySpace(env, {
					projectId: managedProject.project.id,
					memoryOwnerUserId: managedProject.memoryOwnerUserId,
					memoryUserId: scoped.userId,
				});
			}
			const project = normalizeProjectScope(scoped.memoryScope);
			return {
				auth,
				userId: scoped.userId,
				managedProject: managedProject?.project ?? null,
				membership,
				memoryScope: {
					...scoped.memoryScope,
					projectId: project.projectId,
					projectName: project.projectName,
				},
			};
		} catch (error) {
			if (
				error instanceof ProjectScopeError
				|| error?.name === "ProjectScopeError"
				|| error instanceof ManagedProjectError
				|| error?.name === "ManagedProjectError"
			) {
				return { response: json({
					error: error.code ?? "invalid_project",
					code: error.code ?? "invalid_project",
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

/**
 * Authenticate and authorize a JSON mutation before buffering its body.
 * Session and bearer callers receive the same fresh project-role check as the
 * final scoped resolution. The legacy operator key is verified first, then its
 * required target user is read from the bounded body. No registry row is
 * created for a malformed/oversized request.
 */
async function preauthorizeMemoryBody(request, env, options = {}) {
	const principal = await resolveMemoryUser(request, env, null, {
		...options,
		allowLegacy: false,
	});
	if (principal) {
		return requireMemoryUser(request, env, null, {
			...options,
			allowLegacy: false,
			registerSpace: false,
		});
	}
	if (await isAuthorized(request, env)) return { legacy: true };
	return requireMemoryUser(request, env, null, { ...options, registerSpace: false });
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

async function resolveScopedMemory(auth, explicitUserId, scopeInput = {}, managedProject = null) {
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
	const accountUserId = auth.userId;
	const ownerUserId = managedProject?.memoryOwnerUserId ?? accountUserId;
	const externalUserId = cleanScopeValue(
		explicitUserId ?? input.externalUserId ?? input.userId,
		accountUserId,
	);
	const memoryUserId = externalUserId === accountUserId || externalUserId === ownerUserId
		? ownerUserId
		: await scopedMemoryUserId(ownerUserId, externalUserId);
	return {
		userId: memoryUserId,
		memoryScope: {
			...input,
			authType: auth.type,
			memoryUserId,
			ownerUserId,
			accountUserId,
			managedProjectId: managedProject?.project?.id ?? null,
			managedProjectName: managedProject?.project?.name ?? null,
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

function managedProjectFailure(error) {
	const auditResponse = auditFailure(error);
	if (auditResponse) return auditResponse;
	if (error instanceof ManagedProjectError || error?.name === "ManagedProjectError") {
		const payload = {
			error: error.code ?? "invalid_project",
			code: error.code ?? "invalid_project",
			message: String(error.message ?? "The project request is invalid."),
		};
		if (error.currentProject) payload.project = error.currentProject;
		return json(payload, Number(error.status ?? 400));
	}
	throw error;
}

/**
 * The single door for every session route. Resolving membership here — rather
 * than at each endpoint — is what makes it impossible for a new route to
 * forget: the roles are already on the context, and asking for a capability is
 * one call.
 */
async function requireSessionProject(request, env, capability = null) {
	const auth = await getSessionUser(env, request);
	if (!auth) return { response: json({ error: "unauthorized" }, 401) };
	try {
		const managed = await resolveManagedProject(env, request, auth);
		const membership = await resolveMembership(env, {
			userId: auth.userId,
			project: managed?.project ?? null,
		});
		const context = { auth, membership, ...managed };
		if (capability && !can(capability, membership)) return { response: forbidden(capability) };
		return context;
	} catch (error) {
		return { response: managedProjectFailure(error) };
	}
}

/**
 * A capability refusal says which capability was missing, because "forbidden"
 * with no reason is the kind of error that takes an afternoon to diagnose. It
 * says nothing about who DOES hold it, which would leak the member list.
 */
function forbidden(capability) {
	return json({
		error: "forbidden",
		capability,
		message: "You do not have permission to do that in this project.",
	}, 403);
}

/** Guard a capability on a context that is already resolved. */
function requireCapability(context, capability) {
	return can(capability, context.membership ?? {}) ? null : forbidden(capability);
}

function orgFailure(error) {
	const auditResponse = auditFailure(error);
	if (auditResponse) return auditResponse;
	if (error instanceof OrgError) {
		const payload = { error: error.code, code: error.code, message: error.message };
		if (error.currentOrganization) payload.organization = error.currentOrganization;
		if (error.currentCategory) payload.category = error.currentCategory;
		return json(payload, Number(error.status ?? 400));
	}
	console.error("organization route failed:", error?.message ?? error);
	return json({ error: "organization_unavailable", message: "That could not be completed. Try again." }, 500);
}

function auditFailure(error) {
	if (!(error instanceof AuditReplayError) && !(error instanceof AuditUnavailableError)
		&& !["AuditReplayError", "AuditUnavailableError"].includes(error?.name)) return null;
	return json({
		error: error.code ?? "audit_unavailable",
		code: error.code ?? "audit_unavailable",
		message: String(error.message ?? "The security audit trail is unavailable. No changes were made."),
		...(error.eventId ? { audit_event_id: error.eventId, outcome: error.outcome } : {}),
	}, Number(error.status ?? 503));
}

function auditQuery(url, { exportMode = false } = {}) {
	const action = url.searchParams.get("action");
	if (action && !/^[a-z0-9_.:-]{1,60}$/.test(action)) {
		return { response: json({ error: "invalid_audit_action", message: "Audit action is not valid." }, 400) };
	}
	const cursor = url.searchParams.get("cursor") ?? url.searchParams.get("before");
	if (cursor && !decodeAuditCursor(cursor)) {
		return { response: json({ error: "invalid_audit_cursor", message: "Audit cursor is not valid." }, 400) };
	}
	const parseTime = (name) => {
		const raw = url.searchParams.get(name);
		if (raw === null || raw === "") return null;
		if (!/^\d{1,16}$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error(name);
		return Number(raw);
	};
	let from;
	let to;
	try { from = parseTime("from"); to = parseTime("to"); } catch {
		return { response: json({ error: "invalid_audit_time", message: "Audit from/to must be epoch milliseconds." }, 400) };
	}
	if (from !== null && to !== null && from > to) {
		return { response: json({ error: "invalid_audit_range", message: "Audit from must not be after to." }, 400) };
	}
	const rawLimit = url.searchParams.get("limit");
	let limit = exportMode ? 5_000 : 50;
	if (rawLimit !== null) {
		if (!/^\d+$/.test(rawLimit)) return { response: json({ error: "invalid_audit_limit", message: "Audit limit must be a positive integer." }, 400) };
		limit = Number(rawLimit);
		const max = exportMode ? 20_000 : 200;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > max) {
			return { response: json({ error: "invalid_audit_limit", message: `Audit limit must be between 1 and ${max}.` }, 400) };
		}
	}
	return { action: action || null, cursor, from, to, limit };
}

function retentionFailure(error) {
	if (error instanceof RetentionError || error?.name === "RetentionError") {
		return json({
			error: error.code ?? "invalid_retention_request",
			code: error.code ?? "invalid_retention_request",
			message: String(error.message ?? "The retention request is invalid."),
			...(error.current ? { current: error.current } : {}),
		}, Number(error.status ?? 400));
	}
	throw error;
}

function rulesPrecondition(request, body) {
	const bodyVersion = body?.expected_version;
	const headerValue = request.headers.get("if-match");
	const headerVersion = headerValue === null
		? null
		: headerValue.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
	if ((bodyVersion === undefined || bodyVersion === null || bodyVersion === "") && !headerVersion) {
		return {
			response: json({
				error: "precondition_required",
				message: "Reload these settings before saving so a newer policy is not overwritten.",
			}, 428),
		};
	}
	if (headerVersion && bodyVersion !== undefined && bodyVersion !== null && String(bodyVersion) !== headerVersion) {
		return {
			response: json({
				error: "invalid_precondition",
				message: "If-Match and expected_version must identify the same rules version.",
			}, 400),
		};
	}
	return { expectedVersion: headerVersion || String(bodyVersion) };
}

function rulesAuditMetadata(saved) {
	const shape = (rules) => ({
		includes_count: rules.includes.length,
		excludes_count: rules.excludes.length,
		categories_count: rules.customCategories.length,
		instructions_present: Boolean(rules.customInstructions),
		capture_default: rules.captureDefault,
		capture_density: rules.captureDensity,
		auto_collect: rules.autoCollect,
	});
	return auditDiff(shape(saved.previousRules), shape(saved.rules));
}

function savedRulesMetadata(saved, actor = null) {
	return {
		version: saved.version,
		updated_at: saved.updatedAt ?? null,
		updated_by: actor?.id
			? { id: actor.id, name: actor.name ?? null, email: actor.email ?? null }
			: null,
	};
}

function rulesFailure(error) {
	if (error instanceof MemoryRulesConflictError) {
		return json({
			error: "settings_conflict",
			message: "These settings changed elsewhere. Reload the current values before saving again.",
			rules: error.currentRules,
			rules_version: error.currentVersion,
		}, 409);
	}
	if (error?.code === "memory_rules_unavailable") {
		return json({
			error: "memory_rules_unavailable",
			message: "The current policy could not be verified, so no changes were saved. Try again.",
		}, 503);
	}
	return orgFailure(error);
}

/**
 * The organization a session acts in: the selected project's, falling back to
 * the account's own. Bootstraps lazily, so an account that never opens a team
 * feature still has no organization row.
 */
async function sessionOrganization(env, context) {
	const effective = context.membership?.orgId ?? context.project?.organization_id ?? null;
	if (effective) {
		const org = await getOrganization(env, effective);
		if (org) return org;
		throw new OrgError("org_not_found", "That project's organization is not available.", 404);
	}
	// A NULL organization id is the backwards-compatible representation of the
	// PROJECT OWNER's default organization. A collaborator's own default must
	// never become the target merely because they made the request.
	return ensureDefaultOrganization(env, context.project?.owner_user_id ?? context.auth.userId);
}

function waitUntilFrom(ctx) {
	return typeof ctx?.waitUntil === "function" ? (promise) => ctx.waitUntil(promise) : null;
}

/** One request-scoped, commit-time authorization + audit contract. */
async function contextAuditDetails(request, env, ctx, context, capability, {
	orgId = context.membership?.orgId ?? context.project?.organization_id ?? null,
	projectId = context.project?.id ?? null,
	action,
	targetType = null,
	targetId = null,
	metadata = null,
	idempotencyKey = null,
} = {}) {
	if (!orgId && context.project?.owner_user_id) {
		orgId = (await ensureDefaultOrganization(env, context.project.owner_user_id)).id;
	}
	return {
		orgId,
		projectId,
		actorUserId: context.auth?.userId ?? null,
		actorType: context.auth?.type ?? "user",
		action,
		targetType,
		targetId,
		metadata,
		requestId: auditRequestId(request),
		idempotencyKey,
		waitUntil: waitUntilFrom(ctx),
		authorizationGuards: capability ? [capabilityGuardStatement(env, {
			actorUserId: context.auth?.userId,
			orgId,
			projectId,
			capability,
		})] : [],
	};
}

async function runContextAuditedMutation(request, env, ctx, context, capability, details, mutate, finish = null) {
	return runAuditedMutation(
		env,
		await contextAuditDetails(request, env, ctx, context, capability, details),
		mutate,
		finish,
	);
}

function managedMemoryAuditContext(auth) {
	return {
		auth: { userId: auth.auth?.userId, type: auth.auth?.type ?? "user" },
		project: auth.managedProject,
		membership: auth.membership,
	};
}

function tokenProjectOptions(context) {
	return {
		projectId: context.project.id,
		// NULL-project keys predate managed projects and belong only to their
		// creator's own default project. A collaborator looking at somebody
		// else's default must never see or mutate those historical credentials.
		isDefault: context.project.is_default && context.project.owner_user_id === context.auth.userId,
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
	// The V3 rollout state is operational information, not user data: the mode
	// and how many accounts are selected, never which ones. Surfacing it here is
	// what makes "is V3 off in production?" answerable without a deploy inspection.
	"GET /health": (request, env) => json({
		ok: true,
		service: "memory-engine",
		version: "0.1.0",
		memory_v3: memoryV3Status(env),
	}),
	"GET /v1/ingest/limits": () => json({
		ok: true,
		schema: "itsuki.ingest-limits/v1",
		limits: INGEST_LIMITS,
		character_unit: "unicode_code_points",
		request_encoding: "utf-8-json",
		delivery_schema: INGEST_DELIVERY_SCHEMA,
	}),
	// The whole limits surface in one unauthenticated fetch: rate buckets,
	// ingest bounds, and the AI plan. Frozen configuration only — a caller's
	// CONSUMED quota needs auth and lives on GET /v1/usage. The account-wide
	// AI ceiling is deliberately not published.
	"GET /v1/limits": (request, env) => json({
		ok: true,
		schema: LIMITS_SCHEMA,
		rate: RATE_LIMITS_DOC,
		ingest: {
			limits: INGEST_LIMITS,
			character_unit: "unicode_code_points",
			request_encoding: "utf-8-json",
			delivery_schema: INGEST_DELIVERY_SCHEMA,
		},
		ai: aiLimitsDocument(env),
	}),

	"GET /auth/me": async (request, env) => {
		const auth = await getSessionUser(env, request);
		if (!auth) return json({ authenticated: false, user: null });
		return json(authPayload(auth));
	},

	"POST /auth/signup": async (request, env) => {
		if (!(await allowRate(env.AUTH_LIMITER, clientIp(request)))) return tooManyFor("auth");
		try {
			const parsed = await readSmallJsonObject(request, "/auth/signup", 8 * 1024);
			if (parsed.response) return parsed.response;
			const body = parsed.body;
			const result = await signup(env, request, body);
			if (result.error) return json({ error: result.error }, result.status);
			return json(
				{ authenticated: true, user: result.user, session: { id: result.session.id, expires_at: result.session.expiresAt } },
				result.status,
				{ "set-cookie": result.session.cookie },
			);
		} catch (error) {
			const auditResponse = auditFailure(error);
			if (auditResponse) return withResponseRequestId(auditResponse, auditRequestId(request));
			return authFailureResponse("signup", error);
		}
	},

	"POST /auth/login": async (request, env) => {
		if (!(await allowRate(env.AUTH_LIMITER, clientIp(request)))) return tooManyFor("auth");
		try {
			const parsed = await readSmallJsonObject(request, "/auth/login", 8 * 1024);
			if (parsed.response) return parsed.response;
			const body = parsed.body;
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

	"POST /auth/logout-all": async (request, env, ctx) => {
		const auth = await getSessionUser(env, request);
		if (!auth) return json({ error: "unauthorized" }, 401, { "set-cookie": clearSessionCookie(request) });
		await runAuditedMutation(env, {
			actorUserId: auth.userId,
			actorType: "user",
			action: "account.sessions.revoked_all",
			targetType: "account",
			targetId: auth.userId,
			requestId: auditRequestId(request),
			waitUntil: waitUntilFrom(ctx),
		}, (intent) => logoutAll(env, auth.userId, { auditIntent: intent }), () => ({
			metadata: { status: { from: "active", to: "revoked" } },
		}));
		return json({ ok: true }, 200, { "set-cookie": clearSessionCookie(request) });
	},

	"GET /auth/projects": async (request, env) => {
		const auth = await getSessionUser(env, request);
		if (!auth) return json({ error: "unauthorized" }, 401);
		try {
			return json({ projects: await listManagedProjects(env, auth.userId) });
		} catch (error) {
			return managedProjectFailure(error);
		}
	},

	"GET /auth/organizations": async (request, env) => {
		const auth = await getSessionUser(env, request);
		if (!auth) return json({ error: "unauthorized" }, 401);
		try {
			return json({ organizations: await listOrganizations(env, auth.userId) });
		} catch (error) { return orgFailure(error); }
	},

	"POST /auth/organizations": async (request, env, ctx) => {
		const auth = await getSessionUser(env, request);
		if (!auth) return json({ error: "unauthorized" }, 401);
		if (!(await allowRate(env.AUTH_LIMITER, `org-create:actor:${auth.userId}`))) return tooManyFor("auth");
		if (!(await allowRate(env.AUTH_LIMITER, `org-create:ip:${clientIp(request)}`))) return tooManyFor("auth");
		const parsed = await readSmallJsonObject(request, "/auth/organizations");
		if (parsed.response) return parsed.response;
		try {
			const created = await runAuditedMutation(
				env,
				{
					actorUserId: auth.userId,
					action: "org.created",
					targetType: "organization",
					requestId: auditRequestId(request),
					waitUntil: waitUntilFrom(ctx),
					guardOrgId: null,
					guardProjectId: null,
					metadata: {
						status: { from: null, to: "active" },
						project_count: { from: 0, to: 1 },
					},
				},
				(intent) => createOrganization(env, auth.userId, parsed.body, { auditIntent: intent }),
				(result) => ({
					orgId: result.organization.id,
					projectId: result.project.id,
					targetId: result.organization.id,
				}),
			);
			const project = await getManagedProjectForUser(env, auth.userId, created.project.id);
			return json({ ok: true, organization: created.organization, project }, 201);
		} catch (error) { return orgFailure(error); }
	},

	"POST /auth/projects": async (request, env, ctx) => {
		const context = await requireSessionProject(request, env, "project.create");
		if (context.response) return context.response;
		try {
			const org = await sessionOrganization(env, context);
			const parsed = await readSmallJsonObject(request, "/auth/projects");
			if (parsed.response) return parsed.response;
			const body = parsed.body;
			if (!body || typeof body !== "object" || Array.isArray(body)) {
				throw new ManagedProjectError("invalid_project", "Project details must be a JSON object.");
			}
			const unknown = Object.keys(body).filter((key) => !["name", "description", "organization_id"].includes(key));
			if (unknown.length) {
				throw new ManagedProjectError(
					"unknown_project_field",
					`Unknown project field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`,
				);
			}
			if (body.organization_id !== undefined && body.organization_id !== org.id) {
				return forbidden("project.create");
			}
			const project = await runContextAuditedMutation(
				request, env, ctx, context, "project.create",
				{
					orgId: org.id,
					projectId: null,
					action: "project.created",
					targetType: "project",
					metadata: { status: { from: null, to: "active" } },
				},
				(intent) => createManagedProject(
					env,
					org.owner_user_id,
					{ name: body.name, description: body.description },
					{ organizationId: org.id, auditIntent: intent },
				),
				(created) => ({
					orgId: org.id,
					projectId: created.id,
					targetId: created.id,
					metadata: { status: { from: null, to: "active" } },
				}),
			);
			return json({ project }, 201);
		} catch (error) {
			if (error instanceof OrgError) return orgFailure(error);
			return managedProjectFailure(error);
		}
	},

	// ---- Settings: organization, membership, categories, audit --------------
	// Every route here resolves membership at the door and then names the exact
	// capability it needs. Hiding a control in the browser is not authorization.

	/** Everything the Settings workspace renders in one round trip. */
	"GET /v1/settings": async (request, env) => {
		const context = await requireSessionProject(request, env, "project.view");
		if (context.response) return context.response;
		try {
			const org = await sessionOrganization(env, context);
			const rulesState = await getMemoryRulesState(env, context.memoryOwnerUserId);
			const rules = rulesState.rules;
			const latestRulesAudit = await env.DB.prepare(
				`SELECT a.actor_user_id, a.created_at, u.name AS actor_name, u.email AS actor_email
				   FROM audit_events a LEFT JOIN users u ON u.id = a.actor_user_id
				  WHERE a.project_id = ? AND a.action = 'project.rules.updated' AND a.outcome = 'ok'
				  ORDER BY a.created_at DESC, a.id DESC LIMIT 1`,
			).bind(context.project.id).first();
			return json({
				ok: true,
				project: context.project,
				organization: org,
				membership: {
					org_role: context.membership.orgRole,
					project_role: context.membership.projectRole,
					capabilities: context.membership.capabilities,
				},
				rules,
				// Always present, including before the first rules row exists. The
				// opaque token is backed by an atomic D1 compare-and-set on write.
				rules_version: rulesState.version,
				rules_metadata: {
					version: rulesState.version,
					updated_at: rulesState.row?.updated_at ?? null,
					updated_by: latestRulesAudit?.actor_user_id
						? {
							id: latestRulesAudit.actor_user_id,
							name: latestRulesAudit.actor_name ?? null,
							email: latestRulesAudit.actor_email ?? null,
						}
						: null,
				},
				categories: await listProjectCategories(env, {
					projectId: context.project.id,
					memoryOwnerUserId: context.memoryOwnerUserId,
					legacy: rules.customCategories ?? [],
				}),
				category_color_tokens: CATEGORY_COLOR_TOKENS,
				builtin_categories: CATEGORIES,
				members: can("project.members.view", context.membership)
					? await listProjectMembers(env, context.project.id)
					: [],
				org_members: can("org.members.view", context.membership)
					? await listOrganizationMembers(env, org.id)
					: [],
				invitations: can("org.members.manage", context.membership)
					? await listInvitations(env, org.id)
					: [],
				// Lights up the Settings → General usage row, which shipped ahead
				// of the quota and has read "No project quota is configured" ever
				// since. Best-effort: settings must answer without it.
				project_usage: await (async () => {
					try {
						const used = await countWritesThisMonth(env, { accountUserId: context.auth.userId });
						return { used, limit: aiBudget(env).monthlyWrites, unit: "AI saves this month" };
					} catch { return null; }
				})(),
			});
		} catch (error) { return orgFailure(error); }
	},

	"PATCH /v1/settings/organization": async (request, env, ctx) => {
		const context = await requireSessionProject(request, env, "org.edit");
		if (context.response) return context.response;
		try {
			const org = await sessionOrganization(env, context);
			const parsed = await readSmallJsonObject(request, "/v1/settings/organization");
			if (parsed.response) return parsed.response;
			const body = parsed.body;
			const mutation = await runContextAuditedMutation(
				request, env, ctx, context, "org.edit",
				{ orgId: org.id, projectId: null, action: "org.updated", targetType: "organization", targetId: org.id },
				(intent) => updateOrganization(env, org.id, body, request.headers.get("if-match"), { auditIntent: intent }),
				(result) => ({
					outcome: result.changed ? "ok" : "noop",
					reason: result.changed ? null : "no_change",
					metadata: auditDiff(result.previousOrganization, result.organization),
				}),
			);
			return json({ ok: true, changed: mutation.changed, organization: mutation.organization });
		} catch (error) { return orgFailure(error); }
	},

	"PATCH /v1/settings/project": async (request, env, ctx) => {
		const context = await requireSessionProject(request, env, "project.edit");
		if (context.response) return context.response;
		try {
			const before = context.project;
			const parsed = await readSmallJsonObject(request, "/v1/settings/project");
			if (parsed.response) return parsed.response;
			const body = parsed.body;
			const mutation = await runContextAuditedMutation(
				request, env, ctx, context, "project.edit",
				{ action: "project.updated", targetType: "project", targetId: before.id },
				(intent) => updateManagedProject(
					env, before.owner_user_id, before.id, body, request.headers.get("if-match"), { auditIntent: intent },
				),
				(saved) => ({
					outcome: saved.changed ? "ok" : "noop",
					reason: saved.changed ? null : "no_change",
					metadata: auditDiff(saved.previousProject, saved.project),
				}),
			);
			return json({ ok: true, changed: mutation.changed, project: mutation.project });
		} catch (error) { return managedProjectFailure(error); }
	},

	/**
	 * Extraction rules for the selected project. `expected_version` is the
	 * optimistic-concurrency check: two tabs editing the same policy must not
	 * silently last-write-win, because the thing being overwritten is what the
	 * user believes is protecting their memory.
	 */
	"PUT /v1/settings/rules": async (request, env, ctx) => {
		const context = await requireSessionProject(request, env, "project.rules.edit");
		if (context.response) return context.response;
		try {
			const parsed = await readSmallJsonObject(request, "/v1/settings/rules");
			if (parsed.response) return parsed.response;
			const body = parsed.body;
			const precondition = rulesPrecondition(request, body);
			if (precondition.response) return precondition.response;
			const saved = await runContextAuditedMutation(
				request, env, ctx, context, "project.rules.edit",
				{ action: "project.rules.updated", targetType: "rules", targetId: context.project.id },
				(intent) => saveMemoryRulesIfCurrent(
					env,
					context.memoryOwnerUserId,
					body.rules ?? body,
					precondition.expectedVersion,
					{ auditIntent: intent },
				),
				(result) => ({
					outcome: result.changed ? "ok" : "noop",
					reason: result.changed ? null : "no_change",
					metadata: rulesAuditMetadata(result),
				}),
			);
			const next = saved.rules;
			return json({
				ok: true,
				rules: next,
				rules_version: saved.version,
				rules_metadata: savedRulesMetadata(saved, context.auth.user),
				changed: saved.changed,
			});
		} catch (error) { return rulesFailure(error); }
	},

	/**
	 * Dry run: what would these rules do to this text? Runs the real admission
	 * filter, writes nothing. This is what lets the Settings page show a
	 * truthful "kept / not kept" instead of a promise.
	 */
	"POST /v1/settings/rules/preview": async (request, env) => {
		const context = await requireSessionProject(request, env, "project.rules.edit");
		if (context.response) return context.response;
		if (!(await allowRate(
			env.SAVE_LIMITER,
			`rules-preview:${context.auth.userId}:project:${context.project.id}`,
		))) return tooManyFor("save");
		const parsed = await readSmallJsonObject(request, "/v1/settings/rules/preview");
		if (parsed.response) return parsed.response;
		const body = parsed.body;
		const unknown = Object.keys(body).filter((key) => !["samples", "rules"].includes(key));
		if (unknown.length) return json({ error: "unknown_preview_field", message: `Unknown preview field: ${unknown[0]}.` }, 400);
		const storedRules = await getMemoryRules(env, context.memoryOwnerUserId);
		let rules = storedRules;
		if (body.rules !== undefined) {
			if (!body.rules || typeof body.rules !== "object" || Array.isArray(body.rules)) {
				return json({ error: "invalid_preview_rules", message: "Preview rules must be a JSON object." }, 400);
			}
			const ruleUnknown = Object.keys(body.rules).filter((key) => ![
				"customInstructions", "includes", "excludes", "captureDefault", "captureDensity", "autoCollect",
			].includes(key));
			if (ruleUnknown.length) return json({ error: "unknown_preview_rule", message: `Unknown preview rule: ${ruleUnknown[0]}.` }, 400);
			rules = mergeRuleOverride(storedRules, body.rules);
		}
		const projectCategories = await activeCategoryRulesReadOnly(env, {
			projectId: context.project.id,
			legacy: rules.customCategories ?? [],
		});
		return json(await previewMemoryRules(env, { samples: body.samples, rules, projectCategories }));
	},

	"GET /v1/settings/categories": async (request, env) => {
		const context = await requireSessionProject(request, env, "project.view");
		if (context.response) return context.response;
		const rules = await getMemoryRules(env, context.memoryOwnerUserId);
		return json({
			ok: true,
			builtin: CATEGORIES,
			color_tokens: CATEGORY_COLOR_TOKENS,
			categories: await listProjectCategories(env, {
				projectId: context.project.id,
				memoryOwnerUserId: context.memoryOwnerUserId,
				legacy: rules.customCategories ?? [],
			}),
		});
	},

	"POST /v1/settings/categories": async (request, env, ctx) => {
		const context = await requireSessionProject(request, env, "project.categories.edit");
		if (context.response) return context.response;
		try {
			const parsed = await readSmallJsonObject(request, "/v1/settings/categories");
			if (parsed.response) return parsed.response;
			const body = parsed.body;
			const unknown = Object.keys(body).filter((key) => !["name", "description", "color_token"].includes(key));
			if (unknown.length) throw new OrgError("unknown_category_field", `Unknown category field: ${unknown[0]}.`);
			const rules = await getMemoryRules(env, context.memoryOwnerUserId);
			const result = await runContextAuditedMutation(
				request, env, ctx, context, "project.categories.edit",
				{ action: "project.category.created", targetType: "category" },
				(intent) => createProjectCategory(env, {
					projectId: context.project.id,
					memoryOwnerUserId: context.memoryOwnerUserId,
					legacy: rules.customCategories ?? [],
					name: body.name, description: body.description, colorToken: body.color_token,
					actorUserId: context.auth.userId,
					auditIntent: intent,
				}),
				(created) => ({
					targetId: created.category.id,
					metadata: {
						slug: { from: null, to: created.category.slug },
						color_token: { from: null, to: created.category.color_token },
					},
				}),
			);
			return json({ ok: true, category: result.category }, 201);
		} catch (error) { return orgFailure(error); }
	},

	"GET /v1/settings/audit": async (request, env) => {
		const context = await requireSessionProject(request, env, "project.audit.view");
		if (context.response) return context.response;
		const url = new URL(request.url);
		const query = auditQuery(url);
		if (query.response) return query.response;
		return json({
			ok: true,
			...await listAuditEvents(env, {
				projectId: context.project.id,
				action: query.action,
				limit: query.limit,
				cursor: query.cursor,
				from: query.from,
				to: query.to,
			}),
		});
	},

	"GET /v1/settings/audit/export": async (request, env, ctx) => {
		const context = await requireSessionProject(request, env, "project.audit.export");
		if (context.response) return context.response;
		const url = new URL(request.url);
		const query = auditQuery(url, { exportMode: true });
		if (query.response) return query.response;
		const result = await runContextAuditedMutation(
			request, env, ctx, context, "project.audit.export",
			{ action: "project.audit.exported", targetType: "audit", targetId: context.project.id },
			async (intent) => {
				const exported = await exportAuditCsv(env, {
					projectId: context.project.id,
					action: query.action,
					from: query.from,
					to: query.to,
					maxEvents: query.limit,
				});
				return commitAuditedAccess(env, intent, exported);
			},
			(exported) => ({ metadata: { events_count: exported.count, format: "csv" } }),
		);
		return new Response(result.csv, {
			headers: {
				"content-type": "text/csv; charset=utf-8",
				"content-disposition": `attachment; filename="itsuki-audit-${new Date().toISOString().slice(0, 10)}.csv"`,
				"x-itsuki-export-count": String(result.count),
				"x-itsuki-export-truncated": String(result.truncated),
				"cache-control": "private, no-store",
			},
		});
	},

	"GET /v1/settings/retention": async (request, env) => {
		const context = await requireSessionProject(request, env, "project.retention.view");
		if (context.response) return context.response;
		try {
			const url = new URL(request.url);
			const input = {
				projectId: context.project.id,
				memoryOwnerUserId: context.memoryOwnerUserId,
			};
			return json({
				ok: true,
				policies: await listRetentionPolicies(env, input),
				runs: await listRetentionRuns(env, {
					...input,
					limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined,
				}),
			});
		} catch (error) { return retentionFailure(error); }
	},

	"POST /v1/settings/retention/preview": async (request, env) => {
		const context = await requireSessionProject(request, env, "project.retention.view");
		if (context.response) return context.response;
		const parsed = await readSmallJsonObject(request, "/v1/settings/retention/preview");
		if (parsed.response) return parsed.response;
		try {
			const body = parsed.body;
			const unknown = Object.keys(body).filter((key) => !["class", "days", "expected_version"].includes(key));
			if (unknown.length) {
				throw new RetentionError("unknown_retention_field", `Unknown retention field: ${unknown[0]}.`);
			}
			const preview = await previewRetentionChange(env, {
				projectId: context.project.id,
				memoryOwnerUserId: context.memoryOwnerUserId,
				retentionClass: body.class,
				days: body.days,
				expectedVersion: body.expected_version,
			});
			return json({ ok: true, preview });
		} catch (error) { return retentionFailure(error); }
	},

	"PUT /v1/settings/retention": async (request, env, ctx) => {
		const context = await requireSessionProject(request, env, "project.retention.manage");
		if (context.response) return context.response;
		const parsed = await readSmallJsonObject(request, "/v1/settings/retention");
		if (parsed.response) return parsed.response;
		try {
			const body = parsed.body;
			const unknown = Object.keys(body).filter((key) => ![
				"class", "days", "expected_version", "preview_cutoff_at",
				"preview_inventory_hash", "confirmation",
			].includes(key));
			if (unknown.length) {
				throw new RetentionError("unknown_retention_field", `Unknown retention field: ${unknown[0]}.`);
			}
			const result = await activateRetentionPolicy(env, {
				projectId: context.project.id,
				memoryOwnerUserId: context.memoryOwnerUserId,
				actorUserId: context.auth.userId,
				retentionClass: body.class,
				days: body.days,
				expectedVersion: body.expected_version,
				previewCutoffAt: body.preview_cutoff_at,
				previewInventoryHash: body.preview_inventory_hash,
				confirmation: body.confirmation,
				requestId: auditRequestId(request),
				waitUntil: waitUntilFrom(ctx),
				authorizationGuards: [capabilityGuardStatement(env, {
					actorUserId: context.auth.userId,
					orgId: context.membership.orgId,
					projectId: context.project.id,
					capability: "project.retention.manage",
				})],
			});
			return json({ ok: true, ...result });
		} catch (error) { return retentionFailure(error); }
	},

	"POST /v1/settings/retention/process": async (request, env) => {
		const context = await requireSessionProject(request, env, "project.retention.manage");
		if (context.response) return context.response;
		if (!(await allowRate(env.SAVE_LIMITER, `retention:${context.auth.userId}:${context.project.id}`))) return tooManyFor("save");
		const parsed = await readSmallJsonObject(request, "/v1/settings/retention/process");
		if (parsed.response) return parsed.response;
		try {
			const body = parsed.body;
			const unknown = Object.keys(body).filter((key) => key !== "run_id");
			if (unknown.length) {
				throw new RetentionError("unknown_retention_field", `Unknown retention field: ${unknown[0]}.`);
			}
			const run = await processRetentionRun(env, {
				runId: body.run_id,
				projectId: context.project.id,
				memoryOwnerUserId: context.memoryOwnerUserId,
				batchSize: 40,
			});
			return json({ ok: true, run });
		} catch (error) { return retentionFailure(error); }
	},

	/**
	 * Invite. The copy-once link is always returned. When transactional email is
	 * configured the encrypted outbox reports its real delivery state; the API
	 * never claims a send merely because an invitation was created.
	 */
	"POST /v1/settings/invitations": async (request, env, ctx) => {
		const context = await requireSessionProject(request, env, "org.members.manage");
		if (context.response) return context.response;
		try {
			const org = await sessionOrganization(env, context);
			const inviteRateKeys = [
				`invite:actor:${context.auth.userId}`,
				`invite:org:${org.id}`,
				`invite:ip:${clientIp(request)}`,
			];
			for (const key of inviteRateKeys) {
				if (!(await allowRate(env.AUTH_LIMITER, key))) return tooManyFor("auth");
			}
			const parsed = await readSmallJsonObject(request, "/v1/settings/invitations");
			if (parsed.response) return parsed.response;
			const body = parsed.body;
			const unknown = Object.keys(body).filter((key) => ![
				"email", "org_role", "project_role", "access_starts_at", "access_expires_at",
			].includes(key));
			if (unknown.length) throw new OrgError("unknown_invitation_field", `Unknown invitation field: ${unknown[0]}.`);
			const invitationResult = await runContextAuditedMutation(
				request, env, ctx, context, "org.members.manage",
				{
					orgId: org.id,
					projectId: body.project_role ? context.project.id : null,
					action: "org.invitation.created",
					targetType: "invitation",
					metadata: {
						email_domain: { from: null, to: emailDomain(body.email) },
						org_role: { from: null, to: body.org_role ?? "member" },
						project_role: { from: null, to: body.project_role ?? null },
						access_starts_at: { from: null, to: body.access_starts_at ?? null },
						access_expires_at: { from: null, to: body.access_expires_at ?? null },
					},
				},
				(intent) => createInvitation(env, {
					orgId: org.id,
					projectId: body.project_role ? context.project.id : null,
					email: body.email,
					orgRole: body.org_role ?? "member",
					projectRole: body.project_role ?? null,
					invitedByUserId: context.auth.userId,
					origin: new URL(request.url).origin,
					accessStartsAt: body.access_starts_at ?? null,
					accessExpiresAt: body.access_expires_at ?? null,
					auditIntent: intent,
				}),
				(result) => ({
					targetId: result.invitation.id,
					metadata: {
						email_domain: { from: null, to: emailDomain(body.email) },
						org_role: { from: null, to: result.invitation.org_role },
						project_role: { from: null, to: result.invitation.project_role },
						active_count: {
							from: Number(result.expired_invitation_count ?? 0) + Number(result.replaced_invitation_ids?.length ?? 0),
							to: 1,
						},
					},
				}),
			);
			const {
				replaced_invitation_ids: _replacedInvitationIds = [],
				expired_invitation_count: _expiredInvitationCount = 0,
				...created
			} = invitationResult;
			// Superseded/expired rows are part of the same atomic create transition.
			// Their bounded counts are folded into the committed create event rather
			// than pretending separate best-effort audit events were durable.
			// Delivery is an aid, never the invitation authority. Dispatch after the
			// hash-only invitation and encrypted outbox are durable; any provider
			// failure is retried by cron and never changes this successful response.
			ctx?.waitUntil?.(processInvitationEmailOutbox(env, { limit: 5 }).catch((error) => {
				console.warn("invitation email dispatch failed:", error?.message ?? error);
			}));
			return json({ ok: true, ...created }, 201);
		} catch (error) { return orgFailure(error); }
	},

	"POST /v1/settings/invitations/accept": async (request, env, ctx) => {
		const auth = await getSessionUser(env, request);
		if (!auth) return json({ error: "unauthorized" }, 401);
		if (!(await allowRate(env.AUTH_LIMITER, `accept:${clientIp(request)}`))) return tooManyFor("auth");
		const parsed = await readSmallJsonObject(request, "/v1/settings/invitations/accept", 4 * 1024);
		if (parsed.response) return parsed.response;
		const body = parsed.body;
		const unknown = Object.keys(body).filter((key) => key !== "token");
		if (unknown.length) return json({ error: "unknown_invitation_field", message: `Unknown invitation field: ${unknown[0]}.` }, 400);
		if (typeof body.token !== "string" || !body.token.trim() || body.token.length > 512) {
			return json({ error: "invalid_invitation", message: "That invitation link is not valid." }, 400);
		}
		const user = await env.DB.prepare("SELECT id, email FROM users WHERE id = ? LIMIT 1")
			.bind(auth.userId).first();
		if (!user) return json({ error: "unauthorized" }, 401);
		try {
			const inviteScope = await env.DB.prepare(
				`SELECT id, org_id, project_id FROM organization_invitations
				  WHERE token_hash = ? LIMIT 1`,
			).bind(await sha256Hex(body.token)).first();
			if (!inviteScope) return json({ ok: false, reason: "invalid", message: "That invitation link is not valid." }, 409);
			const result = await runAuditedMutation(
				env,
				{
					orgId: inviteScope.org_id,
					projectId: inviteScope.project_id ?? null,
					actorUserId: auth.userId,
					action: "org.invitation.accepted",
					targetType: "invitation",
					targetId: inviteScope.id,
					requestId: auditRequestId(request),
					waitUntil: waitUntilFrom(ctx),
				},
				(intent) => acceptInvitation(env, body.token, user, { auditIntent: intent }),
				(mutation) => ({
					outcome: mutation.ok ? "ok" : "denied",
					reason: mutation.ok ? null : mutation.reason,
				}),
			);
			return json(result, result.ok ? 200 : 409);
		} catch (error) { return orgFailure(error); }
	},

	"POST /v1/settings/invitations/describe": async (request, env) => {
		const auth = await getSessionUser(env, request);
		if (!auth) return json({ error: "unauthorized" }, 401);
		const parsed = await readSmallJsonObject(request, "/v1/settings/invitations/describe", 4 * 1024);
		if (parsed.response) return parsed.response;
		const body = parsed.body;
		const unknown = Object.keys(body).filter((key) => key !== "token");
		if (unknown.length) return json({ error: "unknown_invitation_field", message: `Unknown invitation field: ${unknown[0]}.` }, 400);
		if (typeof body.token !== "string" || !body.token.trim() || body.token.length > 512) {
			return json({ error: "invalid_invitation", message: "That invitation link is not valid." }, 400);
		}
		const user = await env.DB.prepare("SELECT id, email FROM users WHERE id = ? LIMIT 1")
			.bind(auth.userId).first();
		return json(await describeInvitation(env, body.token, user));
	},

	"POST /v1/settings/members": async (request, env, ctx) => {
		const context = await requireSessionProject(request, env, "project.members.manage");
		if (context.response) return context.response;
		try {
			const org = await sessionOrganization(env, context);
			const parsed = await readSmallJsonObject(request, "/v1/settings/members");
			if (parsed.response) return parsed.response;
			const body = parsed.body;
			const unknown = Object.keys(body).filter((key) => ![
				"user_id", "role", "access_starts_at", "access_expires_at",
			].includes(key));
			if (unknown.length) throw new OrgError("unknown_member_field", `Unknown member field: ${unknown[0]}.`);
			const targetUserId = String(body.user_id ?? "");
			const mutation = await runContextAuditedMutation(
				request, env, ctx, context, "project.members.manage",
				{ action: "project.member.added", targetType: "member", targetId: targetUserId },
				(intent) => setProjectRole(
					env,
					context.project.id,
					org.id,
					targetUserId,
					body.role ?? "viewer",
					context.auth.userId,
					body,
					{ auditIntent: intent },
				),
				(result) => ({
					metadata: {
						project_role: { from: null, to: result.member.role },
						access_starts_at: { from: null, to: result.member.access_starts_at },
						access_expires_at: { from: null, to: result.member.access_expires_at },
					},
				}),
			);
			if (!mutation.created) throw new OrgError("already_project_member", "That person already has a project role.", 409);
			return json({ ok: true, member: mutation.member }, 201);
		} catch (error) { return orgFailure(error); }
	},

	"GET /auth/tokens": async (request, env) => {
		const context = await requireSessionProject(request, env, "project.keys.view");
		if (context.response) return context.response;
		return json({
			project: context.project,
			tokens: await listConnectionTokens(env, context.auth.userId, tokenProjectOptions(context)),
		});
	},

	"POST /auth/tokens": async (request, env, ctx) => {
		const context = await requireSessionProject(request, env, "project.keys.manage");
		if (context.response) return context.response;
		const parsed = await readSmallJsonObject(request, "/auth/tokens");
		if (parsed.response) return parsed.response;
		const body = parsed.body;
		const result = await runContextAuditedMutation(
			request, env, ctx, context, "project.keys.manage",
			{ action: "project.credential.created", targetType: "credential" },
			(intent) => createConnectionToken(env, context.auth.userId, body, {
				...tokenProjectOptions(context), auditIntent: intent,
			}),
			(created) => ({
				targetId: created.tokenRecord?.id ?? null,
				metadata: { status: { from: null, to: "active" } },
			}),
		);
		return json(result, 201);
	},

	"GET /auth/google/start": async (request, env) => {
		if (!(await allowRate(env.AUTH_LIMITER, clientIp(request)))) return tooManyFor("auth");
		const result = googleAuthStart(env, request);
		const headers = new Headers({ location: new URL(result.redirect, request.url).toString() });
		if (result.cookie) headers.append("set-cookie", result.cookie);
		return new Response(null, { status: 302, headers });
	},

	"GET /auth/google/callback": async (request, env) => {
		if (!(await allowRate(env.AUTH_LIMITER, clientIp(request)))) return tooManyFor("auth");
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
		// Bulk import is legitimate burst traffic (workspace files, backfills):
		// it gets the roomy IMPORT bucket, keyed to the credential+project so a
		// rotated body.userId cannot buy a fresh bucket.
		if (!(await allowRate(env.IMPORT_LIMITER, managedActorRateKey("ingest", auth)))) return tooManyFor("import");
		const capped = await refuseWriteOverAiBudget(env, auth);
		if (capped) return capped;
		const ungatedSourceTime = refuseUngatedSourceTime(env, auth.userId, body, auth.memoryScope);
		if (ungatedSourceTime) return ungatedSourceTime;
		const { messages, flush } = body;
		if (!Array.isArray(messages)) return json({ error: "messages[] is required" }, 400);
		const sourceLabel = clientSourceFromBody(body);
		if (sourceLabel.response) return sourceLabel.response;

		// Route through the shared command facade. Extraction runs in the
		// background, so fired async requests return an accepted/processing receipt.
		const door = await doorOverrides(env, auth, body);
		const test = testOnlyOverrides(env, body._test);
		const result = await runObserveMessagesCommand(env, ctx, auth.userId, messages, {
			flush: Boolean(flush),
			clientSource: sourceLabel.clientSource,
			conversationId: body.conversationId,
			threadId: body.threadId,
			sourceId: body.sourceId,
			idempotencyKey: body.idempotencyKey,
			delivery: normalizeDeliveryMetadata(body.delivery),
			memoryScope: auth.memoryScope,
			sourceTime: body.sourceTime,
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
		if (result.invalidIngestMessage) {
			return json({
				error: result.error,
				code: result.code,
				message: result.summary,
				retryable: false,
				field: result.field,
				message_index: result.message_index,
				first_message_index: result.first_message_index,
			}, result.http_status ?? 422, contractHeaders);
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
		if (result.episodePersistenceFailed) {
			return json({
				error: result.error,
				code: result.code,
				message: result.summary,
				retryable: result.retryable,
				outcome: result.outcome,
				job_id: result.job_id,
				source_packet_id: result.source_packet_id,
			}, result.http_status ?? 503, {
				...contractHeaders,
				...(result.retry_after_s ? { "retry-after": String(result.retry_after_s) } : {}),
			});
		}
		if (result.sourceEpisodeErased) {
			return json({
				error: result.error,
				code: result.code,
				message: result.summary,
				retryable: false,
				job_id: result.job_id,
				source_packet_id: result.source_packet_id,
			}, result.http_status ?? 409, contractHeaders);
		}
		if (result.extractionFailedTerminal) {
			// 422: this exact content's extraction failed permanently after its
			// bounded repairs. Deliberately NOT acceptance-shaped so outbox-style
			// callers quarantine their durable copy instead of deleting it.
			return json({
				error: "extraction_failed_terminal",
				code: "extraction_failed_terminal",
				message: result.summary,
				job_id: result.job_id,
				source_packet_id: result.source_packet_id,
			}, 422, contractHeaders);
		}
		return json(result, 200, contractHeaders);
	},

	"POST /v1/mcp/choose": async (request, env) => {
		const parsed = await readBody(request, "/v1/mcp/choose", { maxBytes: 16 * 1024 });
		if (parsed.response) return parsed.response;
		const body = parsed.body;
		if (!body || typeof body !== "object" || Array.isArray(body)) {
			return json({ error: "invalid_body", message: "The request body must be a JSON object." }, 400);
		}
		const auth = await requireMemoryUser(request, env, body.userId, {
			scopeInput: body.memoryScope ?? body.sourceScope,
			requiredScope: MEMORY_READ_SCOPE,
			requiredCapability: "project.chooser.use",
		});
		if (auth.response) return auth.response;
		if (!(await allowRate(env.SAVE_LIMITER, managedActorRateKey("mcp-choose", auth)))) return tooManyFor("save");

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
		const categoryMetadata = auth.managedProject
			? await projectCategoryMetadata(env, auth.managedProject.id)
			: new Map();
		const withProjectCategory = (item) => {
			const category = item?.project_category_id ? categoryMetadata.get(item.project_category_id) ?? null : null;
			return {
				...item,
				project_category: category,
			};
		};

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

		const nodes = nodesResult.results.map((node) => withProjectCategory(withCluster({
			...node,
			slices: slicesByNode.get(node.id) ?? [],
			events: eventsByNode.get(node.id) ?? [],
		})));
		const pages = pagesResult.results.map((page) => withProjectCategory(withCluster({
			...page,
			title: page.title,
			category: page.topic_filter ?? "interest",
			summary: page.short_summary,
		})));
		const candidates = candidatesResult.results.map((candidate) => withProjectCategory(withCluster({
			...candidate,
			label: candidate.label_guess ?? candidate.label,
			category: candidate.role_guess ?? candidate.cluster_guess ?? candidate.cluster_hint ?? "interest",
			cluster: candidate.cluster_guess ?? candidate.cluster_hint,
			summary: null,
		})));
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
		if (!(await allowRate(env.SAVE_LIMITER, managedActorRateKey("save", auth)))) return tooManyFor("save");
		const capped = await refuseWriteOverAiBudget(env, auth);
		if (capped) return capped;
		const ungatedSourceTime = refuseUngatedSourceTime(env, auth.userId, body, auth.memoryScope);
		if (ungatedSourceTime) return ungatedSourceTime;
		const { mode, content, messages, scope, n, topic, conversationId, recentContext } = body;
		const sourceLabel = clientSourceFromBody(body);
		if (sourceLabel.response) return sourceLabel.response;

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
				clientSource: sourceLabel.clientSource,
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
				clientSource: sourceLabel.clientSource,
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
		const parsed = await readSmallJsonObject(request, "/v1/beacon", 4 * 1024);
		if (parsed.response) return parsed.response;
		const body = parsed.body;
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
		const parsed = await readSmallJsonObject(request, "/v1/funnel", 4 * 1024);
		if (parsed.response) return parsed.response;
		const body = parsed.body;
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
		const parsed = await readSmallJsonObject(request, "/v1/error-report", 4 * 1024);
		if (parsed.response) return parsed.response;
		const body = parsed.body;
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

	"POST /auth/password": async (request, env, ctx) => {
		// This is a visible security mutation, so authenticate before buffering an
		// attacker-controlled body. Keep both actor and network buckets: an account
		// cannot rotate IPs for unlimited guesses, and one address cannot spray many
		// signed-in accounts without sharing the limiter.
		const auth = await getSessionUser(env, request);
		if (!auth) return json({ error: "unauthorized" }, 401);
		if (!(await allowRate(env.AUTH_LIMITER, `password:actor:${auth.userId}`))) return tooManyFor("auth");
		if (!(await allowRate(env.AUTH_LIMITER, `password:ip:${clientIp(request)}`))) return tooManyFor("auth");
		const parsed = await readSmallJsonObject(request, "/auth/password", 8 * 1024);
		if (parsed.response) return parsed.response;
		const body = parsed.body;
		if (Object.keys(body).some((key) => !["currentPassword", "newPassword"].includes(key))
			|| (body.currentPassword !== undefined && typeof body.currentPassword !== "string")
			|| typeof body.newPassword !== "string") {
			return json({ error: "invalid_password_request", message: "Only currentPassword and newPassword string fields are accepted." }, 400);
		}
		const result = await runAuditedMutation(env, {
			actorUserId: auth.userId,
			action: "account.password.changed",
			targetType: "user",
			targetId: auth.userId,
			requestId: auditRequestId(request),
			waitUntil: waitUntilFrom(ctx),
		}, (intent) => changePassword(env, request, body, { auditIntent: intent }), (changed) => ({
			outcome: changed.error ? "denied" : "ok",
			reason: changed.error ? "password_change_rejected" : null,
		}));
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
			`WITH account_spaces(account_user_id, memory_user_id) AS (
				SELECT id, id FROM users
				UNION
				SELECT owner_user_id, memory_owner_user_id FROM managed_projects WHERE status = 'active'
				UNION
				SELECT mp.owner_user_id, sp.memory_user_id
				FROM managed_projects mp
				JOIN source_packets sp ON sp.owner_user_id = mp.memory_owner_user_id
				WHERE mp.status = 'active' AND sp.memory_user_id IS NOT NULL
			)
			 SELECT u.id, u.email, u.name, u.role, u.status, u.created_at, u.terms_accepted_at,
				u.email_verified_at, (u.google_sub IS NOT NULL) AS google_linked,
				(SELECT COUNT(*) FROM nodes n JOIN account_spaces s ON s.memory_user_id = n.user_id
				 WHERE s.account_user_id = u.id AND n.deleted_at IS NULL) AS nodes,
				(SELECT COUNT(*) FROM memory_pages p JOIN account_spaces s ON s.memory_user_id = p.user_id
				 WHERE s.account_user_id = u.id AND p.deleted_at IS NULL) AS pages,
				(SELECT COUNT(*) FROM receipts r JOIN account_spaces s ON s.memory_user_id = r.user_id
				 WHERE s.account_user_id = u.id) AS receipts,
				(SELECT COUNT(*) FROM connection_tokens t WHERE t.user_id = u.id AND t.revoked_at IS NULL) AS tokens,
				(SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen_at
			 FROM users u
			 WHERE (? = '' OR lower(u.email) LIKE ? OR lower(COALESCE(u.name,'')) LIKE ?)
			 ORDER BY u.created_at DESC LIMIT 100`,
		).bind(query, like, like).all();
		return json({ ok: true, users: results ?? [] });
	},

	"POST /v1/admin/users/action": async (request, env, ctx) => {
		const auth = await getSessionUser(env, request);
		if (!auth) return json({ error: "unauthorized" }, 401);
		if (auth.user?.role !== "admin") return json({ error: "forbidden" }, 403);
		const parsed = await readSmallJsonObject(request, "/v1/admin/users/action");
		if (parsed.response) return parsed.response;
		const body = parsed.body;
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
		if (!["disable", "enable", "revoke_sessions", "promote", "demote", "delete"].includes(action)) {
			return json({ error: "unknown action" }, 400);
		}
		const auditDetails = {
			actorUserId: auth.userId,
			action: `admin.user.${action}`,
			targetType: "user",
			targetId: target.id,
			requestId: auditRequestId(request),
			waitUntil: waitUntilFrom(ctx),
			authorizationGuards: [auditInvariantStatement(
				env,
				`SELECT 1 FROM users
				  WHERE id = ? AND role = 'admin' AND status = 'active'
				    AND NOT EXISTS (SELECT 1 FROM account_erasure_tombstones WHERE user_id = ?)`,
				[auth.userId, auth.userId],
			)],
		};
		const auditedAdminBatch = async (intent, statements, postconditions, result) => {
			try {
				await commitAuditedBatch(env, intent, statements, {
					preconditions: [auditInvariantStatement(
						env,
						"SELECT 1 FROM users WHERE id = ? AND role = ? AND status = ?",
						[target.id, target.role, target.status],
					)],
					postconditions,
				});
				return auditedMutationResult(result, intent);
			} catch (error) {
				if (/fence_guard|violation IS NULL/i.test(String(error?.message ?? error))) {
					const conflict = new Error("The administrator or target account changed. Reload and try again.");
					conflict.code = "admin_state_conflict";
					conflict.status = 409;
					throw conflict;
				}
				throw error;
			}
		};
		switch (action) {
			case "disable": {
				await runAuditedMutation(env, auditDetails, (intent) => auditedAdminBatch(intent, [
					env.DB.prepare("UPDATE users SET status = 'disabled', updated_at = ? WHERE id = ? AND role = ? AND status = ?")
						.bind(now, target.id, target.role, target.status),
					env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").bind(now, target.id),
				], [auditInvariantStatement(env, "SELECT 1 FROM users WHERE id = ? AND status = 'disabled'", [target.id])],
				{ ok: true }), () => ({ metadata: { status: { from: target.status, to: "disabled" } } }));
				return json({ ok: true, action, status: "disabled" });
			}
			case "enable": {
				await runAuditedMutation(env, auditDetails, (intent) => auditedAdminBatch(intent, [
					env.DB.prepare("UPDATE users SET status = 'active', updated_at = ? WHERE id = ? AND role = ? AND status = ?")
						.bind(now, target.id, target.role, target.status),
				], [auditInvariantStatement(env, "SELECT 1 FROM users WHERE id = ? AND status = 'active'", [target.id])],
				{ ok: true }), () => ({ metadata: { status: { from: target.status, to: "active" } } }));
				return json({ ok: true, action, status: "active" });
			}
			case "revoke_sessions": {
				await runAuditedMutation(env, auditDetails, (intent) => auditedAdminBatch(intent, [
					env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").bind(now, target.id),
				], [auditInvariantStatement(env,
					"SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM sessions WHERE user_id = ? AND revoked_at IS NULL)", [target.id])],
				{ ok: true }));
				return json({ ok: true, action });
			}
			case "promote": {
				await runAuditedMutation(env, auditDetails, (intent) => auditedAdminBatch(intent, [
					env.DB.prepare("UPDATE users SET role = 'admin', updated_at = ? WHERE id = ? AND role = ? AND status = ?")
						.bind(now, target.id, target.role, target.status),
				], [auditInvariantStatement(env, "SELECT 1 FROM users WHERE id = ? AND role = 'admin'", [target.id])],
				{ ok: true }), () => ({ metadata: { role: { from: target.role, to: "admin" } } }));
				return json({ ok: true, action, role: "admin" });
			}
			case "demote": {
				await runAuditedMutation(env, auditDetails, (intent) => auditedAdminBatch(intent, [
					env.DB.prepare("UPDATE users SET role = 'user', updated_at = ? WHERE id = ? AND role = ? AND status = ?")
						.bind(now, target.id, target.role, target.status),
				], [auditInvariantStatement(env, "SELECT 1 FROM users WHERE id = ? AND role = 'user'", [target.id])],
				{ ok: true }), () => ({ metadata: { role: { from: target.role, to: "user" } } }));
				return json({ ok: true, action, role: "user" });
			}
			case "delete": {
				try {
					const result = await runAuditedMutation(
						env, auditDetails,
						(intent) => deleteAccountCompletely(env, target.id, { auditIntent: intent }),
						(deleted) => ({ metadata: { status: { from: target.status, to: deleted.deleted ? "deleted" : target.status } } }),
					);
					return json({ ok: true, action, deleted: result.deleted, already_deleted: result.already_deleted ?? false });
				} catch (error) {
					if (error?.code === "organization_transfer_required") {
						return json({ error: error.code, code: error.code, message: error.message }, error.status ?? 409);
					}
					throw error;
				}
			}
		}
	},

	"GET /v1/export": async (request, env, ctx) => {
		// Data portability: everything the user owns, one JSON download.
		const requestedUserId = new URL(request.url).searchParams.get("userId");
		const auth = await requireMemoryUser(request, env, requestedUserId, {
			requiredScope: MEMORY_READ_SCOPE,
			requiredCapability: "project.export",
		});
		if (auth.response) return auth.response;
		const buildPayload = async () => {
			const tables = EXPORT_TABLES;
			const results = await env.DB.batch(tables.map((table) => prepareExportRows(env, auth.userId, table)));
			const payload = {
				format: "uml-export",
				version: 1,
				exported_at: new Date().toISOString(),
				user_id: auth.userId,
			};
			tables.forEach((table, index) => { payload[table] = results[index].results ?? []; });
			return payload;
		};
		const payload = auth.managedProject
			? (await runContextAuditedMutation(
				request, env, ctx, managedMemoryAuditContext(auth), "project.export",
				{
					action: "project.export.downloaded",
					targetType: "export",
					targetId: auth.managedProject.id,
				},
				async (intent) => commitAuditedAccess(env, intent, { payload: await buildPayload() }),
				() => ({ metadata: { format: "json" } }),
			)).payload
			: await buildPayload();
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
				`WITH account_spaces(account_user_id, memory_user_id) AS (
					SELECT id, id FROM users
					UNION
					SELECT owner_user_id, memory_owner_user_id FROM managed_projects WHERE status = 'active'
					UNION
					SELECT mp.owner_user_id, sp.memory_user_id
					FROM managed_projects mp
					JOIN source_packets sp ON sp.owner_user_id = mp.memory_owner_user_id
					WHERE mp.status = 'active' AND sp.memory_user_id IS NOT NULL
				 )
				 SELECT u.id, u.email, u.name, u.created_at,
					(SELECT COUNT(*) FROM nodes n JOIN account_spaces s ON s.memory_user_id = n.user_id
					 WHERE s.account_user_id = u.id AND n.deleted_at IS NULL) AS nodes,
					(SELECT COUNT(*) FROM receipts r JOIN account_spaces s ON s.memory_user_id = r.user_id
					 WHERE s.account_user_id = u.id) AS receipts,
					(SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen_at
				 FROM users u ORDER BY receipts DESC LIMIT 20`,
			),
			env.DB.prepare("SELECT day, kind, count FROM site_visits WHERE day >= date('now', '-14 days') ORDER BY day"),
			env.DB.prepare(
				`SELECT date(created_at / 1000, 'unixepoch') AS day, source, COUNT(*) AS n
				 FROM receipts WHERE created_at > ? GROUP BY day, source ORDER BY day`,
			).bind(since14),
			env.DB.prepare(
				`WITH account_spaces(account_user_id, memory_user_id) AS (
					SELECT id, id FROM users
					UNION SELECT owner_user_id, memory_owner_user_id FROM managed_projects
					UNION
					SELECT mp.owner_user_id, sp.memory_user_id FROM managed_projects mp
					JOIN source_packets sp ON sp.owner_user_id = mp.memory_owner_user_id
					WHERE sp.memory_user_id IS NOT NULL
				 )
				 SELECT er.id, er.tool_name, er.status, er.error, er.created_at, u.email
				 FROM extraction_runs er
				 LEFT JOIN account_spaces s ON s.memory_user_id = er.user_id
				 LEFT JOIN users u ON u.id = COALESCE(s.account_user_id, er.user_id)
				 WHERE er.status = 'failed' ORDER BY er.created_at DESC LIMIT 12`,
			),
			env.DB.prepare(
				`WITH account_spaces(account_user_id, memory_user_id) AS (
					SELECT id, id FROM users
					UNION SELECT owner_user_id, memory_owner_user_id FROM managed_projects
					UNION
					SELECT mp.owner_user_id, sp.memory_user_id FROM managed_projects mp
					JOIN source_packets sp ON sp.owner_user_id = mp.memory_owner_user_id
					WHERE sp.memory_user_id IS NOT NULL
				 )
				 SELECT r.created_at, r.source, r.summary, u.email
				 FROM receipts r
				 LEFT JOIN account_spaces s ON s.memory_user_id = r.user_id
				 LEFT JOIN users u ON u.id = COALESCE(s.account_user_id, r.user_id)
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
			`WITH account_spaces(account_user_id, memory_user_id) AS (
				SELECT id, id FROM users
				UNION SELECT owner_user_id, memory_owner_user_id FROM managed_projects WHERE status = 'active'
			)
			 SELECT
				(SELECT COUNT(*) FROM users) AS accounts,
				(SELECT COUNT(DISTINCT s.account_user_id) FROM nodes n
				 JOIN account_spaces s ON s.memory_user_id = n.user_id
				 WHERE n.deleted_at IS NULL) AS with_memories`,
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
				`WITH account_spaces(memory_user_id) AS (
					SELECT ?1
					UNION SELECT memory_owner_user_id FROM managed_projects WHERE owner_user_id = ?1
					UNION
					SELECT sp.memory_user_id FROM managed_projects mp
					JOIN source_packets sp ON sp.owner_user_id = mp.memory_owner_user_id
					WHERE mp.owner_user_id = ?1 AND sp.memory_user_id IS NOT NULL
				 )
				 SELECT date(created_at / 1000, 'unixepoch') AS day, source, outcome, COUNT(*) AS n
				 FROM receipts WHERE user_id IN (SELECT memory_user_id FROM account_spaces)
				 GROUP BY day, source, outcome ORDER BY day DESC LIMIT 60`,
			).bind(targetId),
			env.DB.prepare(
				`WITH account_spaces(memory_user_id) AS (
					SELECT ?1
					UNION SELECT memory_owner_user_id FROM managed_projects WHERE owner_user_id = ?1
					UNION
					SELECT sp.memory_user_id FROM managed_projects mp
					JOIN source_packets sp ON sp.owner_user_id = mp.memory_owner_user_id
					WHERE mp.owner_user_id = ?1 AND sp.memory_user_id IS NOT NULL
				 )
				 SELECT created_at AS at, side, scope, substr(message, 1, 200) AS message
				 FROM error_reports WHERE user_id IN (SELECT memory_user_id FROM account_spaces)
				 ORDER BY created_at DESC LIMIT 25`,
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
		const ownerUserId = configurationOwnerUserId(auth);
		const state = await getMemoryRulesState(env, ownerUserId);
		return json({ ok: true, rules: state.rules, rules_version: state.version });
	},

	"PUT /v1/rules": async (request, env, ctx) => {
		const preliminary = await preauthorizeMemoryBody(request, env, {
			requiredScope: MEMORY_WRITE_SCOPE,
			requiredCapability: "project.rules.edit",
		});
		if (preliminary.response) return preliminary.response;
		const parsed = await readSmallJsonObject(request, "/v1/rules");
		if (parsed.response) return parsed.response;
		const body = parsed.body;
		const auth = await requireMemoryUser(request, env, body.userId, {
			requiredScope: MEMORY_WRITE_SCOPE,
			requiredCapability: "project.rules.edit",
		});
		if (auth.response) return auth.response;
		const ownerUserId = configurationOwnerUserId(auth);
		const precondition = rulesPrecondition(request, body);
		if (precondition.response) return precondition.response;
		try {
			const context = auth.managedProject ? {
				auth: auth.auth,
				project: auth.managedProject,
				membership: auth.membership,
			} : null;
			const saved = context ? await runContextAuditedMutation(
				request, env, ctx, context, "project.rules.edit",
				{ action: "project.rules.updated", targetType: "rules", targetId: auth.managedProject.id },
				(intent) => saveMemoryRulesIfCurrent(
					env, ownerUserId, body.rules ?? body, precondition.expectedVersion, { auditIntent: intent },
				),
				(result) => ({
					outcome: result.changed ? "ok" : "noop",
					reason: result.changed ? null : "no_change",
					metadata: rulesAuditMetadata(result),
				}),
			) : await saveMemoryRulesIfCurrent(env, ownerUserId, body.rules ?? body, precondition.expectedVersion);
			return json({
				ok: true,
				rules: saved.rules,
				rules_version: saved.version,
				rules_metadata: savedRulesMetadata(saved, auth.auth?.user),
				changed: saved.changed,
			});
		} catch (error) { return rulesFailure(error); }
	},

	"POST /v1/rules": async (request, env, ctx) => {
		// Alias for clients that cannot send PUT.
		const preliminary = await preauthorizeMemoryBody(request, env, {
			requiredScope: MEMORY_WRITE_SCOPE,
			requiredCapability: "project.rules.edit",
		});
		if (preliminary.response) return preliminary.response;
		const parsed = await readSmallJsonObject(request, "/v1/rules");
		if (parsed.response) return parsed.response;
		const body = parsed.body;
		const auth = await requireMemoryUser(request, env, body.userId, {
			requiredScope: MEMORY_WRITE_SCOPE,
			requiredCapability: "project.rules.edit",
		});
		if (auth.response) return auth.response;
		const ownerUserId = configurationOwnerUserId(auth);
		const precondition = rulesPrecondition(request, body);
		if (precondition.response) return precondition.response;
		try {
			const context = auth.managedProject ? {
				auth: auth.auth,
				project: auth.managedProject,
				membership: auth.membership,
			} : null;
			const saved = context ? await runContextAuditedMutation(
				request, env, ctx, context, "project.rules.edit",
				{ action: "project.rules.updated", targetType: "rules", targetId: auth.managedProject.id },
				(intent) => saveMemoryRulesIfCurrent(
					env, ownerUserId, body.rules ?? body, precondition.expectedVersion, { auditIntent: intent },
				),
				(result) => ({
					outcome: result.changed ? "ok" : "noop",
					reason: result.changed ? null : "no_change",
					metadata: rulesAuditMetadata(result),
				}),
			) : await saveMemoryRulesIfCurrent(env, ownerUserId, body.rules ?? body, precondition.expectedVersion);
			return json({
				ok: true,
				rules: saved.rules,
				rules_version: saved.version,
				rules_metadata: savedRulesMetadata(saved, auth.auth?.user),
				changed: saved.changed,
			});
		} catch (error) { return rulesFailure(error); }
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
		if (!(await allowRate(env.SAVE_LIMITER, managedActorRateKey("turn", auth)))) return tooManyFor("save");
		const ungatedSourceTime = refuseUngatedSourceTime(env, auth.userId, body, auth.memoryScope);
		if (ungatedSourceTime) return ungatedSourceTime;
		const messages = Array.isArray(body.messages) ? body.messages : [];
		if (!messages.length && !body.query) {
			return json({ error: "messages[] or query is required" }, 400);
		}
		const lastUser = [...messages].reverse().find((m) => (m?.role ?? "user") === "user");
		const query = String(body.query ?? lastUser?.content ?? "").trim();
		const door = await doorOverrides(env, auth, body);
		// The SDK profile's layered rules govern this door end to end — the
		// autoCollect decision included, so a key's rules can turn capture off.
		// If the rules store cannot be read we do not know what this account
		// allows, and this door both recalls and captures. Refuse honestly rather
		// than proceed on assumed defaults.
		let rules;
		try {
			rules = await resolveAdmissionRules(env, auth.userId, door.rules);
		} catch (error) {
			if (error?.code === "memory_rules_unavailable") {
				return json({
					error: "memory_rules_unavailable",
					code: "memory_rules_unavailable",
					message: "Your memory rules could not be read just now, so nothing was captured. Nothing was lost — retry in a moment.",
				}, 503, { "retry-after": "5" });
			}
			throw error;
		}

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
		// The AI-write quota degrades this door instead of refusing it: recall
		// is a read and costs nothing extra, so the caller's chat loop keeps
		// working — only capture reports capped. No http_status on purpose:
		// the response stays 200 with recall intact.
		let turnBudgetRefusal = null;
		if (rules.autoCollect && messages.length) {
			try {
				turnBudgetRefusal = await checkAiBudget(env, aiBudgetIdentity(auth));
			} catch (error) {
				console.warn(JSON.stringify({ event: "ai_quota_unavailable", door: "turn", error: String(error?.message ?? error) }));
				turnBudgetRefusal = {
					reason: "unavailable",
					error: "ai_quota_unavailable",
					message: "Itsuki could not verify the AI quota just now, so nothing was captured. Nothing was lost — retry in a moment.",
				};
			}
		}
		if (turnBudgetRefusal) {
			collect = {
				enabled: true,
				ok: false,
				capped: turnBudgetRefusal.capped ?? turnBudgetRefusal.reason,
				error: turnBudgetRefusal.error,
				summary: turnBudgetRefusal.message,
				...(turnBudgetRefusal.reason === "monthly"
					? { usage: { used: turnBudgetRefusal.used, limit: turnBudgetRefusal.limit, unit: "ai_writes", resets_at: turnBudgetRefusal.resetsAt } }
					: {}),
			};
		} else if (rules.autoCollect && messages.length) {
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
		// A quota-capped capture is a completed turn: recall answered, and
		// collect says exactly why nothing was captured. 200, like the
		// Playground's daily cap — not an error the caller's loop must handle.
		const ok = collect.ok !== false || Boolean(collect.capped);
		return json({
			ok,
			recall,
			collect,
			rules: { autoCollect: rules.autoCollect, captureDefault: rules.captureDefault },
		}, ok ? 200 : (collect.http_status ?? (collect.backpressure ? 429 : (collect.idempotencyConflict ? 409 : 400))));
	},

	// ---- Playground -------------------------------------------------------
	// Session auth ONLY. An API key or MCP token must not be able to spend a
	// free model call: those doors reach memory, not the chat model.
	"GET /v1/playground": async (request, env) => {
		const context = await requireSessionProject(request, env, "project.playground.read");
		if (context.response) return context.response;
		const userId = context.memoryOwnerUserId;
		const url = new URL(request.url);
		const threads = await listThreads(env, userId);
		const requested = url.searchParams.get("thread");
		const active = (await getThread(env, userId, requested)) ?? (threads[0]
			? await getThread(env, userId, threads[0].id)
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
					messages: await reconcileExtractions(env, userId, await getThreadMessages(env, userId, active.id)),
				}
				: null,
			limits: {
				...limits,
				threadsUsed: threads.length,
				usedToday: await countMessagesToday(env, userId),
			},
		});
	},

	"POST /v1/playground/chat": async (request, env, ctx) => {
		const context = await requireSessionProject(request, env, "project.playground.use");
		if (context.response) return context.response;
		const userId = context.memoryOwnerUserId;
		if (!(await allowRate(env.SAVE_LIMITER, `pg:${userId}`))) return tooManyFor("save");
		const parsed = await readSmallJsonObject(request, "/v1/playground/chat");
		if (parsed.response) return parsed.response;
		const body = parsed.body;
		return json(await playgroundTurn(env, ctx, userId, {
			message: body.message,
			threadId: body.threadId,
			accountUserId: context.auth.userId,
			// The selected managed project is the authority for custom filing
			// categories. playgroundTurn resolves the active set only after its
			// fail-closed rules load, so this door cannot reuse a stale/browser-
			// supplied category or borrow one from another project.
			managedProjectId: context.project.id,
			overrides: testOnlyOverrides(env, body._test),
		}));
	},

	/**
	 * What Itsuki WOULD remember from a sentence, without remembering it.
	 *
	 * The preview examples are scripted; this is what makes a typed sentence do
	 * something real inside one. It runs the model and writes nothing — no source
	 * packet, no episode, no node, no receipt — so a read-only world stays
	 * read-only while still answering honestly.
	 */
	"POST /v1/playground/preview": async (request, env) => {
		const context = await requireSessionProject(request, env, "project.playground.use");
		if (context.response) return context.response;
		if (!(await allowRate(env.SAVE_LIMITER, `pgprev:${context.memoryOwnerUserId}`))) return tooManyFor("save");
		const parsed = await readSmallJsonObject(request, "/v1/playground/preview");
		if (parsed.response) return parsed.response;
		const body = parsed.body;
		const rules = await getMemoryRules(env, context.memoryOwnerUserId);
		return json(await playgroundPreviewExtract(env, body.message, { rules }));
	},

	"POST /v1/playground/thread": async (request, env) => {
		// Authorize before consuming the body: a malformed or oversized request
		// must not become an authentication oracle or make an unauthorized caller
		// spend parsing resources. Deletion is a second, stricter decision made on
		// this already-resolved fresh membership context.
		const context = await requireSessionProject(request, env, "project.playground.use");
		if (context.response) return context.response;
		const parsed = await readBody(request, "/v1/playground/thread", { maxBytes: 16 * 1024 });
		if (parsed.response) return parsed.response;
		const body = parsed.body;
		if (!body || typeof body !== "object" || Array.isArray(body)) {
			return json({ error: "invalid_body", message: "The request body must be a JSON object." }, 400);
		}
		if (Object.prototype.hasOwnProperty.call(body, "delete") && typeof body.delete !== "boolean") {
			return json({ error: "invalid_delete", message: '"delete" must be true or false.' }, 400);
		}
		const deleting = body.delete === true;
		if (deleting) {
			const denied = requireCapability(context, "project.playground.delete");
			if (denied) return denied;
		}
		const userId = context.memoryOwnerUserId;
		if (deleting) return json(await deleteThread(env, userId, body.threadId));
		return json(await createThread(env, userId, body.title || "New chat", {
			accountUserId: context.auth.userId,
			managedProjectId: context.project.id,
		}));
	},

	"PUT /v1/playground/settings": async (request, env) => {
		const context = await requireSessionProject(request, env, "project.playground.policy.edit");
		if (context.response) return context.response;
		const userId = context.memoryOwnerUserId;
		const parsed = await readSmallJsonObject(request, "/v1/playground/settings");
		if (parsed.response) return parsed.response;
		const body = parsed.body;
		const thread = await getThread(env, userId, body.threadId);
		if (!thread) return json({ ok: false, message: "Open a chat first, then apply settings to it." }, 404);
		const settings = normalizeThreadSettings(body.settings ?? body);
		await env.DB.prepare("UPDATE playground_threads SET settings_json = ?, updated_at = ? WHERE id = ? AND user_id = ?")
			.bind(JSON.stringify(settings), Date.now(), thread.id, userId).run();
		return json({ ok: true, settings });
	},

	// ---- Memory exports ---------------------------------------------------
	"GET /v1/exports": async (request, env) => {
		const auth = await requireMemoryUser(request, env, new URL(request.url).searchParams.get("userId"), {
			requiredScope: MEMORY_READ_SCOPE,
			requiredCapability: "project.export",
		});
		if (auth.response) return auth.response;
		return json({ ok: true, exports: await listExports(env, auth.userId) });
	},

	"POST /v1/exports": async (request, env, ctx) => {
		const preliminary = await preauthorizeMemoryBody(request, env, {
			requiredScope: MEMORY_READ_SCOPE,
			requiredCapability: "project.export",
		});
		if (preliminary.response) return preliminary.response;
		const parsed = await readSmallJsonObject(request, "/v1/exports");
		if (parsed.response) return parsed.response;
		const body = parsed.body;
		const unknown = Object.keys(body).filter((key) => !["userId", "entity"].includes(key));
		if (unknown.length) return json({ error: "unknown_export_field", message: `Unknown export field: ${unknown[0]}.` }, 400);
		const auth = await requireMemoryUser(request, env, body.userId, {
			requiredScope: MEMORY_READ_SCOPE,
			requiredCapability: "project.export",
		});
		if (auth.response) return auth.response;
		const auditContext = {
			auth: { userId: auth.auth?.userId, type: auth.auth?.type ?? "user" },
			project: auth.managedProject,
			membership: auth.membership,
		};
		const job = auth.managedProject
			? await runContextAuditedMutation(
				request, env, ctx, auditContext, "project.export",
				{ action: "project.export.created", targetType: "export" },
				(intent) => createExport(env, auth.userId, { entity: body.entity, auditIntent: intent }),
				(created) => ({
					targetId: created.id,
					metadata: { status: { from: null, to: created.status ?? "pending" }, format: created.format ?? "json" },
				}),
			)
			: await createExport(env, auth.userId, { entity: body.entity });
		// The work happens in the user's Durable Object so a large graph cannot
		// hold this response open. The page polls for the finished row.
		const stub = env.USER_MEMORY.get(env.USER_MEMORY.idFromName(auth.userId));
		const run = stub.runExport(auth.userId, job.id).catch((error) => {
			console.warn(`export dispatch failed user=${auth.userId}:`, error?.message ?? error);
		});
		if (ctx?.waitUntil) ctx.waitUntil(run); else await run;
		return json({ ok: true, export: job }, 201);
	},

	"GET /v1/exports/download": async (request, env, ctx) => {
		const url = new URL(request.url);
		const auth = await requireMemoryUser(request, env, url.searchParams.get("userId"), {
			requiredScope: MEMORY_READ_SCOPE,
			requiredCapability: "project.export",
		});
		if (auth.response) return auth.response;
		const requestedExportId = url.searchParams.get("id");
		const row = auth.managedProject
			? (await runContextAuditedMutation(
				request, env, ctx, managedMemoryAuditContext(auth), "project.export",
				{
					action: "project.export.downloaded",
					targetType: "export",
					targetId: requestedExportId,
				},
				async (intent) => commitAuditedAccess(env, intent, {
					row: await getExport(env, auth.userId, requestedExportId),
				}),
				(result) => ({
					outcome: result.row?.status === "complete" && result.row?.data ? "ok" : "noop",
					reason: result.row?.status === "complete" && result.row?.data
						? null
						: result.row ? "export_not_ready" : "export_not_found",
					metadata: result.row
						? { status: result.row.status, format: result.row.format ?? "json" }
						: { format: "json" },
				}),
			)).row
			: await getExport(env, auth.userId, requestedExportId);
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
		// `cancelled` separates the two outcomes that both settle as `failed`:
		// work a confirmed erasure cancelled, and work that actually failed.
		const cancelledParam = url.searchParams.get("cancelled");
		const jobs = await listJobs(env, auth.userId, {
			status: url.searchParams.get("status") || undefined,
			since: url.searchParams.get("since") || undefined,
			limit: url.searchParams.get("limit") || undefined,
			cancelled: cancelledParam === null ? undefined : cancelledParam === "true",
		});
		return json({ ok: true, jobs, count: jobs.length });
	},

	"GET /v1/ops/overview": async (request, env) => {
		// OPS-02. Account-wide operator view: every other read route is scoped to
		// ONE memory user, so an integrator running sub-tenants had nowhere to see
		// backlog, stuck work, cancellations or erasures across their account.
		// METADATA ONLY — counts, states, timestamps, latency; never content.
		const url = new URL(request.url);
		// Deliberately resolved WITHOUT a userId: this is the account's own view,
		// not a sub-tenant's, and the owner id is what scopes every query below.
		const auth = await requireMemoryUser(request, env, null, {
			requiredScope: MEMORY_READ_SCOPE,
			allowLegacy: false,
		});
		// The legacy x-api-key lane writes under RAW external ids and has no
		// owner/sub-tenant relationship to aggregate (architecture.md §4). A
		// valid legacy key here deserves that answer, not the generic
		// "userId is required" — which would send an operator off to add a
		// userId that still could not work.
		const accountScopeRequired = () => json({
			error: "account_scope_required",
			code: "account_scope_required",
			message: "The operator overview needs an account-scoped credential: a Bearer API token or a signed-in session. The legacy x-api-key lane writes under raw external ids and has no sub-tenant relationship to aggregate.",
		}, 400);
		if (auth.response) {
			if (await isAuthorized(request, env)) return accountScopeRequired();
			return auth.response;
		}
		const ownerUserId = auth.memoryScope?.ownerUserId;
		if (!ownerUserId || ownerUserId === "legacy") return accountScopeRequired();
		return json(await operatorOverview(env, ownerUserId, {
			range: url.searchParams.get("range") ?? "7d",
			limit: url.searchParams.get("limit") ?? undefined,
		}));
	},

	"GET /v1/dashboard": async (request, env) => {
		const url = new URL(request.url);
		if (url.searchParams.getAll("range").length > 1) {
			return json({
				error: "duplicate_query_parameter",
				code: "duplicate_query_parameter",
				field: "range",
				message: "The dashboard accepts exactly one range parameter.",
			}, 400, { "cache-control": "private, no-store" });
		}
		for (const key of url.searchParams.keys()) {
			if (key !== "range") {
				return json({
					error: "unsupported_query_parameter",
					code: "unsupported_query_parameter",
					field: key,
					message: "The dashboard accepts only the range parameter. Project scope comes from the authenticated credential and x-itsuki-project header.",
				}, 400, { "cache-control": "private, no-store" });
			}
		}
		const auth = await requireMemoryUser(request, env, null, {
			requiredScope: MEMORY_READ_SCOPE,
			allowLegacy: false,
			registerSpace: false,
		});
		if (auth.response) {
			if (await isAuthorized(request, env)) {
				return json({
					error: "account_scope_required",
					code: "account_scope_required",
					message: "The dashboard needs a signed-in session or a project-bound Bearer API token.",
				}, 400, { "cache-control": "private, no-store" });
			}
			return auth.response;
		}
		if (!auth.managedProject?.id || !auth.memoryScope?.ownerUserId) {
			return json({
				error: "managed_project_required",
				code: "managed_project_required",
			}, 400, { "cache-control": "private, no-store" });
		}
		if (!(await allowRate(env.READ_LIMITER, managedActorRateKey("dashboard", auth)))) {
			return tooManyFor("read");
		}
		try {
			return json(await projectDashboard(env, {
				projectId: auth.managedProject.id,
				memoryOwnerUserId: auth.memoryScope.ownerUserId,
				accountUserId: auth.memoryScope.accountUserId ?? auth.auth?.userId ?? null,
				range: url.searchParams.get("range") ?? "7d",
			}), 200, { "cache-control": "private, no-store" });
		} catch (error) {
			if (error instanceof DashboardRangeError || error?.name === "DashboardRangeError") {
				return json({
					error: error.code ?? "invalid_dashboard_range",
					code: error.code ?? "invalid_dashboard_range",
					message: String(error.message),
				}, Number(error.status ?? 400), { "cache-control": "private, no-store" });
			}
			throw error;
		}
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
		const preliminary = await preauthorizeMemoryBody(request, env, {
			allowTokenAuth: false,
			requiredCapability: "project.memory.delete",
		});
		if (preliminary.response) return preliminary.response;
		const parsed = await readSmallJsonObject(request, "/v1/actions/delete-last-extraction");
		if (parsed.response) return parsed.response;
		const body = parsed.body;
		const auth = await requireControlUser(request, env, body.userId, {
			requiredCapability: "project.memory.delete",
		});
		if (auth.response) return auth.response;
		return json(await deleteLastExtraction(env, auth.userId));
	},

	"POST /v1/actions/delete-object": async (request, env, ctx) => {
		const preliminary = await preauthorizeMemoryBody(request, env, {
			allowTokenAuth: false,
			requiredCapability: "project.memory.delete",
		});
		if (preliminary.response) return preliminary.response;
		const parsed = await readSmallJsonObject(request, "/v1/actions/delete-object");
		if (parsed.response) return parsed.response;
		const body = parsed.body;
		const auth = await requireControlUser(request, env, body.userId, {
			requiredCapability: "project.memory.delete",
		});
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
		const preliminary = await preauthorizeMemoryBody(request, env, {
			allowTokenAuth: false,
			requiredCapability: "project.memory.delete",
		});
		if (preliminary.response) return preliminary.response;
		const parsed = await readSmallJsonObject(request, "/v1/actions/archive-object");
		if (parsed.response) return parsed.response;
		const body = parsed.body;
		const auth = await requireControlUser(request, env, body.userId, {
			requiredCapability: "project.memory.delete",
		});
		if (auth.response) return auth.response;
		if (!body.kind || !body.id) return json({ error: "kind and id are required" }, 400);
		return json(await archiveObject(env, auth.userId, body));
	},

	"POST /v1/actions/delete-all": async (request, env, ctx) => {
		const preliminary = await preauthorizeMemoryBody(request, env, {
			allowTokenAuth: false,
			requiredCapability: "project.memory.delete",
		});
		if (preliminary.response) return preliminary.response;
		const parsed = await readSmallJsonObject(request, "/v1/actions/delete-all");
		if (parsed.response) return parsed.response;
		const body = parsed.body;
		const unknown = Object.keys(body).filter((key) => !["userId", "confirm"].includes(key));
		if (unknown.length) return json({ error: "unknown_delete_field", message: `Unknown delete field: ${unknown[0]}.` }, 400);
		const auth = await requireControlUser(request, env, body.userId, {
			requiredCapability: "project.memory.delete",
		});
		if (auth.response) return auth.response;
		const result = auth.managedProject
			? await runContextAuditedMutation(
				request, env, ctx, managedMemoryAuditContext(auth), "project.memory.delete",
				{
					action: "project.memory.space_reset",
					targetType: "memory_space",
					targetId: auth.userId,
				},
				(intent) => deleteAllMemories(env, auth.userId, body.confirm, { auditIntent: intent }),
				(deleted) => ({
					outcome: deleted.deleted ? "ok" : "noop",
					reason: deleted.deleted ? null : "confirmation_required",
					metadata: deleted.deleted ? {
						status: { from: "active", to: "reset" },
						deleted_count: Object.values(deleted.counts ?? {}).reduce((sum, count) => sum + Number(count || 0), 0),
					} : null,
				}),
			)
			: await deleteAllMemories(env, auth.userId, body.confirm);
		if (result.deleted) {
			ctx.waitUntil(emitWebhookEvent(env, (p) => ctx.waitUntil(p), auth.userId, "memory.deleted", {
				source: "delete_all",
				counts: { deleted_all: true },
			}));
		}
		return json({ ...result, scope: "memory_space" }, result.deleted ? 200 : 400);
	},

	"POST /v1/actions/clean-junk": async (request, env) => {
		const preliminary = await preauthorizeMemoryBody(request, env, {
			allowTokenAuth: false,
			requiredCapability: "project.memory.delete",
		});
		if (preliminary.response) return preliminary.response;
		const parsed = await readSmallJsonObject(request, "/v1/actions/clean-junk");
		if (parsed.response) return parsed.response;
		const body = parsed.body;
		const auth = await requireControlUser(request, env, body.userId, {
			requiredCapability: "project.memory.delete",
		});
		if (auth.response) return auth.response;
		return json(await cleanJunkMemories(env, auth.userId, { confirm: body.confirm }));
	},

	"POST /v1/actions/clear-failed-receipts": async (request, env) => {
		const preliminary = await preauthorizeMemoryBody(request, env, {
			allowTokenAuth: false,
			requiredCapability: "project.memory.delete",
		});
		if (preliminary.response) return preliminary.response;
		const parsed = await readSmallJsonObject(request, "/v1/actions/clear-failed-receipts");
		if (parsed.response) return parsed.response;
		const body = parsed.body;
		const auth = await requireControlUser(request, env, body.userId, {
			requiredCapability: "project.memory.delete",
		});
		if (auth.response) return auth.response;
		return json(await clearFailedReceipts(env, auth.userId));
	},

	"POST /v1/actions/organize-clusters": async (request, env) => {
		const preliminary = await preauthorizeMemoryBody(request, env, {
			allowTokenAuth: false,
			requiredCapability: "project.memory.write",
		});
		if (preliminary.response) return preliminary.response;
		const parsed = await readSmallJsonObject(request, "/v1/actions/organize-clusters");
		if (parsed.response) return parsed.response;
		const body = parsed.body;
		const auth = await requireControlUser(request, env, body.userId, {
			requiredCapability: "project.memory.write",
		});
		if (auth.response) return auth.response;
		return json(await organizeUserClusters(env, auth.userId));
	},

	"POST /v1/actions/repair-graph": async (request, env) => {
		const preliminary = await preauthorizeMemoryBody(request, env, {
			allowTokenAuth: false,
			requiredCapability: "project.memory.delete",
		});
		if (preliminary.response) return preliminary.response;
		const parsed = await readSmallJsonObject(request, "/v1/actions/repair-graph");
		if (parsed.response) return parsed.response;
		const body = parsed.body;
		const auth = await requireControlUser(request, env, body.userId, {
			requiredCapability: "project.memory.delete",
		});
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
			recallMode: body.recallMode,
			// BF-2: this is the line that was missing. The parameter was
			// allowlisted, documented, and exposed by both SDKs, and it stopped here.
			limit: body.limit,
			// E8: cross-encoder reranking. Honoured only for accounts already on
			// the V3 depth path, so it can never add a model call to a legacy read.
			rerank: body.rerank,
			rerankKeep: body.rerankKeep,
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

		// The AI half: what inference this account consumed in the range, and
		// where the monthly plan stands. Attributed to the ACCOUNT (the same
		// column the quota enforces), so a sub-tenant userId cannot present a
		// different bill. Neurons are measured + a labelled derived estimate
		// for calls the binding didn't price — never blended silently.
		const identity = aiBudgetIdentity(auth);
		const budget = aiBudget(env);
		let aiUsage = null;
		let quota = null;
		try {
			const accountColumn = identity.accountUserId
				? "account_user_id = ?1"
				: "user_id = ?1 AND account_user_id IS NULL";
			const ai = await env.DB.prepare(
				`SELECT COUNT(*) AS calls,
					SUM(COALESCE(input_tokens, 0)) AS input_tokens,
					SUM(COALESCE(output_tokens, 0)) AS output_tokens,
					SUM(CASE WHEN neurons IS NOT NULL THEN neurons ELSE 0 END) AS measured_neurons,
					SUM(CASE WHEN neurons IS NULL THEN COALESCE(input_tokens, 0) ELSE 0 END) AS unmeasured_in,
					SUM(CASE WHEN neurons IS NULL THEN COALESCE(output_tokens, 0) ELSE 0 END) AS unmeasured_out
				 FROM ai_calls WHERE ${accountColumn} AND created_at BETWEEN ?2 AND ?3`,
			).bind(identity.accountUserId ?? identity.userId, fromMs, toMs).first();
			const measured = Number(ai?.measured_neurons ?? 0);
			const derived = derivedNeurons(ai?.unmeasured_in, ai?.unmeasured_out);
			aiUsage = {
				calls: Number(ai?.calls ?? 0),
				input_tokens: Number(ai?.input_tokens ?? 0),
				output_tokens: Number(ai?.output_tokens ?? 0),
				neurons_measured: Math.round(measured * 1000) / 1000,
				neurons_derived: Math.round(derived * 1000) / 1000,
				neurons_total: Math.round((measured + derived) * 1000) / 1000,
				neurons_source: "measured+derived",
			};
			const used = await countWritesThisMonth(env, identity);
			quota = {
				unit: "ai_writes",
				used,
				limit: budget.monthlyWrites,
				remaining: Math.max(0, budget.monthlyWrites - used),
				period: "calendar_month_utc",
				resets_at: new Date(startOfNextUtcMonth()).toISOString(),
				capped: used >= budget.monthlyWrites,
			};
		} catch (error) {
			// Usage must answer even if the AI accounting is unreadable — the
			// activity half of this response does not depend on it.
			console.warn(JSON.stringify({ event: "usage_ai_unavailable", error: String(error?.message ?? error) }));
		}
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
			ai: aiUsage,
			quota,
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
		ctx.waitUntil(processInvitationEmailOutbox(env, { limit: 25 }));
		ctx.waitUntil((async () => {
			await drainAuditCompletions(env, { limit: 100 });
			await reconcileStaleAuditIntents(env, {
				now: Number(controller?.scheduledTime) || Date.now(),
				limit: 250,
			});
		})());
		ctx.waitUntil((async () => {
			const scheduledAt = Number(controller?.scheduledTime);
			const now = Number.isFinite(scheduledAt) && scheduledAt > 0 ? scheduledAt : Date.now();
			const requestId = systemRequestId("retention-schedule", String(now));
			await scheduleRetentionRuns(env, { now, limit: 50, requestId });
			await processQueuedRetentionRuns(env, { now, maxRuns: 5, batchSize: 40, requestId });
		})());
	},

	async fetch(request, env, ctx) {
		const requestId = deriveRequestId(request);
		const correlatedRequest = withAuditRequestId(request, requestId);
		// Users must never see a raw exception or an infrastructure error page:
		// every unhandled failure is reported for the admin and answered with one
		// calm, generic message.
		try {
			return withResponseRequestId(await handleRequest(correlatedRequest, env, ctx), requestId);
		} catch (error) {
			const auditResponse = auditFailure(error);
			if (auditResponse) return withResponseRequestId(auditResponse, requestId);
			const scope = (() => { try { return new URL(request.url).pathname; } catch { return "unknown"; } })();
			ctx.waitUntil(reportServerError(env, scope, error));
			return withResponseRequestId(json({ error: "something_went_wrong", message: FRIENDLY_FAILURE }, 500), requestId);
		}
	},
};

// CORS is opt-in (ENABLE_CORS="true") and applies ONLY to /v1/*: browser apps
// authenticate with Bearer tokens, never cookies (allow-credentials is never
// sent, and resolveMemoryUser skips sessions cross-origin). /auth, /mcp,
// admin, and control routes stay same-origin.
const CORS_HEADERS = {
	"access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
	"access-control-allow-headers": "authorization, content-type, if-match, x-request-id, x-uml-token, x-itsuki-project",
	"access-control-expose-headers": "x-request-id, x-itsuki-export-count, x-itsuki-export-truncated",
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

		if (request.method === "PATCH" && url.pathname.startsWith("/auth/projects/")) {
			const auth = await getSessionUser(env, request);
			if (!auth) return json({ error: "unauthorized" }, 401);
			const id = decodeURIComponent(url.pathname.slice("/auth/projects/".length));
			if (!id || id.includes("/")) return json({ error: "not found" }, 404);
			try {
				const project = await getManagedProjectForUser(env, auth.userId, id);
				if (!project) {
					return managedProjectFailure(new ManagedProjectError(
						"project_not_found", "That project does not exist.", 404,
					));
				}
				const membership = await resolveMembership(env, { userId: auth.userId, project });
				if (!can("project.edit", membership)) return forbidden("project.edit");
				const parsed = await readSmallJsonObject(request, "/auth/projects/:id");
				if (parsed.response) return parsed.response;
				const body = parsed.body;
				const orgId = membership.orgId ?? (await ensureDefaultOrganization(env, project.owner_user_id)).id;
				const mutation = await runAuditedMutation(
					env,
					{
						orgId,
						projectId: id,
						actorUserId: auth.userId,
						action: "project.updated",
						targetType: "project",
						targetId: id,
						requestId: auditRequestId(request),
						waitUntil: waitUntilFrom(ctx),
						authorizationGuards: [capabilityGuardStatement(env, {
							actorUserId: auth.userId, orgId, projectId: id, capability: "project.edit",
						})],
					},
					(intent) => updateManagedProject(
						env, project.owner_user_id, id, body, request.headers.get("if-match"), { auditIntent: intent },
					),
					(result) => ({
						outcome: result.changed ? "ok" : "noop",
						reason: result.changed ? null : "no_change",
						metadata: auditDiff(result.previousProject, result.project),
					}),
				);
				return json({ project: mutation.project, changed: mutation.changed });
			} catch (error) {
				return managedProjectFailure(error);
			}
		}

		if (request.method === "POST" && url.pathname.startsWith("/auth/tokens/") && url.pathname.endsWith("/revoke")) {
			const context = await requireSessionProject(request, env, "project.keys.manage");
			if (context.response) return context.response;
			const id = url.pathname.slice("/auth/tokens/".length).replace(/\/revoke$/, "");
			const result = await runContextAuditedMutation(
				request, env, ctx, context, "project.keys.manage",
				{ action: "project.credential.revoked", targetType: "credential", targetId: id },
				(intent) => revokeConnectionToken(
					env,
					context.auth.userId,
					id,
					{ ...tokenProjectOptions(context), auditIntent: intent },
				),
				(mutation) => ({
					outcome: mutation.revoked ? "ok" : "noop",
					reason: mutation.revoked ? null : "already_revoked_or_missing",
					metadata: mutation.revoked ? { status: { from: "active", to: "revoked" } } : null,
				}),
			);
			return json(result);
		}

		// The app offers one action per key now: delete. Revoke stays reachable
		// above for anything already scripted against it.
		if (request.method === "DELETE" && url.pathname.startsWith("/auth/tokens/")) {
			const context = await requireSessionProject(request, env, "project.keys.manage");
			if (context.response) return context.response;
			const id = url.pathname.slice("/auth/tokens/".length);
			if (!id) return json({ error: "not found" }, 404);
			const tokenId = decodeURIComponent(id);
			const result = await runContextAuditedMutation(
				request, env, ctx, context, "project.keys.manage",
				{ action: "project.credential.deleted", targetType: "credential", targetId: tokenId },
				(intent) => deleteConnectionToken(
					env,
					context.auth.userId,
					tokenId,
					{ ...tokenProjectOptions(context), auditIntent: intent },
				),
				(mutation) => ({
					outcome: mutation.deleted ? "ok" : "noop",
					reason: mutation.deleted ? null : "already_deleted_or_missing",
					metadata: mutation.deleted ? { status: { from: "active", to: null } } : null,
				}),
			);
			return json(result);
		}

		if (url.pathname === "/v1/candidates" || url.pathname.startsWith("/v1/candidates/")) {
			return handleCandidateRoutes(request, env, url, ctx);
		}

		// Real delete for API keys (Part 3). Sessions keep full power; Bearer
		// keys are scoped to their account (and sub-tenant when userId given).
		if (request.method === "DELETE" && (url.pathname === "/v1/memories" || url.pathname.startsWith("/v1/memories/"))) {
			return handleMemoryDeleteRoutes(request, env, url, ctx);
		}

		// Read-only inventory: the management half of the memory surface. API
		// keys could write and destroy but never see what they had — every MCP
		// client and plugin doctor needs list/get without a dashboard session.
		if (request.method === "GET" && (url.pathname === "/v1/memories" || url.pathname.startsWith("/v1/memories/"))) {
			return handleMemoryReadRoutes(request, env, url);
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

		if (url.pathname.startsWith("/v1/settings/")) {
			const settingsResponse = await handleSettingsMemberRoutes(request, env, ctx, url);
			if (settingsResponse) return settingsResponse;
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

async function serveProjectBoundMcp(request, env, ctx, url, auth) {
	try {
		const managed = await resolveManagedProject(env, request, auth);
		const membership = await resolveMembership(env, {
			userId: auth.userId,
			project: managed.project,
		});
		const tokenScopes = auth.token?.scopes ?? [];
		if (!tokenAllowsScope(tokenScopes, MEMORY_READ_SCOPE)) {
			return json({ error: "forbidden", code: "insufficient_scope", required_scope: MEMORY_READ_SCOPE }, 403);
		}
		if (!can("project.memory.read", membership)) {
			return forbidden("project.memory.read");
		}
		// Normalize wildcards and intersect the credential's declared scopes with
		// the role that exists now. A downgrade therefore takes effect on the next
		// MCP request without revoking the key: recall remains available to a
		// viewer, while save tools receive the existing insufficient_scope result.
		const effectiveScopes = [MEMORY_READ_SCOPE];
		if (
			can("project.memory.write", membership)
			&& tokenAllowsScope(tokenScopes, MEMORY_WRITE_SCOPE)
		) {
			effectiveScopes.push(MEMORY_WRITE_SCOPE);
		}
		// Deletion is a distinct capability on the REST surface
		// (project.memory.delete), so the MCP delete tools must not ride along on
		// write scope alone — a member who can write but not delete would gain
		// through this door what the API refuses them.
		const allowDelete = can("project.memory.delete", membership)
			&& tokenAllowsScope(tokenScopes, MEMORY_WRITE_SCOPE);
		const accountRules = await getMemoryRules(env, managed.memoryOwnerUserId, { failClosed: true });
		const effectiveRules = narrowManagedMemoryRules(accountRules, auth.token?.rules);
		effectiveRules.projectCategories = await activeCategoryRules(env, {
			projectId: managed.project.id,
			memoryOwnerUserId: managed.memoryOwnerUserId,
			legacy: accountRules.customCategories ?? [],
		});
		return serveMcp(request, env, ctx, url, managed.memoryOwnerUserId, {
			scopes: effectiveScopes,
			allowDelete,
			// Rate-limit + AI-budget identity for the MCP tools: the credential,
			// its bound project, and the ACCOUNT — never the caller-selected
			// memory subject. Same anti-rotation discipline as the REST doors.
			rateContext: { auth, managedProject: managed.project, accountUserId: managed.accountUserId },
			rules: effectiveRules,
			credentialRules: auth.token?.rules ?? null,
			projectCategories: effectiveRules.projectCategories,
			managedPolicy: true,
			memoryScope: {
				authType: auth.type,
				memoryUserId: managed.memoryOwnerUserId,
				ownerUserId: managed.memoryOwnerUserId,
				accountUserId: managed.accountUserId,
				managedProjectId: managed.project.id,
				managedProjectName: managed.project.name,
				externalUserId: managed.accountUserId,
			},
		});
	} catch (error) {
		return managedProjectFailure(error);
	}
}

/** Build the server for an identity and hand a bounded request to the transport. */
async function serveMcp(request, env, ctx, url, userId, authz = {}) {
	const server = buildMemoryServer(env, ctx, userId, authz);
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
		return serveProjectBoundMcp(request, env, ctx, url, auth);
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
		return serveProjectBoundMcp(request, env, ctx, url, auth);
	}

	const id = decodeMcpToken(pathToken);
	if (!id || !env.API_KEY || !(await timingSafeEqualString(id.key, env.API_KEY))) {
		return unauthorizedMcp(
			pathToken || bearer
				? "That credential is not valid for MCP."
				: "No credential. Send Authorization: Bearer <your API key> to /mcp, or connect an MCP link URL.",
		);
	}

	// Legacy operator door: no rateContext on purpose. This branch requires the
	// single operator master key, so every caller here IS one actor — they share
	// the "legacy:configured" bucket rather than minting per-user buckets.
	return serveMcp(request, env, ctx, url, id.userId);
}

/**
 * Settings routes that carry an id in the path. Returns null when nothing here
 * matches, so the caller falls through to the exact-match route table rather
 * than swallowing a 404 that belongs to somebody else.
 *
 * Removing a member and revoking an invitation are the two places where a
 * missing permission check would be an actual breach, so both name their
 * capability explicitly rather than relying on having got here at all.
 */
async function handleSettingsMemberRoutes(request, env, ctx, url) {
	const rest = url.pathname.slice("/v1/settings/".length);
	const [group, rawId, sub] = rest.split("/").map((part) => (part ? decodeURIComponent(part) : part));
	if (!["members", "org-members", "invitations", "categories"].includes(group) || !rawId) return null;
	if (group === "invitations" && ["accept", "describe"].includes(rawId)) return null;

	const context = await requireSessionProject(request, env);
	if (context.response) return context.response;
	const readMutationBody = () => readSmallJsonObject(request, url.pathname);

	try {
		const org = await sessionOrganization(env, context);

		if (group === "members") {
			const denied = requireCapability(context, "project.members.manage");
			if (denied) return denied;
			if (request.method === "PATCH") {
				const parsed = await readMutationBody();
				if (parsed.response) return parsed.response;
				const body = parsed.body;
				const unknown = Object.keys(body).filter((key) => ![
					"role", "access_starts_at", "access_expires_at",
				].includes(key));
				if (unknown.length) throw new OrgError("unknown_member_field", `Unknown member field: ${unknown[0]}.`);
				const mutation = await runContextAuditedMutation(
					request, env, ctx, context, "project.members.manage",
					{ action: "project.member.role_changed", targetType: "member", targetId: rawId },
					(intent) => updateProjectRole(
						env, context.project.id, org.id, rawId, body.role, request.headers.get("if-match"), body,
						context.auth.userId, { auditIntent: intent },
					),
					(result) => ({
						outcome: result.changed ? "ok" : "noop",
						reason: result.changed ? null : "no_change",
						metadata: auditDiff(
							{ project_role: result.previous_role },
							{ project_role: result.member.role },
						),
					}),
				);
				return json({ ok: true, changed: mutation.changed, member: mutation.member });
			}
			if (request.method === "DELETE") {
				const mutation = await runContextAuditedMutation(
					request, env, ctx, context, "project.members.manage",
					{ action: "project.member.removed", targetType: "member", targetId: rawId },
					(intent) => removeProjectMember(
						env, context.project.id, rawId, request.headers.get("if-match"), { auditIntent: intent },
					),
					(result) => ({
						outcome: result.removed ? "ok" : "noop",
						reason: result.removed ? null : "already_removed",
						metadata: result.removed
							? auditDiff({ project_role: result.previous_role }, { project_role: null })
							: null,
					}),
				);
				return json({ ok: true, removed: mutation.removed, already_removed: mutation.already_removed });
			}
		}

		if (group === "org-members") {
			const denied = requireCapability(context, "org.members.manage");
			if (denied) return denied;
			if (request.method === "PATCH") {
				const parsed = await readMutationBody();
				if (parsed.response) return parsed.response;
				const body = parsed.body;
				const unknown = Object.keys(body).filter((key) => ![
					"role", "access_starts_at", "access_expires_at",
				].includes(key));
				if (unknown.length) throw new OrgError("unknown_member_field", `Unknown member field: ${unknown[0]}.`);
				const mutation = await runContextAuditedMutation(
					request, env, ctx, context, "org.members.manage",
					{ orgId: org.id, projectId: null, action: "org.member.role_changed", targetType: "member", targetId: rawId },
					(intent) => setOrganizationRole(
						env, org.id, rawId, body.role, request.headers.get("if-match"), body,
						context.auth.userId, { auditIntent: intent },
					),
					(result) => ({
						outcome: result.changed ? "ok" : "noop",
						reason: result.changed ? null : "no_change",
						metadata: auditDiff(
							{ org_role: result.previous_role },
							{ org_role: result.member.role },
						),
					}),
				);
				return json({ ok: true, changed: mutation.changed, member: mutation.member });
			}
			if (request.method === "DELETE") {
				const mutation = await runContextAuditedMutation(
					request, env, ctx, context, "org.members.manage",
					{ orgId: org.id, projectId: null, action: "org.member.removed", targetType: "member", targetId: rawId },
					(intent) => removeOrganizationMember(
						env, org.id, rawId, request.headers.get("if-match"), { auditIntent: intent },
					),
					(result) => ({
						outcome: result.removed ? "ok" : "noop",
						reason: result.removed ? null : "already_removed",
						metadata: result.removed
							? auditDiff({ org_role: result.previous_role }, { org_role: null })
							: null,
					}),
				);
				return json({ ok: true, removed: mutation.removed, already_removed: mutation.already_removed });
			}
		}

		if (group === "invitations") {
			const denied = requireCapability(context, "org.members.manage");
			if (denied) return denied;
			if (request.method === "POST" && sub === "resend") {
				const inviteRateKeys = [
					`invite:actor:${context.auth.userId}`,
					`invite:org:${org.id}`,
					`invite:ip:${clientIp(request)}`,
				];
				for (const key of inviteRateKeys) {
					if (!(await allowRate(env.AUTH_LIMITER, key))) return tooManyFor("auth");
				}
				const result = await runContextAuditedMutation(
					request, env, ctx, context, "org.members.manage",
					{ orgId: org.id, action: "org.invitation.resent", targetType: "invitation", targetId: rawId },
					(intent) => resendInvitation(env, {
						orgId: org.id,
						invitationId: rawId,
						invitedByUserId: context.auth.userId,
						origin: new URL(request.url).origin,
						auditIntent: intent,
					}),
					(created) => ({
						targetId: created.invitation.id,
						metadata: { status: { from: "pending", to: "pending" } },
					}),
				);
				const { replaced_invitation_ids: _replaced, expired_invitation_count: _expired, ...created } = result;
				ctx?.waitUntil?.(processInvitationEmailOutbox(env, { limit: 5 }).catch((error) => {
					console.warn("invitation resend email dispatch failed:", error?.message ?? error);
				}));
				return json({ ok: true, ...created }, 201);
			}
			if (request.method === "DELETE") {
				await runContextAuditedMutation(
					request, env, ctx, context, "org.members.manage",
					{ orgId: org.id, action: "org.invitation.revoked", targetType: "invitation", targetId: rawId },
					(intent) => revokeInvitation(env, org.id, rawId, { auditIntent: intent }),
					() => ({ metadata: { status: { from: "pending", to: "revoked" } } }),
				);
				return json({ ok: true });
			}
		}

		if (group === "categories") {
			const denied = requireCapability(context, "project.categories.edit");
			if (denied) return denied;
			if (request.method === "PATCH" && sub === "status") {
				const parsed = await readMutationBody();
				if (parsed.response) return parsed.response;
				const body = parsed.body;
				const unknown = Object.keys(body).filter((key) => key !== "status");
				if (unknown.length) throw new OrgError("unknown_category_field", `Unknown category field: ${unknown[0]}.`);
				const mutation = await runContextAuditedMutation(
					request, env, ctx, context, "project.categories.edit",
					{ action: "project.category.status_changed", targetType: "category", targetId: rawId },
					(intent) => setProjectCategoryStatus(env, {
						projectId: context.project.id,
						categoryId: rawId,
						status: body.status,
						expectedRevision: request.headers.get("if-match"),
						actorUserId: context.auth.userId,
						auditIntent: intent,
					}),
					(result) => ({
						outcome: result.changed ? "ok" : "noop",
						reason: result.changed ? null : "no_change",
						metadata: result.changed
							? { status: { from: result.previousCategory.status, to: result.category.status } }
							: null,
					}),
				);
				return json({ ok: true, changed: mutation.changed, category: mutation.category });
			}
			if (request.method === "POST" && sub === "reassign") {
				const parsed = await readMutationBody();
				if (parsed.response) return parsed.response;
				const body = parsed.body;
				const unknown = Object.keys(body).filter((key) => key !== "target_category_id");
				if (unknown.length) throw new OrgError("unknown_category_field", `Unknown category field: ${unknown[0]}.`);
				const targetCategoryId = body.target_category_id === undefined || body.target_category_id === null
					? null
					: String(body.target_category_id);
				const mutation = await runContextAuditedMutation(
					request, env, ctx, context, "project.categories.edit",
					{ action: "project.category.reassigned", targetType: "category", targetId: rawId },
					(intent) => reassignProjectCategory(env, {
						projectId: context.project.id,
						categoryId: rawId,
						targetCategoryId,
						expectedRevision: request.headers.get("if-match"),
						actorUserId: context.auth.userId,
						auditIntent: intent,
					}),
					(result) => ({ metadata: {
						replacement_category_id: { from: rawId, to: targetCategoryId },
						assignment_count: {
							from: result.reassigned.nodes + result.reassigned.pages
								+ result.reassigned.candidates + result.reassigned.atoms,
							to: 0,
						},
					} }),
				);
				return json({ ok: true, ...mutation });
			}
			if (request.method === "PATCH") {
				const parsed = await readMutationBody();
				if (parsed.response) return parsed.response;
				const body = parsed.body;
				const unknown = Object.keys(body).filter((key) => !["name", "description", "color_token"].includes(key));
				if (unknown.length) throw new OrgError("unknown_category_field", `Unknown category field: ${unknown[0]}.`);
				const mutation = await runContextAuditedMutation(
					request, env, ctx, context, "project.categories.edit",
					{ action: "project.category.updated", targetType: "category", targetId: rawId },
					(intent) => updateProjectCategory(env, {
						projectId: context.project.id,
						categoryId: rawId,
						name: body.name,
						description: body.description,
						colorToken: body.color_token,
						expectedRevision: request.headers.get("if-match"),
						actorUserId: context.auth.userId,
						auditIntent: intent,
					}),
					(result) => ({
						outcome: result.changed ? "ok" : "noop",
						reason: result.changed ? null : "no_change",
						metadata: auditDiff(result.previousCategory, result.category),
					}),
				);
				return json({ ok: true, changed: mutation.changed, category: mutation.category });
			}
			if (request.method === "DELETE") {
				const mutation = await runContextAuditedMutation(
					request, env, ctx, context, "project.categories.edit",
					{ action: "project.category.deleted", targetType: "category", targetId: rawId },
					(intent) => deleteProjectCategory(env, {
						projectId: context.project.id,
						categoryId: rawId,
						expectedRevision: request.headers.get("if-match"),
						auditIntent: intent,
					}),
				);
				return json({ ok: true, deleted: mutation.deleted });
			}
		}
		return null;
	} catch (error) {
		return orgFailure(error);
	}
}

/**
 * Webhooks are standing configuration, so they authenticate like keys do:
 * session only, never a bearer token (a leaked API key must not be able to
 * silently point a user's memory events somewhere new).
 */
async function handleWebhookRoutes(request, env, ctx, url) {
	const capability = request.method === "GET"
		? "project.integrations.view"
		: "project.integrations.manage";
	const context = await requireSessionProject(request, env, capability);
	if (context.response) return context.response;
	const userId = context.memoryOwnerUserId;

	if (request.method === "GET" && url.pathname === "/v1/webhooks") {
		return json({ webhooks: await listWebhooks(env, userId) });
	}
	if (request.method === "POST" && url.pathname === "/v1/webhooks") {
		const parsed = await readSmallJsonObject(request, "/v1/webhooks");
		if (parsed.response) return parsed.response;
		const body = parsed.body;
		const unknown = Object.keys(body).filter((key) => ![
			"name", "url", "events", "metadataOnly", "metadata_only",
		].includes(key));
		if (unknown.length) return json({ error: "unknown_webhook_field", message: `Unknown webhook field: ${unknown[0]}.` }, 400);
		const result = await runContextAuditedMutation(
			request, env, ctx, context, "project.integrations.manage",
			{ action: "project.webhook.created", targetType: "webhook" },
			(intent) => createWebhook(env, userId, body, { auditIntent: intent }),
			(created) => ({
				outcome: created.error ? "noop" : "ok",
				reason: created.error ? "invalid_or_limited" : null,
				targetId: created.webhook?.id ?? null,
				metadata: created.webhook ? {
					status: { from: null, to: "active" },
					metadata_only: { from: null, to: created.webhook.metadata_only },
				} : null,
			}),
		);
		if (result.error) return json({ error: "invalid_webhook", message: result.error }, 400);
		return json(result, 201);
	}

	const rest = url.pathname.slice("/v1/webhooks/".length);
	const [id, sub] = rest.split("/");
	if (!id) return json({ error: "not found" }, 404);

	if (request.method === "DELETE" && !sub) {
		const webhookId = decodeURIComponent(id);
		const result = await runContextAuditedMutation(
			request, env, ctx, context, "project.integrations.manage",
			{ action: "project.webhook.deleted", targetType: "webhook", targetId: webhookId },
			(intent) => deleteWebhook(env, userId, webhookId, { auditIntent: intent }),
			(mutation) => ({
				outcome: mutation.deleted ? "ok" : "noop",
				reason: mutation.deleted ? null : "already_deleted_or_missing",
				metadata: mutation.deleted ? { status: { from: "active", to: null } } : null,
			}),
		);
		return json(result);
	}
	if (request.method === "GET" && sub === "deliveries") {
		return json({ deliveries: await listDeliveries(env, userId, decodeURIComponent(id)) });
	}
	if (request.method === "POST" && sub === "test") {
		const webhookId = decodeURIComponent(id);
		const mutation = await runContextAuditedMutation(
			request, env, ctx, context, "project.integrations.manage",
			{ action: "project.webhook.tested", targetType: "webhook", targetId: webhookId },
			(intent) => queueAuditedWebhookTest(
				env,
				(promise) => ctx.waitUntil(promise),
				userId,
				webhookId,
				{
					source: "webhook_test",
					receipt_id: null,
					counts: { nodes: 1, updated_nodes: 0, slices: 1, events: 0, edges: 0 },
					new_node_labels: ["Webhook test"],
				},
				intent,
			),
			(result) => ({
				outcome: result.queued ? "ok" : "noop",
				reason: result.queued ? null : "webhook_not_found",
			}),
		);
		if (mutation.notFound) return json({ error: "not_found" }, 404);
		return json({ ok: true, sent: true, delivery_id: mutation.deliveryId });
	}
	return json({ error: "not found" }, 404);
}

/**
 * GET /v1/memories and GET /v1/memories/:id — the read-only inventory.
 * List is nodes + pages newest-first with a keyset cursor; get-one uses the
 * same id-prefix dispatch as delete so any id a receipt or delete names can
 * be looked up. Pure SELECTs from lib/memory_inventory.js.
 */
async function handleMemoryReadRoutes(request, env, url) {
	const auth = await requireMemoryUser(request, env, url.searchParams.get("userId"), {
		requiredScope: MEMORY_READ_SCOPE,
	});
	if (auth.response) return auth.response;
	// After auth on purpose: an unauthenticated caller must not be able to
	// consume another actor's read bucket.
	if (!(await allowRate(env.READ_LIMITER, managedActorRateKey("read", auth)))) return tooManyFor("read");

	const id = url.pathname === "/v1/memories" ? null : decodeURIComponent(url.pathname.slice("/v1/memories/".length));
	if (id) {
		const found = await getMemory(env, auth.userId, id);
		if (found?.error === "unrecognized_id") {
			return json({ error: "bad_request", message: "Unrecognized memory id — expected a node_, page_, slice_, or candidate id." }, 400);
		}
		if (!found) return json({ error: "not_found" }, 404);
		return json({ ok: true, kind: found.kind, memory: found.memory });
	}

	const options = parseInventoryListOptions({
		kind: url.searchParams.get("kind"),
		limit: url.searchParams.get("limit"),
		cursor: url.searchParams.get("cursor"),
		projectId: url.searchParams.get("projectId"),
		q: url.searchParams.get("q"),
	});
	if (options.error) return json({ error: options.error, message: options.message }, 400);
	return json({ ok: true, ...(await listMemories(env, auth.userId, options)) });
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
		requiredCapability: "project.memory.delete",
	});
	if (auth.response) return auth.response;
	// Destructive work gets the tighter DELETE bucket: a loop that deletes is
	// worse than a loop that saves.
	if (!(await allowRate(env.DELETE_LIMITER, managedActorRateKey("del", auth)))) return tooManyFor("delete");
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
	// SRV-01: the same identifier rule the write doors stamp with. A filter
	// value no stamp could ever equal must 400, not silently delete nothing.
	const rawSource = url.searchParams.get("source");
	if (rawSource != null && rawSource !== "" && !cleanClientSource(rawSource)) {
		return json({
			error: "source must be a 1-64 character string with no control characters",
			field: "source",
		}, 400);
	}
	const result = await bulkDeleteBySource(env, auth.userId, {
		source: cleanClientSource(rawSource),
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
		const auth = await requireControlUser(request, env, url.searchParams.get("userId"), {
			requiredCapability: "project.memory.read",
		});
		if (auth.response) return auth.response;
		const status = url.searchParams.get("status") || "pending";
		const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 250);
		return json({ candidates: await listCandidates(env, auth.userId, { status, limit }) });
	}

	if (request.method !== "POST") return json({ error: "not found" }, 404);
	const match = url.pathname.match(/^\/v1\/candidates\/([^/]+)\/(promote|reject|merge)$/);
	if (!match) return json({ error: "not found" }, 404);
	const preliminary = await preauthorizeMemoryBody(request, env, {
		allowTokenAuth: false,
		requiredCapability: "project.memory.write",
	});
	if (preliminary.response) return preliminary.response;
	const parsed = await readSmallJsonObject(request, url.pathname);
	if (parsed.response) return parsed.response;
	const body = parsed.body;
	const auth = await requireControlUser(request, env, body.userId, {
		scopeInput: body.memoryScope ?? body.sourceScope,
		requiredCapability: "project.memory.write",
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
