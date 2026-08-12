# Stage E terminal production closure

Date: 2026-08-12

Stage E is final. After the owner raised only the Stage E cap from 500,000 to
550,000 neurons, the exact frozen semantic-judge tail resumed by identity and
completed 1,540/1,540 rows. The global 3,000,000-neuron ceiling did not change.
No re-ingest, answer regeneration, completed-row rerun, retuning, Stage F/G or
new experiment occurred. No additional inference is authorized.

## Final measurement

- LLM-judge: **60.45% (931/1,540)**.
- Official token-F1: **36.08%**.
- Evidence availability: **73.77% (1,136/1,540)**.
- Conditional accuracy: **71.13% (808/1,136)**.
- Absent-evidence accuracy: **30.45% (123/404)**.
- Category judge accuracy: multi-hop 67.73%, temporal 55.14%, open-domain
  35.42%, single-hop 62.90%.
- Settled inference: campaign 2,444,870/3,000,000 neurons; Stage E
  511,288/550,000; 103,184 calls; direct first-party Workers AI only.
- V3-H24 HIGH is closed: 40 transport-only rows with no model verdict were
  quarantined, all valid verdicts were preserved, and the completed ledger has
  zero judge errors counted wrong.

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
