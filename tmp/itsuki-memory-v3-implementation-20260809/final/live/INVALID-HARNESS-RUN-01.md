# Stage B invalid harness run 01

- Classification: **HARNESS DEFECT — INVALID; no product verdict**.
- The run stopped immediately after its same-idempotency-key race audit.
- Observed durable state for the raced packet: one source packet, one source
  episode, one `extract` job, one semantic capture run, and one legitimate
  `pass2_rollup` job.
- The two concurrent accepts returned the same packet and extract-job IDs.
- Root cause: the harness incorrectly required one total job, conflating the
  idempotent extract job with the downstream pass-2 rollup job.
- Correction: audit extract and pass-2 job cardinalities separately; require
  exactly one extract job, at most one pass-2 job, and no other job type.
- Benchmark/security results from this run are not scored or reused.
- Original stdout/stderr logs are retained under `final/live/logs/`.
- Synthetic state is erased through the public product deletion contract and
  independently counted before the replacement run.
