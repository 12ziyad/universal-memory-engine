/** First-party, versioned Aven facade; never trusts caller-supplied identities. */
import { changePasswordForUser, getSessionUser, googleAuthStart, login, parseCookies, randomSecret, resetPasswordAfterEmailProof, sha256Hex, signup, timingSafeEqualString } from "../auth.js";
import { EMAIL_CHALLENGE_COOKIE, startEmailChallenge, verifyEmailChallenge } from "../lib/passwordless_auth.js";
import { githubAuthStart } from "../lib/github_auth.js";
import { newId } from "../lib/ids.js";
import { allowRate } from "../lib/rate.js";
import { createManagedProject, getManagedProjectForUser, listManagedProjects, resolveManagedProject, updateManagedProject } from "../lib/managed_projects.js";
import { can, capabilityGuardStatement, ensureDefaultOrganization, resolveMembership } from "../lib/organizations.js";
import { auditedMutationResult, auditInvariantStatement, commitAuditedBatch, runAuditedMutation } from "../lib/audit.js";
import { getMemory, listMemories, parseInventoryListOptions } from "../lib/memory_inventory.js";
import { applyMemoryChange, contentHash, credentialFenceStatement, listMemoryHistory, runProjections, snapshotFor, validateIdempotencyKey, validatePatch, versionErrorResponse } from "../lib/memory_versions.js";
import { projectMemorySpaceRegistrationStatement, retentionFenceGuardStatement } from "../lib/retention.js";
import { deleteObject } from "../pipeline/cleanup.js";
import { stageMcpConversation } from "../pipeline/mcp_engine.js";
import { getMemoryRules } from "../pipeline/rules.js";
import { checkAiBudget } from "../lib/ai_budget.js";
import { runRecallCommand } from "../pipeline/commands.js";
import { activeCategoryRules } from "../lib/project_categories.js";
import { AVEN_MODEL_PROFILE } from "./model-profile.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
const CODE_TTL = 60_000;
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
// Sessions opened at Aven's own sign-in door exist only for Aven and close with it.
const DIRECT_PREFIX = "aven_direct_";
const RETURN_COOKIE = "uml_aven_return";
class BridgeError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
const fail = (code, status = 400) => { throw new BridgeError(code, status); };
const encode = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export async function avenPkce(verifier) { return encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))); }

function allowedRedirect(env, raw) {
  try {
    const url = new URL(raw);
    const allowed = String(env.AVEN_ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/auth/callback" || url.search || url.hash || !allowed.includes(url.origin)) return null;
    return url.href;
  } catch { return null; }
}
async function bodyOf(request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) fail("json_required", 415);
  if (Number(request.headers.get("content-length") ?? 0) > 65536) fail("body_too_large", 413);
  const reader = request.body?.getReader();
  if (!reader) fail("invalid_json");
  const chunks = []; let size = 0;
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > 65536) { await reader.cancel(); fail("body_too_large", 413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let body; try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { fail("invalid_json"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) fail("invalid_json");
  return body;
}
function onlyFields(body, fields) { if (Object.keys(body).some((key) => !fields.includes(key))) fail("unknown_field"); }
function originalSessionGuard(env, auth) {
  return credentialFenceStatement(env, { credential: { kind: "session", id: auth.source_session_id }, actorUserId: auth.user_id });
}
function bridgeSessionGuard(env, auth) {
  return auditInvariantStatement(env, "SELECT 1 FROM aven_bridge_sessions WHERE id = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > ?", [auth.id, auth.user_id, Date.now()]);
}
async function resolveSession(env, request) {
  const token = request.headers.get("x-aven-session") ?? "";
  if (/^abg_[A-Za-z0-9_-]{43}$/.test(token)) {
    const auth = await env.DB.prepare(`SELECT g.*, u.name, u.email FROM aven_background_grants g
      JOIN users u ON u.id=g.user_id WHERE g.token_hash=? AND g.revoked_at IS NULL AND u.status='active'
      AND NOT EXISTS(SELECT 1 FROM account_erasure_tombstones t WHERE t.user_id=u.id)`)
      .bind(await sha256Hex(token)).first();
    if (!auth) fail("background_access_revoked", 401);
    auth.background = true;
    // Neither a service secret nor a stored grant bypasses current membership.
    await scopeFor(env, auth, auth.project_id, auth.purpose === "automation" ? "project.memory.write" : "project.integrations.manage");
    return auth;
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) fail("unauthorized", 401);
  const auth = await env.DB.prepare(`SELECT a.*, u.name, u.email FROM aven_bridge_sessions a
    JOIN sessions s ON s.id = a.source_session_id AND s.user_id = a.user_id
    JOIN users u ON u.id = a.user_id WHERE a.token_hash = ? AND a.revoked_at IS NULL AND a.expires_at > ?
    AND s.revoked_at IS NULL AND s.expires_at > ? AND u.status = 'active'
    AND NOT EXISTS(SELECT 1 FROM account_erasure_tombstones t WHERE t.user_id = u.id) LIMIT 1`)
    .bind(await sha256Hex(token), Date.now(), Date.now()).first();
  if (!auth) fail("unauthorized", 401);
  return auth;
}
async function safeProject(env, auth, project) {
  const membership = await resolveMembership(env, { userId: auth.user_id, project });
  return { id: project.id, name: project.name, description: project.description, organizationId: membership.orgId,
    status: project.status, revision: project.revision, capabilities: membership.capabilities, createdAt: project.created_at, updatedAt: project.updated_at };
}
async function sessionResult(env, auth, includeProjects = true) {
  const base = { ok: true, expiresAt: auth.background ? null : auth.expires_at, principal: { actorId: auth.user_id, name: auth.name ?? "", email: auth.email ?? "" } };
  if (!includeProjects) return base;
  if (auth.background) {
    const scope = await scopeFor(env, auth, auth.project_id, auth.purpose === "automation" ? "project.memory.write" : "project.integrations.manage");
    const project = await safeProject(env, auth, scope.project);
    project.capabilities = project.capabilities.filter((cap) => (auth.purpose === "automation" ? ["project.memory.read", "project.memory.write"] : ["project.integrations.manage"]).includes(cap));
    return { ...base, projects: [project], background: { id: auth.id, purpose: auth.purpose, resourceId: auth.resource_id } };
  }
  const projects = await listManagedProjects(env, auth.user_id);
  return { ...base, projects: await Promise.all(projects.map((project) => safeProject(env, auth, project))) };
}
async function scopeFor(env, auth, projectId, capability = "project.memory.read") {
  if (auth.background && auth.project_id !== projectId) fail("not_found", 404);
  const req = new Request("https://itsuki.internal/", { headers: { "x-itsuki-project": projectId } });
  const scope = await resolveManagedProject(env, req, { type: "session", userId: auth.user_id });
  const membership = await resolveMembership(env, { userId: auth.user_id, project: scope.project });
  if (!can(capability, membership)) fail("forbidden", 403);
  return { ...scope, membership };
}
function auditDetails(env, request, ctx, auth, scope, capability, action, targetType, targetId, idempotencyKey) {
  return { actorUserId: auth.user_id, actorType: "user", orgId: scope.membership.orgId, projectId: scope.project?.id ?? null,
    action, targetType, targetId, idempotencyKey, requestId: request.headers.get("x-request-id"),
    waitUntil: ctx?.waitUntil ? (p) => ctx.waitUntil(p) : null,
    authorizationGuards: [capabilityGuardStatement(env, { actorUserId: auth.user_id, orgId: scope.membership.orgId, projectId: scope.project?.id ?? null, capability }), originalSessionGuard(env, auth), bridgeSessionGuard(env, auth)] };
}
function knowledgeItem(memory, meta = {}) {
  return { id: memory.id, kind: meta.kind ?? (memory.kind === "page" && ["note", "decision", "handoff", "correction"].includes(memory.category) ? memory.category : "note"),
    title: memory.title ?? memory.label ?? "Untitled", text: memory.full_markdown ?? memory.summary ?? memory.short_summary ?? memory.text ?? "",
    memoryKind: memory.kind, revision: Number(memory.revision ?? 1), createdAt: memory.created_at, updatedAt: memory.updated_at,
    sources: meta.sources ?? [], ...meta };
}
async function oneKnowledge(env, scope, id) {
  const found = await getMemory(env, scope.memoryOwnerUserId, id);
  if (!found || found.error) fail("not_found", 404);
  // Namespace is authoritative; project attribution further fences imported content.
  if (found.memory.project_id && found.memory.project_id !== scope.project.id) fail("not_found", 404);
  let sources = [];
  if (found.kind === "page") {
    const row = await env.DB.prepare("SELECT evidence_json FROM memory_pages WHERE id = ? AND user_id = ?").bind(id, scope.memoryOwnerUserId).first();
    try { sources = JSON.parse(row?.evidence_json ?? "[]"); } catch { /* malformed legacy evidence is omitted */ }
  }
  return { found, item: knowledgeItem(found.memory, { sources }) };
}
function cleanSources(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) fail("invalid_sources");
  return value.map((source) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) fail("invalid_sources");
    onlyFields(source, ["title", "url", "path", "revision"]);
    const result = {};
    for (const field of ["title", "url", "path", "revision"]) if (source[field] !== undefined) {
      if (typeof source[field] !== "string" || source[field].length > (field === "url" ? 2048 : 500)) fail("invalid_sources");
      result[field] = source[field];
    }
    if (result.url) { try { const url = new URL(result.url); if (url.protocol !== "https:" || url.username || url.password) fail("invalid_sources"); } catch { fail("invalid_sources"); } }
    return result;
  });
}
async function createKnowledge(env, request, ctx, auth, scope, body) {
  onlyFields(body, ["title", "text", "kind", "idempotencyKey", "sources"]);
  const key = validateIdempotencyKey(body.idempotencyKey);
  const kind = body.kind ?? "note";
  if (!["note", "decision", "handoff", "correction"].includes(kind)) fail("invalid_kind");
  const patch = validatePatch("page", { title: body.title, full_markdown: body.text }).fields;
  if (patch.full_markdown.length > 20000) fail("text_too_large");
  const sources = cleanSources(body.sources);
  const hash = await sha256Hex(JSON.stringify({ ...patch, kind, sources }));
  const readClaim = () => env.DB.prepare("SELECT * FROM aven_creation_claims WHERE user_id = ? AND project_id = ? AND operation_kind = 'knowledge' AND idempotency_key = ?").bind(auth.user_id, scope.project.id, key).first();
  const prior = await readClaim();
  if (prior) {
    if (prior.request_hash !== hash) fail("idempotency_conflict", 409);
    return { ok: true, item: (await oneKnowledge(env, scope, prior.object_id)).item, replayed: true };
  }
  const id = newId("page"), at = Date.now();
  const snapshot = snapshotFor("page", { title: patch.title, full_markdown: patch.full_markdown, short_summary: patch.full_markdown.slice(0, 1000) });
  const hashContent = await contentHash(snapshot);
  try {
    await runAuditedMutation(env, auditDetails(env, request, ctx, auth, scope, "project.memory.write", "project.memory.created", "memory_object", id, key), async (intent) => {
      await commitAuditedBatch(env, intent, [
        retentionFenceGuardStatement(env, { projectId: scope.project.id, retentionClass: "semantic_memory", acceptedAt: at }),
        projectMemorySpaceRegistrationStatement(env, { projectId: scope.project.id, memoryOwnerUserId: scope.memoryOwnerUserId, memoryUserId: scope.memoryOwnerUserId, seenAt: at }),
        env.DB.prepare(`INSERT INTO memory_pages (id, user_id, title, canonical_title, short_summary, full_markdown, topic_filter, source_mode, evidence_json, project_id, project_name, revision, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'aven_direct', ?, ?, ?, 1, ?, ?)`)
          .bind(id, scope.memoryOwnerUserId, patch.title, patch.title.toLowerCase(), snapshot.short_summary, patch.full_markdown, kind, JSON.stringify(sources), scope.project.id, scope.project.name, at, at),
        env.DB.prepare(`INSERT INTO memory_revisions (id, user_id, project_id, object_kind, object_id, revision, action, snapshot_json, content_hash, actor_class, actor_ref, created_at)
          VALUES (?, ?, ?, 'page', ?, 1, 'update', ?, ?, 'user', ?, ?)`)
          .bind(newId("mrev"), scope.memoryOwnerUserId, scope.project.id, id, JSON.stringify(snapshot), hashContent, auth.user_id, at),
        env.DB.prepare("INSERT INTO aven_creation_claims (user_id, project_id, operation_kind, idempotency_key, request_hash, object_id, created_at) VALUES (?, ?, 'knowledge', ?, ?, ?, ?)")
          .bind(auth.user_id, scope.project.id, key, hash, id, at),
        env.DB.prepare("INSERT INTO memory_projection_state (user_id, object_id, projection, status, updated_at) VALUES (?, ?, 'search', 'pending', ?)").bind(scope.memoryOwnerUserId, id, at),
      ]);
      return auditedMutationResult({ id }, intent);
    });
  } catch (error) {
    const raced = await readClaim();
    if (raced) { if (raced.request_hash !== hash) fail("idempotency_conflict", 409); return { ok: true, item: (await oneKnowledge(env, scope, raced.object_id)).item, replayed: true }; }
    throw error;
  }
  // The page search projection is deterministic; the shared helper embeds nodes only.
  if (ctx?.waitUntil) ctx.waitUntil(runProjections(env, scope.memoryOwnerUserId, "page", id));
  else await runProjections(env, scope.memoryOwnerUserId, "page", id);
  return { ok: true, item: (await oneKnowledge(env, scope, id)).item };
}

function authorizeParams(env, params) {
  const redirectUri = allowedRedirect(env, params.get("redirect_uri"));
  const state = params.get("state") ?? "", challenge = params.get("code_challenge") ?? "";
  if (!redirectUri || !/^[A-Za-z0-9_-]{16,200}$/.test(state) || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return null;
  const query = new URLSearchParams({ redirect_uri: redirectUri, state, code_challenge: challenge }).toString();
  return { redirectUri, state, challenge, query, origin: new URL(redirectUri).origin };
}
async function authorize(request, env, url) {
  const params = authorizeParams(env, url.searchParams);
  if (!params) fail("invalid_authorization_request");
  const { redirectUri, state, challenge } = params;
  if (!await allowRate(env.AUTH_LIMITER, `aven:authorize:${request.headers.get("cf-connecting-ip") ?? "unknown"}`, { fail: "closed" })) fail("rate_limited", 429);
  const auth = await getSessionUser(env, request);
  // Aven has its own sign-in page; an unsigned visitor goes back there, never to an Itsuki screen.
  if (!auth) return new Response(null, { status: 302, headers: { ...JSON_HEADERS, location: `${params.origin}/signin` } });
  const code = randomSecret(32), at = Date.now();
  await env.DB.prepare("INSERT INTO aven_authorization_codes (code_hash,user_id,session_id,redirect_uri,code_challenge,expires_at,created_at) VALUES(?,?,?,?,?,?,?)")
    .bind(await sha256Hex(code), auth.userId, auth.session.id, redirectUri, challenge, at + CODE_TTL, at).run();
  // Opportunistic cleanup is bounded by expiry indexes; no user content is kept.
  await env.DB.prepare("DELETE FROM aven_authorization_codes WHERE code_hash IN (SELECT code_hash FROM aven_authorization_codes WHERE expires_at < ? LIMIT 100)").bind(at - 60_000).run();
  const target = new URL(redirectUri); target.searchParams.set("code", code); target.searchParams.set("state", state);
  return new Response(null, { status: 302, headers: { ...JSON_HEADERS, location: target.href } });
}
async function exchange(request, env) {
  const body = await bodyOf(request); onlyFields(body, ["code", "codeVerifier", "redirectUri"]);
  if (!/^[A-Za-z0-9_-]{43}$/.test(body.code ?? "") || !/^[A-Za-z0-9._~-]{43,128}$/.test(body.codeVerifier ?? "") || !allowedRedirect(env, body.redirectUri)) fail("invalid_grant", 401);
  const hash = await sha256Hex(body.code);
  const code = await env.DB.prepare(`SELECT c.*, s.expires_at AS session_expires_at, u.name, u.email FROM aven_authorization_codes c
    JOIN sessions s ON s.id = c.session_id AND s.user_id = c.user_id JOIN users u ON u.id = c.user_id
    WHERE c.code_hash = ? AND c.consumed_at IS NULL AND c.expires_at > ? AND s.revoked_at IS NULL AND s.expires_at > ? AND u.status = 'active' LIMIT 1`)
    .bind(hash, Date.now(), Date.now()).first();
  if (!code || code.redirect_uri !== body.redirectUri || !await timingSafeEqualString(code.code_challenge, await avenPkce(body.codeVerifier))) fail("invalid_grant", 401);
  const token = randomSecret(32), at = Date.now(), expiresAt = Math.min(at + SESSION_TTL, Number(code.session_expires_at));
  const [consumed] = await env.DB.batch([
    env.DB.prepare("UPDATE aven_authorization_codes SET consumed_at = ? WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?").bind(at, hash, at),
    // A unique token-derived id AND a consumed code claim prevents two concurrent exchanges.
    env.DB.prepare(`INSERT INTO aven_bridge_sessions (id, token_hash, user_id, source_session_id, expires_at, created_at)
      SELECT ?, ?, c.user_id, c.session_id, ?, ? FROM aven_authorization_codes c JOIN sessions s ON s.id = c.session_id JOIN users u ON u.id = c.user_id
      WHERE c.code_hash = ? AND c.consumed_at = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND u.status = 'active'
      AND NOT EXISTS(SELECT 1 FROM aven_bridge_sessions a WHERE a.id = ?)`)
      .bind(`aven_code_${hash}`, await sha256Hex(token), expiresAt, at, hash, at, at, `aven_code_${hash}`),
  ]);
  if (Number(consumed.meta?.changes ?? 0) !== 1) fail("invalid_grant", 401);
  const auth = await resolveSession(env, new Request("https://itsuki.internal/", { headers: { "x-aven-session": token } }));
  // Historical Itsuki accounts may predate organization bootstrap. Resolve it
  // once at this authenticated handoff so Aven always has a canonical tenant.
  await ensureDefaultOrganization(env, auth.user_id);
  return json({ ...(await sessionResult(env, auth)), token });
}

function returnCookie(request, value, maxAge) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${RETURN_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${maxAge}`;
}
/** Google and GitHub start here when the person pressed the button on Aven's page. */
async function oauthStart(request, env, url, provider) {
  const params = authorizeParams(env, url.searchParams);
  if (!params) fail("invalid_authorization_request");
  if (!await allowRate(env.AUTH_LIMITER, `aven:${provider}:${request.headers.get("cf-connecting-ip") ?? "unknown"}`, { fail: "closed" })) fail("rate_limited", 429);
  const result = provider === "google" ? googleAuthStart(env, request) : await githubAuthStart(env, request);
  // An unconfigured provider returns no state cookie; say so on Aven's page instead.
  if (!result.cookie) return new Response(null, { status: 302, headers: { ...JSON_HEADERS, location: `${params.origin}/signin?error=${provider}_unavailable` } });
  const headers = new Headers({ ...JSON_HEADERS, location: new URL(result.redirect, request.url).toString() });
  headers.append("set-cookie", result.cookie);
  headers.append("set-cookie", returnCookie(request, params.query, 600));
  return new Response(null, { status: 302, headers });
}
/**
 * After a Google or GitHub callback, a person who started on Aven continues to
 * Aven: success goes through /aven/authorize (which hands Aven a code), and a
 * failure returns to Aven's sign-in page with the reason. Others are untouched.
 */
export function avenOAuthReturn(request, env, result) {
  const raw = parseCookies(request).get(RETURN_COOKIE);
  if (!raw || !env.AVEN_BRIDGE_SECRET) return result;
  const cookies = [...(result.cookies ?? []), returnCookie(request, "", 0)];
  const params = authorizeParams(env, new URLSearchParams(raw));
  if (!params) return { ...result, cookies };
  if (!String(result.redirect).startsWith("/login")) return { redirect: `/aven/authorize?${params.query}`, cookies };
  const reason = new URL(result.redirect, request.url).searchParams.get("error") ?? "sign_in_failed";
  return { redirect: `${params.origin}/signin?error=${encodeURIComponent(reason.replace(/[^a-z0-9_]/gi, "").slice(0, 60))}`, cookies };
}
/** The person's address and browser, as Aven's Worker saw them, for rate limits and session records. */
function personRequest(request) {
  const ip = (request.headers.get("x-aven-client-ip") ?? "").trim().slice(0, 64);
  const agent = (request.headers.get("x-aven-user-agent") ?? "").slice(0, 500);
  const headers = {};
  if (ip) headers["cf-connecting-ip"] = ip;
  if (agent) headers["user-agent"] = agent;
  return new Request("https://itsuki.internal/", { headers });
}
async function directSession(env, userId, source, extra = {}) {
  const token = randomSecret(32), at = Date.now(), expiresAt = Math.min(at + SESSION_TTL, Number(source.expiresAt));
  await env.DB.prepare("INSERT INTO aven_bridge_sessions (id, token_hash, user_id, source_session_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(`${DIRECT_PREFIX}${crypto.randomUUID()}`, await sha256Hex(token), userId, source.id, expiresAt, at).run();
  const auth = await resolveSession(env, new Request("https://itsuki.internal/", { headers: { "x-aven-session": token } }));
  await ensureDefaultOrganization(env, auth.user_id);
  return json({ ...(await sessionResult(env, auth)), token, ...extra });
}
const DIRECT_ERRORS = { 400: "invalid_request", 401: "invalid_credentials", 403: "account_disabled", 409: "signup_failed" };
/** Email and password sign-in or sign-up from Aven's own page; Aven passes the password through and never stores it. */
async function directSignIn(request, env, kind) {
  const body = await bodyOf(request);
  onlyFields(body, kind === "signup" ? ["email", "password", "name", "acceptTerms"] : ["email", "password"]);
  if (typeof body.email !== "string" || typeof body.password !== "string" || (body.name !== undefined && typeof body.name !== "string")) fail("invalid_request");
  const person = personRequest(request);
  const who = person.headers.get("cf-connecting-ip") || `email:${await sha256Hex(body.email.trim().toLowerCase())}`;
  if (!await allowRate(env.AUTH_LIMITER, `aven:${kind}:${who}`, { fail: "closed" })) fail("rate_limited", 429);
  const result = kind === "signup" ? await signup(env, person, body) : await login(env, person, body);
  if (result.error) return json({ ok: false, error: { code: DIRECT_ERRORS[result.status] ?? "sign_in_failed", message: result.error } }, result.status);
  return directSession(env, result.user.id, result.session);
}

const CHALLENGE = /^emc_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/;
const EMAIL_ERRORS = {
  email_code_recently_sent: [429, "A code was just sent. Wait a minute before asking for another."],
  invalid_email_code: [401, "That code is not valid."],
  email_code_expired: [401, "That code expired. Ask for a new one."],
  account_disabled: [403, "This account is disabled."],
};
const refuse = (code, status, message) => json({ ok: false, error: { code, message } }, status);
const emailFailure = (error) => {
  const known = EMAIL_ERRORS[error];
  return known ? refuse(error, known[0], known[1]) : refuse("email_unavailable", 503, "The code could not be sent or checked. Try again shortly.");
};
/** Email a one-time code for Aven's page. The browser binding goes back to Aven, which keeps it in its own cookie. */
async function emailCodeStart(request, env) {
  const body = await bodyOf(request);
  onlyFields(body, ["email"]);
  if (typeof body.email !== "string") fail("invalid_request");
  const person = personRequest(request);
  const who = person.headers.get("cf-connecting-ip") || `email:${await sha256Hex(body.email.trim().toLowerCase())}`;
  if (!await allowRate(env.AUTH_LIMITER, `aven:email-start:${who}`, { fail: "closed" })) fail("rate_limited", 429);
  const result = await startEmailChallenge(env, person, body, { brand: "aven" });
  if (result.status === 400) return refuse("invalid_request", 400, "Enter a valid email address.");
  if (result.error) return emailFailure(result.error);
  return json({ ok: true, email: result.body.email, expiresAt: result.body.expires_at, resendAt: result.body.resend_at, challenge: result.challenge });
}
/** Check the code. With `newPassword` it also replaces the password and closes every other session. */
async function emailCodeVerify(request, env, ctx) {
  const body = await bodyOf(request);
  onlyFields(body, ["challenge", "code", "newPassword"]);
  if (typeof body.challenge !== "string" || !CHALLENGE.test(body.challenge) || typeof body.code !== "string") fail("invalid_request");
  const resetting = body.newPassword !== undefined;
  // Checked before the code, so a short password never spends the code.
  if (resetting && (typeof body.newPassword !== "string" || body.newPassword.length < 8 || body.newPassword.length > 1024)) return refuse("invalid_request", 400, "Password must be at least 8 characters");
  const person = personRequest(request);
  const who = person.headers.get("cf-connecting-ip") || body.challenge.split(".")[0];
  if (!await allowRate(env.AUTH_LIMITER, `aven:email-verify:${who}`, { fail: "closed" })) fail("rate_limited", 429);
  const headers = new Headers(person.headers);
  headers.set("cookie", `${EMAIL_CHALLENGE_COOKIE}=${encodeURIComponent(body.challenge)}`);
  const result = await verifyEmailChallenge(env, new Request(person.url, { headers }), { code: body.code });
  if (result.error) return emailFailure(result.error);
  if (resetting) {
    const reset = await runAuditedMutation(env, { actorUserId: result.user.id, actorType: "user", action: "account.password.reset", targetType: "user", targetId: result.user.id,
      requestId: request.headers.get("x-request-id"), waitUntil: ctx?.waitUntil ? (p) => ctx.waitUntil(p) : null },
    (intent) => resetPasswordAfterEmailProof(env, person, result.user.id, result.session.id, body.newPassword, { auditIntent: intent }));
    if (reset.error) return refuse("account_disabled", 403, "This account is disabled.");
  }
  return directSession(env, result.user.id, result.session, { created: Boolean(result.created), passwordReset: resetting });
}

export async function handleAvenBridge(request, env, ctx, url = new URL(request.url)) {
  if (!url.pathname.startsWith("/aven/") && !url.pathname.startsWith("/internal/aven/")) return null;
  if (!env.AVEN_BRIDGE_SECRET || String(env.AVEN_BRIDGE_SECRET).length < 32) return json({ error: "not_found" }, 404);
  try {
    if (url.pathname === "/aven/authorize" && request.method === "GET") return await authorize(request, env, url);
    if (url.pathname === "/aven/oauth/google" && request.method === "GET") return await oauthStart(request, env, url, "google");
    if (url.pathname === "/aven/oauth/github" && request.method === "GET") return await oauthStart(request, env, url, "github");
    if (!url.pathname.startsWith("/internal/aven/")) fail("not_found", 404);
    if (!await timingSafeEqualString(request.headers.get("authorization") ?? "", `Bearer ${env.AVEN_BRIDGE_SECRET}`)) fail("unauthorized", 401);
    // No CORS, no browser cookies, no caller-selected actor or owner id.
    if (request.headers.has("origin")) fail("browser_access_forbidden", 403);
    if (url.pathname === "/internal/aven/session" && request.method === "POST") return await exchange(request, env);
    if (url.pathname === "/internal/aven/auth/login" && request.method === "POST") return await directSignIn(request, env, "login");
    if (url.pathname === "/internal/aven/auth/signup" && request.method === "POST") return await directSignIn(request, env, "signup");
    if (url.pathname === "/internal/aven/auth/email/start" && request.method === "POST") return await emailCodeStart(request, env);
    if (url.pathname === "/internal/aven/auth/email/verify" && request.method === "POST") return await emailCodeVerify(request, env, ctx);
    // Possession permits only self-revocation, even after membership is removed.
    if (url.pathname === "/internal/aven/background-grants/revoke" && request.method === "POST") {
      const token = request.headers.get("x-aven-session") ?? "";
      if (!/^abg_[A-Za-z0-9_-]{43}$/.test(token)) fail("unauthorized", 401);
      await env.DB.prepare("UPDATE aven_background_grants SET revoked_at=COALESCE(revoked_at,?) WHERE token_hash=?").bind(Date.now(), await sha256Hex(token)).run();
      return json({ ok: true });
    }
    const auth = await resolveSession(env, request);
    if (!await allowRate(request.method === "GET" ? env.READ_LIMITER : env.SAVE_LIMITER, `aven:${auth.user_id}:${request.method}`, { fail: "closed" })) fail("rate_limited", 429);
    if (auth.background && !(request.method === "GET" && (url.pathname === "/internal/aven/session" || (auth.purpose === "automation" && url.pathname.startsWith(`/internal/aven/projects/${auth.project_id}/knowledge`))))) fail("background_scope_forbidden", 403);
    if (url.pathname === "/internal/aven/background-grants" && request.method === "POST") {
      const body = await bodyOf(request);
      onlyFields(body, ["id", "tokenHash", "projectId", "purpose", "resourceId"]);
      if (!/^[A-Za-z0-9_-]{16,100}$/.test(body.id ?? "") || !/^proj_[A-Za-z0-9_-]{8,80}$/.test(body.projectId ?? "") || !/^[a-f0-9]{64}$/.test(body.tokenHash ?? "") || !["automation", "github_connection"].includes(body.purpose) || typeof body.resourceId !== "string" || body.resourceId.length < 1 || body.resourceId.length > 160) fail("invalid_background_grant");
      const capability = body.purpose === "automation" ? "project.memory.write" : "project.integrations.manage";
      const scope = await scopeFor(env, auth, body.projectId, capability);
      const prior = await env.DB.prepare("SELECT * FROM aven_background_grants WHERE id=?").bind(body.id).first();
      if (prior) {
        if (prior.user_id !== auth.user_id || prior.project_id !== body.projectId || prior.purpose !== body.purpose || prior.resource_id !== body.resourceId || prior.token_hash !== body.tokenHash || prior.revoked_at !== null) fail("grant_conflict", 409);
        return json({ ok: true, id: prior.id });
      }
      await runAuditedMutation(env, auditDetails(env, request, ctx, auth, scope, capability, "aven.background.authorized", "background_grant", body.id, body.id), async (intent) => {
        await commitAuditedBatch(env, intent, [env.DB.prepare("INSERT INTO aven_background_grants(id,token_hash,user_id,project_id,purpose,resource_id,created_at) VALUES(?,?,?,?,?,?,?)").bind(body.id, body.tokenHash, auth.user_id, body.projectId, body.purpose, body.resourceId, Date.now())]);
        return auditedMutationResult({ id: body.id }, intent);
      });
      return json({ ok: true, id: body.id }, 201);
    }
    if (url.pathname === "/internal/aven/session" && request.method === "GET") return json(await sessionResult(env, auth, url.searchParams.get("projects") !== "0"));
    if (url.pathname === "/internal/aven/account/password" && request.method === "POST") {
      const body = await bodyOf(request);
      onlyFields(body, ["currentPassword", "newPassword"]);
      if ((body.currentPassword !== undefined && typeof body.currentPassword !== "string") || typeof body.newPassword !== "string") fail("invalid_request");
      if (!await allowRate(env.AUTH_LIMITER, `aven:password:${auth.user_id}`, { fail: "closed" })) fail("rate_limited", 429);
      const changed = await runAuditedMutation(env, { actorUserId: auth.user_id, actorType: "user", action: "account.password.changed", targetType: "user", targetId: auth.user_id,
        requestId: request.headers.get("x-request-id"), waitUntil: ctx?.waitUntil ? (p) => ctx.waitUntil(p) : null,
        authorizationGuards: [originalSessionGuard(env, auth), bridgeSessionGuard(env, auth)] },
      (intent) => changePasswordForUser(env, personRequest(request), auth.user_id, body, { auditIntent: intent }));
      if (changed.error) return refuse({ 401: "unauthorized", 409: "password_conflict" }[changed.status] ?? "invalid_request", changed.status ?? 400, changed.error);
      return json({ ok: true });
    }
    if (url.pathname === "/internal/aven/session/revoke" && request.method === "POST") {
      const at = Date.now();
      const closing = [env.DB.prepare("UPDATE aven_bridge_sessions SET revoked_at = ? WHERE id = ? AND user_id = ?").bind(at, auth.id, auth.user_id)];
      if (String(auth.id).startsWith(DIRECT_PREFIX)) closing.push(env.DB.prepare("UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND user_id = ?").bind(at, auth.source_session_id, auth.user_id));
      await env.DB.batch(closing); return json({ ok: true });
    }
    if (url.pathname === "/internal/aven/projects" && request.method === "GET") return json({ ok: true, projects: (await sessionResult(env, auth)).projects });
    if (url.pathname === "/internal/aven/projects" && request.method === "POST") {
      const body = await bodyOf(request); onlyFields(body, ["name", "description", "idempotencyKey"]); const key = validateIdempotencyKey(body.idempotencyKey);
      const org = await ensureDefaultOrganization(env, auth.user_id);
      const membership = await resolveMembership(env, { userId: auth.user_id, orgId: org.id });
      if (!can("project.create", membership)) fail("forbidden", 403);
      const hash = await sha256Hex(JSON.stringify({ name: body.name, description: body.description ?? null }));
      const prior = await env.DB.prepare("SELECT * FROM aven_creation_claims WHERE user_id = ? AND project_id = ? AND operation_kind = 'project' AND idempotency_key = ?").bind(auth.user_id, org.id, key).first();
      if (prior) {
        if (prior.request_hash !== hash) fail("idempotency_conflict", 409);
        const project = await getManagedProjectForUser(env, auth.user_id, prior.object_id); if (!project) fail("not_found", 404);
        return json({ ok: true, project: await safeProject(env, auth, project), replayed: true });
      }
      const scope = { membership };
      let project;
      try {
        project = await runAuditedMutation(env, auditDetails(env, request, ctx, auth, scope, "project.create", "project.created", "project", null, key),
          (intent) => createManagedProject(env, org.owner_user_id, { name: body.name, description: body.description }, { organizationId: org.id, auditIntent: intent,
            transactionStatements: (projectId) => [env.DB.prepare("INSERT INTO aven_creation_claims(user_id,project_id,operation_kind,idempotency_key,request_hash,object_id,created_at) VALUES(?,?,'project',?,?,?,?)").bind(auth.user_id, org.id, key, hash, projectId, Date.now())] }),
          (created) => ({ projectId: created.id, targetId: created.id }));
      } catch (error) {
        const raced = await env.DB.prepare("SELECT * FROM aven_creation_claims WHERE user_id = ? AND project_id = ? AND operation_kind = 'project' AND idempotency_key = ?").bind(auth.user_id, org.id, key).first();
        if (!raced) throw error;
        if (raced.request_hash !== hash) fail("idempotency_conflict", 409);
        project = await getManagedProjectForUser(env, auth.user_id, raced.object_id); if (!project) fail("not_found", 404);
        return json({ ok: true, project: await safeProject(env, auth, project), replayed: true });
      }
      return json({ ok: true, project: await safeProject(env, auth, project) }, 201);
    }
    const projectRoute = /^\/internal\/aven\/projects\/(proj_[A-Za-z0-9_-]{8,80})$/.exec(url.pathname);
    if (projectRoute && request.method === "PATCH") {
      const projectId = projectRoute[1], scope = await scopeFor(env, auth, projectId, "project.edit");
      const body = await bodyOf(request); onlyFields(body, ["name", "description", "expectedRevision", "idempotencyKey"]);
      const key = validateIdempotencyKey(body.idempotencyKey);
      if (typeof body.expectedRevision !== "string" || !body.expectedRevision || body.expectedRevision.length > 100) fail("precondition_required", 428);
      const patch = {}; if (body.name !== undefined) patch.name = body.name; if (body.description !== undefined) patch.description = body.description;
      if (!Object.keys(patch).length) fail("empty_patch");
      const hash = await sha256Hex(JSON.stringify({ name: body.name, description: body.description, expectedRevision: body.expectedRevision }));
      const readClaim = () => env.DB.prepare("SELECT * FROM aven_creation_claims WHERE user_id = ? AND project_id = ? AND operation_kind = 'project_update' AND idempotency_key = ?").bind(auth.user_id, projectId, key).first();
      const prior = await readClaim();
      if (prior) { if (prior.request_hash !== hash) fail("idempotency_conflict", 409); return json({ ok: true, project: await safeProject(env, auth, scope.project), replayed: true }); }
      let updated;
      try {
        updated = await runAuditedMutation(env, auditDetails(env, request, ctx, auth, scope, "project.edit", "project.updated", "project", projectId, key),
          (intent) => updateManagedProject(env, scope.project.owner_user_id, projectId, patch, body.expectedRevision, { auditIntent: intent,
            transactionStatements: () => [env.DB.prepare("INSERT INTO aven_creation_claims(user_id,project_id,operation_kind,idempotency_key,request_hash,object_id,created_at) VALUES(?,?,'project_update',?,?,?,?)").bind(auth.user_id, projectId, key, hash, projectId, Date.now())] }));
      } catch (error) {
        const raced = await readClaim(); if (!raced) throw error;
        if (raced.request_hash !== hash) fail("idempotency_conflict", 409);
        return json({ ok: true, project: await safeProject(env, auth, await getManagedProjectForUser(env, auth.user_id, projectId)), replayed: true });
      }
      return json({ ok: true, project: await safeProject(env, auth, updated.project), changed: updated.changed });
    }
    const match = /^\/internal\/aven\/projects\/(proj_[A-Za-z0-9_-]{8,80})\/(knowledge|graph|capture|recall)(?:\/((?:page|node|slice|event)_[A-Za-z0-9_-]{8,100}))?(\/history)?$/.exec(url.pathname);
    if (!match) fail("not_found", 404);
    const [, projectId, resource, memoryId, history] = match;
    const write = request.method !== "GET" && resource !== "recall";
    const scope = await scopeFor(env, auth, projectId, request.method === "DELETE" ? "project.memory.delete" : write ? "project.memory.write" : "project.memory.read");
    if(resource === "recall" && request.method === "POST" && !memoryId){
      const body=await bodyOf(request);onlyFields(body,["query"]);
      if(typeof body.query!=="string" || !body.query.trim() || body.query.length>500) fail("invalid_query");
      const result=await runRecallCommand(env,scope.memoryOwnerUserId,body.query,{recallScope:"project_only",memoryScope:{authType:"session",memoryUserId:scope.memoryOwnerUserId,ownerUserId:scope.memoryOwnerUserId,accountUserId:scope.accountUserId,managedProjectId:scope.project.id,managedProjectName:scope.project.name,projectId:scope.project.id,externalUserId:scope.accountUserId}});
      return json(result);
    }
    if(resource === "capture" && request.method === "GET" && !memoryId){
      const receiptId=url.searchParams.get("receiptId");
      if(!receiptId || receiptId.length>160) fail("invalid_receipt");
      // The engine replaces its staging receipt when enrichment finishes.
      // Resolve the stable job identity only inside this project's namespace.
      const stagedJobId=/^receipt_mcp_stage_job_[A-Za-z0-9-]+$/.test(receiptId) ? receiptId.slice("receipt_mcp_stage_".length) : "";
      const job=await env.DB.prepare("SELECT status FROM memory_jobs WHERE user_id=? AND (receipt_id=? OR id=?) ORDER BY created_at DESC LIMIT 1").bind(scope.memoryOwnerUserId,receiptId,stagedJobId).first();
      if(!job) return json({ok:true,state:"unknown"});
      return json({ok:true,state:job.status});
    }
    if (resource === "capture" && request.method === "POST" && !memoryId) {
      const body = await bodyOf(request);
      onlyFields(body, ["messages", "conversationId", "idempotencyKey"]);
      const idempotencyKey = validateIdempotencyKey(body.idempotencyKey);
      if (typeof body.conversationId !== "string" || body.conversationId.length < 1 || body.conversationId.length > 160) fail("invalid_conversation");
      if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 16) fail("invalid_messages");
      let total = 0;
      const messages = body.messages.map((message) => {
        if (!message || typeof message !== "object") fail("invalid_message");
        onlyFields(message,["role","content"]);
        if (!["user","assistant"].includes(message.role) || typeof message.content !== "string" || message.content.length > 12000) fail("invalid_message");
        total += message.content.length;
        return {role:message.role,content:message.content};
      });
      if (total > 24000) fail("capture_too_large",413);
      const rules = await getMemoryRules(env,scope.memoryOwnerUserId,{failClosed:true});
      rules.projectCategories = await activeCategoryRules(env,{projectId:scope.project.id,memoryOwnerUserId:scope.memoryOwnerUserId,legacy:rules.customCategories ?? []});
      const cap = await checkAiBudget(env,{userId:scope.memoryOwnerUserId,accountUserId:scope.accountUserId});
      if (cap) return json({ok:true,state:"paused",summary:cap.message,receiptId:null});
      // Admission is audited and fenced to the current actor before durable staging.
      await runAuditedMutation(env,auditDetails(env,request,ctx,auth,scope,"project.memory.write","project.memory.capture_requested","project",projectId,idempotencyKey),async(intent)=>{
        await commitAuditedBatch(env,intent,[]);
        return auditedMutationResult({accepted:true},intent);
      });
      const result = await stageMcpConversation(env,ctx,scope.memoryOwnerUserId,{
        messages,conversationId:`aven:${body.conversationId}`,idempotencyKey,aiProfile:AVEN_MODEL_PROFILE,
        rules,managedPolicy:true,credentialRules:null,projectCategories:rules.projectCategories ?? [],
        // projectId tags the captured rows; Aven recall filters on it (project_only).
        memoryScope:{authType:"session",memoryUserId:scope.memoryOwnerUserId,ownerUserId:scope.memoryOwnerUserId,accountUserId:scope.accountUserId,managedProjectId:scope.project.id,managedProjectName:scope.project.name,projectId:scope.project.id,externalUserId:scope.accountUserId},
      });
      return json({ok:true,state:result.ok === false ? "failed" : result.processing ? "staged" : "completed",summary:result.summary ?? "Capture received.",receiptId:result.receipt_id ?? result.receipt?.id ?? null});
    }
    if (resource === "graph" && request.method === "GET" && !memoryId) {
      const inventory = await listMemories(env, scope.memoryOwnerUserId, { limit: 200 });
      const ids = new Set(inventory.items.map((item) => item.id));
      const edges = await env.DB.prepare("SELECT id,from_node AS source,to_node AS target,type FROM edges WHERE user_id = ? AND deleted_at IS NULL AND invalid_at IS NULL LIMIT 500").bind(scope.memoryOwnerUserId).all();
      return json({ ok: true, nodes: inventory.items.map((item) => ({ id: item.id, label: item.label, kind: item.kind, category: item.category, revision: item.revision })), edges: (edges.results ?? []).filter((edge) => ids.has(edge.source) && ids.has(edge.target)), truncated: Boolean(inventory.next_cursor) });
    }
    if (resource !== "knowledge") fail("not_found", 404);
    if (request.method === "GET" && !memoryId) {
      const options = parseInventoryListOptions({ limit: url.searchParams.get("limit"), cursor: url.searchParams.get("cursor"), q: url.searchParams.get("q") });
      if (options.error) fail(options.error);
      const result = await listMemories(env, scope.memoryOwnerUserId, options);
      return json({ ok: true, items: result.items.map((item) => knowledgeItem(item, { textTruncated: item.kind === "page" })), nextCursor: result.next_cursor });
    }
    if (request.method === "POST" && !memoryId) return json(await createKnowledge(env, request, ctx, auth, scope, await bodyOf(request)), 201);
    if (!memoryId) fail("not_found", 404);
    if (request.method === "DELETE" && !history) {
      const body = await bodyOf(request); onlyFields(body, ["expectedRevision", "idempotencyKey"]);
      const key = validateIdempotencyKey(body.idempotencyKey);
      if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1) fail("precondition_required", 428);
      const hash = await sha256Hex(JSON.stringify({ id: memoryId, expectedRevision: body.expectedRevision }));
      const readClaim = () => env.DB.prepare("SELECT * FROM aven_creation_claims WHERE user_id = ? AND project_id = ? AND operation_kind = 'forget' AND idempotency_key = ?").bind(auth.user_id, projectId, key).first();
      const prior = await readClaim();
      if (prior) { if (prior.request_hash !== hash) fail("idempotency_conflict", 409); return json({ ok: true, deleted: true, id: memoryId, replayed: true }); }
      let mutationIntent = null;
      try {
      const { found } = await oneKnowledge(env, scope, memoryId);
      if (!["page", "node", "slice"].includes(found.kind)) fail("unsupported_kind", 422);
      if (Number(found.memory.revision ?? 1) !== body.expectedRevision) fail("stale_revision", 412);
      const table = found.kind === "page" ? "memory_pages" : found.kind === "node" ? "nodes" : "slices";
      const result = await runAuditedMutation(env, auditDetails(env, request, ctx, auth, scope, "project.memory.delete", "project.memory.deleted", "memory_object", memoryId, key),
        (intent) => { mutationIntent = intent; return deleteObject(env, scope.memoryOwnerUserId, { kind: found.kind, id: memoryId,
          // Forget removes this memory and its derivatives; a future independent
          // explicitly approved teaching can create a new memory.
          suppress: false, auditIntent: intent,
          guards: [auditInvariantStatement(env, `SELECT 1 FROM ${table} WHERE id = ? AND user_id = ? AND deleted_at IS NULL AND COALESCE(revision,1) = ?`, [memoryId, scope.memoryOwnerUserId, body.expectedRevision])],
          transactionStatements: [env.DB.prepare("INSERT INTO aven_creation_claims(user_id,project_id,operation_kind,idempotency_key,request_hash,object_id,created_at) VALUES(?,?,'forget',?,?,?,?)").bind(auth.user_id, projectId, key, hash, memoryId, Date.now())] }); });
      return json({ ok: true, deleted: Boolean(result.deleted), id: memoryId });
      } catch (error) {
        // A genuine post-commit cleanup failure is not a transport race.
        // Existing audit machinery records this as failed_partial.
        if (mutationIntent?.committed) throw error;
        const raced = await readClaim();
        if (raced) { if (raced.request_hash !== hash) fail("idempotency_conflict", 409); return json({ ok: true, deleted: true, id: memoryId, replayed: true }); }
        throw error;
      }
    }
    const { found, item } = await oneKnowledge(env, scope, memoryId);
    if (request.method === "GET" && history) return json({ ok: true, ...(await listMemoryHistory(env, scope.memoryOwnerUserId, memoryId, { limit: url.searchParams.get("limit") ?? undefined, cursor: url.searchParams.get("cursor") })) });
    if (request.method === "GET") return json({ ok: true, item });
    if (request.method === "PATCH" && !history) {
      const body = await bodyOf(request); onlyFields(body, ["title", "text", "expectedRevision", "idempotencyKey", "reason"]);
      const patch = {};
      if (body.title !== undefined) patch[found.kind === "page" ? "title" : "label"] = body.title;
      if (body.text !== undefined) {
        patch[found.kind === "page" ? "full_markdown" : found.kind === "node" ? "summary" : "text"] = body.text;
        if (found.kind === "page" && typeof body.text === "string") patch.short_summary = body.text.slice(0, 1000);
      }
      const result = await runAuditedMutation(env, auditDetails(env, request, ctx, auth, scope, "project.memory.write", "project.memory.updated", "memory_object", memoryId, body.idempotencyKey),
        (intent) => applyMemoryChange(env, ctx, { userId: scope.memoryOwnerUserId, project: { id: projectId }, actor: { userId: auth.user_id, type: "session", capability: "project.memory.write", orgId: scope.membership.orgId, credential: { kind: "session", id: auth.source_session_id } }, actorClass: "user", actorRef: auth.user_id,
          id: memoryId, mode: "update", patch, expectedRevision: body.expectedRevision, idempotencyKey: body.idempotencyKey, reason: body.reason, auditIntent: intent }));
      return json({ ok: true, item: (await oneKnowledge(env, scope, memoryId)).item, replayed: Boolean(result.replayed) });
    }
    fail("method_not_allowed", 405);
  } catch (error) {
    const version = versionErrorResponse(error);
    if (version) return json(version.body, version.status);
    if (error instanceof BridgeError || Number.isInteger(error?.status)) return json({ error: error.code ?? "request_failed" }, error.status);
    // Intentionally never log token/header/body/error text from the auth lane.
    console.error("aven.bridge unavailable", { errorClass: error?.name ?? "Error" });
    return json({ error: "bridge_unavailable" }, 503);
  }
}
