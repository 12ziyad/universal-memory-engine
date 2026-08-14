# Itsuki Stage 3 Cleanup and Erasure Ledger

Status: **PASS**. Stage 3 production erasure/no-resurrection canaries completed and cleanup was verified.

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

## Production cleanup proof

The completed canary used redacted account hashes admin `037d0a5d7d2c292e`, owner `ec0f8ece18473689`, and viewer `61c18bd0e4c15b32`; organization `1c3ed12dc78e566d`; project `148eb11c13806671`; category `18fababc87e6ba24`; memory root `6ea60e6c710bcb9d`; and marker `31cd16f4287af05d`.

- Viewer and owner product erasure endpoints each returned HTTP 200 with `deleted: true`, using the governed/transactional boundaries implemented by the product.
- Old sessions no longer resolved, and a late save returned HTTP 401.
- Synthetic admin cleanup was a narrow, preflight-proven, fail-safe sequence of exact remote D1 statements—not one `DB.batch` transaction. It persisted tombstone/barrier protection first, then disabled/revoked, anonymized, and deleted identity last.
- The operator preflight proved zero unexpected non-minimal rows before the final scrub/delete sequence.
- Final production user count returned to the **14-user baseline** with **0 canary users**.

Exact canary counts were zero for users, sessions, connection tokens, login records, organizations, projects, organization/project members, invitations, invitation email outbox, categories, project memory-space registry, every retention table, nodes, pages, receipts, jobs, staged text, source episodes, semantic atoms, webhooks, webhook deliveries, exports, audit identity references, and all three FTS marker searches.

The completed pass intentionally retained **3 account tombstones**, **4 deletion barriers**, and **1 content-free source replay fence**. That fence uses sentinel hash `itsuki-erased-source/v1`, a null preview, `message_count=0`, raw metadata `{}`, and null source, role, topic, project-name, external-user, and source-time fields. Opaque routing and idempotency fields remain only to enforce the replay fence. Including a prior harness-only aborted pass that was also safely erased, recent anti-resurrection totals are **6 tombstones** and **8 barriers**.

Two node/page identifiers were checked before cleanup, but no Vectorize records had materialized because Vectorize is best-effort. Production vector deletion was therefore not observed and is not claimed by this canary; deterministic test coverage proves the deletion path. Production health returned HTTP 200 after cleanup.
