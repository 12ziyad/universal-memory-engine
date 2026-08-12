# Stage E terminal production closure

Date: 2026-08-12

Stage E is final. The frozen product and complete official score are retained;
the semantic judge is terminally incomplete because the hard Stage E spend
guard fired. No Stage F/G, retuning, replacement run, cap change or additional
inference is authorized.

## Production-safe state

- Product commit/origin: `2816395`.
- Worker version: `a38142b9-842a-4c4c-83bf-41f68d5e205d` at 100% traffic.
- Deployment ID: `dc96a1df-0b65-497b-a674-f8ac9f90b5f6`.
- Parent V3 remains an explicit 30-account campaign allowlist; normal users are
  not selected.
- Atomic capture, atomic projection and source expansion are OFF with empty
  allowlists.
- Rejected coalescing, episode fallback and adaptive context remain OFF with
  empty allowlists.
- Hybrid retrieval is restored to only the historical d04 ten.
- Focused feature/episode gates pass 104/104; Wrangler 4.120.0 dry deployment
  passes; no binding or migration changed.
- Twenty uncached production checks across `itsuki.app` and the workers.dev
  domain returned the exact same terminal-safe state.

## Data cleanup

The ten Stage E tenants have zero live/derived state, zero FTS rows, zero recall
and export results, zero packet-content rows and zero nonterminal jobs. All
2,096 retained packet fences are minimized. Authoritative data proof:
`evidence/cleanup.json`. Authoritative propagation proof:
`evidence/terminal-production-closure.json`.
