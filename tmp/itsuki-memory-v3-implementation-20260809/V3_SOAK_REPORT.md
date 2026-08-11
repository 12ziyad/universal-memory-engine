# V3 SOAK REPORT

**Current status: PASS — bounded final live Stage B soak, 2026-08-11.**

The valid run completed ten writes plus 200 recalls, drained the backlog, then
held a 30-second stability grace. Before cleanup it contained 31 episodes, 30
candidates, 30 capture runs, 30 projections, 42 nodes, 59 slices and two
events, with zero live staged or non-terminal jobs. Recall mean/p95 was
399.41/1,285 ms. Cleanup and the later erasure reattack ended with zero live V3
state and zero episode/semantic FTS or packet-content hits across 34 markers.
Full evidence: `final/STAGE-B-FINAL.md` and
`final/live/evidence/stage-b-live-reattack.json`.

This is a bounded production soak, not a substitute for Stage C's local
1k/10k/100k scaling frontier.

The historical pre-credit-gate assessment below is retained rather than
rewritten.

**Historical status at initial campaign freeze: NOT RUN; cost-gate blocked.**

Campaign §42 asks for endurance sufficient to expose episode accumulation, index
growth, late writes, cleanup issues and ranking degradation, then proof that
removing pressure drains the backlog, erases synthetic data, and returns latency
and resources to baseline.

Every phase of that requires sustained real ingests. Zero inference calls were
made during this campaign, so no soak was performed and none is reported.

## What is known about growth without running one

| surface | bound |
|---|---|
| episodes per accepted write | ≤ 40 rows (`EPISODE_MAX_ROWS_PER_WRITE`); the wire contract already caps a batch at 30 messages |
| characters per episode | ≤ 4,000 (`EPISODE_TEXT_CAP`) |
| episode search per query | ≤ 50 rows (`EPISODE_SEARCH_MAX`); the evidence budget decides how many are used |
| recall candidates per lane | Vectorize topK ≤ 100 · BM25 ≤ 200 · graph expansion ≤ 200 |
| rendered context | ≤ 24,000 characters, absolute |
| event scan | ≤ 4,000 rows |
| extraction sub-chunk | ≤ 8 messages **and** ≤ 6,000 characters |

Production storage delta so far is exactly three nullable columns and one empty
table. `source_episodes` cannot grow until an account is selected for
`ITSUKI_MEMORY_V3`, and none is.

## The one soak number that already exists

D1 reported `rows_written_24h = 233,552` and `rows_read_24h = 4,611,678` for
`uml-memory` at migration time — the live system's own load, unrelated to this
campaign. Recorded because a soak plan should start from what the database is
already doing, not from zero.
