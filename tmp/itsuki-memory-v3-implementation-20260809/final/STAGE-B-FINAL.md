# Final Stage B — live security, concurrency and soak

**Verdict: PASS**

**Valid run:** 2026-08-11T17:08:02.788Z to 2026-08-11T17:14:07.538Z

**Evidence:** `live/evidence/stage-b-live-reattack.json`

The preregistered live reattack completed from a clean ten-tenant treatment
cohort after V3-D10, V3-D11 and V3-D12 were closed through failing-first,
repair, regression, deploy and production reattack lifecycles. Invalid earlier
runs remain explicitly invalid and were not scored.

## Measured result

- Ten parallel subtenant writes and six same-tenant/project burst writes had
  **zero accepted loss**. The identical-write race converged to one packet, one
  episode, one extraction job, one pass-2 job and one atomic capture run.
- Tenant, subtenant, project-only and project-then-global persistence and recall
  boundaries all passed. All ten eligible recalls used their own exact source
  expansion; no sibling project or tenant marker crossed scope.
- Eleven secret/rules persistence audits and three path-aware export audits
  passed. Rules configuration was unchanged; no raw shadow archive, episode
  vector lane or reranker was active.
- The bounded soak completed 10 writes and 200 recalls, drained backlog, held
  recall mean/p95 at **399.41 / 1,285 ms**, then observed a 30-second stability
  grace. The maximum rendered context was 8 items / 1,100 characters against
  hard bounds of 200 items / 24,000 characters.
- Delete-during-extraction drained in **40,713 ms**. Erased replay returned
  `409 source_write_erased`; late residue was zero; a genuinely new post-delete
  write succeeded. Ten post-erasure recalls returned zero items.
- Final FTS/content audit checked 34 markers: episode FTS, semantic FTS and
  packet content hits were all zero. Final episode, candidate, capture,
  projection, graph, staging and non-terminal-job counts were all zero.
- Mean ingest/recall latency was **1,625.5 / 231.71 ms**; recall p95 was
  **410 ms**. The valid run consumed **2,227 neurons**, from 1,912,019 to
  1,914,246 / 3,000,000, entirely on permitted first-party Workers AI.

## Defect closure carried into this verdict

- **V3-D10 HIGH:** rules-excluded packet shadow-copy — CLOSED.
- **V3-D11 HIGH:** minimized query packet blocked valid future recall — CLOSED.
- **V3-D12 HIGH:** capture claim could survive a delete barrier — CLOSED.
- **V3-H11/H12/H13:** harness accounting, race polling and final-audit ordering
  defects — CLOSED; affected runs remain invalid.

Stage B therefore establishes the final candidate's live security, isolation,
erasure, replay, bounded concurrency and bounded-soak claims. It does not by
itself establish the 1k/10k/100k scaling frontier, repeated holdout variance or
final complete LoCoMo score; those remain later preregistered stages.
