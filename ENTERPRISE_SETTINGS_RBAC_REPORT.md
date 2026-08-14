# Itsuki Stage 3 Enterprise Settings and RBAC Report

Status: **PASS / deployed and production verified** for the Stage 3 scope below.

Scope: Stage 3 only. Playground policy-version persistence and chat-plus-memory erasure are Stage 2; project transfer/archive/delete and project-wide convergent deletion are Stage 4. They are not claimed here.

## Shipped role model

Organization roles are `owner`, `admin`, and `member`. Project roles are `admin`, `member`, and `viewer`. The handoff's suggested **Developer** role is shipped as project **Member — read and write**. Organization membership by itself grants no project access, except organization owner/admin authority across projects in that organization.

| Capability group | Org owner | Org admin | Org member | Project admin | Project member | Viewer |
|---|---:|---:|---:|---:|---:|---:|
| View organization and member directory | Yes | Yes | Yes | — | — | — |
| Edit organization / manage invitations and members | Yes | Yes | No | — | — | — |
| Create projects in organization | Yes | Yes | No | — | — | — |
| View project, members, and memory | Yes | Yes | No implicit access | Yes | Yes | Yes |
| Write memory; use Playground/chooser | Yes | Yes | No implicit access | Yes | Yes | No |
| View/manage keys and webhooks | Yes | Yes | No implicit access | Yes | Yes | No |
| Export resolved memory space | Yes | Yes | No implicit access | Yes | Yes | No |
| Edit project/rules/categories; manage members | Yes | Yes | No implicit access | Yes | No | No |
| View/manage retention and audit | Yes | Yes | No implicit access | Yes | No | No |
| Delete ordinary memory objects / Playground chats | Yes | Yes | No implicit access | Yes | No | No |
| Transfer/delete project | Yes | No | No | No | No | No |

The executable source of truth is `CAPABILITIES` in `src/lib/organizations.js`. UI capability state is project-id/epoch scoped and fails closed while unknown or unavailable. Every sensitive handler rechecks capability; UI visibility is not authorization.

## Authorization invariants

- Session, bearer, MCP, and selected-project doors re-resolve current organization/project membership and temporal windows.
- Managed credentials are immutable-project-bound. Client headers cannot redirect a credential to another project.
- Organization and project access windows intersect. Organization owners are permanent.
- A non-owner may not grant a role or expiry window broader/longer than their own effective delegation.
- Member mutations use opaque per-row revisions and `If-Match`; stale PATCH/DELETE cannot resurrect or overwrite a replaced seat.
- Member removal revokes project credentials, including implicit organization-admin keys. Re-adding the account does not revive old keys.
- Organization/project General, rules, categories, and memberships use atomic optimistic concurrency.
- Cross-organization misses are nondisclosing.

## Settings information architecture

One top-level Settings surface contains Project General, Memory extraction, Categories, Retention, Members, Integrations, Audit history, Organization General, Members & invitations, Profile & security, and Appearance. Desktop uses a secondary navigation column; narrow layouts use an accessible compact selector/stacked tables. The project selector groups by organization and supports name/description search. Create Organization and organization-scoped Create Project use server-validated organization context.

## Enterprise controls

- Project policy has an opaque version, fail-closed reads, atomic CAS, stale-draft preservation, and a separate monotonic narrowing composer. Credential/request rules cannot remove parent denies.
- Test with sample performs deterministic admission first and one bounded, no-write category proposal call for allowed samples; only exact active governed categories may be returned.
- Categories have stable IDs/slugs, bounded palette, CAS, provenance timestamps/actors, active/history caps, atomic legacy/V3 assignment, usage/reassignment, and archived-category commit guards.
- Retention has seven independent classes, keep-forever defaults, exact preview/version/hash binding, explicit shortening confirmation, monotonic fences, bounded resumable runs, daily scheduling, and cross-lane convergence.
- Invitations are single-use, hash-only authority, seven-day links, atomic grant/consume, bounded/rate-limited, copy-once, optionally emailed through an encrypted outbox, and support revoke/resend.
- Audit is project-scoped, content-free, request-correlated, tuple-paginated, time/action filtered, and independently export-authorized.

### Exact managed-policy precedence

The authoritative order is **project parent policy → immutable credential layer → immutable request layer**. A queued job refreshes the server-owned project parent before extraction, then reapplies the accepted credential/request layers. Managed layers can only narrow: deny terms and deny instructions accumulate; each non-empty include list becomes an additional AND requirement; graph-only capture, standard density, disabled auto-collect, and the shortest finite retention value win; governed categories accumulate as extraction vocabulary and never grant storage authority. Legacy unmanaged credentials retain their documented replacement semantics.

### Retention defaults

| Class | Default | Project may shorten |
|---|---|---|
| Playground transcripts | Keep forever | Yes, with version-bound preview and confirmation |
| Source episodes | Keep forever | Yes, with version-bound preview and confirmation |
| Semantic memory | Keep forever | Yes, with version-bound preview and confirmation |
| Export blobs | Keep forever | Yes, with version-bound preview and confirmation |
| Webhook deliveries | Keep forever | Yes, with version-bound preview and confirmation |
| Operational records | Keep forever | Yes, with version-bound preview and confirmation |
| Security audit | Keep forever | No; locked to separately reviewed policy |

## Honest limits

- Project archive/transfer/delete and organization deletion have no enabled workflow in Stage 3.
- Project-wide memory deletion is not self-serve. The compatibility reset affects only one resolved memory space and has no browser affordance.
- Export is explicitly labelled as the resolved current memory space, not all SDK subtenant spaces.
- No billing plan or project quota is invented; the UI says none is configured.

## Final evidence

Verified before production mutation on 2026-08-14:

- Independent security review: **GO**, no Stage 3 release blockers.
- Cloudflare Workers-pool serial: **134/134 files, 1657/1657 tests passed**.
- Node/unit: **33/33 files; 541 passed, 1 skipped**.
- Migration append-only: **3/3 passed**.
- Clean `0001` to `0040` replay: **40/40 passed**, including schema and trigger proof.
- Migration 0040 SHA-256: `0034ba291d0754454d5b2111075322a707c7ac87540463211708687a1d1b4790`.
- Production read-only preflight: **4 active projects**, **0 effective-organization/name collision groups**, **0 non-null organization owner mismatches**, and only `0040_enterprise_settings.sql` pending.
- Desktop and 390 px browser QA: **green**, with no console warnings.

## Production Settings/RBAC canary

The canary created an organization and starter project, persisted a governed `teal` category, passed rules CAS, listed all seven retention classes, and proved retention preview mutation-free. Invitation delivery was honestly reported as queued; acceptance succeeded once and exact replay returned HTTP 409.

The viewer could read the graph (HTTP 200) but was denied category editing, export, audit viewing, and key management (HTTP 403). Audit contained category, rules, and invitation actions under the exact request correlation ID and contained no invitation token. A real save returned HTTP 200 in accepted/processing state and produced two graph objects.

Source commit `9b2d2d81452b73abaa3fd33256b37a8778857bc5` deployed as deployment `08e0c041-6d56-4e90-a630-9ff25280c7a7`, version `9ed4826b-2149-40da-885e-a416208b06e5`, after bookmark `00000e44-00000000-000050c7-ca8add7d10c7bc4cc753b035b947993c` and successful migration/post-apply proof. Owner/viewer deletion and operator cleanup returned the database to the 14-user baseline with zero canary users and zero canary Settings/control-plane rows. Full redacted identifiers and cleanup counts are recorded in `ENTERPRISE_PRODUCT_FINAL_REPORT.md` and `ENTERPRISE_CLEANUP_LEDGER.md`; the delivery message identifies the separately committed evidence snapshot.
