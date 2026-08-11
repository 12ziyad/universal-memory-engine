# Stage E harness repair 01 — terminal replay episode acknowledgement

Date: 2026-08-11T21:16:45Z
Classification: V3-H16 MEDIUM harness defect; V3-I04 contained infrastructure transient

## Failing-first evidence

The reference-blind product stopped after 111/272 ledgered sessions and before
any answer or score. Two production extract jobs independently reached failed
terminal state after the 15-minute orphan margin with
`inference_outcome_unknown`, zero published objects, and `attempts=0`. The
driver released its lock and retained a resumable manifest.

An exact resume exercised the established SRV-02 same-job repair contract. In
parallel, another session had already completed remotely but had not reached
the local ledger before the first process stopped. Its exact terminal replay
returned HTTP 200 with `duplicate=true`, the original packet/job/receipt, and
no top-level `source_episodes_written` field. This is the product's intentional
terminal-replay response shape. The harness converted the missing field to zero
and incorrectly rejected it as source episode loss.

## Narrow repair

- Fresh and repaired writes still require an explicit top-level episode count
  exactly equal to the accepted message count.
- An exact duplicate with the top-level field absent may defer only this proof
  to the existing post-ingest production-primary state audit.
- Explicit zero, partial counts, and missing counts on non-duplicates still
  fail closed.
- The final audit still requires every expected message exactly once, exact
  packet/message/provenance identity, exact scrubbed text, scope, source time,
  FTS integrity, and zero secret/rules failures before any answer is generated.
- No product code, model, prompt, dataset, reference, tenant, seed, architecture,
  or benchmark denominator changed. Completed sessions are not re-ingested;
  the same frozen idempotency identities resume.

Pure contract proof: 5/5 arms PASS. Repaired product dry run remains
reference-blind with 272 sessions, 5,882 messages, 301 batches, 1,540 questions,
and zero reference files opened. Evidence:
`INGEST-REPLAY-CONTRACT-PROOF.json`.
