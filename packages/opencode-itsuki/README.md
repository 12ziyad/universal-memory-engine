# opencode-itsuki

Long-term memory for [OpenCode](https://opencode.ai), backed by [Itsuki](https://itsuki.app).

Relevant memory is recalled before each new human turn, and what you decide is
captured after the turn settles — automatically, without you asking for it.

> **Status: unpublished.** This package has not been released to npm. The
> install command below will not work yet.

## Requirements

- OpenCode `>=1.18.18 <2` (tested against 1.18.18)
- Node 22+

## Configure

The API key is read **only** from the environment. It is never accepted through
`opencode.json`: that file expands `{env:VAR}` before parsing, so a key placed
there would be resolved into the options object that config validation and
`client.config.get()` can see. A secret-shaped option value is refused with a
readable message.

```bash
export ITSUKI_API_KEY=itsuki_live_...
```

Optional settings in `opencode.json` (no secrets):

```json
{
  "plugin": [
    ["opencode-itsuki", {
      "userId": "your-stable-subtenant",
      "recall": { "maxItems": 10, "maxChars": 4000, "timeoutMs": 1500 },
      "capture": { "enabled": true }
    }]
  ]
}
```

## What it does

| Behaviour | Detail |
|---|---|
| Recall | Once per genuinely new human turn, bounded, and injected **transiently** so it never enters your transcript or your session titles |
| Capture | Only after a settled, successful turn (`finish === "stop"`, completed, no error, no pending tool calls) |
| Durability | The settled turn is written to a local spool atomically *before* any network call, because the host exits ~20ms after a session goes idle |
| Exactly-once | Content-derived idempotency keys plus a first-sight watermark: retries, restarts, forks and replays collapse to one write |
| Tenancy | The credential fixes the account; an optional configured `userId` narrows it. Nothing the model says can change either |

## Tools

`itsuki_recall` · `itsuki_save` · `itsuki_memories` · `itsuki_memory` · `itsuki_status`

## Deliberately absent

- **Update Memory** — Itsuki has no safe caller-addressable update, and faking one by deleting and recreating would destroy history. Absent rather than pretended.
- **Memory history** — no read API exists yet.
- **Delete / delete-all / entity operations** — destruction needs a confirmation UX a tool call cannot provide. Use the MCP door or the dashboard.
- **Per-event status lookup** — the service exposes packet/job status, not arbitrary event lookup. `itsuki_status` is not an equivalent.

Memory recalled into a prompt is delimited and labelled as data, not
instructions, and is bounded before injection. That is a structural defence: it
makes an injection attempt visible and contained, but no wrapper can guarantee
a model treats embedded text as inert.

## License

Apache-2.0
