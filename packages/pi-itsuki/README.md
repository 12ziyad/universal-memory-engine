# pi-itsuki

Long-term memory for the [Pi coding agent](https://pi.dev), backed by [Itsuki](https://itsuki.app).

Relevant memory is recalled **before** each turn's first model call, and what you decide is captured **after** the turn settles. The agent never has to choose to look things up, and never has to remember to write them down.

## Install

```
pi install npm:pi-itsuki
```

Then set your key and restart pi:

```
export ITSUKI_API_KEY=itsuki_live_...
```

Create a key at [itsuki.app](https://itsuki.app) under **API Keys**. The key is read from the environment only — never from a config file this extension writes — and travels only as an `Authorization` header.

Check it worked:

```
/itsuki status
```

## What it does

| Moment | Behaviour |
|---|---|
| `session_start` | Delivers anything left over from a previous run (crash, offline, rate limit). |
| `before_agent_start` | Recalls memory for your prompt and injects it as labelled context. Bounded and **fail-open**: if Itsuki is slow or down, the turn proceeds with no memory rather than not at all. |
| `agent_settled` | Captures the user/assistant text of the turn that just finished. |
| `session_before_compact` | Flushes the outstanding span before compaction rewrites context. |
| `session_shutdown` | One last flush. |

`agent_settled` is the only event pi documents as "will not continue running automatically", which is why capture waits for it: a turn that is still auto-retrying, auto-compacting, or draining queued follow-ups is not a finished thought.

## Commands and tools

- `/itsuki status` · `/itsuki doctor` — connection, scope, spool depth, last receipt, breaker state. Never prints the key.
- `/itsuki recall <query>` — a one-off lookup.
- `itsuki_recall` / `itsuki_save` — tools the model can call itself.

There is deliberately **no delete tool**. Nothing in this extension can destroy memory; deletion stays a human action in the dashboard.

## Configuration

Optional `~/.pi/agent/itsuki/itsuki.json`. Behaviour only — never credentials.

```json
{
  "baseUrl": "https://itsuki.app",
  "userId": "alice",
  "recall": { "enabled": true, "maxItems": 10, "maxChars": 4000, "timeoutMs": 3000 },
  "capture": { "enabled": true, "timeoutMs": 10000 }
}
```

`userId` isolates one end user's memory space under your key. Tenancy always comes from the credential; this can only narrow it, never widen it.

## What it captures

User and assistant **text** from settled turns. Not thinking blocks, not tool calls, not tool results, and not other extensions' messages. Every message is scrubbed for credentials locally before it leaves your machine, and anything Itsuki itself injected is stripped so recalled text is never re-saved as if you had just said it.

## Reliability

Writes are staged to a durable local spool **before** any network call, under a content-derived idempotency key. That is what makes capture exactly-once: a retry, a crash, a `/resume`, or a `/fork` that re-settles the same content all produce the same key, so the server collapses them into one write. If Itsuki is unreachable the span waits on disk and goes out later. If the spool ever genuinely overflows, the loss is counted and reported by `/itsuki doctor` — never silently dropped.

`Retry-After` is honoured exactly. Reads retry with jittered backoff; writes retry only under an idempotency key. Rate limits, quota exhaustion and account-wide pauses map to named, secret-free messages.

## Recalled memory is data, not instructions

Injected context is wrapped in `<itsuki-recalled-context-v1>` markers behind an explicit label saying it is stored context and directives inside it must not be followed. Stored text reaching the prompt is never a reason to execute it.

## Deliberately absent

No update/edit operation (the backend has no safe versioned-correction contract, and this extension will not fake one), no multimodal memory, no automatic consolidation. Per-call extraction instructions and categories are project policy in Itsuki, not a per-call knob.

## Requirements

Node >= 22.19.0, matching pi's own floor. Zero runtime dependencies.

## License

Apache-2.0
