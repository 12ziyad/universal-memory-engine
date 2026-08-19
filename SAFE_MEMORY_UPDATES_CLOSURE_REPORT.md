# Safe memory updates — final closure report

Date: 2026-08-19 · Supersedes `SAFE_MEMORY_UPDATES_CORRECTIVE_REPORT.md` for the
three blockers it did not close.

## Verdict

**GO for the platform** (Worker, D1, REST, MCP, dashboard, Python SDK).
**HOLD on two npm publications** — externally blocked, verified this session.

Every blocker was reproduced with a deterministic failing test on the current
baseline before any code changed, fixed, and re-proved in production against
disposable tenants.

## Evidence classes

| Class | Meaning |
|---|---|
| **PROD** | Proven on itsuki.app this session with disposable tenants |
| **TEST** | Deterministic test against real D1 in the Workers pool |
| **SIM** | Exercised against a controllable double (fake Vectorize) |
| **BLOCKED** | Externally blocked; not claimed |

## Baseline verified before editing

| Fact | Value |
|---|---|
| Git commit at start | `3bff0abb0bd1c796e7ce2037cde24eff25f54cd0` (clean, == origin/master) |
| Production Worker at start | `2e16c08d-943e-4b91-8eac-d0894b5c8b86` |
| Flag at start | `SAFE_MEMORY_UPDATES=on` |
| D1 | `uml-memory` / `3202df08-e568-4e53-a8cd-a85630db50f8` |
| Vectorize | `uml-node-embeddings` |
| Migrations applied | 0047, 0048 |
| npm | `itsuki@0.2.1`, `n8n-nodes-itsuki@0.1.0` |
| PyPI | `itsuki@0.4.1` |

## Safety action (taken before any fix)

The doors were open and three live defects reproduced, so the first deploy of
this campaign closed them:

- Safety Worker **`f275db9e-3bf6-42d2-a67a-b2f95ebbcbab`**, `SAFE_MEMORY_UPDATES=track`.
- Revision tracking stayed live; migrations untouched; no rollback to an
  unversioned Worker.
- Verified: health 200, doors `feature_disabled`, save→recall healthy (PROD).

## Blocker 1 — commit-time credential revocation — CLOSED

**Was:** the guard proved organization/project MEMBERSHIP but never the
credential. A token revoked, scope-narrowed, or rebound between preflight and
commit still committed. The corrective report cited a production 401 as proof;
that 401 came from the **preflight** auth layer, so the evidence was real but
proved a different proposition than the one claimed.

**Now:** `applyMemoryChange` carries a credential identity and re-proves the
exact `connection_tokens` / `sessions` row inside the committing batch —
status, `revoked_at`, session expiry, current scopes, and project binding.
Absence is never permission. Wired through REST and MCP.

- TEST: active credential commits (control); revoked / scope-narrowed / rebound / deleted each abort atomically, leaving head content, revision, history, idempotency claim, projection state and audit outcome unchanged.
- PROD: C3 update while authorized → 200; C4 revocation confirmed by response body; C5 the same credential refused **401**.

A schema mismatch in my first attempt (`connection_tokens` has no `expires_at`)
was caught by the control test, not by review — recorded because it is the
class of error this campaign exists to eliminate.

## Blocker 2 — fail-closed CAS for every semantic writer — CLOSED

**Was, in four distinct ways:**
1. `pages.js` and `mcp_engine.js` used `(? IS NULL OR revision = ?)` — a fence a NULL bind switches off, precisely when staleness is most likely.
2. `mcp_engine.js` turned a failed revision read into an unfenced NULL write.
3. `pass2.js` selected **no** revision, so its CAS fell back to r1 and silently no-opped on every r2+ node. **This was a regression introduced by the previous corrective campaign** and its 1,973-test suite did not catch it.
4. No writer inspected the affected-row count, so a lost CAS reported success and settled dependent work.

**Now:** legacy NULL revision is compared as logical r1; a failed revision read
fails the job closed and retryable; `pass2` reads and CASes its observed
revision; and `applyFencedUpdate()` turns a zero-row CAS into a refusal the
caller must read. `retention` no longer deletes a node's search profile when its
CAS lost.

The census is now a real gate — it detects nullable fences and unchecked results,
not merely missing ones:

**8 statements checked · 0 unfenced · 0 nullable · 0 unchecked.**

- TEST: stale regeneration loses; uncontended r2+ regeneration still works (the regression); census clean.
- PROD: C6 user edit lands; C7 the edit **survived** real background extraction.

### Blocker 2b — user-authored content (found by this campaign's canary)

The canary's C7 failed on the first run. The deterministic split proved the
stale path was already fenced correctly and the cause was different: a **fresh**
regeneration — recomputing from newly committed facts — is not stale, so no
revision CAS can catch it, and it was silently replacing summaries users had
just corrected.

Automatic summary regeneration now defers while the stored text is text a user
typed, matched against their own recorded revision snapshots. Matching on text
rather than a revision number is order-independent, so unrelated revision bumps
cannot release the pin, and regeneration resumes on its own once the user rolls
back to machine-written text — asserted by a test, so this is not a permanent
freeze.

- TEST: stale loses · fresh defers · regeneration RESUMES after rollback.
- PROD: C7 `survived=true`.

## Blocker 3 — Vectorize async ordering and complete deletion — CLOSED

**Was:** cleanup enumerated a fixed 20-revision window and `deleteObject` passed
only the bare object id, so gapped artifacts (`#r25`, `#r50`) survived canonical
deletion — deleted customer content persisting in a search index.

**Now:** migration **0049** adds `memory_vector_artifacts`, a durable ledger of
every physical vector id submitted, with revision and provider mutation id.
Content-free by construction.

- Deletion enumerates the ledger by **keyset** — no fixed window, no OFFSET, no assumption that revisions are contiguous — and includes the legacy bare id.
- A ledger row is retired **only** after a post-delete readback confirms absence, so an upsert that becomes visible *after* deletion is still listed and removed by the reconciler.
- A provider failure leaves rows in place and retryable; nothing claims a deletion the provider did not accept.
- Registered in the lifecycle census, purge, and version-residue table lists.

- TEST/SIM: bare + r1 + r2 + gapped r25 + r50 all removed; a delayed upsert appearing after deletion is reconciled away.
- TEST: a deleted node's own text leaves the search projection, its read 404s, the inventory will not surface it, and an unrelated live node is untouched.
- PROD: C10–C13 — deleted, unreadable, history erased, nothing resurfaced in recall; C8 vector projection converged `submitted → ready`.

## Test evidence

| Suite | Result |
|---|---|
| `memory_updates_closure.spec.js` | 11 — each written failing first on the baseline |
| `memory_updates_user_authored.spec.js` | 3 |
| `memory_updates_corrections.spec.js` | 20 |
| `memory_updates.spec.js` + `_rbac` + `_ui` | 45 |
| Unit config (incl. migration append-only, schema census) | 602 passed, 1 intentional skip |
| Python SDK | 154 |
| n8n package | 52 |
| JS SDK contract | 35 |

**Final full suite:** commit `d70400b` (last source commit, clean worktree
verified before the run) — **153 files / 1,987 tests passed, exit code 0, zero
failures.** The only commit after that run is this report, which changes no
shipped code (`git diff --stat` shows documentation only).

## Deployment record

| Stage | Worker | Purpose |
|---|---|---|
| Safety | `f275db9e-3bf6-42d2-a67a-b2f95ebbcbab` | Doors closed the moment blockers reproduced |
| Corrected, track | `b9c0f6cc-4eba-4812-9a41-9d2f4f32167c` | Soaked with doors closed |
| Doors enabled | `f63654c5-698b-446d-87bd-e48055c72735` | First enabled run (canary found 2b) |
| **Current** | **`0afd4dae-1521-439d-a779-5b5a425ecace`** | Includes the user-authorship fix |

- Migration **0049** applied through Wrangler; pending list now empty.
- D1 Time Travel bookmark before migration: `00001513-00000000-000050cc-a6bae8c9c2d53f03c16d5bdbe4a7ffd3`.
- Track soak on the corrected tree: health 200, doors `feature_disabled`, save→recall healthy, revision tracking live (probe reached r2).
- **Rollback position:** this same tree with `SAFE_MEMORY_UPDATES=track`. Trackers keep running under rollback, so no unversioned-mutation window can open.

## Production canary — 19/19

Disposable account, project and credentials. Evidence persisted is content-free
by construction: case ids, status codes, counts, booleans, timestamps. No
passwords, tokens, cookies, emails, request bodies, memory text or reasons are
written to disk; cleanup runs in the same process.

Cleanup: purge terminal, memory space empty, all credentials revoked (verified
401), sessions closed. Four older canary files containing plaintext credentials
from previous campaigns were shredded.

## Packages

| Artifact | State |
|---|---|
| `itsuki` (PyPI) 0.4.1 | **PUBLISHED**, unchanged — correct, not republished |
| `itsuki` (npm) 0.3.0 | **HOLD — BLOCKED.** Reaches the publish step, fails `ENEEDAUTH`. Registry still serves 0.2.1 |
| `n8n-nodes-itsuki` (npm) 0.2.0 | **HOLD — BLOCKED.** Same, verified this session. Registry still serves 0.1.0 |

The previous report's npm HOLD was asserted from a run that had died on a
version gate **before** reaching auth. Both were re-dispatched from the
corrected commit this session and genuinely reach the publish step, so the HOLD
is now evidence-backed.

**Four** version literals were found one at a time — package.json, the runtime
export, the TypeScript declaration, and finally the tarball probe. Both the
probe and the workflow gate now assert **agreement** between declarations rather
than matching a maintained constant, so a bump cannot outgrow them again.

JS SDK packaging proven: `npm pack` → clean install from the tarball → installed
version and runtime `VERSION` agree at 0.3.0 → all six methods present
(`updateMemory`/`memoryHistory`/`rollbackMemory` plus retained short aliases) →
a strict TypeScript consumer compiles with `skipLibCheck` disabled. n8n:
lockfile corrected to agree at 0.2.0, build + 52 tests + pack clean.

No live surface advertises either unpublished version.

## Remaining risks

1. **npm publications — external.** Configure npm Trusted Publishing for both packages, then re-dispatch `publish-js-sdk.yml` and `publish-n8n-node.yml` unchanged. Owner action; not something this campaign can complete.
2. **Real n8n host run** of the three operations follows the npm release. Currently execute-level tested only.
3. **Vectorize reordering is SIM.** Delayed, duplicated and reordered completion are proven against a controllable double. Live convergence was observed in production (`submitted → ready` at the correct revision), but deliberately reordering real Vectorize mutations was not forced.
4. **Dashboard browser canary** was not re-run against this build; UI behaviour is covered by 11 deterministic tests. TEST, not PROD.
5. **History storage remains unbounded** until object deletion — stated and measured via `total_revisions`, deliberately not pruned so nothing offered as rollbackable disappears.
