# Conversation Pages — Campaign A final report

**Verdict: GO.** Implemented, tested, migrated, deployed in two stages, and
production-canaried on live doors. Evidence below; anything not proven is
labelled as such.

Date: 2026-08-21. Baseline commit `12cc980`, production Worker version before
this campaign `0afd4dae-1521-439d-a779-5b5a425ecace`.

---

## 1. What changed, in product terms

A conversation now has ONE page.

- Pass a stable `conversationId` (or `threadId`) to MCP `save_conversation` or
  `POST /v1/save` with `mode:"conversation"` (JS `addConversation`, Python
  `add_conversation`, n8n Save Conversation) and every later explicit save of
  that conversation **advances the same page as a forward revision** instead of
  creating a duplicate.
- Within one account and project at most one live page owns a given
  conversation. This is a **database uniqueness guarantee**
  (`idx_memory_pages_conversation_identity`), not best-effort matching, so
  concurrent saves converge instead of forking.
- The **REST conversation door now builds pages too**. Before this campaign
  only the MCP door produced a page; SDK and n8n conversation saves produced
  graph memories alone.
- **Automatic capture still creates zero pages** (`/v1/turn`, `/v1/ingest`,
  hooks/plugin capture, playground) and `save_memory` still creates zero pages.
- **"Never build pages" now means it**: with `captureDefault: "graph_only"` an
  explicit conversation save extracts facts and relationships and writes no
  page, and the receipt names the reason.
- **User-authored text is never reverted by an advance.** If a user edited a
  page's wording, a later save of that conversation adds its memories and
  leaves the wording alone, recording `page_text_kept_user_authored`.
- **One name.** "Notes", "notes page", "memory page", "capture pages",
  "organized pages" are gone from the docs and dashboard; the object is a
  **Conversation page**.
- The deprecated whole-chat digest lane is retired from the public API.
  `scope:"summary"` is now an ordinary conversation save. It survives only
  behind its explicit test hook.

## 2. Architecture

- **Identity**: `memory_pages.conversation_key` (canonical id = explicit
  `conversationId`, else `threadId`, else NULL). NULL means "no stable
  identity supplied" — each explicit batch then legitimately keeps its own
  page, and exact retries still replay safely through packet idempotency.
- **Convergence authority**: the partial unique index over
  `(user_id, COALESCE(project_id,''), conversation_key) WHERE conversation_key
  IS NOT NULL AND deleted_at IS NULL`. Code treats a constraint loss as
  "someone else created it — re-read and advance", never as an error to
  surface.
- **Advance = forward revision** through the existing safe-update machinery:
  fenced revision CAS at staging and at finalize, `userAuthoredSummaryFence` on
  the body, bounded markdown with oldest-advance trimming and a truthful trim
  marker (never silent tail loss).
- **Provenance by link, not copy**: `conversation_page_sources` records one row
  per accepted batch (ids only; the packet remains the content authority).
- **REST lane**: the accepted ingest save is followed by a `page_follow` job
  that waits for that batch's durable extraction verdict and finalizes the page
  from the run manifests. **No second model call, no duplicate charge.** A page
  problem never fails the accepted save; it is reported on the response and the
  job row.
- **Flag**: `CONVERSATION_PAGES` = `track` (schema + links live, behavior
  unchanged — the rollback target) or `on` (identity + REST pages).

## 3. Deletion, lifecycle, retention

- Deleting a page removes its content, revision history, idempotency and
  projection residue, search rows, **and its source links**, and suppresses the
  conversation identity (`memory_suppressions` kind `conversation_page`) so a
  re-save cannot silently re-materialize it.
- **Source-scoped deletion honours independent support**: a page whose linked
  packets are all in scope is deleted; a page that keeps out-of-scope sources
  is **rebuilt from the survivors** (and its revision history erased, because
  old snapshots may quote the deleted source). A page left with no surviving
  content is deleted outright.
- `conversation_page_sources` is registered in `PURGE_SPACE_TABLES` and
  `CENSUS` (`schema_census.spec.js` enforces registration), in account
  erasure, project delete, and retention (`semantic_memory` target, sweeping
  links before the pages they name).

## 4. Migration

`migrations/0050_conversation_pages.sql` — additive only:
`memory_pages.conversation_key`, `memory_pages.message_count`, the partial
unique identity index, `conversation_page_sources` + two indexes.

- Registered via `node scripts/update-migration-checksums.mjs` (append-only
  hash ledger; `migrations_append_only.spec.js` enforces it). No existing
  migration was edited.
- **Compatible with the previous Worker version**: new columns are nullable and
  unread by the old code; the unique index only constrains rows that carry a
  non-NULL `conversation_key`, which only the new code writes.
- **Legacy rows are left truthful**: production has **0** pages with a
  non-NULL `conversation_key` after the migration — nothing was invented.
  Identity is adopted onto a legacy page only when exactly one live page in
  scope carries the same `source_conversation_id` (evidence-based, CAS-guarded,
  race-settled by the index). That same path covers rows created between
  migration apply and code deploy.

## 5. Defects found and fixed during the campaign

1. **Link insert had a TOCTOU race.** `WHERE NOT EXISTS` let two concurrent
   exact retries both pass the check and collide on the primary key (surfaced
   by `mcp_engine.spec.js` concurrency tests). Now `INSERT OR IGNORE` — the
   primary key is the authority.
2. **Page-follower re-polled every 250 ms.** The Durable Object's in-progress
   branch leaves `runAfter` at 0, so a follower waiting on an extraction would
   have hammered D1 for the whole wait. Followers now pass a bounded backoff
   hint the DO honours; waiting still does not count as failure, and the
   follower carries its own 15-minute deadline.
3. **Terminal failure dropped the follower's lane marker.**
   `markMcpEnrichmentFailed` replaced the payload, which would have let a
   failed follower re-announce a batch the ingest lane already announced
   (double webhook). The lane marker now survives terminal failure.

## 6. Tests

New: `conversation_pages.spec.js` (5), `conversation_pages_matrix.spec.js` (8),
`conversation_pages_failures.spec.js` (5), `conversation_pages_flag.spec.js`
(4), `conversation_pages_naming.spec.js` (12).

Coverage against the mandated matrix:

| # | Requirement | Where |
|---|---|---|
| 1 | 100-scale automatic capture → structured memories, zero pages | matrix (12 `/v1/turn` + ingest + save_memory) + production canary (8 turns) |
| 2 | One explicit save → exactly one page | conversation_pages, canary |
| 3 | Same conversation id advances the same page, forward revision | conversation_pages, canary |
| 4 | Exact replay returns the original outcome | failures, matrix, canary |
| 5 | Same key / different payload conflicts | canary (409 `idempotency_conflict`) |
| 6 | Concurrent same-conversation storm converges | matrix (3-way `Promise.all` → 1 page, 3 links) |
| 7 | Same words in different conversations stay distinct | conversation_pages, canary |
| 8 | `save_memory` creates no page | matrix, canary |
| 9 | Overlapping doors sharing operation identity don't double-submit | matrix replay + canary replay |
| 10 | DO/D1/AI/projection failure and retry don't duplicate | failures (llm_failed create + advance), mcp_engine suite |
| 11 | Order, roles, oversized input, duplicate/missing ids deterministic | pre-existing ingest/MCP contracts + `appendAdvanceSection` bounds |
| 12 | Project/account isolation, forged ids fail | matrix (project isolation), pre-existing sub-tenancy suites |
| 13 | Archive/delete/retention/purge/erasure leave zero residue | matrix (suppression), srv/cleanup/retention/lifecycle suites, canary + direct D1 scan |
| 14 | A fact with independent support survives one page's deletion | `srv_source_scoped_deletion.spec.js` + rebuild path |
| 15 | UI/docs/SDK/n8n vocabulary consistent, no dead commands | naming spec, `get_started`, `docs_connect_tool` |
| 16 | Existing suites stay green | full run below |

**Full suite on the shipped tree (uninterrupted):**

```
npx vitest run --no-file-parallelism
 Test Files  158 passed (158)
      Tests  2021 passed (2021)
   Duration  1136.51s
```

```
npx vitest run --config vitest.unit.config.mjs
 Test Files  36 passed (36)
      Tests  616 passed | 1 skipped (617)
```

Not proven by these tests: real n8n Cloud host execution and real third-party
MCP host behaviour beyond the canary's own MCP client — unchanged from before
this campaign, since the wire contract did not change.

## 7. Release

| Step | Evidence |
|---|---|
| Account / Worker | `b6009ce8df89884b79e4f6fa49e52942`, Worker `uml`, itsuki.app |
| D1 | `uml-memory` `3202df08-e568-4e53-a8cd-a85630db50f8` |
| Dry run | `wrangler deploy --dry-run` clean, `CONVERSATION_PAGES ("track")` |
| **Time Travel bookmark (pre-migration)** | `000016ae-00000000-000050cd-50b55a83fefd1b71918303373e4ef046` |
| Migration | `0050_conversation_pages.sql` applied remotely, 7 commands, ✅; table + 3 indexes verified by `sqlite_master` read-back |
| Stage A (`track`) | version `b2e07090-04ed-4d34-8633-9e0b09f67880` |
| Stage A canary | **23/23 PASS** — legacy behaviour preserved (grown re-send → 2 pages, REST creates no page) |
| Stage B (`on`) | version `784cc865-b553-4583-9e6c-e3a3e92912d8` |
| Stage B canary | **25/25 PASS** — convergence, advance, replay, conflict, distinctness, zero pages from automatic capture, REST create + advance, delete |
| Rollback | flip `CONVERSATION_PAGES` to `track` and redeploy; previous Worker version is the hard rollback; the D1 bookmark covers the schema |

**Canary honesty labels.** Both canaries ran against **live itsuki.app** with
disposable accounts and disposable content — no real customer memory. Every
check above is a real production call, not a simulation. The deeper
fault-injection legs (forced D1-commit-before-Vectorize failure, DO eviction
mid-advance) are covered by the deterministic suite, not by production probes.

**Cleanup.** Both canary accounts erased their own memory
(`DELETE /v1/memories?confirm=true`), reported `{nodes:0, pages:0, slices:0,
events:0, candidates:0}`, and revoked every credential. Independently verified
by direct D1 read: `SELECT COUNT(*) FROM conversation_page_sources` = **0**
across the whole production database. Two empty account shells remain (zero
memory, zero credentials) because no self-serve account-erasure route exists —
the same known residual as previous campaigns; removable via the admin
account-erasure route.

## 8. Packages

No package was published. The wire contract did not change —
`conversationId`/`idempotencyKey` already existed on every surface — so the JS
SDK, Python SDK, and n8n node are unchanged and their published artifacts stay
correct. Documentation copy changed only.

## 9. Remaining risks

- **Adoption of legacy pages is deliberately narrow.** A conversation whose
  history is spread over several pre-campaign pages will not be merged; only an
  unambiguous single-page match adopts an identity. Merging is a product
  decision, not a safe automatic one.
- **Advance limit is 200 linked batches per page.** Past it the save still
  stores memories and the receipt says the page was skipped. No silent
  truncation, but a very long-lived conversation will eventually stop advancing
  its page.
- **Markdown trimming** drops oldest advance sections past ~24k characters with
  a visible marker; full history stays reachable through the page's linked
  sources.
