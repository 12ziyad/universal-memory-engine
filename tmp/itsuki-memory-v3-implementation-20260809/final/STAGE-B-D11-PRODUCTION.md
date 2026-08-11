# Stage B V3-D11 production closure

- Code/origin: `183d540184e3e355e2bf99b82cfdc43ee5fb648e`.
- Worker version: `345cd4d7-c680-4e16-9a99-2fe59baa33bc`.
- Deployment: `1b13b0e9-68ae-4520-8353-33a27b1a343d`, 100% traffic.
- No migration or binding changed.
- Propagation: **20/20 pass** across both production domains; parent V3 remains
  allowlist/30, final treatment capture/projection/source-expansion remain
  allowlist/10, hybrid remains historical+treatment allowlist/20, and rejected
  E2-B1/E6M/E9B/E10 features remain off.
- Exact pre-fix query after confirmed erasure: **200**, one live query/recall
  packet, original deterministic packet identity renewed.
- Fresh accepted write settled `enriched`; after erasure, its exact replay
  remained non-retryable **409 `source_write_erased`**.
- The identical recall after that second erasure again returned **200** with the
  same packet identity.
- Account rules were unchanged.
- Final production-primary audit: zero episodes/candidates/runs/projections/
  graph/pages/staging/nonterminal jobs; **643/643** retained source packets are
  minimized and zero retain content.
- Evidence: `final/live/evidence/v3-d11-production-reattack.json`.

Verdict: **V3-D11 CLOSED**. Stage B must now restart from its unchanged frozen
preregistration; no failed-run result is valid or reusable.
