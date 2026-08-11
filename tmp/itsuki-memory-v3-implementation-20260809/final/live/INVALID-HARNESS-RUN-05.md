# Stage B invalid harness run 05

- Classification: **HARNESS MEDIUM / INVALID AND UNSCORED**.
- The replacement passed every product assertion through concurrency,
  persistence/scope isolation, rules, secrets, export, source expansion,
  200-recall soak, bounded delete-race convergence, replay fencing and a fresh
  post-delete write.
- It stopped before writing a result at the final FTS/source-packet audit.
- Production-primary D1 proved exactly ten base-marker packet hits, all
  `source_type=query, source_mode=recall`. They were the harness's own ten new
  post-erasure probe questions, not source episodes or semantic memory.
- Root cause: packet-content audit ran after those new reads but before the
  second cleanup that minimizes their query packets.
- Fix: preserve the post-delete recall proof, perform the already-preregistered
  second product cleanup, then audit episode FTS, semantic FTS and packet text;
  every marker must still be zero.
- No Stage B result exists or is salvageable. The unchanged replacement starts
  only after failed-run cleanup proves zero live state and content-free fences.
