# Aven first-party bridge v1

This facade lives in the maintained Itsuki repository. Itsuki remains the authority for identity, managed projects, membership, memory content, revisions, and deletion. Aven stores its own work and agent presentation metadata. The bridge does not create an alternate memory engine or expose an owner-wide key to a browser.

## Deployment prerequisites

1. Apply append-only D1 migration `0064_aven_bridge.sql` after its tests pass.
2. Set `AVEN_BRIDGE_SECRET` with a cryptographically random secret of at least 32 characters in both Workers' secret stores. Never put it in a public asset, wrangler vars, source, or client response.
3. Set `AVEN_ALLOWED_ORIGINS` to a comma-separated list of exact HTTPS origins, for example `https://aven-workspace.pages.dev`. No wildcard or preview-origin matching is supported. Each origin's only allowed callback is `/auth/callback`, without query or fragment.
4. Bind Aven's `ITSUKI` service to this maintained Itsuki Worker. The binding itself is not authentication: every private request additionally requires the shared secret.
5. Use a separate Aven session encryption key. Store the opaque bridge token only in encrypted server storage. The browser receives an opaque, HttpOnly, Secure, SameSite session cookie for Aven, never the bridge token.

Without a sufficiently long bridge secret, every bridge route returns 404. No existing public login screen, integration, or MCP route changes behaviour.

## Real authentication flow

Aven creates a high-entropy state and PKCE verifier, storing both server-side with a short expiry and binding state to the initiating browser. It sends the user to:

```
GET https://itsuki.app/aven/authorize?redirect_uri=https%3A%2F%2Faven-workspace.pages.dev%2Fauth%2Fcallback&state=...&code_challenge=...
```

Only S256 is supported. State is 16–200 URL-safe characters; challenge is a 43-character base64url SHA-256 digest. The verifier is 43–128 RFC 7636 unreserved characters.

A signed-in user immediately receives a 60-second authorization code at the exact allowed callback. A signed-out user sees an isolated sign-in handoff: Sign in opens the existing Itsuki login in another tab, and the handoff checks same-origin sign-in status every four seconds. Continue retries manually. This deliberately reuses existing password, email, GitHub and Google sign-in rather than duplicating their forms.

The callback validates and consumes Aven's state before exchanging the code over the private binding:

```http
POST /internal/aven/session
Authorization: Bearer <AVEN_BRIDGE_SECRET>
Content-Type: application/json

{"code":"...","codeVerifier":"...","redirectUri":"https://aven-workspace.pages.dev/auth/callback"}
```

Successful response:

```json
{
  "ok": true,
  "token": "opaque-server-only-token",
  "expiresAt": 1792300000000,
  "principal": {"actorId":"user_...","name":"Example","email":"example@example.com"},
  "projects": [{"id":"proj_...","name":"Atlas","description":null,"organizationId":"org_...","status":"active","revision":"prv1....","capabilities":["project.memory.read"]}]
}
```

Codes and tokens are stored only as SHA-256 hashes. Code consumption and token issuance share one D1 batch. A code can create at most one bridge session. Bridge sessions expire after seven days or the originating Itsuki session's expiry, whichever is sooner. Every call joins the original session and user, so logout, revoke-all, disabled accounts and account erasure revoke bridge access. Membership is re-resolved for every scoped request. Writes also fence the credential, bridge session, capability, project lifecycle and audit record inside their committing batch.

All private requests after exchange use:

```http
Authorization: Bearer <AVEN_BRIDGE_SECRET>
X-Aven-Session: <opaque-server-only-token>
```

Private requests carrying an Origin header are refused. There are no CORS grants. The frontend calls its same-origin Aven API; the API makes a fresh binding Request and does not copy browser headers wholesale.

## Operations

### Background delegation (migration 0065)

`POST /background-grants` requires a live interactive bridge session and the private service secret. It accepts `id`, `tokenHash` (SHA-256 hex), `projectId`, `purpose` (`automation` or `github_connection`) and `resourceId`. The client generates and encrypts the high-entropy `abg_` token; Itsuki receives only its hash. Issuance is audited and fenced against session, membership and project changes. Identical registration is idempotent; conflicting or revoked registration fails.

Background grants survive logout and original session expiry. Every use checks the active account, erasure state, active project and current required membership capability. `/session` returns `expiresAt: null`, background grant metadata and only the scoped project. Automation grants can read that project's knowledge and check authorization; GitHub grants can check authorization only. Neither can create grants, mutate memory, enumerate unrelated projects or access normal browser routes. `POST /background-grants/revoke` accepts the grant itself with the private service secret and remains available after membership loss so cleanup can complete. Account or hard-project deletion cascades the grant; archive and capability removal deny it immediately. Aven handles routine pause/revision fences and orphan-grant cleanup.

| Method | Path relative to `/internal/aven` | Contract |
|---|---|---|
| GET | `/session` | Current principal, expiry and accessible projects; no token echoed. `?projects=0` skips project enumeration for authentication middleware. |
| POST | `/session/revoke` | Revokes only this Aven session; Itsuki login continues |
| GET | `/projects` | Current accessible projects and capabilities |
| POST | `/projects` | `{name,description?,idempotencyKey}`; creates in the actor's own default organization |
| PATCH | `/projects/:id` | `{name?,description?,expectedRevision,idempotencyKey}`; opaque canonical project revision and exact `project.edit` capability |
| GET | `/projects/:id/knowledge` | `?q=&limit=&cursor=`; bounded canonical inventory with summaries |
| POST | `/projects/:id/knowledge` | `{title,text,kind?,idempotencyKey,sources?}`; exact approved text, no LLM |
| GET | `/projects/:id/knowledge/:memoryId` | Full canonical item up to the 20k page reading limit |
| PATCH | `/projects/:id/knowledge/:memoryId` | `{title?,text?,expectedRevision,idempotencyKey,reason?}`; revision-safe correction |
| DELETE | `/projects/:id/knowledge/:memoryId` | `{expectedRevision,idempotencyKey}`; canonical forget, requires `project.memory.delete` |
| GET | `/projects/:id/knowledge/:memoryId/history` | Existing canonical revision history, `?limit=&cursor=` |
| GET | `/projects/:id/graph` | Up to 200 live inventory nodes and 500 canonical edges; `truncated` is explicit |

Knowledge item:

```json
{"id":"page_...","kind":"decision","memoryKind":"page","title":"Architecture","text":"Exact approved text.","revision":1,"createdAt":1792300000000,"updatedAt":1792300000000,"sources":[{"title":"Source","url":"https://example.com/source","path":"docs/adr.md","revision":"commit-sha"}]}
```

Creation accepts `note`, `decision`, `handoff`, `correction`; default is `note`. Text is capped at 20,000 characters. Sources are at most 20 structured references. URLs must be HTTPS, without credentials; no source URL is fetched by the bridge. Supplied actor/owner/organization fields are rejected, not trusted. `textTruncated:true` on list items means the detail operation is needed before showing or editing full content.

Creation dedupe is atomic with canonical creation. An actor's same key and same payload returns the same object; a changed payload returns 409. A deleted object cannot be resurrected by a replay. Updates use Itsuki's existing idempotency and revision pipeline. A stale revision returns 412; a missing precondition returns 428. Typed teaching content is stored without an LLM, OCR or OpenAI call. Search projection uses the existing helper: its text indexing is deterministic, while a production Itsuki deployment configured for vector search may perform metered Cloudflare embeddings. Test settings disable those external providers.

Forget reuses the canonical deletion cascade, including revision removal, search/vector cleanup and stored export invalidation. A revision fence and content-free replay claim share the canonical mutation's audit transaction. It does not install a permanent suppression of the label: a later independent, explicitly approved teaching may create a new memory. Aven must also invalidate its own derived context caches after success. This operation removes active memory; underlying storage follows Itsuki's existing deletion and retention policy.

## Boundaries and follow-up

- Graph and inventory are bounded projections, not another editable authority.
- Aven should check capabilities for presentation, but Itsuki rechecks them independently before access.
- Customer MCP/API grants and automated ingestion need explicit additional contracts. This bridge has no bulk delete, arbitrary SQL, owner credentials, upload execution, or deployment operation.
- An unauthenticated handoff page is a real sign-in route, not a demonstration login. The current isolated two-tab login is functional; an eventual shared first-party auth UX can replace it without weakening state/PKCE requirements.
- The private shared secret proves the trusted Aven backend; it does not by itself identify a user. A valid scoped bridge session is also mandatory.

Validation: run `npx vitest run test/aven_bridge.spec.js test/managed_projects.spec.js test/memory_updates.spec.js --no-file-parallelism` in the maintained repository. This uses deterministic test-only settings, with external AI and vector providers disabled.
