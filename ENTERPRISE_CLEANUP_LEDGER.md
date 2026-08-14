# Itsuki Stage 3 Cleanup and Erasure Ledger

Status: implementation and predeployment release gates complete. Production migration, deploy, and cleanup canaries remain pending.

Scope: Stage 3 account erasure and retention cleanup only. Stage 2 chat-plus-memory deletion and Stage 4 project/organization lifecycle deletion are excluded and not claimed.

## Account-erasure order

1. Verify organization ownership safety; shared owned organizations require transfer/removal first.
2. Persist permanent account tombstone; disable account; revoke sessions and connection tokens; archive account-owned projects.
3. Discover immutable root and all registered/proven managed subtenant memory spaces.
4. Fail-closed reset every `USER_MEMORY` Durable Object, including held/queued state and alarms.
5. Install/preserve monotonic deletion barriers and converge each memory space.
6. Delete semantic, graph, source episode/FTS, staged/job/receipt, export, webhook, Playground, manual-search, profile, and Vectorize state.
7. Delete identity/security rows, including login records found by normalized email and error reports under every memory space.
8. Remove departing-member transcripts and anonymize stable account IDs in surviving foreign-tenant provenance/audit/configuration.
9. Remove solo-owned organization/project control plane in child-first order.
10. Delete the disabled user last. Tombstones/barriers remain as anti-resurrection state.

## Invitation/email cleanup

- Accept/revoke/replace/expire suppresss encrypted outbox material.
- Live pending invitations retain recipient email for account matching.
- After 30 days in terminal invitation/delivery state, recipient email, provider ID, delivery error, ciphertext, and IV are irreversibly scrubbed in bounded scheduled work.
- Account erasure removes invitation/outbox rows addressed to the account and anonymizes creator/acceptor references in surviving foreign resources.

## Retention convergence

Seven independent classes default to keep forever: Playground transcripts, source episodes, semantic memory, export blobs, webhook deliveries, operational records, and security audit. Security audit cannot be shortened by project policy. Preview is exact and mutation-free within bounded inventory; shortening requires version/hash/cutoff binding and exact confirmation. Runs are leased, resumable, idempotent, project-isolated, fenced against late commits, and processed in bounded batches.

## Final proof

Verified before production mutation on 2026-08-14:

- Independent security review: **GO**, with no remaining Stage 3 release blockers.
- Cloudflare Workers-pool serial gate: **134/134 files, 1657/1657 tests passed**.
- Node/unit gate: **33/33 files; 541 passed, 1 skipped**.
- Migration append-only gate: **3/3 passed**.
- Clean migration replay from `0001` through `0040`: **40/40 passed**, including schema and trigger proof.
- Migration `0040_enterprise_settings.sql` SHA-256: `0034ba291d0754454d5b2111075322a707c7ac87540463211708687a1d1b4790`.
- Desktop and 390 px browser QA: **green**, with no console warnings.

Still pending by design: production D1 recovery bookmark, migration application, post-apply production schema/invariant verification, exact Worker deployment identity, production cleanup/erasure canaries (including Durable Object and Vectorize convergence), and canary cleanup evidence.
