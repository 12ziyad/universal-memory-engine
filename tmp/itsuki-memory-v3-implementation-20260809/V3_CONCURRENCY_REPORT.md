# V3 CONCURRENCY REPORT

**Current status: PASS — final live Stage B, 2026-08-11.**

The valid preregistered run accepted ten concurrent subtenant writes and six
same-tenant/project burst writes with zero loss. Its identical-write race
converged to one packet, one episode, one extract job, one pass-2 job and one
capture run. Parallel recalls respected tenant, subtenant and project scopes;
delete-during-extraction drained in 40,713 ms with zero late residue. Recall
mean/p95 was 231.71/410 ms outside the soak and 399.41/1,285 ms during 200
bounded soak recalls. Full evidence: `final/STAGE-B-FINAL.md` and
`final/live/evidence/stage-b-live-reattack.json`.

The historical pre-credit-gate assessment below is retained rather than
rewritten.

**Historical status at initial campaign freeze: NOT RUN; cost-gate blocked.**

Campaign §41 targets V3-specific concurrency: same tenant, multi-tenant, project
mixes, episodes alongside semantic writes, parallel recall, reranking, source
expansion, delete during extraction, index lag. Every one of those needs real
ingests, and an ingest is an inference call.

## What IS established deterministically

The existing concurrency suites pass unchanged against the V3 code, and they
cover the paths V3 extends:

| suite | what it holds |
|---|---|
| `test/concurrent_enqueue.spec.js` | concurrent accepts lose and duplicate nothing |
| `test/concurrent_identical_content.spec.js` | identical content racing itself resolves to one write |
| `test/delete_during_enrichment.spec.js` | a delete landing mid-extraction cancels rather than publishes |
| `test/failed_replay_repair.spec.js` | a replay of failed work repairs instead of echoing an acceptance |
| `test/outbox_state_machine.spec.js` | randomized state-machine coverage of the delivery queue |

## What V3 adds that these do NOT yet cover

- Episode writes racing an erasure. `cleanup.js` counts episodes inside the
  convergence loop and re-deletes, and `test/source_episodes.spec.js` proves
  convergence for a *late arrival* deterministically — but not under real
  concurrency.
- FTS trigger behaviour under concurrent insert and delete on `source_episodes`.
- Recall at `limit: 200` under parallel load, where the per-lane candidate
  budgets are at their ceilings.

These are the first things to run when the gate opens — before any benchmark,
because a leak or a lost write invalidates every number that follows it.
