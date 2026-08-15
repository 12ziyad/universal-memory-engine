# camel-itsuki

Itsuki memory for [CAMEL](https://camel-ai.org): a lossless local history that
also mirrors durable memory to Itsuki.

```bash
pip install camel-itsuki
```

```python
from camel.memories import ChatHistoryMemory
from camel_itsuki import ItsukiStorage

memory = ChatHistoryMemory(
    context_creator,
    storage=ItsukiStorage(user_id="user_42", agent_id="researcher"),
)
```

Set `ITSUKI_API_KEY` in your environment. Create one at
[itsuki.app](https://itsuki.app) under API Keys.

## Two jobs, kept apart

`BaseKeyValueStorage` promises to store records "without any loss of
information", and `ChatHistoryMemory` expects to read back exactly what it
wrote. So:

- **`save`/`load`/`clear` are a lossless local mirror.** Byte-for-byte what
  went in comes out. Nothing is reconstructed from extracted memories, because
  an agent whose history quietly rewrites itself between turns is a genuinely
  hard bug to find.
- **Durable semantic memory** is mirrored to Itsuki in the same `save` call and
  read back through `ItsukiContextBlock`, which is the host's own abstraction
  for context from elsewhere.

```python
from camel_itsuki import ItsukiContextBlock

block = ItsukiContextBlock(user_id="user_42", client=storage.client)
context = block.retrieve("what is this project about?")
```

## Local-first writes

The mirror file is written with an atomic replace before the network is
touched, so an Itsuki outage costs durable memory but never the agent's own
history. The file is bounded (`max_records`, default 5000) and a truncated file
is discarded rather than served as fact.

## Multi-agent societies

Give each agent its own `ItsukiStorage` with its own `agent_id`. Each gets its
own mirror file and its own attribution, which is what keeps two agents from
reading each other's history.

## Deletion

`clear()` clears the **local** history only. Server-side memory is untouched
unless you construct with `allow_remote_clear=True` — an agent restarting its
chat history is not a user asking to be forgotten, and conflating the two is
how an integration deletes somebody's memory by accident.

## License

Apache-2.0
