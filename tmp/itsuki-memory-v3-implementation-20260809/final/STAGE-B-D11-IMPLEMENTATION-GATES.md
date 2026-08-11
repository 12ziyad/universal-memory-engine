# Stage B V3-D11 implementation gates

- Production reproduction: the exact post-erasure recall returned **409
  `idempotency_conflict`** and named the retained source packet.
- Failing-first: `source_episodes.spec.js` **31 pass / 1 fail** at the expected
  `409` versus `200` assertion.
- Exact rerun: **32/32 pass**. The adjacent erased-write replay test still
  requires non-retryable `409 source_write_erased`.
- Focused erasure, replay, ingest, recall, rules and project regressions:
  **14 files / 195 tests pass**.
- Full Worker gate: **110 files / 1,311 tests pass**.
- Unit/cross-door gate: **33 files / 539 pass / 1 intentional skip**.
- `npm audit`: **0 vulnerabilities** across the installed dependency graph.
- Wrangler 4.120.0 dry deployment: **pass**; no migration or binding change.
- Invalid Stage B replacement state was erased through the public product
  contract. Production-primary verification found zero live memory/jobs and
  **642/642** retained packet fences content-free.
- Production deployment, exact reattack and the unchanged clean Stage B run
  remain mandatory before V3-D11 can close.
