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

The release is nevertheless not yet deployed: the production recovery bookmark, migration application, exact Worker deployment identity, production canaries, and canary cleanup remain explicit operational gates.

## Verified predeployment gate

- Cloudflare Workers-pool serial: **134/134 files, 1657/1657 tests passed**.
- Node/unit: **33/33 files; 541 passed, 1 skipped**.
- Migration append-only: **3/3 passed**.
- Clean `0001` through `0040` replay: **40/40 passed**, including schema and trigger proof.
- Desktop and 390 px browser QA: **green**, with no console warnings.
- Production read-only preflight: **4 active projects**, **0 effective-organization/name collision groups**, **0 non-null organization owner mismatches**, and only `0040_enterprise_settings.sql` pending.

## Accepted Stage 3 limits

- DNS rebinding hardening via a dedicated egress service is deferred; current Worker egress is public-only, HTTPS-only, redirect-manual, and rejects literal private/internal/self targets.
- A deterministic rule denial is authoritative; category preview is a bounded model proposal and can honestly return unavailable/no clear category.
- Maximums: 20 active organizations per owner; 20 active projects per organization; 50 live invitations; 32 active/128 total category rows; 50 active/200 total connection-key rows per project; 512 retention memory spaces before operator handling; 10 preview samples × 400 characters.

## Outside Stage 3

- Stage 2 immutable Playground policy snapshots and chat-plus-memory erasure.
- Stage 4 archive/restore/transfer/delete state machines, organization deletion, and project-wide convergent deletion.
- Billing/plan enforcement, SCIM/SAML, and ownership transfer are not invented.
