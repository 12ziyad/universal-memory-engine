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

## Many end users, one API key

Your API key is your account. `userId` selects an
**isolated memory space inside it** — one per end user of your app. Nothing
saved for one value is reachable from another, on save or on recall.

```
await memory.add("Ada's depot is in Porto.", { userId: "ada" });
await memory.add("Grace's depot is in Faro.", { userId: "grace" });

const { context } = await memory.search("where is my depot?", { userId: "ada" });
// -> Porto, never Faro
```

Pass it per call, or fix it for the life of a client with
`new MemoryClient({ apiKey, userId: "ada" })`. Omit it entirely and the memory
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
const receipt = await memory.ingest(messages, { flush: true });
const done = await memory.waitFor(receipt.source_packet_id);   // polls until terminal
// done.status is "enriched" or "failed" — never silently neither.
```

`memory.packetStatus(id)` answers once; `memory.jobs({ status: "failed" })`
lists every accepted write and where it is. Webhooks can subscribe to
`memory.enriched` and `memory.failed` for push instead of poll.

**Idempotent replay:** re-sending identical content (or reusing an
`idempotencyKey`) within 24 hours returns the ORIGINAL receipt and enqueues
nothing — client retries after a timeout cannot double-ingest.

## Changelog note — addConversation now builds the graph

`addConversation()` previously condensed the conversation into one flat
memory page. It now runs the same extraction engine as every other write:
entities, facts, relationships, bi-temporal history. Expect richer results
from the same call — nodes AND edges where you used to get a page.

## Version skew (read this if a method is missing)

The **source in this repo is 0.2.0** and npm tracks it. The PyPI package may
still be **0.1.1** until the next release is pushed, so a Python service and a
JS service in the same system can disagree about which helpers exist
(`waitFor`/`wait_for`, `jobs`, `delete`, `deleteBySource`). The REST endpoints
behind them are live either way.
