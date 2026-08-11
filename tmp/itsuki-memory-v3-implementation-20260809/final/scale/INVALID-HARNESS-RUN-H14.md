# V3-H14 invalid Stage C aggregate

Date: 2026-08-11

`evidence/stage-c-scale-final.json` is retained but **INVALID / UNSCORED**.
All three child processes exited zero, but Vitest intercepted stdout for passing
tests, so the aggregate parser received no cell result and correctly failed
`allArtifactsPresent`. This is not product evidence.

The harness now uses `disableConsoleIntercept: true`. An intermediate filename
containing `-v2` was then blocked by the already-recorded ReasonLabs filename
filter (V3-I01) and produced no artifact. The filter-safe exact rerun wrote
`evidence/stage-c-scale-repaired.json`; all three cells and every aggregate gate
passed. No inference or production mutation occurred in any run.
