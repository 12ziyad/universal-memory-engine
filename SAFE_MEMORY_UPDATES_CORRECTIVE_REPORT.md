# Safe memory updates — corrective campaign report

Date: 2026-08-19 · Supersedes `SAFE_MEMORY_UPDATES_REPORT.md` (marked retracted)

## Verdict: **GO for the platform** · **HOLD on two npm publications** (external credential)

Eight release blockers found by independent review were reproduced with failing
tests, fixed, and verified — in the deterministic suite and again against
production with disposable tenants. The Worker, D1 schema, REST/MCP surfaces,
dashboard and Python SDK are corrected and live. Two npm publications remain
externally blocked and are the only outstanding items.

The previous report's GO was **not** trustworthy: its green suite never
interleaved a background writer with a user edit, never exercised MCP's
non-audited commit path, never called `GET` on an event id, never asserted
deletion residue for `deleteLastExtraction`, and asserted vector readiness that
Cloudflare's own asynchronous write model cannot provide.

## Evidence classes used below

| Class | Meaning |
|---|---|
| **PROD** | Proven on itsuki.app with disposable tenants this campaign |
| **TEST** | Deterministic test against real D1 in the Workers pool |
| **SIM** | Tested against a scripted/fake provider (no real third party) |
| **NOT TESTED** | Honestly untested |
| **BLOCKED** | Externally blocked |

## Blocker-by-blocker

### 1. Stale automatic writers could overwrite user edits — FIXED (PROD)

**Was:** six read-modify-write paths incremented `revision` without CASing the
revision they read. A summary/enrichment job that read state at revision N
could commit after a user's edit and overwrite it as N+2.

**Now:** every such writer captures its observed revision and commits with
`AND COALESCE(revision,1) = ?`, treating zero changed rows as stale
(`cleanup.js` summary regeneration and page repair, `retention.js`,
`pass2.js`, `mcp_engine.js` enrichment, `pages.js` merge). A new static census
(`src/lib/mutation_census.js`) parses the source and fails when any UPDATE
assigns an editable column without a revision fence.

Census on the shipped tree: **8 statements checked · 7 fenced · 1 exempt · 0 unfenced.**
The single exemption is `write.js`'s summary recompute, which derives its value
inside the UPDATE from facts committed in the same transaction — there is no
earlier snapshot to be stale against; the reason is recorded in the allowlist.

- TEST: stale writer refused after a user edit; same writer applies when not stale; census clean.
- **PROD (K5/K6):** a user summary written through the door **survived** 45s of real background extraction and enrichment. Final value was the user's text, not the machine's.

### 2. MCP mutations had no commit-time authorization — FIXED (PROD)

**Was:** `applyMemoryChange` only added authorization guards when an audit
intent was supplied. The MCP door supplies none, so a downgrade or revocation
between preflight and commit could still land a write.

**Now:** the function takes an actor identity and appends
`capabilityGuardStatement` to the committing batch on **every** door; a fence
abort is disambiguated into `403 forbidden` (authorization lost) versus
`412`/`409` (concurrency). REST and MCP both pass the identity.

- TEST: a non-owner actor with no membership row is refused and the row is unchanged.
- **PROD (A3–A8):** update succeeds while authorized; after revocation (confirmed by response body) the same credential is refused **401 on read, update, and history**, and the refused write left no trace.

### 3. Events were editable but not readable — FIXED (PROD/TEST)

`GET /v1/memories/event_*` returned 400. Now events return the full object with
`revision` and an ETag, through REST and MCP `get_memory`; the 400 message lists
`event_` as a valid prefix.

- TEST: GET + ETag; read→edit→history→rollback; cross-tenant 404.
- PROD: exercised in the canary where an event existed; in the run corpus no event was extracted, so the production leg for events is **TEST-only** and marked as such. (See limitations.)

### 4. Deletion paths left revision residue — FIXED (TEST) / exports corrected

`deleteLastExtraction` removed objects but not `memory_revisions`,
`memory_update_idempotency` or `memory_projection_state`. Residue removal is now
in the same D1 batch as the deletion. Portability exports now include revision
history **for live objects only**, with an explicit `history_truncated` notice
at the export bound rather than silent omission.

- TEST: delete-last-extraction leaves zero rows in all three tables; export contains history; export of a deleted object's history is absent.
- PROD: object deletion + history 404 proven during cleanup (below).

### 5. Idempotency fingerprint was computed pre-normalization — FIXED (PROD)

**Was:** the fingerprint hashed the raw request before validation, so reordered
keys or padded whitespace produced a different identity (spurious conflict), and
`reason` was excluded (distinct operations collided). The no-op path used an
unchecked `ON CONFLICT DO NOTHING` outside the guarded transaction.

**Now:** the fingerprint is computed **after** validation and canonical
normalization (recursively sorted keys, NFC, trimmed) over tenant, kind, object,
action, precondition, payload and reason. The no-op path claims the key inside
the same fenced batch as every other write.

- TEST: normalized replay; differing reason conflicts; no-op storm claims once; no-op on an archived object is refused rather than claimed.
- **PROD (K3/K4):** reordered-key + whitespace + Unicode replay returned the original result with `replayed: true`; the same fields with a different reason returned `409`.

### 6. Projection state was untruthful and order-unsafe — FIXED (PROD)

**Was:** `ready` was recorded immediately after enqueueing a Vectorize upsert.
Cloudflare documents inserts as asynchronous (a mutation id now, an async job
makes it queryable), so "ready" was an unverified claim. `upsertNodeVector`
swallowed provider errors, `markProjection` did not CAS, and FTS warnings did
not block readiness.

**Now:**
- Vector ids are revision-qualified (`<objectId>#r<N>`), so a delayed writer can only touch its own revision — a late r2 write cannot clobber r3.
- States are `pending → submitted → ready`, and `ready` requires a **provider readback** (`getByIds`).
- Provider failure, missing embedding, or FTS failure record `failed`; never `ready`.
- `markProjectionApplied` CASes the canonical head and refuses to move `applied_revision` backwards.
- `queryNodeVectors` resolves hits back to object ids and **drops non-head revisions**, so a stale vector cannot outrank or resurface stale content. Legacy unversioned ids are accepted as head (what they were under the old scheme) and replaced on next projection.
- Stale-revision vectors are deleted after a successful readback.

- TEST: provider failure → not ready; stale r2 worker cannot mark r3 ready; FTS failure blocks ready; head-vector id predicate.
- **PROD (K11/K12 + follow-up):** state was honestly `submitted` while unverified, and the cron sweep later promoted it to `ready` at `applied_revision 6` matching the head. Recall served the corrected value throughout (K13).
- SIM: reordered/delayed provider completion is exercised with a scripted provider, not against live Vectorize timing.

### 7. Schema invariant and history-retention claim — FIXED (PROD)

Migration **0048** replaces the global `(object_id, revision)` unique index with
`(user_id, object_kind, object_id, revision)`, created before the old one is
dropped so uniqueness is never unenforced. 0047 was not edited.

The "bounded history" claim was false — only page size was bounded. Rather than
prune revisions a customer was told are rollbackable, the truth is now stated
and measured: history is retained until the object is deleted, purged,
retention-expired, or the account is erased. `GET …/history` returns
`total_revisions` and `retention: "retained_until_object_deleted"`; the docs say
the same.

- PROD: applied via Wrangler (bookmark `000014cb-00000000-000050cc-cb7e4a98f155f6c84f6ef4defc225b13` taken first); history responses carry the new fields.

### 8. Package and surface truth — PARTLY FIXED, two HOLDs

| Artifact | Was | Now |
|---|---|---|
| JS SDK | package.json 0.3.0, `VERSION = "0.2.1"` | both 0.3.0; user-agent derives from `VERSION` |
| Python SDK | **published 0.4.0 reports `VERSION = "0.3.0"`** | corrected to 0.4.1 (0.4.0 is immutable on PyPI) |
| Tests | pinned literals that enshrined the mismatch | both suites assert **agreement** with packaging metadata |
| n8n | description-only tests | 8 execute-level tests driving the real branches |
| Dashboard | markup assertions only | 11 behaviour tests (draft preservation on 412, load-latest rebase, bounded history paging, stale-selection discard, escaping) |

The Python publish gate caught a **second** hardcoded pin (`test_client.py`)
that I had missed — recorded here because it is exactly the failure mode this
campaign exists to correct.

## Test results (final tree)

| Suite | Result |
|---|---|
| Workers pool (full) | **151 files / 1,973 tests green** |
| Unit config | **35 files / 602 passed, 1 intentional skip** |
| Corrective regressions (`memory_updates_corrections.spec.js`) | 20 — each written failing first |
| Dashboard UI behaviour (`memory_updates_ui.spec.js`) | 11 |
| Python SDK | 154 |
| n8n package | 52 |
| Migration append-only + schema census | 9 |

## Deployment record

| Stage | Version | Purpose |
|---|---|---|
| Safety | `cc3bf740-c21a-4993-9dc4-5cfa14980ee0` | Doors **disabled** the moment blockers reproduced; tracking kept live |
| Corrected, track | `a6a50047-57ac-4a77-93c0-4df4203eb793` | Corrected tree soaked with doors closed — 8/8 |
| Corrected, doors on | `2e16c08d-943e-4b91-8eac-d0894b5c8b86` | Current |

Migration 0048 applied via Wrangler after a Time Travel bookmark. Rollback
target is this same tree with `SAFE_MEMORY_UPDATES="track"` — trackers keep
running under rollback, so no unversioned-mutation window can open.

Commits: `fa1d8e8` (safety) → `7a97393` (all eight fixes) → `0b3a6cd` →
`4fbb243` (doors on) → `b5b0774` (version truth + retraction).

## Production canary results

Track soak 8/8 · corrective canary 11/12 · authorization canary 9/9.

The single canary failure (K14) was a **defect in my canary script**, not the
product: it posted to `/auth/tokens//revoke` with an empty id, which answers
`200 {"revoked": false}`, and the script read the 200 as success. Re-run
asserting the response body: revocation confirmed and the credential refused
401 on read, update and history (A4–A8). Recorded rather than quietly fixed
because a canary that misreads its own evidence is the same class of error as
the report this campaign is correcting.

## Cleanup

All disposable fixtures purged through the production lifecycle API; edited
objects verified gone with their history (404 on both object and history);
credentials revoked; sessions closed. Residual: content-free account shells
(no self-serve account erasure exists; admin-removable), consistent with prior
campaigns.

## Honest limitations

1. **npm publications — BLOCKED (external).** `itsuki@0.3.0` and
   `n8n-nodes-itsuki@0.2.0` fail at `ENEEDAUTH` after all gates pass; npm
   Trusted Publishing is not configured for either package. Registry state
   confirmed this session: npm still serves `itsuki@0.2.1` and
   `n8n-nodes-itsuki@0.1.0`. No surface advertises the unpublished versions.
   Owner action: configure the Trusted Publisher for both, then re-dispatch
   `publish-js-sdk.yml` and `publish-n8n-node.yml`.
2. **Event production leg — TEST only.** The canary corpus produced no event, so
   event GET/edit/history/rollback is proven deterministically and in the track
   soak's read path, not through a full production edit cycle.
3. **Vectorize reordering — SIM.** Delayed/reordered provider completion is
   exercised with a scripted provider. Real convergence was observed in
   production (`submitted → ready` at the correct revision), but deliberately
   reordering live Vectorize mutations is not something this campaign forced.
4. **MCP commit-time race — TEST.** The downgrade-between-preflight-and-commit
   race is proven deterministically; production evidence covers the revocation
   case end to end.
5. **History storage is unbounded** by design until object deletion. This is now
   stated and measured (`total_revisions`), not pruned. Growth monitoring is a
   follow-up, not a shipped alert.
6. **Dashboard browser canary** was not re-run against the live corrected build
   this campaign; UI behaviour is covered by 11 deterministic tests plus the
   earlier live UI verification. Marked TEST, not PROD.
