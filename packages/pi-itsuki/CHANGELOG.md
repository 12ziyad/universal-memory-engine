# Changelog

## 0.1.0 (unpublished)

First release. Itsuki memory as a native Pi lifecycle extension:

- Bounded, fail-open recall in `before_agent_start`, injected behind an explicit
  data-not-instructions boundary.
- Exactly-once capture on `agent_settled`, with a content-derived idempotency
  key and a durable local spool that takes ownership before any network call.
- Pre-compaction and shutdown flushes; leftover spans drain at the next
  `session_start`.
- Correct behaviour across retries, tool loops, compaction, `/fork`, `/resume`
  and crashes — watermarks live in pi's own session tree.
- Local secret scrubbing (byte-identical to the server's canonical lane) and
  recall-echo suppression before anything leaves the machine.
- `Retry-After`-aware retries, circuit breaker, timeouts, cancellation.
- `/itsuki status|doctor|recall`, plus `itsuki_recall` and `itsuki_save` tools.
- No destructive operation of any kind.
- Zero runtime dependencies.
