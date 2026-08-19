# itsuki (Python SDK)

Python client for the Itsuki memory API. It is typed, synchronous, and supports
Python 3.9 and newer.

```bash
pip install itsuki
```

```python
import os

from itsuki import MemoryClient

memory = MemoryClient(api_key=os.environ["ITSUKI_API_KEY"])

receipt = memory.add(
    "I started learning Kotlin this week.",
    idempotency_key=MemoryClient.new_idempotency_key(),
)
print(memory.search("what am I learning?")["context"])
```

Keep API keys on the server. Itsuki sends them as Bearer credentials. Legacy
`uml_live_...` keys remain accepted by the API, while new keys use
`itsuki_live_...`.

Custom `base_url` values must be bare HTTPS origins without credentials, a
path, query, or fragment. Plain HTTP is accepted only for loopback development
(`localhost`, `127.0.0.0/8`, or `::1`), so a Bearer key cannot be sent to an
arbitrary cleartext host.

## Core operations

| Python | API | Result |
|---|---|---|
| `add(content)` | `POST /v1/save` | Durable-write receipt |
| `add_conversation(messages)` | `POST /v1/save` | Durable-write receipt |
| `turn(messages)` | `POST /v1/turn` | Recall plus optional auto-capture |
| `search(query)` / `recall(query)` | `POST /v1/recall` | Prompt-ready `context` |
| `ingest(messages)` | `POST /v1/ingest` | Bounded bulk-ingest receipt |
| `packet_status(id)` | `GET /v1/packets/:id/status` | One job snapshot |
| `jobs()` | `GET /v1/jobs` | Accepted-write ledger |
| `wait_for(id)` | packet status polling | Terminal job snapshot |
| `update(id, fields, expected_revision=...)` | `PATCH /v1/memories/:id` | Correct editable fields; stale revisions refused, never overwritten |
| `history(id)` | `GET /v1/memories/:id/history` | Bounded immutable revision history |
| `rollback(id, to_revision, expected_revision=...)` | `POST /v1/memories/:id/rollback` | Restore an old revision as a new forward revision |
| `delete(id)` | `DELETE /v1/memories/:id` | One-memory deletion |
| `delete_by_source(...)` | `DELETE /v1/memories` | Dry-run or confirmed bulk deletion |

`graph()`, `status()`, `receipts()`, `usage()`, `get_rules()`, `set_rules()`,
and `export_all()` expose the remaining account endpoints.
`usage(range=...)` accepts exactly `1d`, `7d`, `30d`, or `all`.

Conversation messages are oldest first:

```python
from itsuki import Message

messages: list[Message] = [
    {"role": "user", "content": "My preferred editor is Helix."},
    {"role": "assistant", "content": "Noted."},
]

receipt = memory.add_conversation(
    messages,
    conversation_id="onboarding-42",
    idempotency_key=MemoryClient.new_idempotency_key(),
)
turn = memory.turn(messages, thread_id="support-42")
```

`add()` and `search()` require non-empty strings, and
`add_conversation()` requires at least one message. `turn([])` is valid only
when accompanied by a non-empty `query`; `ingest([])` remains valid so a caller
can flush held context. Method-owned fields such as `content`, `messages`,
`mode`, and `query` cannot be replaced through extra options.

Writes are not automatically retried unless they contain an
`idempotency_key`. Reads are retried for transient transport, rate-limit, and
server failures according to `max_retries`, which defaults to `2` and accepts
values from `0` through `10`. The client's `timeout` bounds the complete
request, including retry backoff and every attempt, and request/poll timers
cannot exceed `2_147_483.647` seconds.

## Tenant and project scope

Your API key selects an account. `user_id` optionally selects one isolated
end-user memory inside that account:

```python
memory = MemoryClient(api_key=os.environ["ITSUKI_API_KEY"], user_id="ada")
memory.add("My depot is in Porto.")

# A per-call value overrides the constructor default.
memory.search("where is my depot?", user_id="grace")

# Explicit None selects the API-key owner's memory for this call.
memory.status(user_id=None)
```

Per-call `user_id` works on writes, recall, graph/status reads, packet/job
status, exports, and deletes. Capture rules are account-wide: `get_rules()` and
`set_rules()` govern every end-user memory under the API key even when a client
or call supplies `user_id`. An empty or whitespace-padded value is
rejected locally so it cannot silently fall back to another memory space.

Projects are metadata within a memory space, not tenants:

```python
from itsuki import MemoryScope

scope: MemoryScope = {"project_id": "atlas", "project_name": "Atlas"}
memory.add("Atlas deploys from main.", memory_scope=scope)
result = memory.search(
    "How does this deploy?",
    memory_scope=scope,
    recall_scope="project_then_global",
)
```

The default recall scope is `global`. `project_only` searches exactly one
project. `project_then_global` searches that project plus account-global rows.
Both project-specific modes require `memory_scope.project_id` (camel-case
`projectId` is also accepted).

## Background status and deletion

Every accepted write exposes a `source_packet_id` for its asynchronous work:

```python
receipt = memory.ingest(messages, flush=True)
packet_id = receipt["source_packet_id"]

current = memory.packet_status(packet_id)
terminal = memory.wait_for(packet_id, timeout=60, interval=1.5)
failed = memory.jobs(status="failed", limit=20)
```

Job status filters accept `queued`, `staged`, `processing`, `enriched`,
`failed`, or `completed`; `since` and `limit` must be positive finite values,
and `limit` must be an integer.

`wait_for()` performs one immediate check, then polls until `enriched`,
`failed`, or compatibility status `completed`. If its polling deadline expires,
it returns the last snapshot with `timed_out=True`; a polling timeout is not
reported as a processing failure.

Bulk deletion is a dry run unless `confirm=True` is explicit:

```python
preview = memory.delete_by_source(source="ingest", after=started_at)
deleted = memory.delete_by_source(
    source="ingest",
    after=started_at,
    confirm=True,
)
```

When supplied, `source` must be a non-empty identifier and `before`/`after`
must be finite numbers greater than or equal to `1`.

### Scoped delete vs erasure

The two shapes behave differently on purpose:

- **Scoped** (a `source` and/or a time window) is curation. Saves already
  submitted and still processing are **not** cancelled — they finish, and their
  output lands after the delete. The preview reports `pending_jobs` so that
  count is never a surprise.
- **Unscoped and confirmed** is an erasure. It records a barrier, sweeps to
  convergence, and **cancels accepted work that has not yet committed**, so
  nothing erased can reappear.

```python
result = memory.delete_by_source(confirm=True, user_id="ada")
result["cancelled_runs"]       # in-flight saves the erasure cancelled
result["convergence_passes"]   # 1 means the first sweep was sufficient
result["deleted"]              # runs, nodes, pages, slices, events, edges, candidates
```

### A save your own erasure cancelled

A cancelled save is **terminal**, reported through the status you already poll:

```python
terminal = memory.wait_for(receipt["source_packet_id"])

if terminal.get("cancelled_by_delete"):
    terminal["status"]          # "failed"
    terminal["outcome_reason"]  # "cancelled_by_delete"
    terminal["error"]           # "cancelled_by_delete: a confirmed delete erased this scope …"
```

The status stays `failed` rather than becoming a new word, because every
released client treats `enriched`, `failed` and `completed` as the complete
terminal set — a fourth value would make an older client poll a finished job
forever. The distinction is published as its own field instead.

**Do not retry a cancelled save.** It is not transient: the barrier applies to
that original work, so a retry is cancelled the same way. If you still want the
content stored, submit it as a **new** save — work accepted after the barrier is
ordinary work and lands normally.

Triage — separate real failures from your own erasures by reading the field,
which this version returns on every job:

```python
failed = memory.jobs(status="failed", user_id="ada")
broken = [job for job in failed["jobs"] if not job.get("cancelled_by_delete")]
erased = [job for job in failed["jobs"] if job.get("cancelled_by_delete")]
```

The API also accepts a server-side filter, `GET /v1/jobs?cancelled=true|false`.
**This client cannot send it**: `jobs()` has a fixed signature and raises
`TypeError` on `cancelled`. That is a client limitation, not a server one —
filter locally as above, or call the endpoint directly with `httpx` when you
need the server to do it.

## Memory scope

Sending no `user_id` writes to your account root. Sending one creates an
isolated sub-tenant derived from your account plus that string — two accounts
sending the same `user_id` never share memory.

Project scope narrows recall *within* a memory user. Memory that the Claude Code
or Codex plugin captured in a project is reachable here **only when this client
carries the same project scope**:

```python
memory.recall(
    "deployment decisions",
    memory_scope={"project_id": "local_3f2a…"},
    recall_scope="project_then_global",   # or "project_only"
)
```

It does not become account-global on its own. Run the plugin's `doctor` to see
the project id a directory derives.

## Errors and types

Non-success responses and transport failures raise `MemoryAPIError` with:

- `status`: HTTP status, or `0` for a transport/local error;
- `code`: stable API/local error code when one is available;
- `body`: parsed response JSON, including non-object JSON;
- `retry_after`: parsed `Retry-After` delay in seconds, including HTTP-date values.

The package includes a `py.typed` marker and exports inline types for messages,
memory scopes, option dictionaries, write/recall/turn/delete results, packets,
jobs, counts, source-event metadata, recall scopes, capture density, and job
statuses.

## 0.2.1 release preparation

The source and artifacts prepared from this directory are version `0.2.1`.
PyPI `0.1.1` predates per-call read/delete tenant scope, packet/job helpers,
`wait_for`, and the typed surface. Confirm the installed version when upgrading:

```python
from itsuki import VERSION
print(VERSION)
```

Full API documentation is available at <https://itsuki.app/docs/>.
