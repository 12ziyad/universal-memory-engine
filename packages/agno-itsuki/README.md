# agno-itsuki

Itsuki memory tools for [Agno](https://agno.com) agents.

```bash
pip install agno-itsuki
```

```python
from agno.agent import Agent
from agno_itsuki import ItsukiTools

agent = Agent(tools=[ItsukiTools(user_id="user_42")], ...)
```

Set `ITSUKI_API_KEY` in your environment. Create one at
[itsuki.app](https://itsuki.app) under API Keys.

## This is model-called memory

The model decides when to search and when to save. That is the same shape
Agno's own Mem0 toolkit has, and it is deliberately **not** an automatic
lifecycle: nothing here fires on every turn. Agno's built-in memory remains the
automatic layer, and this runs alongside it.

The toolkit ships instructions telling the model to search at the start of a
conversation and to save the moment the user states a durable fact. Pass
`add_instructions=False` if you would rather write your own.

## Tools

| Tool | Enabled by default |
|---|---|
| `itsuki_search_memory` | yes |
| `itsuki_save_memory` | yes |
| `itsuki_list_memories` | yes |
| `itsuki_get_memory` | yes |
| `itsuki_delete_memory` | no — `enable_delete=True` |
| `itsuki_delete_all_memories` | no — `enable_delete_all=True` |

Deletion is off because a model that can delete is a model that can be talked
into deleting. When enabled, both tools additionally require an explicit
`confirmed=True` argument, and both are registered in Agno's
`requires_confirmation_tools` so the host asks too. `itsuki_delete_all_memories`
previews by default and is scoped to memories this adapter wrote.

## Identity

Resolution order is the constructor's `user_id`, then the run's
`run_context.user_id`, then a readable refusal. **No tool takes a user id.**
Every tool argument is filled in by a model that has read attacker-influenced
text, so tenancy is never expressible as an argument.

## Behaviour under failure

Tools return a JSON error object — never a raised exception, which would break
the agent run. Credentials are scrubbed from content before storage and
redacted from every error surface, because a tool result goes straight into the
model's context.

## License

Apache-2.0
