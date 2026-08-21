# MCP OAuth 2.1 / PKCE — architecture checkpoint (Campaign B)

Date: 2026-08-21. Baseline: `8df0552` (Campaign A GO), production Worker
`784cc865-b553-4583-9e6c-e3a3e92912d8`, next migration **0051**.

This is authorization for Itsuki's **remote MCP server**. It is separate from
the Google OAuth used to sign in to the dashboard (Itsuki is a *client* there;
here Itsuki is an authorization server + resource server). The dashboard login
path is not touched.

## Decision: implement the OAuth endpoints against D1, not `@cloudflare/workers-oauth-provider`

I installed `@cloudflare/workers-oauth-provider@0.10.3` and read its actual
`dist/oauth-provider.d.ts` and `dist/oauth-provider.js` before deciding, then
uninstalled it. It is a good library; it is the wrong fit *here*, for three
evidence-backed reasons:

1. **It stores grants and tokens in KV** (`env.OAUTH_KV`, confirmed in
   `dist/oauth-provider.js`). This campaign requires that revoking a token,
   narrowing a scope, removing membership, or archiving a project takes effect
   **between request preflight and mutation commit**. Itsuki enforces that with
   `fence_guard` statements inside the same `env.DB.batch()` as the mutation
   (`credentialGuardStatement`, `capabilityGuardStatement`). A KV-held grant
   cannot participate in a D1 batch, and KV is eventually consistent — so the
   guarantee would silently degrade to "revocation applies to the next
   request". Mirroring KV into D1 would create two sources of truth for
   revocation, which is worse than one.
2. **It owns the whole Worker.** The documented shape is
   `export default new OAuthProvider({apiRoute, apiHandler, defaultHandler})`,
   which puts every route in this 81-route Worker (dashboard, REST, cron, DO
   exports, assets) behind the library's request path for a feature that only
   concerns `/mcp`. That is a large blast radius against an explicit
   "don't break dashboard authentication" constraint.
3. **Legacy `/mcp/<token>` path tokens have no Authorization header.** With
   `/mcp` as `apiRoute`, `/mcp/<token>` matches the same prefix and would be
   required to present a bearer token. `resolveExternalToken` exists and would
   rescue header-based legacy tokens, but not the path door, which is a
   currently-supported surface that must keep working.

The library's conformance surface (endpoint set, metadata field names, PKCE
S256-only default, refresh rotation, hash-only storage, DCR TTL) is used as the
reference implementation to match. Spec sources: MCP authorization 2026-07-28,
RFC 9728 / 8414 / 7591 / 7636 / 7009 / 8707 / 9207, and Anthropic's published
connector-authentication behaviour.

## Frozen scope matrix

Existing scope strings: `memory:read`, `memory:write` (+ wildcards `*`,
`memory:*`). **New: `memory:delete`.** `memory:write` implies `memory:read`
(existing behaviour, kept). `memory:write` does **not** imply `memory:delete`.

| Tool | Kind | Required scope | Additional live gate |
|---|---|---|---|
| `recall_memory`, `list_memories`, `get_memory`, `memory_history`, `whoami` | read | `memory:read` | `project.memory.read` |
| `save_memory`, `save_conversation`, `update_memory`, `rollback_memory` | write | `memory:write` | `project.memory.write` |
| `delete_memory`, `delete_all_memories` | destructive | `memory:delete` | `project.memory.delete` (admin) |

`rollback_memory` stays a **write**, not a delete: it never removes a row or a
revision, it appends a forward revision. It is noted as the one write that can
blank a body (update-to-null then rollback), which is why it still requires
write plus the live write capability at commit time.

No further scopes. History/update do not get their own scopes: `memory_history`
returns snapshots of content the read scope already exposes, and
`update_memory` cannot exceed what `save_memory` can already write.

**Legacy compatibility (documented, deliberate):** existing connection tokens
keep today's semantics — `memory:write` + `project.memory.delete` capability
permits deletion — because removing delete from live integrations would be a
silent breaking change. Only **OAuth-issued** credentials use the strict model
where deletion requires `memory:delete`. Existing tokens gain nothing.

## Storage (migration 0051, additive)

- `oauth_clients` — `client_id` PK, `client_secret_hash` (NULL for public
  clients), name, redirect URIs, grant/response types, auth method,
  `registration_access_token_hash`, `created_at`, `expires_at` (DCR TTL 90d),
  `status`.
- `oauth_grants` — `id` PK, `user_id`, `client_id`, `project_id`,
  `scopes_json`, `created_at`, `updated_at`, `revoked_at`. One live grant per
  (user, client, project).
- `oauth_authorization_codes` — `code_hash` PK, grant fields, `redirect_uri`,
  `code_challenge`, `code_challenge_method`, `resource`, `expires_at`,
  `consumed_at`. Single-use, 60 s.
- `oauth_tokens` — `id` PK, `grant_id`, `user_id`, `kind` (`access`|`refresh`),
  `token_hash` UNIQUE, `expires_at`, `revoked_at`, `consumed_at`,
  `rotated_from`. Access 1 h, refresh 30 d with rotation and reuse detection
  (a replayed refresh token revokes the whole grant).
- `oauth_consent_requests` — short-lived server-side state for the consent
  screen, so no signed blob is trusted from the browser.

Hash-only storage throughout, reusing `sha256Hex` and `timingSafeEqualString`
from `src/auth.js`. Raw tokens exist only in the issuing response.

## Enforcement

Effective authorization = **intersection** of: grant scopes ∩ token validity ∩
account/project binding ∩ live project membership + role capability ∩ lifecycle
status/epoch ∩ deletion barrier.

- Request time: resolve the token → grant → user/project; then the existing
  `serveProjectBoundMcp` capability logic computes effective scopes.
- Commit time: `credentialGuardStatement` gains **kind `oauth`**, proving in
  the same D1 batch that the access token row is live, unexpired, unrevoked,
  its grant is unrevoked, still carries the required scope, and is still bound
  to the project — the exact analogue of the existing token/session guards.
- Grants are revoked wherever connection tokens are revoked today:
  `removeOrganizationMember`, `removeProjectMember`, account erasure, and
  `project_delete`'s control-plane phase.

**Latent bug to fix in passing:** `tokenAllowsScope` accepts `memory:*`, but
the commit-time fence SQL accepts only an exact match or `'*'` — so a
`memory:*` credential passes preflight and then aborts the batch. The fence
will be given the same accepted-literal set as the request-time check.

## Routing

`/.well-known/*` and `/oauth/*` are unclaimed. `not_found_handling` is unset
(default `none`), so unmatched asset requests already fall through to the
Worker — but that is incidental, so `run_worker_first` gains `/.well-known/*`
and `/oauth/*` to make it deterministic and immune to a future
`public/.well-known/...` file shadowing the routes.

Endpoints: `/.well-known/oauth-protected-resource[/mcp]`,
`/.well-known/oauth-authorization-server`, `GET|POST /oauth/authorize`,
`POST /oauth/token`, `POST /oauth/revoke`, `POST /oauth/register`.

401s from `/mcp` gain `WWW-Authenticate: Bearer resource_metadata="..."` so a
client can discover the authorization server (Claude requires this, and falls
back to probing the well-known paths).

## Consent

Server-rendered, escaped HTML in Itsuki's visual system. Shows client name,
the exact account and project being authorized, human-readable permissions
with destructive permission visually separated, approve and deny. State is
held server-side (`oauth_consent_requests`) with a CSRF token bound to the
session; the active identity and project are **re-verified immediately before
the grant commits**, so a user can never approve for an account they are not
actually signed in as.

## Tool advertisement

A connection is offered only the tools it can actually use: write tools
require write scope, destructive tools require the delete scope (OAuth) or the
historical write-plus-capability contract (legacy tokens). Advertisement is a
usability measure — `ensureScope`, `deleteForbidden`, and the commit-time
fences remain the authority, and every hidden tool is still refused if called
directly. This applies to legacy connection tokens too: a read-only key could
never write, so hiding the tools removes a misleading affordance rather than
taking anything away.

## Flag

`MCP_OAUTH` = `track` (schema + metadata endpoints live, no grants issued) or
`on` (full flow). Rollback is the flag flip; the previous Worker version is the
hard rollback.
