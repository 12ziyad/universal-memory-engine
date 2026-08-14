# Stage 3 enterprise checkpoint

Date: 2026-08-14
Scope: Stage 3 Settings, organizations, RBAC, categories, retention, integrations, audit, invitations, account erasure, and cross-door enforcement only. Stage 2 and Stage 4 are explicitly excluded.

## Production state

- Verdict: **PASS / deployed / release-clean**.
- Deployed source commit: `9b2d2d81452b73abaa3fd33256b37a8778857bc5` (`origin/master` identical at deployment; the documentation-only evidence commit follows it).
- Worker deployment: `08e0c041-6d56-4e90-a630-9ff25280c7a7`.
- Worker version: `9ed4826b-2149-40da-885e-a416208b06e5`, 100% traffic.
- Production origin: `https://itsuki.app`.
- Migration: `0040_enterprise_settings.sql` applied once; SHA-256 `0034ba291d0754454d5b2111075322a707c7ac87540463211708687a1d1b4790`.
- D1 recovery bookmark: `00000e44-00000000-000050c7-ca8add7d10c7bc4cc753b035b947993c`.
- Post-apply checks: 0040 recorded once, six enterprise tables, two effective-organization name-scope triggers, old owner-wide index absent, zero effective-scope collisions.
- Post-cleanup health: HTTP 200 with `x-request-id`; deployed V3 production modes unchanged.

## Frozen gates

- Workers/Vitest pool: 134/134 files, 1,657/1,657 tests.
- Node/unit: 33/33 files, 541 passed, one intentional skip.
- Append-only migration guard: 3/3.
- Clean database replay through 0040: 40/40 migrations; schema and trigger postconditions passed.
- Focused UI: 125/125; script parse, UTF-8/mojibake, raw-webhook, reset reachability, and diff checks passed.
- Manual browser review: desktop and 390x844 mobile across the Stage 3 Settings surface; no console warnings or errors.
- Independent security verdict: GO, with zero Critical, High, or release-blocking Medium findings in Stage 3 scope.

## Production canary

Redacted identity hashes:

- accounts: admin `037d0a5d7d2c292e`, owner `ec0f8ece18473689`, viewer `61c18bd0e4c15b32`;
- organization `1c3ed12dc78e566d`;
- project `148eb11c13806671`;
- category `18fababc87e6ba24`;
- memory root `6ea60e6c710bcb9d`;
- content marker `31cd16f4287af05d`.

Verified against production:

- atomic organization + starter project creation and scoped discovery;
- governed teal category creation;
- optimistic rules CAS with a new opaque version;
- all seven retention classes and a mutation-free preview;
- invitation queued honestly, accepted by the matching account, and rejected on replay;
- viewer graph read allowed while category editing, export, audit, and key management were denied with the exact capabilities;
- content-free audit contained category/rules/invitation events, the supplied correlation ID, and no invitation token;
- a real memory save returned accepted/processing and produced two graph objects;
- owner and viewer deletion succeeded through the governed account-erasure path; their old sessions were invalid and a late save returned 401.

## Cleanup proof

- User count returned from 14 to exactly 14; zero canary users remain.
- Zero canary sessions, tokens, login events, organizations, projects, memberships, invitations, email outbox rows, categories, registry rows, retention rows/runs, graph objects, receipts, jobs, staged rows, episodes, atoms, webhooks/deliveries, exports, audit identity references, or marker hits in all three FTS indexes.
- The completed pass retained three permanent account-erasure tombstones, four deletion barriers, and one deliberate content-free source replay fence. That fence uses `itsuki-erased-source/v1`, has no preview, zero messages, `{}` metadata, and no source, role, topic, project-name, external-user, or source-time provenance.
- An earlier harness-only assertion pass was also fully erased. Combined release verification residue is six content-free account tombstones and eight deletion barriers; no live account, tenant, or content state remains beyond the explicitly listed permanent anti-resurrection records.
- Two graph vector identifiers were sampled before cleanup, but their best-effort Vectorize writes had not materialized. Production evidence therefore does not claim a vector deletion observation; deterministic cleanup tests provide that proof.

## Boundaries

- Stage 2 is not included or claimed by this checkpoint.
- Stage 4 archive/restore, ownership transfer, project-wide convergent deletion, and organization deletion remain honestly disabled/deferred.
- Invitation provider delivery state means provider handoff status, not inbox delivery.
- Webhook DNS rebinding protection beyond Workers' strictly-public global fetch remains defense-in-depth work; HTTPS-only, literal private/self-host rejection, and manual redirects are active.
- User-owned `AGENTS.md` and `CLAUDE_ENTERPRISE_COMPLETION_HANDOFF.md` were not modified or committed by this campaign.

The detailed evidence is in the six `ENTERPRISE_*.md` reports and `ENTERPRISE_HASH_MANIFEST.sha256`.
