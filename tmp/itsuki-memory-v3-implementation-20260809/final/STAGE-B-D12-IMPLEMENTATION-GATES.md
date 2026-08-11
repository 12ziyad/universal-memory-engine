# Stage B V3-D12 implementation gates

- Invalid Stage B replacement: all isolation/privacy/export/source-expansion and
  200-recall soak checks passed; delete-race stopped unscored with one
  nonterminal job and one atomic capture run, but zero content-bearing rows.
- Production-primary timeline: barrier at acceptance +1.6s; capture run claimed
  about 17s after the barrier, immediately terminal `cancelled_by_delete`, with
  proposed/accepted/stored all zero. The job later drained safely.
- Failing-first: `atomic_capture_persistence.spec.js` **11 pass / 1 fail**;
  the pre-existing barrier still allowed one model call and one capture-run row.
- Exact rerun: **12/12 pass**, zero model calls and zero run/candidate rows when
  deletion owns the claim.
- Focused atomic-capture, erasure, replay and ingest regressions:
  **8 files / 110 tests pass**.
- Full Worker gate: **110 files / 1,312 tests pass**.
- Unit/cross-door gate: **33 files / 539 pass / 1 intentional skip**.
- `npm audit`: **0 vulnerabilities**.
- Wrangler 4.120.0 dry deployment: **pass**; no migration or binding change.
- V3-H12 is independently closed: the live driver polls boundedly for terminal
  convergence instead of assuming every in-flight model call ends in 15s, but
  still requires the complete residue vector to reach absolute zero.
- Failed-run cleanup: zero live memory/jobs; the one content-free cancelled run
  was removed; **699/699** retained packet fences are minimized/content-free.
- Commit/origin: `cef9581902948e0d4a8cc55b46ed49298b8a3f49`.
- Production version `e34b92bc-0577-4a16-b63d-7a1bc8b9a1f2`, deployment
  `297b55ff-9668-4c11-8886-ba3d08bcbdfb`, 100% traffic; 20/20 propagation.
- Production reattack: 20 episodes accepted; delete reported one pending job;
  bounded drain reached absolute zero in 34,507ms; capture runs/candidates zero;
  exact replay non-retryable `409 source_write_erased`; erased recall zero.
- Final production-primary cleanup: zero live memory/jobs and **701/701**
  retained packet fences minimized/content-free. V3-D12 is closed; the
  unchanged clean Stage B replacement remains mandatory.
