# MCP OAuth 2.1 / PKCE — Campaign B final report

**Verdict: GO.** Implemented, tested, migrated, deployed in two stages, and
production-canaried against live itsuki.app. Evidence below; anything not
proven is labelled as such.

Date: 2026-08-21. Baseline: `8df0552` (Campaign A GO).

---

## 1. What shipped

Itsuki's remote MCP server is now an OAuth 2.1 protected resource with its own
authorization server. A compatible MCP client can discover the authorization
server, authorize with PKCE S256, sign in with an ordinary Itsuki session,
approve a named account and project on an explicit consent screen, exchange the
code, and connect — receiving only the tools its consented scopes allow.

This is **separate from the Google OAuth used to sign in to the dashboard**,
where Itsuki is a client. That path is untouched and was re-verified in
production after every deploy.

**Endpoints:** `/.well-known/oauth-protected-resource[/mcp]` (RFC 9728),
`/.well-known/oauth-authorization-server` (RFC 8414), `GET|POST
/oauth/authorize`, `POST /oauth/token`, `POST /oauth/revoke` (RFC 7009),
`POST /oauth/register` (RFC 7591).

## 2. The load-bearing decision: D1, not the KV-backed library

`@cloudflare/workers-oauth-provider@0.10.3` was installed and its actual
`dist/oauth-provider.js` and `.d.ts` read before deciding; it was then
uninstalled and the dependency tree restored. It is a good library and the
wrong fit here, for reasons taken from its own source:

1. **It stores grants and tokens in KV** (`env.OAUTH_KV`). This campaign
   requires revocation to take effect *between request preflight and mutation
   commit*. Itsuki enforces that with `fence_guard` statements inside the same
   `env.DB.batch()` as the mutation. A KV-held grant cannot join a D1 batch and
   KV is eventually consistent, so the guarantee would have quietly degraded to
   "revocation applies to the next request". Mirroring KV into D1 would create
   two sources of truth for revocation — worse than one.
2. **It owns the whole Worker** (`apiHandler`/`defaultHandler`), putting all 81
   routes behind the library for a feature that concerns `/mcp` only.
3. **Legacy `/mcp/<token>` path tokens carry no Authorization header** and
   would have been required to present a bearer under its `apiRoute` prefix.
   `resolveExternalToken` (which does exist) rescues header tokens, not the
   path door.

Its conformance surface is used as the reference implementation to match.

## 3. Frozen scope matrix

| Tool | Kind | Scope | Live capability |
|---|---|---|---|
| `recall_memory`, `list_memories`, `get_memory`, `memory_history`, `whoami` | read | `memory:read` | `project.memory.read` |
| `save_memory`, `save_conversation`, `update_memory`, `rollback_memory` | write | `memory:write` | `project.memory.write` |
| `delete_memory`, `delete_all_memories` | destructive | `memory:delete` | `project.memory.delete` |

`memory:write` implies `memory:read` (existing behaviour). **`memory:write`
does not imply `memory:delete`** — the new scope. `rollback_memory` stays a
write: it appends a forward revision and removes nothing.

**Tool advertisement** matches: a connection is offered only tools it can use.
Enforcement (`ensureScope`, `deleteForbidden`, commit-time fences) remains
authoritative — every hidden tool is still refused if called directly.

**Legacy compatibility, deliberate and documented:** existing connection tokens
keep their historical contract (write scope + live `project.memory.delete`
permits deletion). Only OAuth credentials face the strict model. No existing
integration lost a capability and none gained reach.

## 4. Enforcement

Effective authorization is the intersection of: consented grant scopes ∩ token
validity/expiry ∩ account+project binding ∩ live membership and role ∩ account
status and erasure tombstone ∩ lifecycle status/epoch ∩ deletion barrier.

- **Commit-time**: `credentialGuardStatement` gained kind `oauth`, proving in
  the same D1 batch that the access token is live and unexpired, its grant is
  unrevoked and still carries the required scope, still bound to this project,
  and the account is active and untombstoned.
- **Grants are revoked wherever connection tokens are**: project-member
  removal, organization-member removal, `project_delete`'s control-plane phase,
  and account erasure — in the same batches, so remove-and-re-add cannot revive
  an authorization.
- **Project binding is authoritative**: an OAuth caller cannot switch projects
  with a request header.

## 5. Defects found and fixed during the campaign

1. **OAuth callers could switch projects via a request header.**
   `resolveManagedProject` only honoured a credential's project binding for
   `type === "token"`, so an OAuth connection fell through to the header or the
   default project — escaping the project the user actually consented to. Fixed
   to treat `oauth` exactly like a project-bound token.
2. **Deletion had no commit-time credential fencing at all.** `deleteObject`
   took no guards, so a token revoked between preflight and commit could still
   erase memory. It now accepts fence statements that ride in the deleting
   batch; the MCP delete tool supplies the credential and
   `project.memory.delete` capability guards.
3. **Latent pre-existing bug: preflight and fence disagreed on scope.**
   `tokenAllowsScope` accepts `memory:*`, but the fence SQL accepted only an
   exact match or `'*'` — so such a credential passed preflight and then
   aborted its own mutation with a misleading `project_state_changed`. Both
   sides now derive accepted literals from one function
   (`scopeLiteralsSatisfying`).
4. **`state` was silently truncated at 512 characters** (RFC 6749 §4.1.2
   violation): the client received a value it never sent, which its own CSRF
   check reads as an attack. Now refused with `invalid_request` on the error
   redirect instead.
5. **Every consent row recorded `session_id = NULL`** — the code read
   `session.sessionId`, which does not exist (`getSessionUser` returns
   `session.session.id`). No bypass today because commit-time identity is
   re-proved from the live session, but any future check on that column would
   have been vacuously true.
6. **Read-only connections were still offered the write tools.** Caught by the
   *production* canary, not by the suite: `save_memory`/`save_conversation`
   were registered unconditionally. Writes were correctly refused, but the
   model was shown capabilities the connection did not have. Now gated on write
   scope, for OAuth and legacy connections alike.

Items 4 and 5 were found by a test-writing pass; 1, 2, 3 during implementation;
6 by the Stage B production canary.

## 6. Tests

New suites: `oauth_protocol.spec.js` (25), `oauth_security.spec.js` (13),
`oauth_enforcement.spec.js` (22).

Coverage against the mandated matrix — all proven:

| # | Requirement | Where |
|---|---|---|
| 1 | Metadata/discovery spec-compliant | protocol + canary |
| 2 | Valid code + PKCE S256 succeeds | protocol + canary |
| 3 | Missing/wrong/plain verifier fails | protocol (incl. verifier-equals-challenge) |
| 4 | Code single-use and short-lived | protocol (replay revokes the grant; expired code refused) |
| 5 | State mismatch / CSRF fails | security + canary |
| 6 | Exact redirect matching; no open redirect | protocol + canary (never a 302) |
| 7 | Unknown client and abusive DCR input fail safely | protocol (7 rejection cases) |
| 8 | Consent deny produces no grant or token | security + canary |
| 9 | Scope escalation fails | security + canary (refresh cannot widen) |
| 10 | Read-only advertises/executes only read tools | security + canary |
| 11 | Write token cannot delete | security + canary |
| 12 | Delete requires delete scope + live admin capability | security + enforcement |
| 13 | Refresh rotates; reuse revokes the family | security + canary |
| 14 | Revoked/expired token and revoked session fail | security + enforcement + canary |
| 15 | Revocation between preflight and commit aborts the mutation | enforcement (direct `applyMemoryChange` with a revoked token, then a revoked grant) |
| 16 | Project/account switch cannot reuse old authorization | enforcement |
| 17 | Lifecycle changes invalidate stale grants | enforcement (member removal, erasure) |
| 18 | Concurrent refresh/exchange/revocation deterministic | protocol + security |
| 19 | Cross-tenant and forged identifiers fail without leakage | enforcement + canary |
| 20 | Raw credentials never in audit/logs/errors | security (table scan) + protocol (hash-only storage) |
| 21 | Existing bearer/path-token integrations still work | mcp.spec + canary legacy leg |
| 24 | Dashboard login and Google OAuth unchanged | google_auth.spec + production probe (302 → accounts.google.com) |
| 25 | Full repository suite green | below |

**Full suite on the shipped tree:**

```
npx vitest run --no-file-parallelism
 Test Files  161 passed (161)
      Tests  2081 passed (2081)
```

```
npx vitest run --config vitest.unit.config.mjs
 Test Files  36 passed (36)
      Tests  616 passed | 1 skipped (617)
```

**Requirement 22/23 — real third-party MCP client: NOT PROVEN.** The canary is
a real HTTP/JSON-RPC MCP client of my own making that completes discovery,
registration, consent, tool listing, read, write, refresh, and revoke against
production. No third-party host (Claude Desktop, Claude Code, Cursor, VS Code)
was driven end to end, because that needs interactive human sign-in in a real
client. Every such client is therefore **unverified**, not "supported". The
implementation follows Anthropic's published connector-authentication
behaviour (401 → `WWW-Authenticate` `resource_metadata` → PRM → DCR → PKCE
S256, loopback redirect accepted for Claude Code), but that is a documented
expectation, not an observation.

**Test-configuration change:** `vitest.config.mjs` gained
`testTimeout/hookTimeout: 30s`. Vitest's 5s default was failing 8 RBAC
integration tests under full-suite load while they passed in isolation — a
clock verdict, not a correctness one. No assertion was relaxed; a genuine hang
still fails, 30s later.

**Test contract updates (not weakenings):** four tests pinned the old
"advertise then refuse" shape for read-only connections. The campaign requires
read-only connections not to receive write tools, so they now assert
non-advertisement *and* refusal, plus that nothing was written.

**Known intermittent, pre-existing:** `hook_outbox.spec.js` › "times out a
response whose headers arrive but body never completes" failed once under full
unit-lane load and passed on re-run and in isolation. It is a timing test in
the plugin outbox, untouched by this campaign.

## 7. Release

| Step | Evidence |
|---|---|
| Account / Worker | `b6009ce8df89884b79e4f6fa49e52942`, Worker `uml`, itsuki.app |
| `wrangler types` | run after the config change (generated file is gitignored) |
| Dry run | clean; 4852.97 KiB / gzip 967.97 KiB |
| **Time Travel bookmark (pre-migration)** | `000016c9-00000000-000050ce-7808f1835fa50dd0f532169dc845e503` |
| Migration | `0051_mcp_oauth.sql`, 18 commands, ✅; all five tables verified by `sqlite_master` read-back |
| Stage A (`track`) | version `f108d85a-eb14-45ce-a78a-8cb34e742c3a` |
| Stage A canary | **3/3** — metadata and registration answer 404; OAuth is deployed but undiscoverable |
| Campaign A regression under Stage A | **25/25** — Conversation Pages unaffected |
| Stage B (`on`) | `738180f3` → canary found the advertisement defect → fixed → **`40724a34-f4be-46a9-9eee-92a4bfe87b6b`** (shipped) |
| Stage B canary | **41/41** on the shipped version |
| Campaign A regression on shipped version | **25/25** |
| Dashboard | `/auth/google/start` → 302 to accounts.google.com; `/health` 200; landing 200; docs 307 |
| Rollback | flip `MCP_OAUTH` to `track` and redeploy (metadata disappears, no grants issued, legacy doors unaffected); previous Worker version is the hard rollback; the D1 bookmark covers the schema |

**Canary honesty:** both canaries ran against **live itsuki.app** with
disposable accounts and disposable content. No real customer memory was used.
Every check is a real production call, not a simulation.

**Cleanup and residue:** canary accounts erased their own memory
(`{nodes:0, pages:0, slices:0, events:0, candidates:0}`) and revoked every
credential. Independently verified by direct D1 read:
`SELECT COUNT(*) FROM oauth_grants WHERE revoked_at IS NULL` = **0** and
`SELECT COUNT(*) FROM oauth_tokens WHERE revoked_at IS NULL` = **0** across the
whole production database. Disposable account shells remain (zero memory, zero
live credentials) because no self-serve account-erasure route exists — the same
known residual as previous campaigns.

## 8. Security decisions

- Hash-only storage for codes, access tokens, refresh tokens, client secrets,
  registration access tokens, and consent CSRF tokens. Raw values exist only in
  the issuing response.
- PKCE S256 only; `plain` is neither implemented nor advertised.
- Exact redirect-URI matching. `https`, RFC 8252 loopback, and private-use
  schemes only; fragments, credentials, and `javascript:`/`data:` refused.
- Unknown client or unregistered redirect → an **on-site** error page, never a
  redirect, so the flow cannot be used as an open redirector.
- Authorization codes: single-use via a `consumed_at IS NULL` claim; a replay
  revokes the grant and every token it issued.
- Refresh rotation with reuse detection: a replayed refresh token revokes the
  whole family.
- Re-authorization **replaces** grant scope rather than accumulating it, and
  narrowing revokes tokens issued under the wider scope.
- The consent screen escapes every interpolated value, sets `noindex`, is
  `no-store`, holds state server-side (the browser carries only an opaque id),
  and **re-verifies the signed-in identity immediately before commit** — a
  mismatch answers 409 and grants nothing.
- Tokens never travel in query strings and are absent from audit records,
  receipts, and error reports (asserted by table scan).

## 9. Remaining risks

- **No third-party MCP client has been driven end to end** (see §6). This is
  the largest open item; it needs a human at a real client.
- **Consent binds to the account's default project.** There is no in-consent
  project chooser yet; a user with several managed projects authorizes the
  default one. The binding is enforced and displayed, so nothing is
  mis-scoped — but selecting a different project requires a follow-up.
- **`delete_all_memories` is fenced at its start, not through its whole run.**
  It is a multi-pass convergent erasure; a revocation mid-run does not abort a
  destruction the user already confirmed. Single-object deletion is fully
  fenced.
- **No dashboard UI to review or revoke connections yet.** Revocation works
  through the RFC 7009 endpoint and through membership/lifecycle changes, but a
  user cannot yet see their authorized clients in the app.
- DCR is open (no initial access token), bounded by a 90-day registration TTL
  and by the fact that a client can do nothing without a user completing
  consent. Worth revisiting if abuse appears.
