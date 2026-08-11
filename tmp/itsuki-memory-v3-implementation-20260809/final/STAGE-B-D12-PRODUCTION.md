# Stage B V3-D12 production closure

- Code/origin: `cef9581902948e0d4a8cc55b46ed49298b8a3f49`.
- Worker version: `e34b92bc-0577-4a16-b63d-7a1bc8b9a1f2`.
- Deployment: `297b55ff-9668-4c11-8886-ba3d08bcbdfb`, 100% traffic.
- No migration or binding changed.
- Propagation: **20/20 pass** across both production domains with the exact
  treatment-only Stage B configuration unchanged.
- Delete-race input: 20 scrubbed permitted episodes accepted, then immediate
  confirmed account erasure; the delete honestly reported one pending job.
- Exact replay: non-retryable **409 `source_write_erased`**.
- Bounded drain: **34,507ms** to terminal state; complete live residue vector
  reached zero. `semantic_atom_capture_runs` and candidates both remained zero.
- Recall after drain returned none of the erased marker.
- Account rules were unchanged.
- Final production-primary cleanup: zero live memory/jobs and **701/701**
  source-packet fences minimized/content-free.
- Evidence: `final/live/evidence/v3-d12-production-reattack.json`.

Verdict: **V3-D12 CLOSED** and **V3-H12 CLOSED**. Stage B must restart from
its unchanged preregistration; invalid run 04 remains unscored.
