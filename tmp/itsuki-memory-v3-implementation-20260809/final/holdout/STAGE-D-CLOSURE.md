# Stage D safe closure

Stage D evidence/config commit `2484f772a79889dba0297f83b575d2c6fb2e99d9`
is deployed as Worker `c85c7844-9e2e-426e-8f87-ee468296b572`, deployment
`cef8320d-afd0-4c9f-a4a5-690a2d149f68`, at 100% traffic.

Twenty uncached checks (10 per production domain) passed exactly: parent V3
allowlist 30; capture, projection, coalescing, source expansion, episode
fallback and adaptive context OFF/0; E7 restricted to the historical d04 ten;
normal users outside V3. No migration, binding, model, prompt or product-code
change occurred. Focused feature/isolation regression passed 4 files / 66
tests, and Wrangler dry deploy passed.

The Stage E cohort preflight found zero live state in both ten-slot synthetic
cohorts, but the middle/control ten still held 217 pre-D10 packet rows with
legacy plaintext metadata. They were not searchable/live memory, but they
violated the final privacy/cleanup invariant. The current product erasure API
was applied to exactly those ten synthetic accounts; it minimized all 217 rows
without direct D1 mutation. The final audit now reports:

- treatment: zero live V3/graph/staging/job state; 881/881 packet fences
  minimized, zero content rows;
- control: zero live V3/graph/staging/job state; 217/217 packet fences
  minimized, zero content rows;
- combined: 1,098/1,098 packet fences minimized; zero content rows;
- global benchmark lock absent.

Evidence: `evidence/stage-e-cohort-preflight-before.json`,
`evidence/stage-e-control-cleanup.json`, and
`evidence/stage-d-closure.json`. No inference was used.
