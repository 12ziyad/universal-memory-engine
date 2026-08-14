# Itsuki Stage 3 Enterprise Security Report

Status: **independent security review GO** with no remaining Stage 3 release blockers. Production bookmark, migration, deployment, and canary verification remain pending operational gates.

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

Pending: fresh production D1 recovery bookmark, migration apply and post-apply invariant proof, exact end commit/Worker deployment IDs, production security/RBAC/audit/retention/email canaries, canary cleanup, and final production artifact identity.
