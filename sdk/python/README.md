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

Errors raise `MemoryAPIError` with `.status`, `.code`, and `.body`. Docs: your deployment's `/docs/`.
