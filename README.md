# Itsuki

**Try it live: [https://itsuki.app](https://itsuki.app)** — free during early access, sign in with Google or GitHub.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**A structured memory service for AI applications and coding agents.**

Itsuki (樹, "tree") stores durable context as a structured graph you can open, search, edit,
and export — not a hidden blob, and not a chat log replayed back at you. It exposes that
service through MCP, REST, server-side SDKs, a dashboard, and a Claude Code plugin.

Live at **https://itsuki.app** · Apache-2.0 · built entirely on Cloudflare.

---

## What makes it different

Most memory tools onboard *developer* tools — an IDE, a coding agent, a CLI. Itsuki also
exposes a Streamable HTTP MCP endpoint for supported chat-app connectors. The client or host
model still decides whether and when to call a memory tool.

Itsuki provides four interfaces to one account- and scope-aware backend:

| Door | Who uses it |
| --- | --- |
| **App Connect** | claude.ai and ChatGPT — paste one MCP link. Coding agents (Claude Code, Codex, Cursor, OpenCode, Antigravity) and agent harnesses (OpenClaw, Hermes, Pi) each have a Get-started tab |
| **REST API** | `/v1/*` with a Bearer key |
| **SDKs** | `itsuki` for Node and Python |
| **The app itself** | dashboard, graph, and a Playground that captures as you talk |

These interfaces route through the same server-side authentication, scope, extraction, and
receipt code paths. End-to-end behavior still depends on each client's configuration and tool
use; the repository does not treat an available connector as proof that a host called it.

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
  tools; it cannot force a call. For guaranteed per-turn invocation, call the API or SDK
  inside your own app and inspect the receipt and terminal packet status.
- Claude remote custom connectors are currently a beta on Free, Pro, Max, Team, and Enterprise;
  Free is limited to one, and organization plans require an owner to add the connector. ChatGPT's
  full MCP write actions — required for Itsuki save as well as recall — are currently limited to
  Business and Enterprise/Edu on the web; Pro custom apps are read/fetch only. Check the current
  [Claude connector guide](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
  and [ChatGPT MCP availability](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt-beta) before setup.
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
| MCP server (11 tools) | `src/mcp/server.js` |
| Extraction pipeline | `src/pipeline/` |
| App UI — landing + dashboard, one file, no build step | `public/index.html` |
| Docs site | `public/docs/index.html` → `/docs/` |
| SDKs | `sdk/js/`, `sdk/python/` |
| Benchmark harness | `evals/locomo/` |
| Migrations | `migrations/` |

## The app

Signed in at `/app`:

**Setup** — Get started (App Connect · SDK · Integrations · Plugin · Agents), Playground, API Keys.
**Activity** — Dashboard, Memories, Graph, Requests, Memory exports, History.

- **Get started** walks you through connecting Claude, ChatGPT, coding editors (Claude Code,
  Codex, Cursor, OpenCode, Antigravity), agent harnesses (OpenClaw with prompt/manual
  routes, Hermes, Pi), or frameworks and tools (LangChain, LangGraph, CrewAI, AutoGen, Agno,
  OpenAI Agents SDK, Google ADK, LlamaIndex, Mastra, Vercel AI SDK, n8n, Dify, Convex).
  Before you create a link, no code block is copyable — the copy button *is* the create-link
  button, so you can never copy a URL that cannot work.
- **Playground** submits conversations through the same extraction pipeline and displays the
  resulting receipts and memory panel. Rules and gates may save, update, or skip a proposal.
  Per-thread settings feed the account rules system.
- **Requests** shows every call that reached your memory — type, entities, event, latency,
  status. Metadata only: the query never selects a column that could contain your words.
- **Memory exports** builds a JSON copy of one memory space as a background job.

## MCP tools

| Tool | Use |
| --- | --- |
| `save_memory` | Save one durable fact in the user's words. |
| `save_conversation` | Digest a batch of messages, then extract. |
| `recall_memory` | Return compact, relevant context about the user. |
| `list_memories` | List stored memories for the resolved space. |
| `get_memory` | Read one memory by id. |
| `update_memory` | Revise a memory, keeping its history. |
| `rollback_memory` | Restore a memory to an earlier revision. |
| `memory_history` | Show a memory's revision history. |
| `delete_memory` | Delete one memory. |
| `delete_all_memories` | Delete every memory in the resolved space. |
| `whoami` | Report the resolved identity and space. |

Use the stable `/mcp` endpoint with `Authorization: Bearer <key>` when the client supports
headers. Generated MCP-link URLs keep identity in `/mcp/<token>` for headerless clients.
The Streamable HTTP endpoint accepts at most 512 KiB of actual UTF-8 request bytes and
returns a JSON-RPC `request_too_large` error before parsing a larger declared or chunked body.
**Treat either credential as a secret** — generated links are shown once. Tokens minted before
the rename (`uml_live_...`) keep working; a rename must never break someone's integration.

## HTTP API

| Route | Method | Purpose |
| --- | --- | --- |
| `/v1/save` | `POST` | Save a fact, or a conversation. |
| `/v1/recall` | `POST` | Recall compact context for a query. |
| `/v1/turn` | `POST` | One call per agent turn: recall + capture together. |
| `/v1/ingest` | `POST` | Submit one bounded conversation batch with optional idempotency. |
| `/v1/ingest/limits` | `GET` | Read the authoritative machine-readable ingest limits and delivery schema. |
| `/v1/graph` | `GET` | The whole graph: nodes, slices, events, edges, candidates. |
| `/v1/usage` | `GET` | Per-day activity rollups. |
| `/v1/requests` | `GET` | Request metadata for the Requests page. |
| `/v1/exports` | `GET` `POST` | List or start an export job. |
| `/v1/receipts` | `GET` | Recent save receipts. |
| `/v1/rules` | `GET` `PUT` | What to collect, and what never to. |
| `/v1/export` | `GET` | One resolved memory space — its live memory objects, receipts, rules and revision history — as one JSON file. Sources, jobs and sibling subtenant spaces are not included. |
| `/mcp` or `/mcp/<token>` | MCP | Streamable HTTP endpoint; Bearer auth is preferred, path tokens support generated links. |
| `/auth/projects` | `GET` `POST` | List or create dashboard-managed projects (session auth). |
| `/auth/projects/<id>` | `PATCH` | Rename a managed project or update its description (session auth). |

Auth is a session cookie (app), an `itsuki_live_` Bearer key (API/SDK), or the legacy
`x-api-key` + explicit `userId` (admin/tools). Passing a `userId` different from the key owner
creates an **isolated sub-tenant memory space** — that is how one key serves many end users.

### Account, managed project, end user, and source scope

A dashboard **managed project** is a server-owned isolation boundary. Selecting one changes the
memory graph, source episodes and FTS, vectors, entities, receipts, jobs, requests, exports,
webhooks, Playground threads/rules, API keys, MCP credentials, and usage shown by the app. A
project-bound key cannot switch projects with a request header. Keys created before managed
projects existed remain bound to the default project, which maps to the historical account
memory identity so existing data does not move or disappear.

Browser sessions select a project with `x-itsuki-project`. SDK, REST, and MCP users normally do
not send that header: the `itsuki_live_` key itself selects its immutable project. `userId`
remains the optional end-user/sub-tenant boundary *inside* that selected project, so the same
external user id in two projects still resolves to two unrelated memory spaces.

The older `memoryScope: { projectId, projectName }` field has a different purpose: it is optional
source/repository provenance inside the selected managed project. It does not select a dashboard
project and can never override the project bound to the session or key. This preserves coding-
repository attribution and explicit recall modes without trusting client metadata as tenancy.

Recall is explicit:

- omit `recallScope` (or use `global`) for all memories in the selected managed project;
- use `project_only` with `memoryScope.projectId` for one source/repository tag inside it;
- use `project_then_global` for that source tag plus untagged rows, excluding other source tags.

The Claude plugin writes project metadata under the account and uses `project_then_global` at
SessionStart. Older plugin versions wrote `project:<basename>` as isolated sub-tenants; the
account graph reports those legacy spaces as read-only inventory because basename collisions
make an automatic destructive merge unsafe.

### Claude Code plugin delivery

Claude Code itself can run without Node, but Itsuki's three lifecycle hooks require a maintained **Node 22 or 24 LTS**
runtime. Install the public plugin, then configure its two required options explicitly:

```powershell
claude plugin marketplace add 12ziyad/universal-memory-engine
claude plugin install itsuki@itsuki-plugins
```

In a Claude Code session, run `/plugin configure itsuki@itsuki-plugins`, select Node by its absolute path (for example,
`(Get-Command node).Source` in PowerShell or `command -v node` on macOS/Linux), and paste the full API key into the masked
prompt. Then run `/reload-plugins` and `/itsuki:doctor`. Claude stores the sensitive key in its credential store,
interpolates it into the bundled MCP header, and exposes it to plugin subprocesses as plugin-scoped configuration. Do not
put the key in a shell profile or set `ITSUKI_API_KEY`;
the reviewed plugin configuration is authoritative. Using the interactive configuration flow also avoids command-line
quoting differences for Windows executable paths containing spaces. Hooks never resolve `node` through a
project-controlled `PATH`.

SessionEnd does not use the network. It takes a bounded snapshot of the newest
80 completed durable coding outcomes plus any tool-call rows required to interpret them, scrubs them, and atomically queues
one or more protected, ordered v2 batch envelopes under
Claude's persistent `${CLAUDE_PLUGIN_DATA}/outbox/v1` directory before returning within Claude's shutdown budget.

Within that captured-and-scrubbed message set, batching does not silently drop content. A logical message that is too large
is divided at a natural Unicode boundary where possible, each segment receives an explicit position label, and the segments
remain in conversation order. Every batch carries a stable delivery group, batch index/count, source/segment counts, and
capture-omission fields (`captureTruncated` / `truncationReason`). If the bounded snapshot misses older records, encounters an oversized or malformed record, or races
a transcript rewrite, SessionEnd reports the omission and records its reason with every batch; it does not describe that
snapshot as complete.

Capture counters are content-free evidence about the bounded local scan, not part of a batch's semantic identity. A retry
with the same messages therefore reuses the same staged delivery plan even if its later scan observes different counters;
the first successfully staged evidence remains immutable and is the evidence reported for that delivery. The server applies
the same rule to replay identity while still validating and returning the accepted evidence in delivery receipts. If a
later duplicate scan observes an additional omission, SessionEnd reports that current omission in its hook status without
rewriting the evidence attached to the original queued snapshot.

SessionStart attempts at most four due batches before recall. It will not overtake an earlier batch in the same group.
Offline, DNS, timeout, 429, and server failures remain queued with content-bound idempotent backoff; a rejected key pauses
delivery; a permanent request error remains available for `/itsuki:doctor` instead of being discarded. Existing v1 spool
files remain drainable under their former 2 MiB raw-envelope cap; the server retains their bounded request contract of up to
80 messages, 4,001 Unicode code points per message, 320,080 total code points, and 2 MiB of serialized JSON. New plugin
writes use ordered v2 batches. Legacy responses carry `x-itsuki-ingest-contract: legacy-claude-outbox-v1`, and the server
emits content-free migration telemetry; this dual contract exists only so already-protected local data is not stranded.

The current v2 `/v1/ingest` wire contract is authoritative on the server and returned by `GET /v1/ingest/limits`:

| Boundary | Limit |
|---|---:|
| Messages per request | 30 |
| Content per message | 4,000 Unicode code points |
| Combined message content | 120,000 Unicode code points |
| Complete serialized request body | 512 KiB of actual UTF-8 JSON |

Separate downstream safeguards are internal engine boundaries, not fields returned by the limits endpoint:

| Boundary | Limit |
|---|---:|
| Downstream extraction queue entry | 20 messages and 12,000 Unicode code points |
| Complete serialized chat-model input | At most 24,576 UTF-8 bytes |

The model-input ceiling is a conservative full-input guard, not a per-message character allowance. If bounding is needed,
the engine labels omissions and preferentially preserves the newest/source tail; if fixed prompt/schema data cannot fit, it
fails before inference. It accounts for the configured models' documented context windows: Qwen3 extraction is 32,768
tokens, Llama 3.1 summary/digest is 32,000, and Llama 3.2 playground chat is 60,000. After output/template reserves and the
global byte ceiling, their maximum serialized inputs are 24,576, 23,808, and 24,576 bytes respectively; unknown overrides
use the conservative 32,000-token profile. The local outbox separately permits at most 128 raw batch envelopes, 64 MiB total, and 2 MiB per
envelope. It never evicts undelivered content to make room. Raw content is removed as soon as `/v1/ingest` durably accepts
it; body-free completion tombstones remain for seven days. Directories/files are protected as 0700/0600 on POSIX and with
a verified current-user/SYSTEM/Administrators DACL on Windows. If that protection cannot be established, the hook fails
closed and says that the session was **not queued**.

"Queued locally" means only that the protected write completed. "Accepted" means the server durably created the source
packet/job for a batch. Neither state means terminal enrichment: use packet/job status for `enriched` or `failed`. The next
SessionStart reports delivery/backlog state. Claude's SessionEnd budget can be tuned with
`CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`, but correctness does not depend on changing it.
Claude removes plugin data on final uninstall unless its `--keep-data` option is used.

## SDKs

This checkout prepares the Node SDK `0.3.0` and the Python SDK `0.4.1`. Registry installation
resolves whatever version is currently published; inspect the exported `VERSION` before relying
on the packet, jobs, polling, or deletion helpers.

```bash
npm install itsuki      # Node 18+, zero dependencies
pip install itsuki      # httpx
```

```js
import { MemoryClient } from "itsuki";
const memory = new MemoryClient({ apiKey: process.env.ITSUKI_API_KEY });

const receipt = await memory.add("I started learning Kotlin this week.", {
  idempotencyKey: memory.newIdempotencyKey(),
});
if (receipt.source_packet_id) await memory.waitFor(receipt.source_packet_id);
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
