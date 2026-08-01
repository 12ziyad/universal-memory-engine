# itsuki (JavaScript SDK)

One private memory for every AI. Thin, dependency-free client for the Itsuki memory API. Node 18+.

```js
import { MemoryClient } from "itsuki";

const memory = new MemoryClient({ apiKey: process.env.ITSUKI_API_KEY });

await memory.add("I started learning Kotlin this week.");
const { context } = await memory.search("what am I learning?");
```

- `add(content)` / `addConversation(messages)` — write memory, returns a receipt
- `search(query)` — `result.context` is the prompt-ready block
- `turn(messages)` — recall + auto-capture in one call
- `graph()`, `status()`, `usage()`, `receipts()`, `getRules()`, `setRules()`, `exportAll()`
- Sub-tenants: `new MemoryClient({ apiKey, userId: "end-user-42" })` gives each of your users an isolated memory space under one key
- Safe retries: pass `idempotencyKey: memory.newIdempotencyKey()` to writes

Errors throw `MemoryAPIError` with `status`, `code`, and `body`. Docs: your deployment's `/docs/`.
