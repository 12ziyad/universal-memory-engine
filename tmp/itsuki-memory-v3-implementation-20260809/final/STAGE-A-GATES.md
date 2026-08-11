# Final Stage A deterministic gates

Completed: 2026-08-11

- Worker pool: **110 files / 1,309 passed / 0 failed** (`--maxWorkers=4`).
- Host/unit/cross-door: **33 files / 539 passed / 1 intentional skip**.
- `npm audit --audit-level=low`: **0 vulnerabilities**.
- Wrangler 4.120 dry deploy: PASS; all bindings and flags recognized.
- Remote D1 migration chain: **No migrations to apply**; applied history remains
  complete through immutable migration 0037.
- `git diff --check`: no campaign whitespace error; only the owner's existing
  `AGENTS.md` line-ending warning.
- Benchmark/judge/evaluator/Wrangler-dev process scan: zero.
- Repo/origin: `aa16f8a1eded327aaa2af95a933dcc88032b6433`; only owner
  `AGENTS.md` dirty.
- Production: deployment `eaae0273-d09d-4e97-af95-f336315d040e`, version
  `7bb3ac6b-8c50-48e7-aa33-b3250deef657`; E10 closure health 20/20.

The first read-only migration-list attempt returned Cloudflare API code 7403
after OAuth drift. `wrangler whoami` refreshed the existing credential in place;
the exact read-only check then passed. No migration command or schema write was
issued. Classification: transient credential refresh, not migration failure.

Stage A verdict: **PASS**. No inference was used.
