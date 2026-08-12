# Itsuki Memory V3 public-beta activation

Date: 2026-08-12

## Authorization and scope

The owner authorized the validated Memory V3 architecture for all accounts as
a low-volume public beta, with approximately 5–10 early users expected. This is
an operational rollout after the completed V3 validation campaign, not a new
benchmark or architecture experiment.

## Pre-deployment boundary

- Repo/origin: `920e4dcc8780b857559752f294f43c8afcec288e`.
- Deployment: `dc96a1df-0b65-497b-a674-f8ac9f90b5f6`.
- Worker version / rollback target:
  `a38142b9-842a-4c4c-83bf-41f68d5e205d`.
- Parent V3: allowlist, 30 synthetic campaign accounts.
- Atomic capture/projection and source expansion: OFF.
- Hybrid retrieval: allowlist, historical ten.
- All migrations applied; no migration is required for activation.

## Authorized production shape

- Parent V3: ON for every valid account.
- Atomic capture: ON.
- Atomic projection: ON.
- Hybrid retrieval: ON.
- Exact source expansion: ON.
- Extraction B1: OFF (rejected).
- Atomic coalescing: OFF (rejected).
- Episode fallback: OFF (rejected).
- Adaptive context: OFF (rejected).
- Reranking: absent from the production path (rejected).

The rollout uses direct first-party Workers AI bindings already validated by
the campaign. It adds no schema change, no migration, no credential change and
no AI Gateway or partner-provider route.

## Deployment result

- Commit/origin: `9d01dcdefde76102c72e3fabe24449dc1387c4ac`.
- Deployment: `d6d6e7f2-55e7-4993-8df8-51e69f69771b`.
- Worker version: `e3391f6d-3b14-4091-8297-52d44053a693` at 100% traffic.
- `itsuki.app`: 10/10 uncached health checks returned the exact authorized
  public-beta flag bundle.
- `uml.gpmai.workers.dev`: after one ordinary propagation-lag response from the
  prior version, 6/6 uncached convergence checks returned the exact bundle.
- Current production modes: parent V3, atomic capture, atomic projection,
  hybrid retrieval and exact source expansion ON; extraction B1, coalescing,
  episode fallback and adaptive context OFF.
- Rollback target remains Worker
  `a38142b9-842a-4c4c-83bf-41f68d5e205d`. No storage resource or schema changed,
  so behavioural rollback does not require data repair.
- Activation used no synthetic product write and no inference call.

**Result: PUBLIC BETA ACTIVE.** This validates configuration and propagation,
not a high-volume ingestion SLA. The expected first cohort remains 5–10 users.

## Pre-deployment gates

- Focused V3 flag/write/read suites: 8 files, 98/98 pass.
- Complete Worker pool: 112 files, 1,325/1,325 pass.
- Host/unit/cross-door: 33 files, 539 pass, one intentional skip.
- Dependency audit: zero vulnerabilities at `low` severity or above.
- Remote migration list: no migrations to apply.
- Wrangler 4.120.0 dry deployment: PASS; bindings unchanged and exact flag
  modes recognized.
- Repository whitespace check: PASS apart from the owner's pre-existing
  `AGENTS.md` line-ending warning; that file is outside this change.

The first complete Worker command was interrupted by a four-minute host command
timeout before Vitest emitted a verdict. It left no test process behind. The
exact clean rerun completed 1,325/1,325; the interrupted attempt is not counted
as product evidence.

One first convergence helper constructed an invalid local URL and made no
request; its six null rows were discarded as harness output. The corrected
workers.dev probe is the authoritative 6/6 evidence above.
