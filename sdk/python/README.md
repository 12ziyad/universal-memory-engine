# itsuki (Python SDK)

One private memory for every AI. Thin synchronous client for the Itsuki memory API.

```python
from itsuki import MemoryClient

memory = MemoryClient(api_key="itsuki_live_...")

memory.add("I started learning Kotlin this week.")
print(memory.search("what am I learning?")["context"])
```

- `add(content)` / `add_conversation(messages)` — write memory, returns a receipt
- `search(query)` — `result["context"]` is the prompt-ready block
- `turn(messages)` — recall + auto-capture in one call
- `graph()`, `status()`, `usage()`, `receipts()`, `get_rules()`, `set_rules()`, `export_all()`
- Sub-tenants: `MemoryClient(api_key, user_id="end-user-42")` gives each of your users an isolated memory space under one key
- Safe retries: pass `idempotencyKey=MemoryClient.new_idempotency_key()` to writes

Projects are metadata inside one memory space, not sub-tenants:

```python
scope = {"projectId": "atlas", "projectName": "Atlas"}
memory.add("Atlas deploys from main.", memory_scope=scope)
result = memory.search(
    "How does this deploy?",
    memory_scope=scope,
    recall_scope="project_then_global",
)
```

The default recall scope is `global` (all account-global and project rows). Use
`project_only` for exactly one project, or `project_then_global` for that project plus
rows without a project. Both project modes require `memoryScope.projectId`.

Errors raise `MemoryAPIError` with `.status`, `.code`, and `.body`. Docs: your deployment's `/docs/`.

## Many end users, one API key

Your API key is your account. `user_id` selects an
**isolated memory space inside it** — one per end user of your app. Nothing
saved for one value is reachable from another, on save or on recall.

```
memory.add("Ada's depot is in Porto.", user_id="ada")
memory.add("Grace's depot is in Faro.", user_id="grace")

memory.search("where is my depot?", user_id="ada")   # -> Porto, never Faro
```

Pass it per call, or fix it for the life of a client with
`MemoryClient(api_key=..., user_id="ada")`. Omit it entirely and the memory
belongs to the key's owner.

The value is yours to choose — a user id, a tenant slug, an email. It is
hashed with your account id before it becomes a storage key, so two different
API keys using the same string still get different spaces.

**Unknown parameters are rejected**, not ignored: a misspelled `usr_id`
returns `400` naming the offending key rather than silently writing to the
wrong space.

## Background processing, visibly

Writes are accepted instantly and enriched in the background. The
`source_packet_id` on every response is the public handle for that work:

```
receipt = memory.ingest(messages, flush=True)
done = memory.wait_for(receipt["source_packet_id"])   # polls until terminal
# done["status"] is "enriched" or "failed" — never silently neither.
```

`memory.packet_status(id)` answers once; `memory.jobs(status="failed")` lists
every accepted write and where it is. Webhooks can subscribe to
`memory.enriched` and `memory.failed` for push instead of poll.

**Idempotent replay:** re-sending identical content (or reusing an
`idempotency_key`) within 24 hours returns the ORIGINAL receipt and enqueues
nothing — client retries after a timeout cannot double-ingest.

## Changelog note — add_conversation now builds the graph

`add_conversation()` previously condensed the conversation into one flat
memory page. It now runs the same extraction engine as every other write:
entities, facts, relationships, bi-temporal history. Expect richer results
from the same call — nodes AND edges where you used to get a page.

## Version skew (read this if a method is missing)

The **source in this repo is 0.2.0**; the published PyPI package may still be
**0.1.1** until the next release is pushed. 0.1.1 predates the background-status
and delete helpers, so on the published wheel these are absent:

`wait_for` · `packet_status` · `jobs` · `delete` · `delete_by_source`

The REST endpoints they call (`/v1/packets/:id/status`, `/v1/jobs`,
`DELETE /v1/memories`) are live regardless — call them directly, or install
from source (`pip install -e sdk/python`) until the publish lands. The npm
package tracks 0.2.0.
