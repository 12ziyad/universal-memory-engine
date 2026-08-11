# Stage D treatment-cohort activation

## Pre-deployment gate

- Base repo/origin: `b03d1fc01bca6dcc5619a2a2366c9f4d030e5794`.
- Production before state: Worker `052d9b68-b131-45cb-b792-1804c86a50d6`;
  parent V3 allowlist 30, historical E7 ten, all write/source/rejected lanes OFF.
- Change is configuration only. No migration, D1 schema, binding, model, prompt or
  product-code change.
- Exact active cohort: treatment ten for atomic capture, governed projection and
  E9A source expansion; E7 is historical d04 ten plus treatment ten (20 total).
- E2-B1, coalescing, reranking, E9B and E10 remain OFF; every nested id belongs
  to the parent 30; frozen control ten remains outside all nested lanes.
- Durable config verifier: PASS.
- Focused feature/isolation regression: 4 files / 51 tests PASS.
- Wrangler dry deploy: PASS; no binding or migration delta.
- Billing guard: 11/11 first-party `partner=false`, no AI Gateway; no inference
  was used by this activation gate.

The first focused command selected `.test.js` names in a `.spec.js` repository
and therefore ran zero tests; it is invalid and unscored. The exact discovered
four `.spec.js` files were then run and passed 51/51.

## Production apply

Pending the commit/push boundary. This section is updated with the exact Worker
version, deployment id, propagation checks and live health proof after apply.
