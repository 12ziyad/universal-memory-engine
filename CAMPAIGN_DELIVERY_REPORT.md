# Two-campaign delivery report — Conversation Pages + MCP OAuth

Date: 2026-08-21. Both campaigns were implemented, tested, migrated, deployed
in stages, production-canaried, cleaned up, and pushed.

**Overall verdict: GO for both**, with named unverified items listed in §8 —
none of which is claimed as proven.

---

## 1. Commits

| Commit | Campaign |
|---|---|
| `8df0552` | Campaign A — Conversation Pages |
| `87de4e5` | Campaign B — MCP OAuth 2.1 / PKCE |

Baseline before this work: `12cc980`. Both pushed to `origin/master`. The
campaigns are separable: A ships behind `CONVERSATION_PAGES`, B behind
`MCP_OAUTH`, each with its own migration, tests, canary, and report, so either
can be diagnosed or rolled back without the other.

## 2. Migrations

| Migration | Applied remotely | Commands |
|---|---|---|
| `0050_conversation_pages.sql` | ✅ | 7 |
| `0051_mcp_oauth.sql` | ✅ | 18 |

Both additive and compatible with the prior Worker version. Registered through
`scripts/update-migration-checksums.mjs` (append-only hash ledger); no existing
migration was edited. Checksums are committed in `migrations/CHECKSUMS.json`
and enforced by `migrations_append_only.spec.js`; new tables are enforced into
the lifecycle census by `schema_census.spec.js`.

**D1 Time Travel bookmarks (pre-migration restore points):**

- before 0050: `000016ae-00000000-000050cd-50b55a83fefd1b71918303373e4ef046`
- before 0051: `000016c9-00000000-000050ce-7808f1835fa50dd0f532169dc845e503`

## 3. Tests

```
npx vitest run --no-file-parallelism
 Test Files  161 passed (161)
      Tests  2081 passed (2081)

npx vitest run --config vitest.unit.config.mjs
 Test Files  36 passed (36)
      Tests  616 passed | 1 skipped (617)
```

Both run on the shipped tree at `87de4e5`, uninterrupted, after the final
commit. Baseline before this work was 2021 + 616; the campaigns added 60
workers-pool tests across eight new suites.

- `vitest.config.mjs` gained `testTimeout/hookTimeout: 30s`. Vitest's 5s
  default was failing 8 RBAC integration tests under full-suite load while they
  passed in isolation — a clock verdict, not a correctness one. No assertion
  was relaxed.
- Four tests that pinned the old "advertise the tool, then refuse the call"
  shape now assert non-advertisement *and* refusal *and* that nothing was
  written. That is a contract change the campaign explicitly required, not a
  weakening.
- **Known intermittent, pre-existing:** `hook_outbox.spec.js` › "times out a
  response whose headers arrive but body never completes" failed once under
  full unit-lane load, passed on re-run and in isolation. It is a timing test
  in the plugin outbox, untouched by either campaign.

## 4. Production

Account `b6009ce8df89884b79e4f6fa49e52942`, Worker `uml`, itsuki.app, D1
`uml-memory` (`3202df08-e568-4e53-a8cd-a85630db50f8`).

| Version | Stage |
|---|---|
| `0afd4dae` | before this work |
| `b2e07090` | A Stage A — `CONVERSATION_PAGES=track` |
| `784cc865` | A Stage B — `CONVERSATION_PAGES=on` |
| `f108d85a` | B Stage A — `MCP_OAUTH=track` |
| `738180f3` | B Stage B — first `on` (canary found a defect) |
| **`40724a34-f4be-46a9-9eee-92a4bfe87b6b`** | **shipped** — both features on, advertisement fix included |

**Feature flags now:** `CONVERSATION_PAGES=on`, `MCP_OAUTH=on`,
`SAFE_MEMORY_UPDATES=on`, `ITSUKI_MEMORY_V3=on` (unchanged).

**Rollback:** flip either flag to `track` and redeploy — Conversation Pages
returns to one page per accepted batch with no REST pages (proven by the Stage
A canary), and OAuth becomes undiscoverable with no grants issuable (also
proven). The previous Worker version is the hard rollback; the bookmarks cover
the schema.

## 5. Canary matrix

Every row below is a **real** call against live itsuki.app with disposable
accounts and disposable content. No real customer memory was used. Nothing in
this table is simulated.

| Canary | Stage | Result |
|---|---|---|
| Conversation Pages | `track` | **23/23** — legacy behaviour preserved (grown re-send → 2 pages, REST creates none) |
| Conversation Pages | `on` | **25/25** — convergence, advance, replay, same-key conflict, cross-conversation distinctness, zero pages from 8 automatic turns, REST create + advance, delete |
| Conversation Pages | on shipped `40724a34` | **25/25** — no regression from Campaign B |
| MCP OAuth | `track` | **3/3** — metadata and registration answer 404; OAuth deployed but undiscoverable |
| MCP OAuth | `on` (first) | 40/41 — **found a real defect**: read-only grants were still offered write tools |
| MCP OAuth | on shipped `40724a34` | **41/41** — discovery, DCR, consent, PKCE S256, token exchange, MCP access, refresh rotation, reuse detection, revocation, scope enforcement, open-redirect refusal, legacy compatibility |
| Dashboard probe | shipped | `/auth/google/start` → 302 to accounts.google.com; `/health` 200; landing 200; docs 307 |

**Held / not run:** deeper fault injection (forced D1-commit-before-Vectorize
failure, DO eviction mid-advance) stays in the deterministic suite rather than
production probes. No third-party MCP client was driven end to end — see §8.

## 6. Cleanup and residue

Every canary erased its own memory and revoked its own credentials, then the
result was checked **independently** by direct D1 query rather than trusting
the API's self-report:

- `SELECT COUNT(*) FROM conversation_page_sources` → **0**
- `SELECT COUNT(*) FROM oauth_grants WHERE revoked_at IS NULL` → **0**
- `SELECT COUNT(*) FROM oauth_tokens WHERE revoked_at IS NULL` → **0**
- each canary's `/v1/status` → `{nodes:0, pages:0, slices:0, events:0, candidates:0}`

**Residual, unchanged from previous campaigns:** five disposable canary account
shells remain (zero memory, zero live credentials, sessions revoked) because
Itsuki has no self-serve account-erasure route. They are removable via the
admin account-erasure route.

## 7. Packages

**No package was published, and none needed to be.** Neither campaign changed a
wire contract: `conversationId`/`idempotencyKey` already existed on every
surface, and OAuth is a new server-side door that no SDK calls. The JS SDK,
Python SDK, and n8n node are unchanged and their published artifacts remain
correct. Documentation copy changed only.

## 8. What is NOT proven

Stated plainly, because the rest of this report claims a lot:

1. **No third-party MCP client has completed the OAuth flow.** Claude Desktop,
   Claude Code, Cursor, VS Code and every other host are **unverified**. The
   canary is a real MCP client, but one I wrote. Verifying a real host needs a
   human to sign in interactively.
2. **Consent binds to the account's default project.** There is no in-consent
   project chooser; the bound project is displayed and enforced, so nothing is
   mis-scoped, but multi-project users cannot yet pick.
3. **No dashboard UI to review or revoke OAuth connections.** Revocation works
   via RFC 7009 and via membership/lifecycle changes; a user cannot yet see
   their authorized clients in the app.
4. **`delete_all_memories` is fenced at its start, not throughout.** It is a
   multi-pass convergent erasure; a revocation mid-run does not abort a
   destruction the user already confirmed. Single-object deletion is fully
   fenced inside its committing batch.
5. **Conversation Page adoption of legacy rows is deliberately narrow.** A
   conversation spread across several pre-campaign pages is not merged; only an
   unambiguous single-page match adopts an identity. Merging is a product
   decision, not a safe automatic one.
6. **Conversation Pages bound advances at 200 per page** and trim the oldest
   rendered sections past ~24k characters with a visible marker. Nothing is
   silently lost — the full history stays in the page's linked sources — but a
   very long-lived conversation eventually stops advancing its page.
7. n8n Cloud verification and the ChatDev release decision remain open backlog
   items, untouched by this work.

## 9. Defects found and fixed

Nine, across both campaigns. Three were found by the production canaries —
which is what canaries are for.

**Campaign A:** a TOCTOU race on the page-source link insert; a 250 ms re-poll
loop in the page follower; a dropped lane marker that would have
double-announced a failed follower's webhook.

**Campaign B:** OAuth callers could switch projects via a request header,
escaping the consented project; deletion had no commit-time credential fence at
all; `tokenAllowsScope` and the fence SQL disagreed about `memory:*`, so such a
credential passed preflight and then aborted its own mutation (pre-existing);
`state` was silently truncated at 512 characters; consent rows recorded a NULL
session id; read-only connections were still offered the write tools.

Full detail with reasoning in `CONVERSATION_PAGES_REPORT.md` and
`MCP_OAUTH_REPORT.md`.
