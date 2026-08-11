# V3-D13 implementation gates

Date: 2026-08-11

Status: **IMPLEMENTED AND LOCALLY VALIDATED; PRODUCTION REATTACK PENDING**.

## Repair

E7 recall no longer copies the complete scoped node/slice/edge corpus into the
Worker before applying its 200-candidate limits. `loadBoundedV3RecallCorpus`
performs tenant/project predicates before every SQL `LIMIT`, builds separately
bounded exact/FTS/assertion/temporal/vector/graph lanes, fuses candidate
identities fairly, and hydrates only a bounded evidence closure. A failed lane
can fall back only to another bounded lane or bounded recent candidates; it
cannot trigger the legacy full-corpus scan.

The repair is nested under the existing account-scoped E7 hybrid flag. The
legacy path is unchanged for accounts outside that nested flag. There is no
migration or binding change and no inference was used for implementation or
scale validation.

## Exact gates

| gate | result |
|---|---:|
| Focused bounded/hybrid/source/scope regressions | 12 files / 71 tests PASS |
| Exact focused rerun | 4 files / 19 tests PASS |
| Full Worker gate | 111 files / 1,313 tests PASS |
| Unit/cross-door gate | 33 files / 539 PASS + 1 intentional skip |
| `npm audit --audit-level=low` | 0 vulnerabilities |
| Wrangler 4.120.0 dry deploy | PASS |
| Additive migration / binding change | none |

Machine-readable full-gate reports are
`evidence/d13-worker-gate.json` and `evidence/d13-unit-gate.json`.

Production deployment, exact live reattack and cleanup are required before the
HIGH defect can be closed.
