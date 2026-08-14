# Itsuki Stage 3 Defect Ledger

This ledger records Stage 3 release findings. Stage 2 and Stage 4 requirements are excluded from the Stage 3 deployment verdict and appear only as explicit boundaries.

## Closed in this release

- Viewer/admin capability bypasses on Settings, keys, webhooks, exports, chooser, Playground, destructive actions, and legacy reset UI.
- Stale membership PATCH resurrection and multi-tab General/rules lost updates.
- NULL-organization tenant confusion and historical mismatched-member disclosure.
- Managed policy child override weakening parent Never rules.
- Invitation double-create, consume-before-grant, copy-once loss, missing redemption/resend, temporal delegation escalation, and credential revival after re-add.
- Raw webhook URL disclosure and redirect-based signature forwarding.
- Category controls disconnected from extraction, atomic V3 parity gaps, archived-category late commits, missing atom usage, and unbounded category history.
- Test/production Memory V3 flag mismatch.
- Unbounded production JSON bodies on authenticated and public routes.
- Raw recall query shadow persistence.
- Account erasure governance omissions, registry omissions, Durable Object leftovers, foreign provenance identifiers, invitation outbox PII, and post-erasure write races.
- Audit free-text leakage, unstable cursor, missing filters/export/request IDs, and fail-open security mutation events.
- False privacy/export/delete/session/cookie/UI role claims.

## Open release blockers

None known. The independent final security review returned **GO** with no remaining reachable Stage 3 Critical, High, or release-blocking Medium findings.

The exact reviewed source commit is deployed. Production reattack covered organization/project creation, category color, rule concurrency, retention preview, invitation accept/replay, viewer authorization, audit correlation/privacy, real capture/graph materialization, erasure, late-write denial, and cleanup; every checked Stage 3 outcome passed.

## Verified predeployment gate

- Cloudflare Workers-pool serial: **134/134 files, 1657/1657 tests passed**.
- Node/unit: **33/33 files; 541 passed, 1 skipped**.
- Migration append-only: **3/3 passed**.
- Clean `0001` through `0040` replay: **40/40 passed**, including schema and trigger proof.
- Desktop and 390 px browser QA: **green**, with no console warnings.
- Production read-only preflight: **4 active projects**, **0 effective-organization/name collision groups**, **0 non-null organization owner mismatches**, and only `0040_enterprise_settings.sql` pending.

## Production closure

- Source commit `9b2d2d81452b73abaa3fd33256b37a8778857bc5` deployed as deployment `08e0c041-6d56-4e90-a630-9ff25280c7a7`, version `9ed4826b-2149-40da-885e-a416208b06e5`.
- Migration 0040 applied once after recovery bookmark `00000e44-00000000-000050c7-ca8add7d10c7bc4cc753b035b947993c`; post-apply schema/name-scope invariants passed.
- Viewer negative authorization returned the expected four HTTP 403 responses; invitation replay returned HTTP 409; late post-erasure save returned HTTP 401.
- Audit request correlation matched exactly and did not retain the invitation token.
- Final canary identity/content rows and all three FTS marker searches were zero. Intended anti-resurrection tombstones/barriers plus one content-free replay fence remained.
- No Vectorize records had materialized for the checked object IDs, so production vector deletion was not observed; deterministic tests remain the evidence for that deletion path.
- Production health returned HTTP 200 after cleanup.

Open Critical: **0**. Open High: **0**. Open release-blocking Medium: **0**.

## Accepted Stage 3 limits

- DNS rebinding hardening via a dedicated egress service is deferred; current Worker egress is public-only, HTTPS-only, redirect-manual, and rejects literal private/internal/self targets.
- A deterministic rule denial is authoritative; category preview is a bounded model proposal and can honestly return unavailable/no clear category.
- Maximums: 20 active organizations per owner; 20 active projects per organization; 50 live invitations; 32 active/128 total category rows; 50 active/200 total connection-key rows per project; 512 retention memory spaces before operator handling; 10 preview samples × 400 characters.

## Outside Stage 3

- Stage 2 immutable Playground policy snapshots and chat-plus-memory erasure.
- Stage 4 archive/restore/transfer/delete state machines, organization deletion, and project-wide convergent deletion.
- Billing/plan enforcement, SCIM/SAML, and ownership transfer are not invented.
