# Itsuki Stage 3 Enterprise Migration Ledger

Status: migration `0040_enterprise_settings.sql` is frozen and verified for deployment. No production migration has been applied as part of this document yet.

Scope: Stage 3 schema only. This ledger does not claim completion of Stage 2 Playground policy work or Stage 4 project/organization lifecycle work.

## Baseline

- Repository baseline: migrations `0001` through `0039`.
- Production preflight observed before this release: the remote database is applied through `0039`; Wrangler lists only `0040_enterprise_settings.sql` as pending.
- Migration policy: append-only and checksum-enforced. No existing migration is rewritten. Migration 0040 is additive except for one intentional, data-preserving constraint replacement described below.

The read-only production preflight found **4 active projects**, **0 duplicate `(effective organization, normalized name)` groups**, and **0 non-null organization owner mismatches**. The scoped-constraint replacement is therefore clear to apply once a fresh recovery bookmark exists.

## Migration 0040

The Stage 3 migration adds, without destructive backfill:

- temporal access fields and indexes for organization/project memberships and invitations;
- effective-organization project-name uniqueness compatible with historical NULL-organization projects;
- governed category color/provenance and legacy/V3 category-assignment columns/indexes;
- managed project memory-space registry and source packet managed-project provenance;
- encrypted invitation email outbox;
- seven-class retention policy, run, and monotonic fence tables;
- account-erasure tombstones;
- Playground account/project provenance needed for account erasure;
- durable audit dedupe/completion state for request-correlated audited mutations.

Historical rows remain nullable and are interpreted through compatibility code. Existing immutable memory-owner IDs are not changed.

### Intentional project-name constraint replacement

The owner-wide active-project-name unique index is replaced by effective-organization uniqueness triggers plus a lookup index. This deletes no table, column, or row; it is required so the same organization owner can use the same ordinary project name in two different organizations while duplicates inside one effective organization remain rejected.

Production application is conditional on a read-only preflight proving zero duplicate `(effective organization, normalized name)` groups. That preflight passed with zero collision groups. A clean `0001` to `0040` replay passed **40/40**, including schema/trigger proof that same-organization duplicates are rejected and cross-organization duplicates are allowed.

## Freeze and production fields

| Field | Value |
|---|---|
| 0040 SHA-256 | `0034ba291d0754454d5b2111075322a707c7ac87540463211708687a1d1b4790` |
| Checksum / append-only verification | VERIFIED; migration append-only gate 3/3 passed |
| Clean database replay 0001 to 0040 | VERIFIED; 40/40 passed with schema/trigger proof |
| Production pre-migration head | `0039`; only `0040_enterprise_settings.sql` pending |
| Production data preflight | 4 active projects; 0 collision groups; 0 non-null organization owner mismatches |
| Cloudflare D1 recovery bookmark | PENDING DEPLOY PREFLIGHT |
| Migration apply result | NOT YET APPLIED |
| Post-apply schema/invariant check | NOT YET RUN |
| Rollback mechanism | D1 Time Travel bookmark + previous Worker version |

Production application remains migration-first: capture a fresh D1 recovery bookmark, apply the exact verified `0040`, run the post-apply schema/invariant checks, then deploy the exact tested Worker commit. Old code safely ignores the additive objects during that bounded interval.
