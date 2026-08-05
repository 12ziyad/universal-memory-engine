# Itsuki

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**One private memory graph, shared by every AI you use.**

Tell it once. Claude remembers. ChatGPT remembers. Your agent remembers. Itsuki (樹, "tree")
stores the durable parts of what you say as a structured graph you can open, search, edit,
and export — not a hidden blob, and not a chat log replayed back at you.

Live at **https://itsuki.app** · Apache-2.0 · built entirely on Cloudflare.

---

## What makes it different

Most memory tools onboard *developer* tools — an IDE, a coding agent, a CLI. Itsuki connects
**claude.ai and ChatGPT directly**. A non-technical person pastes one link into their chat
app's connector settings and their assistant starts remembering them. No SDK, no terminal.

The same memory is reachable four ways, and they are all the same engine:

| Door | Who uses it |
| --- | --- |
| **App Connect** | claude.ai, ChatGPT, Cursor — paste one MCP link |
| **REST API** | `/v1/*` with a Bearer key |
| **SDKs** | `itsuki` for Node and Python |
| **The app itself** | dashboard, graph, and a Playground that captures as you talk |

One engine, many doors. A new door is never a new engine — the Playground you can try in the
browser runs the same extraction and writes the same receipts a connected Claude does.

## What it stores

Chat history is not memory. Messages are source material; Itsuki keeps the meaning that
should outlive the conversation.

| Object | What it is |
| --- | --- |
| `nodes` | The stable things: a person, a project, a skill, a condition, a tool |
| `slices` | Durable details about a node ("trains three days a week") |
| `events` | Changes over time — started, moved, diagnosed, completed, passed away |
| `edges` | Stated relationships between nodes |
| `memory_pages` | Whole-conversation notes, with evidence |
| `candidates` | Weak signals waiting to become real, or to be dropped |
| `receipts` | What each call saved, updated, or refused — and why |

The graph can **update**, not just append. New evidence supersedes an old fact and keeps the
old one visible on a timeline. It is not an append-only log.

**The backend is the authority, not the model.** The LLM only *proposes*. Gates decide what is
written, and your own rules run as filters — so a model that ignores your instructions still
cannot save what you told it not to.

## Honest limits

- Through MCP, the **host model decides** when to call a memory tool. Itsuki provides the
  tools; it cannot force a call. For guaranteed per-turn capture, use the API or SDK inside
  your own app.
- Custom connectors need a **paid plan** on both Claude and ChatGPT, and must be added from a
  computer — neither phone app can add one.
- Itsuki does not sell data, run third-party trackers, or train on your memory. Fonts are
  self-hosted for the same reason: a font CDN would see every visitor's IP.

## Architecture

```text
claude.ai / ChatGPT / Cursor / your app / the dashboard
        |
        |  MCP token, Bearer key, or browser session
        v
Cloudflare Worker  (src/index.js — exact-match route map)
        |
        +--> D1            users, sessions, tokens, and the graph
        +--> UserMemory    one Durable Object per user: holds, batches,
        |    (per user)    runs extraction, builds exports
        +--> Workers AI    extraction, digest, summaries, embeddings
        +--> Vectorize     semantic half of the shortlist
        v
receipts + recall context
```

| Area | Path |
| --- | --- |
| Routes | `src/index.js` |
| Auth, tokens, Google OAuth | `src/auth.js` |
| MCP server (3 tools) | `src/mcp/server.js` |
| Extraction pipeline | `src/pipeline/` |
| App UI — landing + dashboard, one file, no build step | `public/index.html` |
| Docs site | `public/docs/index.html` → `/docs/` |
| SDKs | `sdk/js/`, `sdk/python/` |
| Benchmark harness | `evals/locomo/` |
| Migrations | `migrations/` |

## The app

Signed in at `/app`:

**Setup** — Get started (App Connect · SDK · Plugin), Playground, API Keys.
**Activity** — Dashboard, Memories, Graph, Requests, Memory exports, History.

- **Get started** walks you through connecting Claude, ChatGPT, or Cursor. Before you create a
  link, no code block is copyable — the copy button *is* the create-link button, so you can
  never copy a URL that cannot work.
- **Playground** is a real conversation with a live Memories panel. Everything it captures is
  genuinely saved, by the same pipeline, with a receipt. Per-thread settings change what gets
  captured, and they feed the real rules system.
- **Requests** shows every call that reached your memory — type, entities, event, latency,
  status. Metadata only: the query never selects a column that could contain your words.
- **Memory exports** builds a full JSON copy as a background job in your Durable Object.

## MCP tools

| Tool | Use |
| --- | --- |
| `save_memory` | Save one durable fact in the user's words. |
| `save_conversation` | Digest a batch of messages, then extract. |
| `recall_memory` | Return compact, relevant context about the user. |

Use the stable `/mcp` endpoint with `Authorization: Bearer <key>` when the client supports
headers. Generated MCP-link URLs keep identity in `/mcp/<token>` for headerless clients.
**Treat either credential as a secret** — generated links are shown once. Tokens minted before
the rename (`uml_live_...`) keep working; a rename must never break someone's integration.

## HTTP API

| Route | Method | Purpose |
| --- | --- | --- |
| `/v1/save` | `POST` | Save a fact, or a conversation. |
| `/v1/recall` | `POST` | Recall compact context for a query. |
| `/v1/turn` | `POST` | One call per agent turn: recall + capture together. |
| `/v1/ingest` | `POST` | Batch messages through the Durable Object. |
| `/v1/graph` | `GET` | The whole graph: nodes, slices, events, edges, candidates. |
| `/v1/usage` | `GET` | Per-day activity rollups. |
| `/v1/requests` | `GET` | Request metadata for the Requests page. |
| `/v1/exports` | `GET` `POST` | List or start an export job. |
| `/v1/receipts` | `GET` | Recent save receipts. |
| `/v1/rules` | `GET` `PUT` | What to collect, and what never to. |
| `/v1/export` | `GET` | Everything you own, streamed as one JSON file. |
| `/mcp` or `/mcp/<token>` | MCP | Streamable HTTP endpoint; Bearer auth is preferred, path tokens support generated links. |

Auth is a session cookie (app), an `itsuki_live_` Bearer key (API/SDK), or the legacy
`x-api-key` + explicit `userId` (admin/tools). Passing a `userId` different from the key owner
creates an **isolated sub-tenant memory space** — that is how one key serves many end users.

### Account, project, and recall scope

`userId` remains a true end-user/sub-tenant boundary. A coding project is not another user:
send it as `memoryScope: { projectId, projectName }`. Project rows stay in the authenticated
account graph with explicit `project_id` / `project_name` provenance, so the dashboard, MCP,
and SDK doors can discover the same memory without weakening account isolation.

Recall is explicit:

- omit `recallScope` (or use `global`) for the whole account memory, including every project;
- use `project_only` with `memoryScope.projectId` for exactly one project;
- use `project_then_global` for that project plus account-global rows, excluding other projects.

The Claude plugin writes project metadata under the account and uses `project_then_global` at
SessionStart. Older plugin versions wrote `project:<basename>` as isolated sub-tenants; the
account graph reports those legacy spaces as read-only inventory because basename collisions
make an automatic destructive merge unsafe.

## SDKs

```bash
npm install itsuki      # Node 18+, zero dependencies
pip install itsuki      # httpx
```

```js
import { MemoryClient } from "itsuki";
const memory = new MemoryClient({ apiKey: process.env.ITSUKI_KEY });

await memory.add("I started learning Kotlin this week.");
const { context } = await memory.search("what am I learning?");
```

Source lives in [`sdk/js/`](sdk/js) and [`sdk/python/`](sdk/python).

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # set a local API_KEY; never commit this file
npx vitest run
npx wrangler dev
```

Deploy:

```bash
npx wrangler d1 migrations apply uml-memory --remote
npx wrangler deploy
```

## Configuration

| Name | Type | Notes |
| --- | --- | --- |
| `API_KEY` | Secret | Legacy admin key for `x-api-key + userId` flows. Never commit it. |
| `LLM_MODEL` | Var | Extraction model. Tuned for capture — changing it changes what is saved. |
| `CHAT_MODEL` | Var | Playground conversation model. Deliberately separate from `LLM_MODEL`. |
| `LLM_SUMMARY_MODEL` · `LLM_DIGEST_MODEL` | Var | Cheaper models for pass-2 and digests. |
| `EMBED_MODEL` | Var | Embeddings for semantic recall. |
| `USE_VECTORS` · `ENABLE_PASS2` | Var | Feature flags; off in tests. |
| `ENABLE_CORS` | Var | Cross-origin `/v1/*`. Bearer only, credentials never allowed. |
| `PLAYGROUND_DAILY_MESSAGES` · `PLAYGROUND_MAX_THREADS` | Var | Playground caps, per user. |
| `EXPORT_MAX_BYTES` | Var | Largest export a job will hold for download. |

Never commit Cloudflare tokens, `.dev.vars`, production keys, session cookies, or MCP URLs.
If one has been exposed anywhere, rotate it before using the project in public.

## License

Apache License 2.0. See [LICENSE](LICENSE).
