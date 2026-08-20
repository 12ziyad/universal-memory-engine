# Itsuki Later-Phase Backlog

Last updated: 2026-08-19

This file records work that was deliberately deferred. These items are not blockers for the current integration campaign and should not be forgotten or silently presented as already shipped.

## Scheduling status

**PAUSED BY PRODUCT OWNER.** Do not begin any item in this file automatically. Resume only when the product owner explicitly starts the later-phase campaign after their usage budget refreshes. At that point, re-audit the then-current repository and upstream contracts before implementation, then apply full enterprise-grade design, adversarial testing, repair, publication, deployment, production canaries, and cleanup gates as applicable. Do not assume today's plans or dependency versions remain current.

## Current campaign boundary

Finish the active Hermes, Google ADK, OpenCode, and Antigravity implementation/publication verification separately. Any unfinished release gates for those packages remain current work, not later-phase work.

## Deferred product work

### 1. Normalize Notes / Conversation Pages

- Keep automatic agent and framework capture writing structured memories without creating a page after every turn.
- Keep `save_memory` for one concise, durable fact.
- Make an explicit conversation-page option consistent across MCP, REST, SDKs, n8n, and the dashboard.
- Decide whether the UI name should be **Conversation pages** or **Memory pages** instead of the ambiguous **Notes**.
- Prove page/memory idempotency, tenant isolation, lifecycle fencing, linked deletion, retry behavior, and zero page flooding.
- If lossless large-document storage is required, design it as a separate document/import capability; current Notes are derived pages, not an unlimited file store.

### 2. Safe memory updates — ✅ COMPLETE (2026-08-20, PRODUCTION GO, all packages published)

Explicit update + bounded immutable history + rollback-as-forward-revision live
for node/page/slice/event behind exact optimistic concurrency (If-Match /
expectedRevision; 428/412; no last-write-wins), required idempotency keys,
fresh-capability + lifecycle-epoch + deletion-barrier fences inside the commit
batch, content-free audit, and history erased by every deletion path.
Migration 0047; Stage A `72aba5ec` (track) → Stage B `b9bdadd7` → final
`593392de`. Surfaces live: REST, MCP (11 tools, scope-gated advertisement),
Memories UI (draft-preserving conflict UX + History/restore), Python SDK 0.4.0
(published + production-canaried sync+async). Full evidence:
SAFE_MEMORY_UPDATES_REPORT.md + SAFE_MEMORY_UPDATES_CHECKPOINT.md.

**CLOSED 2026-08-19 after a second corrective pass.** A further independent
review found three blockers the first correction missed: the commit-time guard
proved membership but never the CREDENTIAL (so a token revoked between preflight
and commit still wrote); several writers had NULL-bypassable CAS predicates,
ignored affected-row counts, and pass2 had been regressed into silently
no-opping on every r2+ node; and vector cleanup guessed a 20-revision window, so
gapped artifacts survived deletion. All reproduced with failing tests first,
fixed, and re-proved in production (canary 19/19). The campaign's own canary
additionally caught a defect nobody had asked about — a FRESH regeneration
silently replacing summaries users had just corrected — now fixed so automatic
regeneration defers to user-authored text and resumes after rollback.
Migration 0049 adds a durable vector artifact ledger. Authoritative evidence:
SAFE_MEMORY_UPDATES_CLOSURE_REPORT.md.

**CORRECTED 2026-08-19 (same day).** Independent review found eight release
blockers the first green suite never covered. All were reproduced with failing
tests, fixed, and re-verified in production; the public doors were disabled
(worker `cc3bf740`, tracking kept live) for the duration. Corrections: stale
automatic writers now CAS the revision they read (+ a static mutation census
gate), commit-time authorization is enforced on every door including MCP,
events gained read parity, delete-last-extraction erases revision residue and
exports carry history, the idempotency fingerprint is normalization-stable and
complete, projection state is truthful and ordering-safe against asynchronous
Vectorize (revision-qualified vector ids + readback), migration 0048 scopes
history uniqueness per tenant+kind, and both SDKs stopped misreporting their
own versions. Authoritative evidence:
SAFE_MEMORY_UPDATES_CORRECTIVE_REPORT.md — the original
SAFE_MEMORY_UPDATES_REPORT.md is superseded and partly retracted.

**npm publications RELEASED 2026-08-20.** The owner configured npm Trusted
Publishing; both workflows were re-dispatched unchanged from `6f859dd` with
`dry_run=false` and succeeded. npm now serves `itsuki@0.3.0` and
`n8n-nodes-itsuki@0.2.0`, each with SLSA provenance naming this repository, the
exact workflow, and commit `6f859dd`. No NPM_TOKEN exists or was used — both
authenticated by OIDC. Verified by clean install from the registry in fresh
projects: signatures + attestations verified, SDK exports all six methods with
working validation, n8n artifact ships the production node and routes
updateMemory/history/rollbackMemory correctly. Downloaded bytes, registry
integrity and the signed provenance subject all agree.

Remaining for item 6 (n8n Cloud): a real n8n host run of the three new
operations. Everything proven so far is execute-level and artifact-level.

### 3. Get Started and integration-catalog redesign — ✅ ABSORBED (2026-08-19, Get Started certification campaign)

Certified end to end: 26 cards / 38 routes graph-equality-pinned by contract
tests; every route's commands executed or parse-verified against published
artifacts and validated hosts; supported hosts and held limitations labeled
(incl. the new OpenClaw validated-version hint); no install verb for any
unpublished package (chatdev absent, registries checked). Evidence:
GET_STARTED_CERTIFICATION_REPORT.md. Remaining redesign ideas beyond the
certified catalog are aesthetic, not correctness, and carry no open defect.

### 4. Project lifecycle — ✅ COMPLETE (2026-08-19, PRODUCTION GO)

Shipped as one unified subsystem: reversible archive/restore, atomic ownership
transfer, convergent project-wide memory purge, and permanent project deletion.
Migrations 0045+0046 (additive), `src/lib/project_lifecycle.js` +
`lifecycle_census.js`, session-only `/v1/settings/lifecycle*` API, server-gated
Danger Zone UI, docs in `docs/PROJECT_LIFECYCLE.md`. Epoch fences, driver
lease, checkpointed resumable runs, residual-scan completion, schema-census
regression gate. Verified by 33 new adversarial tests (suite 1,907 green) and a
13-step disposable production canary (all four capabilities, replay refusal,
fresh-epoch writes, terminal delete).

Narrow residual follow-ups:
- One empty disposable canary project (`proj_e919f41c…`, purged to zero, plus
  two empty canary account shells with unrecoverable throwaway credentials)
  remains from an intermediate canary run; removable any time via the admin
  account-erasure route. Four other fixture sets were lifecycle-deleted.
- Disposable canary account shells (zero memory, zero projects, sessions
  revoked) remain because no self-serve account-erasure route exists; the
  admin route can remove them.
- Archived-project API access intentionally answers 404 (documented); a
  distinct `project_archived` code for key-based callers is a possible later
  refinement.

### 5. Antigravity Desktop support

- Treat Desktop/IDE independently from the proven CLI surface.
- Ship it only after real native hook discovery, install/disable/uninstall, recall/capture, retry, secret, tenancy, and cross-platform tests pass on a supported Desktop version.

### 6. n8n Cloud verification

- Complete the official n8n verification/listing process for `n8n-nodes-itsuki`.
- Retain npm provenance, dependency/SBOM review, credential isolation, clean-install proof, and real n8n Cloud verification before claiming Cloud-native availability.

### 7. ChatDev release decision

- Keep `chatdev-itsuki` unpublished until its host/API contract is current and independently verified.
- Re-audit upstream support, attribution, lifecycle capture, retries, isolation, packaging, and clean installation before deciding to publish or retire it.

### 8. MCP OAuth / PKCE and scoped consent

- Add standards-based user authorization, PKCE where applicable, consent, refresh/revocation, account switching, and per-connection scopes.
- Advertise only tools permitted by the active connection; preserve existing bearer/path-token support only as explicitly documented compatibility paths.
- Test cross-tenant access, revoked sessions, destructive-tool consent, auditability, and secret leakage.

### 9. Memory-quality and benchmark campaign

- Re-run the frozen LoCoMo protocol on the then-current production engine before claiming improvements.
- Improve evidence availability, temporal reasoning, multi-hop retrieval, open-domain recall, answer generation, and extraction settlement latency without benchmark leakage.
- Report token-F1 and semantic judge accuracy separately, include repeated-run variance, and use controlled head-to-head model/prompt comparisons.

### 10. Large documents and knowledge connectors

- Design a lossless, versioned document/source layer before advertising large-note or file storage.
- Consider Google Drive, Notion, GitHub, S3, OneDrive, Gmail, and web crawling only after OAuth, incremental sync, deletion propagation, retry visibility, retention, audit, and tenant-isolation requirements are frozen.
- Keep this separate from ordinary `save_memory`, `save_conversation`, and bounded `/v1/ingest` calls.

### 11. Cross-door capture and idempotency proof — ✅ ABSORBED (2026-08-19, Get Started certification campaign)

Production-proven on live doors with disposable canaries: same-key replay
returns the same source packet; same-key/different-payload → 409
idempotency_conflict; three-way concurrent same-key storm settles clean;
/v1/turn + explicit save of identical words remain distinct legitimate
operations; concurrent two-door delivery clean; receipts observable;
subtenant + cross-account isolation and revocation verified. Full detail in
GET_STARTED_CERTIFICATION_REPORT.md (batteries A/D/F). The deeper
fault-injection legs (forced D1-commit-before-Vectorize failure, DO
eviction replay) remain covered by the deterministic suite rather than
production probes — retained below only as historical scope notes.

#### (historical scope, retained)

- Keep the current write architecture unless adversarial tests demonstrate a concrete correctness, duplication, cost, or recovery defect; do not introduce a new coordinator merely on speculation.
- Exercise the same logical operation concurrently through automatic and explicit door pairs, including `/v1/turn` plus `save_memory`, lifecycle-hook capture plus MCP `save_memory` or `save_conversation`, and native/framework capture plus direct SDK/REST writes.
- Prove same-key replay, same-key conflict, shared logical-operation coalescing where supported, and that identical words with genuinely different operation identities remain distinct.
- Assert the complete result, not only node count: source packets, jobs, receipts, model invocations, nodes, slices/details, events, relationships, vector/search projections, and audit records.
- Cover exact duplicates, paraphrases, corrections, temporal facts, session/project/account isolation, concurrent retries, Durable Object restart, extraction settlement, and a forced D1-commit-before-Vectorize-failure followed by deterministic repair.
- Run realistic burst/concurrency tests and real-host acceptance checks so automatic, model-discretionary, and explicit capture policies match the published integration matrix.
- Cross-reference the fresh LoCoMo campaign in item 9 to detect quality regressions or duplicate-memory effects. These gates provide strong evidence for the tested invariants, not a literal guarantee against every future failure.
- If a test fails, implement the smallest evidence-driven correction. Consider a shared `operation_id` / `origin_event_id` ledger only if cross-door logical duplication cannot be bounded safely by the current architecture; never deduplicate by text alone.

## Explicitly excluded

- Stage 5 remains removed from the plan.
- Zapier remains excluded unless explicitly restored by the product owner.
- Do not increase integration/logo counts without a named proof level and current executable evidence.

## Completion rule

An item leaves this backlog only after implementation, independent adversarial review, deterministic tests, clean package/registry proof where applicable, production canaries, cleanup verification, documentation, and an evidence-backed GO verdict.
