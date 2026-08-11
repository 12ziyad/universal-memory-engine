# Stage B V3-D10 implementation gates

- Failing-first: `source_episodes.spec.js` **29 pass / 2 fail**.
- Exact rerun: **31/31 pass**.
- Focused rules, replay, erasure, race, crash and ingest regression:
  **15 files / 201 tests pass**.
- Full Worker gate: **110 files / 1,310 tests pass**.
- Unit/cross-door gate: **33 files / 539 pass / 1 intentional skip**.
- `npm audit`: **0 vulnerabilities** across 328 dependencies.
- Wrangler 4.120.0 dry deployment: **pass**; no migration or binding change.
- The stale `vitest.unit.config.js` invocation failed before loading tests; the
  repository-authoritative `vitest.unit.config.mjs` command produced the valid
  539-pass result. This is invocation evidence, not a product result.
- Production deployment and reattack: **pending**.
