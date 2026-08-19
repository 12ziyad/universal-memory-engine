# Safe memory updates — final campaign report

> **⚠ SUPERSEDED AND PARTLY RETRACTED (2026-08-19).**
> An independent review found eight release blockers this report did not
> cover, and several of its claims below were **false**. The corrective
> campaign is documented in `SAFE_MEMORY_UPDATES_CORRECTIVE_REPORT.md`, which
> supersedes this file. Specifically retracted:
>
> - "every deletion path erases history" — `deleteLastExtraction` did not.
> - "a stale writer that lost the race cannot overwrite" — six writers bumped
>   `revision` without CASing the revision they read, so a late background job
>   could overwrite a newer user edit.
> - "commit batch re-checks capability" for MCP — the non-audited path
>   (which MCP used) added no capability guard at all.
> - "convergent under any provider completion order" / vector `ready` — the
>   projection was marked ready on enqueue, before Vectorize made it queryable.
> - "events … editable" without noting that `GET /v1/memories/event_*` returned
>   400, so events were editable but not readable.
> - "bounded history" — only the API page size was bounded; stored history was
>   never pruned and the report implied otherwise.
> - Package versions: the published PyPI `itsuki` 0.4.0 reported
>   `VERSION = "0.3.0"`, and the JS SDK claimed 0.3.0 while exporting "0.2.1".
>
> The route-by-route evidence below remains accurate for what it actually
> tested; it simply did not test the paths above.

Date: 2026-08-19 · Verdict: **GO, with two named npm-publication HOLDs (owner action)**

Explicit update, bounded immutable history, and rollback-as-forward-revision are live in production for every supported memory kind, behind exact optimistic concurrency, with history erased by every deletion path. All platform surfaces (REST, MCP, dashboard UI, Python SDK) are shipped and production-canaried. The JS SDK and n8n package releases are built, gated, and tested but cannot reach npm until the owner configures npm Trusted Publishing (or a new token) — every publish attempt fails at `ENEEDAUTH` after all gates pass.

## Supported kinds and editable fields (frozen)

| Kind | Editable | Refusals |
|---|---|---|
| node | label, category (enum), summary | — |
| page | title, short_summary, full_markdown (≤20k) | canonical_title (identity) never edited |
| slice | text, kind (enum) | superseded → `unsupported_state` |
| event | text, importance (enum), happened_at (sets happened_at_source='user') | — |
| edge / candidate | — | `unsupported_kind` (422); suggestions door owns candidates |
| archived / suppressed / deleted | — | `object_archived` (409) / `unsupported_state` (409) / 404 |

## API contract (live)

- `GET /v1/memories/:id` → `revision` + revision ETag `"rN"` (surfaces as `W/"rN"` through Cloudflare content-encoding; If-Match accepts both forms).
- `PATCH /v1/memories/:id` — fields + required `idempotencyKey` (8–120) + precondition: `If-Match: "rN"` or body `expectedRevision` (both → must agree, else 400 `precondition_mismatch`). Missing → 428 `precondition_required`; `*` → 400 `wildcard_rejected`; stale → 412 `stale_revision` + `current_revision`. No last-write-wins path exists.
- `GET /v1/memories/:id/history` — keyset desc by revision, limit ≤50, snapshots + content hashes + projection convergence state.
- `POST /v1/memories/:id/rollback` — `toRevision` + current `expectedRevision`; creates revision N+1 from the retained snapshot; refuses missing/erased snapshots (`revision_unavailable`); never rewinds.
- Idempotency ≠ concurrency: same key + identical op replays the original result even after the head advances or the object archives; same key + different op → 409 `idempotency_conflict`; storms mutate exactly once (D1 PK aborts the batch); claims die with the object so replay-after-erasure answers 404, never erased content.
- Error codes: not_found, unsupported_kind, unsupported_state, object_archived, invalid_content, invalid_field, invalid_idempotency_key, invalid_cursor, precondition_required, precondition_mismatch, wildcard_rejected, stale_revision, idempotency_conflict, revision_unavailable, project_archived, project_state_changed, feature_disabled, forbidden/unauthorized (auth layer).

## Authorization matrix (enforced server-side, re-fenced at commit)

- Update / rollback: scope `memory:write` ∩ fresh `project.memory.write` (admin/member). Viewer → 403 with the capability named.
- History read: `memory:read` ∩ `project.memory.read` (viewer+) — deliberate: a role that could read the value when current may read it as history.
- History deletion: rides the object's delete/purge/retention/erasure paths (admin-gated where those are).
- MCP: update tools advertised only when effective scopes (declared ∩ current role) permit; read-only connections never see them. Commit batch re-checks capability, project `status='active'`, the lifecycle epoch captured at accept, and the deletion barrier via fence_guard.

## Schema and migration

- `0047_memory_revisions.sql` (additive; applied once via Wrangler; D1 `3202df08-e568-4e53-a8cd-a85630db50f8`; pre-apply Time Travel bookmark `000014ad-00000000-000050cc-e5ff90136c248269915f7e70d59d1855`): `revision` on nodes/memory_pages/slices/events (NULL≡1 captured baseline); `memory_revisions` (UNIQUE(object_id, revision)); `memory_update_idempotency`; `memory_projection_state`. All three registered in PURGE_SPACE_TABLES + schema census + bulk/residue/retention deletes.

## Mutation-path coverage

12 semantic writers bump `revision` in-statement (write.js: node state, aliases ×2, slice supersession, summary rewrite, manual-page CAS lane; pass2.js: summary+cluster, slice rollup; mcp_engine.js page enrich; pages.js page write; cleanup.js + retention.js summary regeneration). Operational-only (no bump, documented): reinforcement/last_seen/heat, cluster assignment, enrich_status, receipt links, summary provenance. History records `baseline`/`system` captures lazily and never invents pre-feature content, authors, or timestamps. A stale writer that lost the race cannot overwrite: explicit CAS + fences abort the batch; system writers moving the revision surface as 412 to editors.

## Projection guarantees

- FTS (manual_search_profiles + triggers): re-derived from the current row post-commit; `memory_projection_state` pending→ready with applied_revision; cron sweep (5-min schedule) repairs pending/failed from CURRENT truth. Canary-proven: corrected label present, stale label absent.
- Vectors: per-node stable id; every projection pass recomputes the embedding from the current D1 head and re-reads the head after upsert (bounded ×3, then sweep) — convergent under any provider completion order; compensating deletes only target a deleted node's own id. Recall uses vectors as pointers only (`returnMetadata: "none"`, content loaded from live D1 rows), so a stale embedding can only mis-rank, never resurface stale content. Clients see truthful accepted/pending/ready, never a false "converged".
- Source expansion: current values come from canonical rows (canary: recall returned the corrected value); episodes remain labeled source material.

## Test evidence

- `test/memory_updates.spec.js` — 30: contract, 428/412/wildcard, replay-after-advance, conflict, 2-editor race, 3-way storm, no-op, system-drift capture, per-kind updates, rollback chain + refusals, foreign-revision refusal, Unicode NFC, control-char strip, oversize, erasure residue = 0 across all three tables, projection ready + sweep repair, history pagination + isolation.
- `test/memory_updates_rbac.spec.js` — 5: token update + content-free audit (allowlisted revision/memory_action/edited_fields keys), viewer 403 / viewer history 200, cross-account + forged header, subtenant isolation, archived-project refusal + revoked key 401, MCP advertisement + full round trip.
- Suites on the final tree: **fresh uninterrupted release run 149 files / 1,942 tests green**; unit config 35 files / 602 + 1 intentional skip; migration append-only + schema census green; n8n package 44; Python SDK 147; kernel parity + JS SDK 88. Baseline before changes: 147/1,907 green.

## Deployment record

- Stage A `72aba5ec-6601-45ff-885f-7106dbc33522` (flag "track"): doors answered `feature_disabled`; health 200; production soak probe: automatic extraction moved a disposable node to revision 3 — version tracking live with the doors closed; probe space wiped.
- Stage B `b9bdadd7-8017-4472-95ef-b247cfb3df02` (flag "on"), then `593392de-1e88-4c76-ac8a-7c208d58c1a0` (docs truth: JS-SDK row held until 0.3.0 on npm), final `8c029a34-22f5-4a39-832f-2dea3c6005b9` (ETag wording + report). Rollback target: the same tree with flag "track" — trackers keep every semantic mutation versioned under rollback, so no unversioned window can open. Commits: `d5665b4` → `8f13471` → `04065aa` → `f498f82` → `f36fe75` → `7534d61` → `e98e064` (all pushed).

## Packages

| Package | Version | State |
|---|---|---|
| itsuki (PyPI) | 0.4.0 | **PUBLISHED** via trusted publishing w/ attestations; clean-installed from PyPI; all six methods present; live sync+async production leg 5/5 |
| itsuki (npm) | 0.3.0 | **HOLD — owner action.** All workflow gates pass (version gate bumped deliberately, tarball allowlist, tests); publish fails `ENEEDAUTH`. Owner must configure the npm Trusted Publisher for `itsuki` (or set a granular NPM_TOKEN) and re-dispatch publish-js-sdk.yml. Code tested against production from the repo tree (5/5). |
| n8n-nodes-itsuki (npm) | 0.2.0 | **HOLD — owner action.** Same `ENEEDAUTH`; gates+pack pass (25.9 kB, 15 files). Operations contract-tested (44 green). Live n8n runtime not deployable this session; the operations call the same REST doors the canary proved. |

No customer-facing surface advertises the unpublished artifacts: the live docs list REST/MCP/Python only; npm's `itsuki@0.2.1` and `n8n-nodes-itsuki@0.1.0` remain the published latest and keep working unchanged.

## Production canary (disposable org/project, two accounts, session+API+MCP)

Main battery + repair leg — every proof passed: revision-1 read with ETag; update→r3; same-key replay; stale 412 + current_revision; concurrent editors exactly-one-winner (200/412); history ordered with captured baseline; rollback as forward revision; MCP tools/list = 11 with update tools present, update/history round trips; corrected value in get + recall; cross-account 404; forged project header 403; subtenant 404; revoked key 401; archive → update refused; restore (after the archive run reached terminal — the initial 409 was the lifecycle fence working) → fresh-epoch edit r4; history survived archive/restore; delete → update 404 / history 404 / old-key replay 404 (no resurrection, no erased content). SDK legs: JS 5/5, Python sync+async 5/5. One cosmetic finding: the strong ETag surfaces as weak (`W/"rN"`) through Cloudflare content-encoding; the If-Match parser accepts both and docs state it.

## Cleanup / residual

Canary project: memory purged to terminal, then permanently deleted through the lifecycle door (fences observed working twice: purge-in-flight refused both a delete and a second purge preview). All disposable tokens revoked or destroyed with the project; sessions logged out on both accounts. Residue: two content-free account shells + empty default projects (no self-serve account erasure; admin-removable — same documented class as prior campaigns) and the Stage-A soak account shell (space wiped via delete-all). No canary content, keys, or private text remains; no secrets or memory content in audit rows (verified content-free in tests), logs, or this report.

## Limitations / deferred

1. **npm publications** (itsuki 0.3.0, n8n-nodes-itsuki 0.2.0): blocked on owner npm Trusted Publisher configuration; re-dispatch the two workflows afterwards. Everything else about both releases is done and gated.
2. Real n8n host run of the three new operations: after the npm release lands and a self-hosted n8n is available.
3. Vector-projection ordering is proven at the protocol/code level and by the sweep test; the Workers test pool runs USE_VECTORS=false, so the guarded upsert loop is not exercised against a live Vectorize double-write in CI (it shares the identical code path exercised in production by every node update).
4. Cloudflare serves the revision ETag weak; a future exact-strong-ETag need would require disabling encoding on that route.
