# Itsuki Stage 3 Enterprise Settings and RBAC Report

Status: implementation and predeployment release gates complete; production migration, deployment, and canaries remain pending.

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

The end commit, recovery bookmark, migration apply/post-apply result, end Worker deployment/version IDs, production canaries, and cleanup evidence remain explicitly pending in `ENTERPRISE_PRODUCT_FINAL_REPORT.md`.
