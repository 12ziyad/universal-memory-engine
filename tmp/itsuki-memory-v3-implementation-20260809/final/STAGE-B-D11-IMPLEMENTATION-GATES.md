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
- Commit/origin: `183d540184e3e355e2bf99b82cfdc43ee5fb648e`.
- Production version: `345cd4d7-c680-4e16-9a99-2fe59baa33bc`;
  deployment `1b13b0e9-68ae-4520-8353-33a27b1a343d`, 100% traffic.
- Propagation: **20/20 pass** across `itsuki.app` and the workers.dev domain,
  with the exact treatment-only Stage B flags unchanged.
- Production reattack: identical post-erasure recall **200**, erased write replay
  non-retryable **409 `source_write_erased`**, second identical post-erasure
  recall **200** with the same packet identity.
- Final production-primary cleanup: zero live memory/jobs and **643/643**
  retained packet fences minimized/content-free. V3-D11 is closed; the
  unchanged clean Stage B run remains mandatory.
