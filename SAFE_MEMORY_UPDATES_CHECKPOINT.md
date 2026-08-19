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
- [ ] Baseline suite result: (pending — brj63woil)
- [ ] 0047 migration + checksums + schema census
- [ ] lib/memory_versions.js core + unit tests
- [ ] Writer bumps (write/pass2/mcp_engine/pages/cleanup/retention)
- [ ] Routes + MCP + flag
- [ ] Census/purge/delete/retention/erasure integration
- [ ] SDKs + n8n + UI + docs
- [ ] Adversarial suite
- [ ] Stage A deploy + soak; Stage B deploy
- [ ] Canary (18 proofs) + cleanup + final report
