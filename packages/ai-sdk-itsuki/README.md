# ai-sdk-itsuki

Itsuki memory for the [Vercel AI SDK](https://ai-sdk.dev). Relevant memory is
injected before the model reads anything, and each settled exchange is captured
after it — without the model having to decide to look.

```bash
npm install ai-sdk-itsuki
```

```ts
import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";
import { withItsuki } from "ai-sdk-itsuki";

const model = withItsuki(openai("gpt-5.2"), { userId: "user_42" });

const { text } = await generateText({
  model,
  prompt: "What am I learning at the moment?",
});
```

Set `ITSUKI_API_KEY` in your server environment. Create one at
[itsuki.app](https://itsuki.app) under API Keys.

## What it is, and what it is not

This is **middleware**, not a provider. It wraps the model you already use, so
your provider, your model id, your API keys and your provider's behaviour are
untouched — no provider SDKs are bundled and the package has zero runtime
dependencies. Tool calls, structured output, streaming, usage, warnings and
provider metadata pass through exactly as the provider produced them.

Two things are added: a system block containing relevant memory on the way in,
and an observation of the settled exchange on the way out.

## Configuration

```ts
withItsuki(model, {
  userId: "user_42",            // required — your stable id for this end user
  conversationId: "thread_9",   // recommended — the de-duplication anchor
  projectId: "proj_shop",       // optional — enables project-scoped recall
  capture: "background",        // "background" | "blocking" | "off"
  maxContextChars: 4000,        // hard ceiling on injected memory
  maxItems: 10,                 // hard ceiling on recalled items
  onEvent: (event) => metrics.record(event),
});
```

`userId` has no default on purpose. There is no safe guess for "whose memory is
this", and a silent default would put every end user's memories in one space.

### Per-call overrides

One wrapped model can serve many users. Pass overrides through the AI SDK's
`providerOptions` channel — it comes from your server code, never from the
model:

```ts
await generateText({
  model,
  prompt,
  providerOptions: {
    itsuki: { userId: "user_99", conversationId: "thread_12" },
  },
});
```

The `itsuki` namespace is stripped before the provider sees it.

### Serverless

`capture: "background"` returns the response first and stages the write after.
On a platform that freezes the function once the response is sent, hand the
work to the platform so it survives:

```ts
import { waitUntil } from "@vercel/functions";

withItsuki(model, { userId, waitUntil });
```

Or use `capture: "blocking"`, which stages before returning at the cost of one
round trip in the request path.

## Standalone helpers

For applications that want the pieces rather than the automatic lifecycle:

```ts
import { retrieveMemories, getMemories, saveMemories } from "ai-sdk-itsuki";

const block = await retrieveMemories("what does the user like?", { userId });
const items = await getMemories("preferences", { userId });
await saveMemories([{ role: "user", content: "I prefer dark mode." }], { userId });
```

Unlike the middleware, these surface failures — a caller doing memory by hand
should decide what an outage means for them.

## Behaviour under failure

| Situation | What happens |
|---|---|
| Recall fails (network, 5xx, auth) | The model answers without memory. The turn succeeds. |
| Capture fails | Nothing is stored. The response is unaffected. |
| Run aborted, or stream errors | Nothing is captured — a half-spoken answer is not a settled exchange. |
| Rate limited | `Retry-After` is honoured exactly, inside the call's time budget. |
| Retry or stream reconnect | The idempotency key is derived from the content, so the server keeps one memory. |

Failures are reported through `onEvent`, which carries counts, durations and
error classes only — never message text, recalled memory, queries or keys.

## Security notes

- The API key travels only as an `Authorization` header, never in a URL, and
  redirects are refused so it cannot be replayed at another origin.
- Constructing in a browser throws, because a key in a browser bundle is a
  published key.
- Credentials in message text are redacted before capture, so a pasted key does
  not become a durable memory.
- Recalled memory is injected inside explicit markers with a preamble labelling
  it as data, not instructions — the prompt-injection boundary for anything a
  previous session stored.
- Recalled text the model repeats back is suppressed before capture, so memory
  cannot slowly convince itself of its own output.

## Compatibility

| | Supported |
|---|---|
| `ai` | ^7.0.0 (peer) |
| Node | >= 22 |
| Runtimes | Node, edge, Workers — no Node built-ins are used |

## License

Apache-2.0
