# ITSUKI ENTERPRISE PRODUCT COMPLETION — STAGE 3 FINAL REPORT

This report is intentionally limited to Stage 3: enterprise Settings, organizations, RBAC, members, invitations, governed extraction categories, retention, integrations, audit, and the account-erasure properties required for those surfaces. It does not claim Stage 2 or Stage 4 completion.

## Verdict

**Final Stage 3 verdict: PASS.** The independently reviewed source commit was migrated, deployed, verified through both production hostnames, exercised with a complete synthetic enterprise canary, and cleaned. No Stage 3 release blocker remains.

| Area | Verdict |
|---|---|
| Project scope | PASS |
| Organization/RBAC | PASS |
| Enterprise Settings UI | PASS |
| Extraction policy precedence/CAS/preview | PASS |
| Governed categories (legacy + V3) | PASS |
| Invitations, temporal membership, and email | PASS |
| Retention | PASS |
| Audit/correlation | PASS |
| Erasure/no resurrection | PASS |
| Accessibility/responsive browser review | PASS: desktop + 390 px; no console warnings |

## Release identity

| Field | Value |
|---|---|
| Start commit | `c52e3233d21291a16321c86ecaf23099efe66780` |
| End source commit | `9b2d2d81452b73abaa3fd33256b37a8778857bc5` (HEAD = `origin/master` at deploy) |
| Evidence/report snapshot | Hash-locked by `ENTERPRISE_HASH_MANIFEST.sha256`; the delivery message identifies the documentation commit |
| Start Worker | deployment `2bce6453-df3b-4ceb-b80a-e78d3670e317`; version `a292d696-d3d9-4f97-9000-6720f47aebee` |
| End Worker | deployment `08e0c041-6d56-4e90-a630-9ff25280c7a7`; version `9ed4826b-2149-40da-885e-a416208b06e5` |
| Migration added | `0040_enterprise_settings.sql` (applied once in production) |
| Migration SHA-256 | `0034ba291d0754454d5b2111075322a707c7ac87540463211708687a1d1b4790` |
| Recovery bookmark | `00000e44-00000000-000050c7-ca8add7d10c7bc4cc753b035b947993c` |
| Workers-pool serial gate | 134/134 files; 1657/1657 passed |
| Node/unit gate | 33/33 files; 541 passed, 1 skipped |
| Migration gates | append-only 3/3; clean `0001` to `0040` replay 40/40 with schema/trigger proof |
| Browser gate | desktop + 390 px green; no console warnings |
| Production canaries | PASS; complete synthetic organization/RBAC/settings/save/cleanup canary |

Before migration, production was applied through `0039`, with only `0040_enterprise_settings.sql` pending. The read-only data preflight found **4 active projects**, **0 effective-organization/name collision groups**, and **0 non-null organization owner mismatches**. Migration 0040 then applied **48 commands in 794.78 ms**. Post-apply proof found `applied_0040=1`, **6 enterprise tables**, **2 name-scope triggers**, **0 old owner-wide indexes**, and **0 collision groups**.

## Production canary

Only redacted hashes are recorded: admin `037d0a5d7d2c292e`, owner `ec0f8ece18473689`, viewer `61c18bd0e4c15b32`, organization `1c3ed12dc78e566d`, project `148eb11c13806671`, category `18fababc87e6ba24`, immutable memory root `6ea60e6c710bcb9d`, and marker `31cd16f4287af05d`.

- Organization plus starter project creation passed; the governed category persisted with the `teal` color.
- Rules optimistic concurrency passed. Retention returned all seven classes, and preview was mutation-free.
- Invitation delivery was honestly reported as queued. Acceptance succeeded once; exact replay returned HTTP 409.
- Viewer graph access returned HTTP 200. Category editing, export, audit viewing, and key management each returned HTTP 403.
- Audit contained category, rules, and invitation actions with the exact request correlation ID and no invitation token.
- A real save returned HTTP 200 in accepted/processing state and produced two graph objects.
- Viewer and owner product deletion endpoints returned HTTP 200 with `deleted: true`; old sessions became invalid and a late save returned HTTP 401.
- Cleanup returned production to the **14-user baseline with 0 canary users** and zero canary identity/content rows or FTS marker hits. The completed pass intentionally retained 3 account tombstones, 4 deletion barriers, and one content-free source replay fence. Across this pass and a prior safely erased harness-only aborted pass, recent residual totals are 6 tombstones and 8 barriers.
- Two node/page IDs were checked before cleanup, but no Vectorize records had materialized because Vectorize is best-effort. This canary therefore does not claim a production vector deletion; deterministic tests cover that deletion path.

## Production enablement state

DEPLOYED AND VERIFIED. Source commit `9b2d2d81452b73abaa3fd33256b37a8778857bc5` is deployed as version `9ed4826b-2149-40da-885e-a416208b06e5`. Both the custom domain and `workers.dev` health endpoints returned HTTP 200 with `x-request-id`; production health remained HTTP 200 after canary cleanup.

Open Critical: **0**. Open High: **0**. Open release-blocking Medium: **0**.

## Explicit boundaries

- Stage 2 immutable Playground policy replay and chat-plus-memory deletion are excluded.
- Stage 4 project archive/restore/transfer/delete, organization deletion, and project-wide convergent deletion are excluded and disabled honestly.
- No plan/quota/billing contract is invented.

## Publication recommendation

**PASS — publish Stage 3 as deployed within the explicit boundaries above.** The evidence set is hash-locked separately from the deployed source; the delivery message records its documentation commit.
