# Stage E LoCoMo activation

Date: 2026-08-12

## Frozen code and configuration

- Harness commit/origin: `073e6526ff473241d1d18b28dad6a43496db6045`.
- Activation commit/origin: `517c36db5a6127f8613a08a65b1c92aab7ad92e8`.
- Product input SHA-256:
  `e9818f2070e6b5a4860e3a7e0cbd706433a0c95c00049980f405fe34cccf10dd`.
- Exact config verifier: PASS. Parent V3 allowlist 30; accepted capture,
  projection, and source-expansion lanes contain only the control ten; hybrid
  retrieval contains the historical d04 ten plus the control ten. Coalescing,
  episode fallback, adaptive context, and extraction B1 remain OFF.
- Normal users and the rejected treatment ten remain outside every activated
  nested lane.

## Gates

- Atomic capture/projection, hybrid retrieval, and source expansion: 4 files,
  45 tests PASS.
- Parent V3 flag and searchable source episodes: 2 files, 59 tests PASS.
- Total focused assertions: 104 PASS.
- Wrangler 4.120.0 dry deployment: PASS; no binding or migration change.
- No benchmark/judge process and no global benchmark lock existed before
  activation.

## Production activation

- Deployment ID: `825157fb-1456-4c99-9c4d-1ad41dca93cd`.
- Worker version: `6781ae37-c8cf-4a2e-a3fb-ea9178d1b924` at 100% traffic.
- Uncached propagation: 10/10 `itsuki.app` and 10/10
  `uml.gpmai.workers.dev` returned the exact active Stage E state.
- An earlier propagation sample was mixed (18/20 current, 2/20 prior safe
  config); no ingest began. The required subsequent sample passed 20/20.
- No inference occurred during testing, deployment, or propagation. Settled
  campaign burn remained 1,933,582 / 3,000,000 before activation.

The only authorized next action is the preregistered one-shot Stage E run.
