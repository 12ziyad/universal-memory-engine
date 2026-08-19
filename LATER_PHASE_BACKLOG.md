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

### 2. Safe memory updates

- Add an explicit, authorized `update_memory` contract rather than silently replacing existing content.
- Include optimistic version checks, conflict responses, immutable history, audit records, rollback/recovery, tenant isolation, and deletion-race protection.
- Carry the operation through REST, MCP, JavaScript/Python SDKs, n8n, native adapters, docs, and production canaries.

### 3. Get Started and integration-catalog redesign

- Reorganize the full integration catalog into a clean, understandable hierarchy for new and experienced users.
- Clearly label MCP/configuration guides, native lifecycle integrations, SDK adapters, marketplace status, supported hosts, and proof level.
- Preserve accessible keyboard/mobile behavior, responsive spacing, readable typography, copyable commands, and the existing paired UI/docs contract tests.
- Never display an install command for an unpublished package.

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

### 11. Cross-door capture and idempotency proof

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
