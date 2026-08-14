# Itsuki Stage 3 Enterprise Security Report

Status: **PASS / independent security review GO**. No Stage 3 release blocker remains; production migration, deployment, adversarial canary, and cleanup are verified.

## Security properties implemented

- Central capability matrix across session, bearer, MCP, Settings, Playground, keys, webhooks, chooser, exports, retention, and audit.
- Fresh temporal membership resolution and commit-time authorization fences for governed mutations.
- Immutable project binding and shared immutable memory-owner resolution for managed credentials.
- Nondisclosing cross-organization/project lookup failures.
- Auth-first byte-bounded JSON parsing and unknown-field rejection on production-reachable request bodies.
- Atomic optimistic concurrency for General settings, policies, memberships, and categories.
- Token quarantine on member removal, active/history caps, project-wide masked metadata inventory, and copy-once secret lifecycle.
- Invitation authority stored only as SHA-256; encrypted email payload is temporary and terminal PII is scrubbed after 30 days.
- Webhook public DTO masks target path/query; HTTPS only; private/self targets and URL credentials/fragments rejected; redirects never followed; global fetch is configured strictly public.
- Viewer export and paid chooser/Playground use are denied through explicit capabilities.
- Managed policy denies are monotonic across project, credential, request, MCP, and Playground doors.
- Content-free recall query packets prevent policy-denied query text becoming a shadow archive.
- Audit metadata is allowlisted; request bodies, memory/transcript text, tokens, invitation links, full MCP URLs, free-form descriptions/instructions, and raw webhook URLs are excluded.

## Erasure and no-resurrection

Account erasure first writes a permanent account tombstone, disables the account, revokes sessions/credentials, and archives account-owned projects. It inventories immutable roots plus the authoritative project memory-space registry, fail-closed resets every Durable Object, installs/preserves deletion barriers, removes D1/FTS/Vectorize/derived state, anonymizes foreign-tenant actor/provenance references, then removes the control plane and account last.

Managed write paths use account/project/org lifecycle checks at acceptance and commit. Source packets, episodes, jobs, receipts, AI usage, staging, graph/atomic writes, Playground transcripts, webhook delivery, invitation outbox, and Durable Object queues are covered by same-batch guards or post-await rechecks. Failure leaves a disabled/tombstoned retryable account; success must not permit resurrection.

## Audit durability

Request-driven Stage 3 administration uses one validated caller request ID (or a generated server ID), a durable pre-intent, a mutation-transaction committed marker, and a retryable completion record. Admission fails closed when the audit intent cannot be stored. Correlation is echoed in `x-request-id` and exposed in list/CSV/UI. Scheduled work uses bounded system request IDs.

Invitation creation/resend is governed and atomically commits the hash-only authority plus its audit marker. Encrypted email enqueue follows in a separate durable step; its reported delivery state is honest, and a missing/failed enqueue never burns the copy-once invitation because the visible link plus dedicated Resend flow remain available. Later `sent`, `suppressed`, and terminal provider-failure audit rows are explicitly best-effort operational telemetry because an external email send cannot share a D1 transaction without creating duplicate-delivery ambiguity. The outbox row remains the server-authoritative, retryable delivery state; no authorization or Settings mutation depends on those telemetry rows.

## Residual risk and explicit deferrals

- Hostname DNS rebinding cannot be safely pinned with global Workers fetch. Current public-only egress, HTTPS, literal/private/self rejection, per-attempt revalidation, and manual redirects close concrete reachable SSRF/secret-forwarding paths. A dedicated egress proxy/Gateway allow policy is a future defense-in-depth option.
- Project-wide convergent deletion, project lifecycle deletion, and ownership transfer remain Stage 4 and are disabled/not claimed.
- Stage 2 policy-version replay and chat-plus-memory deletion are outside this Stage 3 verdict.

## Final gates

Verified before production mutation on 2026-08-14:

- Independent security audit: **GO**, no blockers.
- Cloudflare Workers-pool serial: **134/134 files, 1657/1657 tests passed**.
- Node/unit: **33/33 files; 541 passed, 1 skipped**.
- Migration append-only: **3/3 passed**.
- Clean `0001` to `0040` replay: **40/40 passed**, including schema and trigger proof.
- Migration 0040 SHA-256: `0034ba291d0754454d5b2111075322a707c7ac87540463211708687a1d1b4790`.
- Production read-only preflight: **4 active projects**, **0 effective-organization/name collision groups**, **0 non-null organization owner mismatches**, and only `0040_enterprise_settings.sql` pending.
- Desktop and 390 px browser QA: **green**, with no console warnings.

## Production security verification

- Recovery bookmark: `00000e44-00000000-000050c7-ca8add7d10c7bc4cc753b035b947993c`.
- Migration 0040 applied once and passed post-apply proof: `applied_0040=1`, 6 enterprise tables, 2 name-scope triggers, 0 old owner-wide indexes, and 0 collision groups.
- Source commit `9b2d2d81452b73abaa3fd33256b37a8778857bc5` (HEAD = `origin/master` at deployment) deployed as deployment `08e0c041-6d56-4e90-a630-9ff25280c7a7`, version `9ed4826b-2149-40da-885e-a416208b06e5`.
- Custom-domain and `workers.dev` health returned HTTP 200 with `x-request-id`; production health remained HTTP 200 after cleanup.
- A viewer received HTTP 200 for graph read and HTTP 403 for category editing, export, audit viewing, and key management.
- Invitation acceptance succeeded once and exact replay returned HTTP 409. Audit recorded category, rules, and invitation actions with the exact request ID and without the invitation token.
- A real save was accepted and produced two graph objects. After governed owner/viewer erasure, old sessions failed and a late save returned HTTP 401.
- Final canary identity/content rows and all three FTS marker searches were zero. The accepted residual is content-free anti-resurrection state: tombstones, barriers, and one scrubbed source replay fence with sentinel hash `itsuki-erased-source/v1`, no preview/content, empty metadata, and null source, role, topic, project-name, external-user, and source-time fields. Opaque routing and idempotency fields remain only to enforce the replay fence.
- Synthetic admin cleanup was a preflight-proven fail-safe sequence of exact remote D1 statements, not a single transaction. Tombstone/barrier protection preceded disable/revoke, anonymization, and identity deletion.
- No Vectorize record had materialized for the two checked object IDs, so production vector deletion was not observed or claimed; deterministic tests cover the deletion path.

Open Critical: **0**. Open High: **0**. Open release-blocking Medium: **0**. The evidence set is hash-locked separately from the deployed source, and the delivery message records its documentation commit.
