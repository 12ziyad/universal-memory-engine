# chatdev-itsuki

Itsuki memory for [ChatDev 2.0](https://github.com/OpenBMB/ChatDev) workflows.

> **Operator-wired, not built in.** ChatDev has no plugin discovery, so a
> deployment must import this package once to register the store. Until the
> upstream change lands, `type: itsuki` is not available in a fresh ChatDev
> checkout. This README will say "built in" when that is true and not before.

```bash
pip install chatdev-itsuki
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
