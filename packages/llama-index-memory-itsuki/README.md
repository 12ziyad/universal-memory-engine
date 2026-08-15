# llama-index-memory-itsuki

Itsuki long-term memory for [LlamaIndex](https://llamaindex.ai), as a memory
block inside the host's own `Memory` class.

```bash
pip install llama-index-memory-itsuki
```

```python
from llama_index.memory.itsuki import itsuki_memory

memory = itsuki_memory(user_id="user_42", session_id="thread_9")
response = await agent.run("What am I working on?", memory=memory)
```

Set `ITSUKI_API_KEY` in your environment. Create one at
[itsuki.app](https://itsuki.app) under API Keys.

## A block, not a replacement

LlamaIndex has deprecated the `BaseMemory` generation that older third-party
integrations target — `ChatMemoryBuffer`, `SimpleComposableMemory` and friends
are on the way out. The current architecture is the `Memory` class composing
`BaseMemoryBlock` subclasses, so that is what this ships.

Short-term chat history keeps working exactly as the host intends. Itsuki
becomes the long-term half: `_aget` supplies durable memory for the turn, and
`_aput` stages messages as they flush out of short-term memory.

Compose it yourself if you want a different arrangement:

```python
from llama_index.core.memory import Memory
from llama_index.memory.itsuki import itsuki_memory_block

memory = Memory.from_defaults(
    session_id="thread_9",
    memory_blocks=[itsuki_memory_block("user_42", session_id="thread_9")],
)
```

## Async, on purpose

`BaseMemoryBlock` is async-first, so this uses the Itsuki SDK's
`AsyncMemoryClient`. A synchronous client here would block the event loop the
agent runs on, once per step, for the length of an HTTP round trip.

## Scoping

| Argument | Meaning |
|---|---|
| `user_id` | the memory space — required, no default |
| `session_id` | the conversation, and the de-duplication anchor |
| `agent_id`, `run_id` | attribution only |
| `project_id` | attribution, and enables project-scoped recall |

`search_msg_limit` (default 5) controls how many recent turns inform the recall
query.

## Behaviour under failure

`_aget` returns an empty string and `_aput` returns quietly. A memory outage
costs the agent context, never the answer. The API key is a private attribute,
so it never appears in `model_dump()`, an export, or serialized agent state.

## License

Apache-2.0
