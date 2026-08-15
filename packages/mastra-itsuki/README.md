# mastra-itsuki

Itsuki memory for [Mastra](https://mastra.ai). Relevant memory is injected
before the model is called and the settled exchange is captured after it —
plus typed tools for when you want the model to decide.

```bash
npm install mastra-itsuki
```

```ts
import { Agent } from "@mastra/core/agent";
import { createItsuki } from "mastra-itsuki";

const itsuki = createItsuki();

const agent = new Agent({
  id: "support",
  model: "openai/gpt-5.2",
  instructions: "You help customers.",
  inputProcessors: [itsuki.recall],
  outputProcessors: [itsuki.capture],
  tools: itsuki.tools,
});

const result = await agent.generate("What was I working on?", {
  memory: { resource: "user_42", thread: "thread_9" },
});
```

Set `ITSUKI_API_KEY` in your server environment. Create one at
[itsuki.app](https://itsuki.app) under API Keys.

## Two tiers

**Processors — automatic.** `itsuki.recall` is an input processor that looks up
relevant memory and adds it as a system message before the model reads
anything. `itsuki.capture` is an output processor that stores the exchange once
the agent has actually answered. The model never has to decide to remember.

**Tools — deliberate.** `itsuki.tools` gives the model `itsuki-search-memory`,
`itsuki-save-memory`, `itsuki-list-memories` and `itsuki-get-memory` for when
you want an explicit "save that for later".

Use either, or both.

## Identity

Mastra already names both halves of the question, so the adapter reads them
from the run rather than making you configure them twice:

| Mastra | Itsuki |
|---|---|
| `resource` | the memory space (`userId`) |
| `thread` | the conversation, and the de-duplication anchor |

For single-tenant apps, `createItsuki({ defaultUserId: "..." })` covers runs
that carry no resource. When neither exists the adapter **skips** rather than
guessing — writing one person's memory into another person's space is not a
failure worth risking to save a round trip.

Server-side code can override per run through the Mastra `RequestContext`:

```ts
requestContext.set("itsuki.userId", "user_99");
requestContext.set("itsuki.conversationId", "thread_12");
```

No tool takes a user id, a project id, or any other tenancy parameter. A model
that can name the memory space it writes to is a model that can be talked into
writing somewhere else.

## Deletion

Off by default. `createItsuki({}, { enableDelete: true })` registers
`itsuki-delete-memory`, which still refuses unless the call carries an explicit
`confirmed: true`. Bulk deletion is not exposed to models at all.

## Behaviour under failure

| Situation | What happens |
|---|---|
| Recall fails | The agent answers without memory. The run succeeds. |
| Capture fails | Nothing is stored. The answer is unaffected. |
| Run aborted | Nothing is captured. |
| Retry or re-run | The idempotency key is derived from the content, so the server keeps one memory. |
| Tool call fails | The model gets a readable error object, never an exception through the agent. |

Neither processor can fail a run: both wrap everything and degrade to a no-op.
Failures are reported through `onEvent`, which carries counts, durations and
error classes only — never message text, recalled memory, queries or keys.

## Migrating from `@mastra/mem0`

`@mastra/mem0` peer-depends on `@mastra/core >=0.15.3 <0.17.0` while Mastra is
at 1.x, and its documentation page no longer exists. There is no drop-in
equivalent because the shapes differ:

| `@mastra/mem0` | Here |
|---|---|
| `mem0RememberTool` | `itsuki.tools.itsukiSearch`, or `itsuki.recall` for automatic lookup |
| `mem0MemorizeTool` | `itsuki.tools.itsukiSave`, or `itsuki.capture` for automatic storage |
| `user_id` in the tool call | the run's `resource` — never a tool argument |

## Compatibility

| | Supported |
|---|---|
| `@mastra/core` | >= 1.59.0 < 2.0.0 (peer) |
| Node | >= 22.13.0 |
| Runtime dependencies | none |

## License

Apache-2.0
