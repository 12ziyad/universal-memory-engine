# Changelog

## 0.1.0 (unpublished)

First release. Itsuki memory as a native OpenClaw plugin:

- Bounded, fail-open recall in `agent_turn_prepare`, injected via
  `prependContext` behind an explicit data-not-instructions boundary.
- Exactly-once capture on `agent_end` for genuinely settled turns, with a
  content-derived `openclaw:v1` idempotency key and a durable local spool that
  takes ownership before any network call.
- Pre-compaction flush; `session_end(compaction)` deliberately ignored so a
  compaction cycle cannot double-capture.
- Correct across Gateway restart, resume, compaction, handler re-entry and
  concurrent `agent_end` — watermarks and echo fingerprints are persisted per
  session under the OpenClaw state root.
- Owner scope by default; optional `per-sender` tenancy hashes channel+sender
  one-way so two channels can never collide and scope can only narrow.
- Runs alongside OpenClaw's built-in memory. Claims no exclusive memory slot.
- Local secret scrubbing (byte-identical to the server's canonical lane),
  `Retry-After`-aware retries, circuit breaker, timeouts, cancellation.
- `itsuki_recall` and `itsuki_save` tools. No destructive operation of any kind.
- Zero runtime dependencies.
