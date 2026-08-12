# V3 HOLDOUT REPORT — non-LoCoMo general memory

**Final repeated-holdout verdict: PASS (2026-08-11; retained as terminal
generalization evidence).**

Three independent fresh accepted-path seeds produced mean judge **95.24%**,
token-F1 **69.60%**, evidence availability **96.83%**, conditional accuracy
**96.71%**, capture recall **78.18%**, precision **96.59%**, and capture F1
**86.39%**. Per-seed judge was 100.00% / 92.86% / 92.86%; all 126 answers and
verdicts reconciled, all safety/accounting gates passed, and cleanup was zero
after every seed. Full evidence: `final/holdout/STAGE-D-FINAL.md`.

**Status: ACTIVE — measured through E9B; E10 and final repeated holdout are pending.**

**2026-08-11 authoritative update: measured through E10; final repeated
holdout remains pending.** The older status line above is retained as history.

Latest paired read result on one sealed holdout state:

| Metric | E7 control | + E9A exact source |
|---|---:|---:|
| judge | 40/42 (95.24%) | **41/42 (97.62%)** |
| token-F1 | 65.38% | **72.83%** |
| evidence availability | 40/42 (95.24%) | 40/42 (95.24%) |
| conditional | 38/40 (95%) | **40/40 (100%)** |
| recall p95 | 40 ms | 50 ms |

This is a valid paired source-expansion attribution, not the final repeated
holdout verdict. Full evidence: `e9/E9A-SOURCE-EXPANSION-RESULT.md`.

The subsequent E9B cell kept E7+E9A fixed and added bounded episode FTS
fallback. Control and treatment both scored 41/42 judge, 40/42 availability and
40/40 conditional. E9B rendered zero evidence and increased recall p95 68 ->
109 ms, so it is REJECT. Full evidence:
`e9b/E9B-EPISODE-FALLBACK-RESULT.md`.

E10 then held the broad architecture fixed and changed only assertion rendering
on one newly sealed state. It compressed mean context 30.45%, but judge fell
39/42 -> 37/42 and evidence availability fell 41/42 -> 35/42. E10 is REJECT
and its frozen-399 confirmation was not run. This is important generalization
evidence: reducing context is not a win when it removes source-backed facts.
Full evidence: `e10/E10-ADAPTIVE-CONTEXT-RESULT.md`.

The final repeated holdout must validate the accepted E4/E5/E6 + E7 + E9A
candidate across independent write seeds. No E10 result is part of that winner.

The historical cost-gate status below is retained as superseded context.

## The holdout

Frozen **before** any V3 architecture change (campaign §3), authored for this
campaign, containing no LoCoMo content, phrasing, names or reference answers.
Hash-frozen in `holdout/holdout.sha256`; manifest in `holdout/manifest.json`.

| | |
|---|---|
| scenarios | 10 |
| messages | 84 (78 user) |
| expected atoms | 58, of which **55 must be captured** |
| questions with answers | 42 |
| temporal targets | 16, of which **3 must resolve to nothing** |
| negatives (must NOT be captured) | 21 |
| state expectations | 9 |
| entity expectations | 3 |

All 17 axes the campaign lists are covered: coding decisions, architecture
facts, preferences, personal information, relationships, events, explicit dates,
relative dates, goals, plans, procedures, quantities, corrections, single-valued
updates, multi-valued facts, long sessions, noisy conversational details.

**Inputs and references live in physically separate directories.** The build
script fails if a reference key leaks into an input file, or if any message is
byte-equal to a reference answer.

## What ran — temporal targets: 16/16 PASS

`test/temporal_holdout.spec.js`, driven directly off the frozen references.
They were written before `src/pipeline/temporal.js` existed, so this is a
genuine held-out check rather than a restatement of the implementation.

The three that must NOT resolve — "someday", "eventually", "in a while" — pass
as well. That direction matters more than the other thirteen: a memory system
that invents a date for "someday" will rank it, and a reader will believe it.

## What did not run

| portion | needs | blocked by |
|---|---|---|
| Capture coverage (55 must-capture atoms) | ingest + extraction | cost gate |
| Negative capture (21 must-not-capture) | ingest + extraction | cost gate |
| Question answering (42 questions) | recall + reader | cost gate |
| State expectations (single- vs multi-valued) | ingest + extraction | cost gate |
| Entity expectations (merge / never-merge) | ingest + extraction | cost gate |

## The acceptance rule this exists to enforce

Campaign §56: **if LoCoMo rises while this holdout degrades, V3 is not
accepted.** Neither number exists yet, so that test has not been applied and
V3's general-memory quality is unmeasured. Said plainly rather than implied by
the components' test coverage.
