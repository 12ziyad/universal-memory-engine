# chatdev-itsuki

Itsuki memory for [ChatDev 2.0](https://github.com/OpenBMB/ChatDev) workflows.

> **Operator-wired, and held from release.** ChatDev has no plugin discovery,
> so a deployment must import this package once to register the store, and
> until an upstream change lands `type: itsuki` is not present in a fresh
> ChatDev checkout. This README will say "built in" when that is true and not
> before.
>
> This package binds to ChatDev's real memory contract (`BaseConfig`,
> `MemoryBase`, `MemoryItem`, `MemoryWritePayload`), which resolve only inside a
> ChatDev deployment — install it there, not into a bare environment. The store
> and its full manager lifecycle are proven against ChatDev's real host types
> in the test suite. A full multi-agent workflow driven by a live LLM has not
> yet been executed here, so the package is **held from publication** pending
> that proof; the other five Itsuki framework integrations are unaffected.

```bash
pip install chatdev-itsuki  # into a ChatDev 2.0 deployment
```

Add one line to your ChatDev entrypoint:

```python
import chatdev_itsuki.register  # noqa: F401
```

Then declare a memory node in your workflow YAML:

```yaml
memory:
  - name: team_memory
    type: itsuki
    config:
      api_key: ${ITSUKI_API_KEY}
      user_id: acme_team
      project_id: proj_shop
      top_k: 5
```

Attach it to an agent the way ChatDev attaches any memory:

```yaml
memories:
  - name: team_memory
    retrieve_stage: ["gen"]
    top_k: 5
    read: true
    write: true
```

## Automatic lifecycle

ChatDev's memory manager calls `retrieve()` on entering a configured stage and
injects the result under its "Related Memories" heading, then calls `update()`
and `save()` after the stage completes. The agent never chooses to remember.

Two behaviours match the built-in `mem0` store, so swapping `type:` does not
change what an existing workflow captures:

- **Only user input is memorized.** Stage outputs are pipeline chatter, and
  extracting facts from them teaches the system its own noise.
- **Pipeline headers are stripped first**, so the extractor sees the user's
  sentence rather than the framing around it.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `api_key` | `${ITSUKI_API_KEY}` | expanded from the environment |
| `user_id` / `agent_id` | — | at least one is required |
| `project_id` | none | attribution, enables project-scoped recall |
| `top_k` | 5 | bounded to 20 |
| `max_context_chars` | 4000 | hard ceiling on injected memory |
| `timeout_s` | 8.0 | per call |
| `allow_clear` | false | see below |

The credential is excluded from the config's serialized form, so exporting or
logging a workflow cannot leak it.

## Failure and deletion

Every memory failure degrades: retrieval returns empty, capture logs. A stage
never fails because a lookup timed out. `clear()` does nothing unless
`allow_clear: true`, and even then it is scoped to memories this adapter wrote.

## License

Apache-2.0
