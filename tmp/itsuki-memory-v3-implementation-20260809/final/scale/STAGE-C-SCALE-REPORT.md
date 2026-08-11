# Final Stage C long-history scale report

Date: 2026-08-11

Authoritative artifact: `evidence/stage-c-scale-repaired.json`.

## Verdict

**PASS LOCALLY.** The isolated production-schema 1k/10k/100k cells used zero
inference and no production fixture. Every cell passed scope, final result and
context bounds, raw-load bounds, exact source expansion, product deletion, and
episode/manual-FTS erasure. Final fixture state was zero.

| rows | target recall | broad recall | common FTS | product delete | max node/slice/edge load |
|---:|---:|---:|---:|---:|---:|
| 1,000 | 619 ms | 1,490 ms | 4 ms | 113 ms | 600 |
| 10,000 | 518 ms | 1,460 ms | 14 ms | 502 ms | 600 |
| 100,000 | 1,356 ms | 2,596 ms | 130 ms | 4,910 ms | 600 |

At 100k, broad recall improved from 510,978 ms failing-first to 2,596 ms,
approximately **196.8x**, while the raw evidence closure stayed fixed-size.
Every target context contained its in-scope anchor and excluded the sibling
project canary. Final output remained at most 200 items and 24,000 characters.

This validates the repair locally; it does not close V3-D13 until the unchanged
code passes deployment propagation and an exact production reattack.
