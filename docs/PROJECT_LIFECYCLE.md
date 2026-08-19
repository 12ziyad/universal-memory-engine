# Project lifecycle — operator and API reference

Archive/restore, project-wide memory purge, permanent project deletion, and
ownership transfer. Session-only: none of these doors accept an API key, MCP
token, or path token.

## State model

```
ACTIVE → ARCHIVING → ARCHIVED → RESTORING → ACTIVE
ACTIVE | ARCHIVED → PURGING_MEMORY → ACTIVE
ACTIVE | ARCHIVED → DELETING → DELETED   (terminal)
```

`managed_projects.status` stays the coarse fence every deployed writer, DO
assertion, and resolver already enforces (`active`/`archived`); the fine state
lives in `lifecycle_state`, and `lifecycle_epoch` is the monotonic generation
fence every run binds and re-checks before each durable side effect. Ownership
transfer is a governance operation — no lifecycle state, epoch +1.

The default project is identity-bearing (its memory space IS the account
root): it can be purged, never archived, transferred, or deleted.

## API (session auth, `/v1/settings/lifecycle*`)

| Call | Purpose |
|---|---|
| `GET /v1/settings/lifecycle?projectId=` | State, epoch, revision, capabilities, active/recent runs, restorable archived shells. |
| `POST …/preview` | `{projectId, action}` → bounded counts + (destructive actions) an expiring confirmation token bound to actor, session, project, action, epoch, revision, inventory hash. |
| `POST …/execute` | `{projectId, action, idempotencyKey, token?, confirmName?}` → `202` with the run. Applies exactly the fence synchronously; convergence is background + cron. Same key replays the same run; a different key vs an active run → stable `409`. Destructive actions require the token and the typed project name. |
| `POST …/retry` | Resume a `failed_retryable` run. |
| `POST …/cancel` | Only before the fence (`accepted`/`pending`); afterwards the operation must converge — `409 cancel_unsafe`. |
| `POST …/transfer` | `{projectId, recipientUserId, expectedRevision}` — atomic, org-owner only, recipient must be an active member of the project's organization. |

Run statuses: `accepted → running → verifying → completed`, or
`failed_retryable` (resumable; auto-resumed by the 5-minute cron) /
`failed_terminal` / `cancelled`. Status payloads carry phase, bounded counts,
timestamps, and safe error codes only — never memory content.

## What each operation does

**Memory purge** (`project.memory.delete`): fence (status→archived, epoch+1) →
frozen registry inventory (registration is impossible while fenced;
discovery cross-checks provenance tables and fails closed on foreign or
conflicting spaces) → per-space: cancel work (`cancelled_by_delete`), vector
ledger→delete→verify absence (bounded chunks; Vectorize lag is a retryable
wait, not a success), converge-erase (barrier first, packet minimization,
episode hard delete, DO `resetAll`), census-table sweep, residual scan to
zero → full-project fixed-point verify → reopen ACTIVE with a fresh epoch.
Survives: project shell, membership, keys, settings, rules, categories,
registry, deletion barriers, minimized packet fences, content-free audit.

**Permanent delete** (`project.delete`, org owner): the purge above, then
control-plane teardown (project keys revoked + removed, members removed,
invitation project-grants cleared, categories/retention rows removed), the
registry removed only after the residual proof, a permanent content-free
tombstone, and the shell marked `deleted`. The `managed_projects` row is kept
forever — its unique `memory_owner_user_id` index is what reserves the
storage identity against any reuse. Replaying the delete returns the
terminal run; new lifecycle actions answer `410`.

**Archive** (`project.archive`): fence, terminally cancel in-flight jobs/runs
(`cancelled_by_archive`), quiesce every space's DO, verify quiet. Memory is
preserved untouched. Archived projects disappear from resolvers and the
selector (API access answers 404 by design — indistinguishable from absent);
the lifecycle surface lists them for restore. A cancelled pre-archive write
can never replay into an acceptance — even after restore, its exact replay is
refused with `source_write_erased`-shaped honesty; re-send as a new write.

**Restore** (`project.archive`): archived → restoring → active, epoch+1.
Identities (project id, memory owner, space hashes, vector ids) unchanged;
only fresh-epoch work runs.

**Transfer** (`project.transfer`, org owner): one audited D1 batch swaps
`owner_user_id`, pins `organization_id`, grants the previous owner project
admin, bumps the epoch — with commit-time fences re-proving the actor's
capability, the recipient's active membership, and the untouched
`memory_owner_user_id`. There is no zero-owner interval (single-column swap)
and nothing storage-related changes. Authorization is resolved per request,
so there is no cached grant to invalidate.

## Operator notes

- The 5-minute cron resumes interrupted and transiently failed runs; a run
  only reports `completed` after the residual scan proves every store empty.
- The schema census (`test/schema_census.spec.js` +
  `src/lib/lifecycle_census.js`) forces every new table to declare its purge,
  delete, and archive behavior before lifecycle tests pass.
- Time Travel bookmarks are for migration recovery only — never to restore
  customer-erased data after a successful deletion.
- Step-up/MFA reauthentication does not exist in the identity system;
  confirmation tokens instead bind to the actor's current session and expire
  in 10 minutes. This is a documented limitation, not an emulation.
