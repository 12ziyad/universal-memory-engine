# itsuki (JavaScript SDK)

This is the dependency-free, server-side JavaScript client for the Itsuki memory API.

## Install

```sh
npm install itsuki
```

Node.js 18 or newer is required because the SDK uses the built-in `fetch`, `AbortController`, and `node:crypto`. Keep the API key on your server; do not embed a long-lived key in browser code.

Custom service origins must use HTTPS and cannot include credentials, paths, query strings, or fragments. Plain HTTP is accepted only for loopback development hosts so a Bearer key cannot be sent to a remote cleartext endpoint.

```js
import { MemoryClient } from "itsuki";

const memory = new MemoryClient({
  apiKey: process.env.ITSUKI_API_KEY,
});

const receipt = await memory.add("I started learning Kotlin this week.", {
  idempotencyKey: memory.newIdempotencyKey(),
});

if (receipt.source_packet_id) {
  const terminal = await memory.waitFor(receipt.source_packet_id);
  console.log(terminal.status); // enriched, failed, or legacy completed
}

const { context } = await memory.search("What am I learning?");
```

## Supported operations

| SDK method | API operation | Purpose |
| --- | --- | --- |
| `add(content)` / `save(content)` | `POST /v1/save` | Save one durable fact. |
| `addConversation(messages)` | `POST /v1/save` | Save a conversation through the graph extraction engine. |
| `turn(messages)` | `POST /v1/turn` | Recall and, when rules allow it, auto-capture one turn. |
| `search(query)` / `recall(query)` | `POST /v1/recall` | Return prompt-ready context and structured recall results. |
| `ingest(messages)` | `POST /v1/ingest` | Submit a bounded conversation batch, optionally with `flush: true`. |
| `packetStatus(id)` | `GET /v1/packets/:id/status` | Read one accepted write's current state. |
| `jobs()` | `GET /v1/jobs` | List accepted writes, optionally filtered by status. |
| `waitFor(id)` | packet status polling | Wait for `enriched`, `failed`, or compatibility state `completed`. |
| `delete(id)` | `DELETE /v1/memories/:id` | Delete one node, page, slice, or candidate. |
| `deleteBySource()` | `DELETE /v1/memories` | Dry-run or confirm a bulk source/time-window cleanup. |
| `graph()`, `status()`, `receipts()`, `usage()` | read endpoints | Inspect the current memory space. |
| `getRules()`, `setRules()` | `GET/PUT /v1/rules` | Read or update capture rules. |
| `exportAll()` | `GET /v1/export` | Export the selected memory space. |

Every network method returns a promise; invalid arguments can throw synchronously before a request begins. Writes can be accepted before background enrichment finishes. A successful write response is therefore not the same as terminal enrichment: use its `source_packet_id` with `packetStatus()` or `waitFor()`.

## Account, end-user, and project scope

The API key identifies the account. `userId` selects an isolated memory space for one end user of your application. Omit it for the API-key owner's root memory.

Set a default on the client:

```js
const adaMemory = new MemoryClient({
  apiKey: process.env.ITSUKI_API_KEY,
  userId: "ada",
});

await adaMemory.add("Ada's depot is in Porto.");
await adaMemory.search("Where is my depot?");
```

Or select it per call. Per-call selection works on writes, reads, packet/job status, rules, exports, and deletion:

```js
await memory.add("Grace's depot is in Faro.", { userId: "grace" });
await memory.search("Where is my depot?", { userId: "grace" });
await memory.jobs({ userId: "grace", status: "failed" });
```

A per-call `userId` overrides the constructor default. Pass `userId: null` explicitly to select the account root from a client that normally targets a sub-tenant. A typo in a GET/delete option is rejected locally instead of silently selecting the wrong memory space; unknown write-body parameters are rejected by the API.

Projects are metadata within one account or end-user memory space, not separate tenants:

```js
const memoryScope = { projectId: "atlas", projectName: "Atlas" };

await memory.add("Atlas deploys from main.", { memoryScope });

const result = await memory.search("How does Atlas deploy?", {
  memoryScope,
  recallScope: "project_then_global",
});
```

Recall defaults to `global`. Use `project_only` for exactly one project, or `project_then_global` for that project plus rows without a project. Both project modes require `memoryScope.projectId`.

## Idempotency, retries, and terminal status

Create a unique key for each logical write and reuse that key only when retrying the same content:

```js
const idempotencyKey = MemoryClient.newIdempotencyKey();
const receipt = await memory.ingest(messages, {
  flush: true,
  idempotencyKey,
});
const terminal = await memory.waitFor(receipt.source_packet_id, {
  timeoutMs: 60_000,
  intervalMs: 1_500,
});
```

GET requests retry retryable transport/HTTP failures up to `maxRetries` (0–10). A POST is retried only when its body contains an `idempotencyKey`; non-idempotent writes are attempted once. `timeoutMs` bounds the complete request, including retry backoff and every attempt, so an untrusted `Retry-After` value cannot extend the caller's budget. Request and polling timers are capped at Node's safe maximum of `2_147_483_647` milliseconds. `waitFor()` returns the last packet state with `timed_out: true` when its polling budget expires, and a positive polling budget also bounds each status request. A polling timeout is not reported as a terminal job failure.

## Deletion

Delete one known memory object:

```js
await memory.delete("slice_123", { userId: "ada" });
```

Bulk deletion is dry-run by default. Inspect the result before sending the confirmed request:

```js
const after = Date.now() - 60_000;
const preview = await memory.deleteBySource({ source: "ingest", after });

if (preview.dry_run) {
  await memory.deleteBySource({ source: "ingest", after, confirm: true });
}
```

`confirm: true` is destructive. With no source or time filter it can select all extraction runs in the chosen memory space.

## Errors and TypeScript

Every HTTP, timeout, transport, or local validation failure throws `MemoryAPIError`:

```js
import { MemoryAPIError } from "itsuki";

try {
  await memory.packetStatus("missing-packet");
} catch (error) {
  if (error instanceof MemoryAPIError) {
    console.error(error.status, error.code, error.message);
  }
}
```

- `status` is the HTTP status, or `0` for local/transport errors.
- `code` prefers the API's machine-readable `code`, then its `error` value.
- `body` contains the parsed error response when one was available.
- `retryAfterMs` contains a parsed `Retry-After` delay when the server supplied one.

The package includes first-party TypeScript declarations for client options, scopes, messages, receipts, jobs, terminal status, deletion, and errors.

## 0.2.1 release changes

This directory is the `0.2.1` release candidate. `npm install itsuki` resolves the version currently published to the registry; inspect the exported `VERSION` before relying on newly prepared helpers.

- Adds complete TypeScript declarations.
- Makes per-call `userId` selection consistent across every supported operation.
- Treats the compatibility job state `completed` as terminal.
- Preserves machine-readable API error codes and `Retry-After` metadata.
- Validates ambiguous client arguments before any network request.
