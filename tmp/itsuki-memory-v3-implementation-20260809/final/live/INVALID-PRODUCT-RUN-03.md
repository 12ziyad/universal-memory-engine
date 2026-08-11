# Stage B invalid product run 03

- Classification: **PRODUCT HIGH / INVALID AND UNSCORED**.
- The clean replacement passed frozen-input, billing, production-configuration,
  preclean, ten concurrent subtenant ingests and same-key convergence checks.
- It stopped before the immediate-read assertion because `/v1/recall` returned
  `409 idempotency_conflict`; no Stage B result artifact was written or salvaged.
- Exact production reproduction proved that the query's deterministic source
  packet key was owned by its content-free D10 erasure sentinel. Repeating the
  same read after erasure was therefore permanently blocked even though it was
  a genuinely new operation.
- V3-D11 is the product defect. The repair may renew only an erased
  `query/recall` packet; accepted write/ingest replay fences must remain
  immutable and continue returning `409 source_write_erased`.
- Original stdout/stderr are retained as `stage-b-final.*.log`. Stage B must
  restart from the unchanged preregistration only after the full HIGH lifecycle
  closes and failed-run synthetic state is erased through the product API.
