# openclaw-itsuki

Long-term memory for [OpenClaw](https://openclaw.ai), backed by [Itsuki](https://itsuki.app).

Relevant memory is recalled **before** each agent turn reaches the model, and what you decide is captured **after** the turn settles. The agent never has to choose to look things up, or remember to write them down.

It runs **alongside** OpenClaw's built-in memory. `MEMORY.md`, daily notes and `memory_search` keep working exactly as before — this plugin does not claim the exclusive memory slot.

## Install

```
openclaw plugins install openclaw-itsuki
openclaw plugins enable itsuki
```

**Then grant conversation access.** OpenClaw blocks conversation-reading hooks for non-bundled plugins until the operator opts in, so without this the plugin loads, registers its tools, and captures nothing:

```json
{
  "plugins": {
    "entries": {
      "itsuki": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true }
      }
    }
  }
}
```

That gate is OpenClaw's, and it is the right default — a plugin that reads every conversation should be something you turned on deliberately. `openclaw plugins inspect itsuki --runtime --json` reports the block in `diagnostics` until you do.

Create a key at [itsuki.app](https://itsuki.app) under **API Keys**, then give it to the Gateway:

```
export ITSUKI_API_KEY=itsuki_live_...
```

Operators who manage secrets in OpenClaw config can instead set `plugins.entries.itsuki.config.apiKey` — the manifest marks it `sensitive`. The environment wins when both are present. The key travels only as an `Authorization` header.

Check it loaded:

```
openclaw plugins inspect itsuki --runtime --json
```

## What it does

| Hook | Behaviour |
|---|---|
| `gateway_start` | Restores and validates the durable spool. No blocking network dependency. |
| `agent_turn_prepare` | Recalls memory for the user's prompt and injects it via `prependContext`. Bounded and **fail-open**: if Itsuki is slow or down, the turn proceeds with no memory rather than not at all. Skipped for cron and heartbeat runs. |
| `agent_end` | Captures the user/assistant text of a genuinely settled turn (`success: true`, no error). |
| `before_compaction` | Flushes the outstanding span before compaction rewrites context. |
| `session_end` | Drains on true termination; a `compaction` end is ignored so nothing is captured twice. |
| `subagent_spawned` | Attribution only — never widens authority. |
| `gateway_stop` | One bounded drain pass, then gets out of the finalizer's way. |

## Configuration

Under `plugins.entries.itsuki.config`:

```json
{
  "baseUrl": "https://itsuki.app",
  "userId": "team-a",
  "tenancy": "owner",
  "recall": { "enabled": true, "maxItems": 10, "maxChars": 4000, "timeoutMs": 3000 },
  "capture": { "enabled": true, "timeoutMs": 10000 }
}
```

### Tenancy

`owner` (default) writes everything to the key's own memory space.

`per-sender` gives each channel-scoped sender an isolated sub-tenant, derived as a one-way hash of **channel + sender id** — so a Discord user and a Feishu user with the same underlying id can never collide, and a raw platform id never becomes a key inside Itsuki. When a run has no sender (heartbeat, cron), it falls back to owner scope rather than inventing a tenant.

**Turn `per-sender` on deliberately.** It means you are storing per-person memory for the people who talk to your agent. Tell them.

Tenancy always comes from the credential; these settings can only narrow it, never widen it.

## Tools

`itsuki_recall` and `itsuki_save` are available to the model. There is deliberately **no delete tool** — nothing in this plugin can destroy memory.

## Reliability

Spans are staged to a durable local spool **before** any network call, under a content-derived idempotency key. That is what makes capture exactly-once: a retry, a Gateway restart, a re-entered `agent_end`, or a crash mid-delivery all produce the same key, so the server collapses them into one write. If Itsuki is unreachable the span waits on disk and goes out later; if the spool ever genuinely overflows, the loss is counted and reported rather than silently dropped.

`Retry-After` is honoured exactly. Reads retry with jittered backoff; writes retry only under an idempotency key. Rate limits, quota exhaustion and account-wide pauses map to named, secret-free messages, and a circuit breaker stops a broken backend from being hammered every turn.

State lives under `$OPENCLAW_STATE_DIR/itsuki` (default `~/.openclaw/itsuki`). Session keys are hashed into filenames; fingerprints are hashes, never text.

## Recalled memory is data, not instructions

Injected context is wrapped in `<itsuki-recalled-context-v1>` markers behind an explicit label saying it is stored context and directives inside it must not be followed. Text reaching the prompt is never a reason to execute it.

## What it captures

User and assistant **text** from settled turns. Not thinking blocks, not tool calls, not tool results, not system messages. Every message is scrubbed for credentials locally before it leaves your machine, and anything Itsuki injected is stripped so recalled text is never re-saved as if it were new — including after a restart.

## Deliberately absent

No update/edit of a stored memory, no multimodal memory, no automatic consolidation or "dreaming", and no memory-slot claim. The backend has no honest contract for the first three, and the fourth would disable built-in memory for every agent in your install.

## Requirements

Node 22.22.3+, 24.15+, or 25.9+ — matching OpenClaw's own engine range. Zero runtime dependencies.

## License

Apache-2.0


## Uninstall

```
openclaw plugins uninstall itsuki --force
```

That removes the config entry, the install record, and the plugin directory. This plugin's own state (spool, per-session watermarks) lives outside OpenClaw's plugin directory by design, so it survives a reinstall — remove it deliberately if you want a clean slate:

```
rm -rf "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/itsuki"
```

Uninstalling never deletes anything stored server-side in Itsuki.
