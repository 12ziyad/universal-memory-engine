# Safe Memory Updates — campaign checkpoint

Campaign: explicit update + immutable history + rollback (backlog item 2).
Started 2026-08-19 on commit `0f658d9` (clean tree). Deployed Worker at start: `de38637f-58f1-4432-9ea6-6091b761e1aa`. Next migration: 0047.

## Phase 0 findings (COMPLETE)

- Kinds are prefix-dispatched ids: node_/page_/slice_/event_/cand… Nodes+pages are the inventory list; slices/events reachable via workspace + delete door. Edges surface only as "connections".
- Semantic-writer census (files:lines audited 2026-08-19):
  - write.js: node state (419), aliases (493/516), slice supersede is_current (560), summary rewrites (1410/1467); inserts for slices/events/edges; reinforcement/touch bumps = operational.
  - pass2.js: node summary+cluster (262), slice supersede (284).
  - mcp_engine.js: page enrich content (1208), page delete (1170), enrich_status (1023 = operational).
  - pages.js: page content write (676), receipt link (668/824 = operational).
  - cleanup.js: summary rewrite (373), archive/delete state transitions (operational-lifecycle).
  - retention.js: node summary rewrite (1232).
  - clusters.js: cluster assignment (195/213) = operational (presentation grouping).
  - candidates.js: review status (87) = suggestion lifecycle, not memory content.
- FTS: manual_search_profiles + FTS5 triggers; `refreshManualSearchProfiles(env, config, userId, {nodeIds,pageIds})` re-derives synchronously in D1. Slice text feeds node profiles.
- Vectorize: one vector per node, id = nodeId, namespace = userId, best-effort (lib/vectorize.js). No versioning today.
- RBAC: project.memory.read (viewer+), project.memory.write (member+), project.memory.delete (admin). Scopes memory:read/memory:write intersect via requireMemoryUser.
- Audit: runContextAuditedMutation + managedMemoryAuditContext for key flows; content-free discipline enforced repo-wide.
- Census: lifecycle_census.js PURGE_SPACE_TABLES + schema_census.spec.js force new-table classification.
- manual_page_versions = internal page CAS only (manual_revision), NOT customer history. Unchanged by this campaign.
- Baseline full suite: running (brj63woil) — record result below before any commit.

## FROZEN ARCHITECTURE (Phase 1)

### Kind matrix

| Kind | Explicit update | Editable fields | Notes |
|---|---|---|---|
| node | YES | label, category, summary | state/cluster/aliases = system-owned; label edit re-derives FTS profile + re-embed |
| page | YES | title, short_summary, full_markdown (≤20k) | canonical_title (identity) untouched; enrich = system writer |
| slice | YES | text, kind (fixed label set) | superseded (is_current=0) → unsupported_state; edit re-derives parent node FTS |
| event | YES | text, importance, happened_at (+happened_at_source='user' on edit) | |
| edge | NO — `unsupported_kind` | — | corrections via extraction supersession only |
| candidate | NO — `unsupported_kind` | — | suggestions review door owns it |
| archived object | NO — `unsupported_state` (object_archived) | — | restore first |
| deleted object | 404 not_found (no tenant leakage) | — | |

### Versioning core

- New column `revision INTEGER` on nodes, memory_pages, slices, events. NULL ≡ 1 (pre-feature baseline). CAS: `WHERE COALESCE(revision,1) = ?`.
- System writers that change semantic fields add `revision = COALESCE(revision,1) + 1` (participation, no per-change history row — deliberate classification, volume-safe). Operational writers (reinforcement, last_seen, heat, cluster, enrich_status, receipt links) never bump.
- History rows (`memory_revisions`): actions `baseline` | `system` | `update` | `rollback`. Baseline captured lazily at first explicit interaction; accumulated system drift since last recorded row is captured as one labeled `system` snapshot before an explicit action applies. Never invents authors/timestamps: baseline/system rows carry actor_class='system', captured_at = now, and are labeled captured.
- Snapshot = editable fields only (JSON, canonical key order), content_hash = SHA-256.
- `memory_update_idempotency`: UNIQUE(user_id, idem_key); stores request_hash + object_id + result revision + bounded result JSON (content-bearing → erasable).
- `memory_projection_state`: (user_id, object_id, projection) → applied_revision, status pending|ready|failed, attempts, updated_at. Client-visible convergence truth.
- All three tables → PURGE_SPACE_TABLES (memory_space kind) + single-object delete residue + retention + erasure + residual scans.

### API contract (frozen)

- `GET /v1/memories/:id` gains `revision` + strong ETag `"r<revision>"`.
- `PATCH /v1/memories/:id` — body {fields…, reason?, idempotencyKey, expectedRevision?}; `If-Match: "rN"` required (or expectedRevision for non-HTTP; both present must agree → else 400 precondition_mismatch). Missing → 428 precondition_required. Stale → 412 stale_revision (with current_revision). `If-Match: *` → 400 wildcard_rejected.
- `GET /v1/memories/:id/history?cursor&limit≤50` — keyset desc, bounded; includes projection state.
- `POST /v1/memories/:id/rollback` — {toRevision, reason?, idempotencyKey} + If-Match current head. Creates revision N+1 from retained snapshot; refuses missing/erased snapshot revisions (`revision_unavailable`).
- Auth: session or Bearer; scope memory:write + capability project.memory.write (update/rollback); memory:read + project.memory.read (history). Fresh membership re-checked inside the transaction path (requireMemoryUser resolves fresh every call; lifecycle state + epoch re-verified in the mutation).
- Rate: SAVE_LIMITER bucket for update/rollback; READ for history.
- Errors (machine-readable `error` codes): not_found, unsupported_kind, unsupported_state, object_archived, invalid_content, invalid_field, precondition_required, stale_revision, precondition_mismatch, wildcard_rejected, idempotency_conflict, project_archived (lifecycle codes pass through), feature_disabled, forbidden, unauthorized.
- Feature flag: env SAFE_MEMORY_UPDATES — "track" (Stage A: bumps+schema live, doors 404 feature_disabled) | "on" (Stage B). MCP tools registered only when on + connection has the needed scope.

### Projection protocol (Phase 4)

- FTS: synchronous re-derive via refreshManualSearchProfiles in the update path (D1, same request); projection_state.search = ready on success, pending + cron repair on failure.
- Vector (nodes only): async job — compute embedding from CURRENT D1 head, upsert (stable id nodeId), then RE-READ head; if head advanced, recompute from the new current row and upsert again (bounded ×3), else mark pending for cron sweep. Convergent under any completion order because every pass ends with recheck-against-truth; compensating deletes only ever target the per-node id on node deletion. Recall already treats vectors as pointers (returnMetadata:"none", content loaded from D1) — stale embedding can only mis-rank, never surface stale content; test pins this.
- Source expansion: current values come from D1 rows; expanded episodes are labeled source excerpts. Adversarial test: correct a value, prove recall context presents the corrected value as current and the old episode text only as source/history, never as the current fact.

### Surfaces (Phase 5-6)

REST (above); MCP tools update_memory/memory_history/rollback_memory (11 tools total — docs + pinned tests updated); JS SDK 0.3.0 updateMemory/memoryHistory/rollbackMemory; Python SDK 0.4.0 update_memory/memory_history/rollback_memory (sync + async if async client exists — verify); n8n-nodes-itsuki 0.2.0 Update Memory/Memory History/Rollback Memory; Memories UI: Edit + History tab + restore, 412 draft-preserving conflict UX.

### Stage plan (Phase 8)

- Stage A: migration 0047 + revision bumps + core library + doors compiled but flag="track" → deploy, soak, verify no unversioned semantic mutation (probe: automatic save bumps revision).
- Stage B: flag="on" in wrangler.jsonc + deploy same tree. Rollback target for B = same version with flag "track" (fence preserved: trackers keep running under rollback).

## Progress log

- [x] Phase 0 audit + mutation census + architecture freeze
- [x] Baseline full suite: 147 files / 1,907 tests green (pre-change)
- [x] 0047 migration + checksums registered + schema census green (6)
- [x] lib/memory_versions.js core (fence-guarded CAS batch, lazy baseline, rollback-as-forward, idempotency claims, projection convergence + sweep)
- [x] Writer bumps ×12 (write.js ×6 incl. manual page CAS lane, pass2 ×2, mcp_engine, pages, cleanup, retention)
- [x] Erasure integration: single-object delete (incl. node cascade), delete-all, bulk residue tables, retention auxiliary deletes, PURGE_SPACE_TABLES ×3
- [x] REST doors (PATCH/history/rollback; If-Match 428/412/wildcard-reject; content-free audit w/ new allowlisted keys) behind SAFE_MEMORY_UPDATES
- [x] MCP tools ×3, conditionally advertised by effective scopes; server-side flag in workspace counts
- [x] JS SDK 0.3.0, Python SDK 0.4.0 (sync+async), n8n 0.2.0 (3 ops + contract tests 44 green)
- [x] Memories UI: Edit dialog (draft-preserving 412 conflict + load-latest rebase), History tab + restore, revision/editable on workspace details
- [x] Docs: REST rows, MCP page (eleven tools), SDK method tables; docs contract tests updated + green
- [x] Adversarial suites: memory_updates.spec.js (30) + memory_updates_rbac.spec.js (5) — CAS races, same-key storms, replay-after-advance, foreign-revision refusal, Unicode NFC, control-char strip, oversize refusal, recall/list/FTS freshness, RBAC/tenancy/revocation/archived-project, MCP advertisement + round trip, erasure residue = zero
- [x] Unit config suite: 35 files, 602 passed + 1 intentional skip; migration gates green
- [x] wrangler.jsonc SAFE_MEMORY_UPDATES="track" (Stage A ready)
- [x] Full Workers suites: first run caught the stale eight-tools pin (fixed → eleven); FRESH UNINTERRUPTED RELEASE RUN: **149 files / 1,942 tests green** on final tree `f498f82`.
- [x] Stage A SHIPPED: bookmark `000014ad-00000000-000050cc-e5ff90136c248269915f7e70d59d1855`; migration 0047 applied via Wrangler (✅ once; account b6009ce8…2942, D1 3202df08-e568-4e53-a8cd-a85630db50f8); deploy `72aba5ec-6601-45ff-885f-7106dbc33522` flag "track". Soak: health 200; PATCH + history → feature_disabled; production extraction bumped a probe node to revision 3 (automatic writers version-tracking LIVE); probe space wiped via delete-all + logout.
- [x] Stage B SHIPPED: commit `f36fe75`, deploy `b9bdadd7-8017-4472-95ef-b247cfb3df02` flag "on". Rollback target = Stage A version (trackers keep running under rollback; no unversioned window).
- [x] Publishing: PyPI itsuki 0.4.0 PUBLISHED (trusted publishing + attestations; clean-installed; all six methods). npm itsuki 0.3.0 + n8n-nodes-itsuki 0.2.0 → **HOLD (owner)**: every gate passes, publish fails ENEEDAUTH (npm Trusted Publisher not configured / token revoked). JS version gate deliberately bumped to 0.3.0 (`7534d61`).
- [x] Canary: main battery + repair leg — all proofs PASS (initial C16/C17 "failures" were the canary racing the archive run; the lifecycle fence behaved correctly). SDK legs: JS 5/5 (repo 0.3.0), Python 5/5 (published 0.4.0, sync+async). ETag surfaces weak via Cloudflare encoding — accepted by If-Match, documented.
- [x] Cleanup: canary project purged to zero content (4 content-free replay-fence packets minimized by design) then terminal `deleted`; tokens revoked/destroyed; sessions closed on both accounts + soak account. Residue: content-free account shells only (admin-removable).
- [x] Final Stage B worker `593392de-1e88-4c76-ac8a-7c208d58c1a0` (docs truth fixes). Report: SAFE_MEMORY_UPDATES_REPORT.md. Backlog item 2 updated.

## CAMPAIGN COMPLETE — GO with two named npm publication HOLDs (owner action)

### Deliberate classifications (frozen)

- Automatic writers participate via revision bumps; they do not append per-change history rows. Accumulated drift is captured as ONE labeled `system` snapshot when explicit history next needs the chain; pre-history drift becomes the captured baseline. Nothing invents r1 content, authors, or timestamps.
- Operational-only (no bump): reinforcement counts, last_seen, heat, cluster assignment, enrich_status, receipt links, summary_sources_json provenance.
- Vector ordering protocol: per-node stable vector id + recompute-from-current-head with post-upsert head recheck (bounded ×3) + cron sweep from truth; recall treats vectors as pointers (returnMetadata none) and loads content from D1, so a stale embedding can only mis-rank, never surface stale content. Vectorize reversed-completion is therefore convergent by construction; exercised in tests at the protocol level (USE_VECTORS off in the pool; the guarded upsert path is identical code).
- History read authorization: project.memory.read (viewer+) — a role that could read the value when current may read it as history. Update/rollback: project.memory.write. Deletion of history rides the object's delete permission.
