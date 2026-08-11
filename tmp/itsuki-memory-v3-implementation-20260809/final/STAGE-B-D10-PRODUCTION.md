# Stage B V3-D10 production closure

- Code commit/origin: `3148a9c1dc3fb5f147a5234eb5119156f06d5b80`.
- Worker version: `b0dfbaca-3807-4e18-8e66-b2d01ff5d468`.
- Deployment: `26d82115-74df-47a0-89fa-cb8c32b6ed0d`, 100% traffic.
- No migration or binding change.
- Health propagation: 20/20 exact across `itsuki.app` and
  `uml.gpmai.workers.dev`; nested treatment-only flags unchanged and normal
  users excluded.
- Targeted live reattack: PASS for request-scoped rules, packet persistence,
  source episode admission, semantic/staging exclusion, recall, export, generic
  secret audit, unscoped erasure and anti-resurrection replay.
- Erasure retained only the minimal content-free idempotency fence and returned
  non-retryable `409 source_write_erased` for the exact old key.
- Final production-primary audit: 622 packet rows, 622 minimized, zero packet
  content rows, zero episodes, atoms, projections and non-terminal jobs.
- Billing preflight: 11 configured models first-party and `partner=false`; no
  AI Gateway. Latest settled campaign snapshot 1,906,099/3,000,000 neurons.
- Verdict: **V3-D10 HIGH CLOSED**.
