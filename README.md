# UML - Universal Memory Layer

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

One shared memory layer for supported AI tools, MCP clients, coding agents, and your own apps.

UML is a Cloudflare-native memory engine and product shell that stores durable user context as pages, nodes, slices, events, edges, and clusters. It gives supported assistants one private long-term memory layer through account sessions, per-tool API/MCP tokens, HTTP APIs, an MCP endpoint, and a dashboard for inspecting what was saved.

## What It Is

Universal Memory Engine turns messy conversation into structured memory:

- Nodes for people, projects, skills, health facts, tools, interests, preferences, and life events.
- Events for changes over time, such as started, paused, completed, diagnosed, or passed away.
- Slices for durable details about a node.
- Edges for relationships between nodes when the extraction pipeline can infer them.
- Receipts so every save has a traceable result.

The goal is not to replace an assistant. The goal is to give many assistants one reliable external memory.

## Why It Exists

Most AI tools keep memory inside one product. That makes memory fragmented:

| Problem | UML Approach |
| --- | --- |
| One assistant knows one set of facts and another starts fresh | Supported tools can connect to the same UML memory endpoint |
| Raw chat logs are noisy | The pipeline extracts durable facts, events, slices, and candidates |
| Memory is hard to inspect | The dashboard shows graph, table, cards, timeline, receipts, setup, and test views |
| Recall needs relevance | Recall combines structured graph data with Vectorize-backed semantic search when enabled |
| Long saves can time out | Saves return a receipt while Durable Objects continue background extraction |

## Features

- Manual memory save path for explicit "remember this" flows.
- Conversation save path that digests recent messages before extraction.
- Recall path that returns compact personal context for assistants.
- Recall includes both structured graph nodes and compact manual_collect memory pages.
- Public product landing page, email/password login, sign up, and authenticated dashboard shell.
- Session-backed browser dashboard with per-account memory isolation.
- Per-tool MCP/API tokens stored only as hashes and revealed once on creation.
- MCP Streamable HTTP endpoint for supported MCP clients and custom agents.
- Dashboard with Home, Graph, Memories, Save, Recall, Connect, Help, Profile, Settings, and Danger Zone / Reset sections.
- Deterministic graph layout, procedural cluster hulls, dynamic semantic clusters, latest-first sidebars, clean/all/focus/debug graph modes, receipts, cleanup, reset, setup, test, and model views.
- D1 relational storage for graph entities.
- Durable Object per user for batching, retries, and background extraction.
- Workers AI model configuration for extraction, digesting, summaries, and embeddings.
- Vectorize support for semantic recall and node embeddings.
- Receipt trail for saved memories and background processing states.

## Architecture

```text
Browser user / AI assistant / app
        |
        | session, HTTP API token, or MCP token
        v
Cloudflare Worker
        |
        +--> D1 users / sessions / connection tokens
        |
        +--> UserMemory Durable Object
        |       |
        |       +--> extraction / digest / pass-2 pipeline
        |
        +--> D1 graph store
        |
        +--> Workers AI
        |
        +--> Vectorize
        |
        v
Dashboard + recall context
```

## Cloudflare Stack

| Component | Role |
| --- | --- |
| Workers | Public product shell, HTTP API, dashboard assets, auth/session gate, MCP routing |
| D1 | Users, sessions, connection tokens, nodes, slices, events, edges, candidates, checkpoints, receipts |
| Durable Objects | Per-user batching and background extraction continuity |
| Vectorize | Semantic shortlist and recall support |
| Workers AI | Extraction, digesting, summaries, embeddings |
| MCP endpoint | Remote tool door for assistants |

## Data Model

| Entity | Purpose |
| --- | --- |
| `users` | Account identity for the private dashboard and memory ownership. |
| `sessions` | HttpOnly browser sessions stored as hashed random tokens. |
| `connection_tokens` | Per-tool API/MCP tokens stored as hashes and shown once on creation. |
| `nodes` | Stable memory objects such as "Grandmother", "Boxing", or a project |
| `memory_pages` | Manual_collect conversation pages with title, summary, key points, related concepts, and evidence |
| `slices` | Durable descriptive facts attached to nodes |
| `events` | Timeline entries that change or describe node state |
| `edges` | Directed relationships between nodes |
| `candidates` | Ambiguous or lower-confidence extracted memories |
| `receipts` | Save results, processing state, summaries, and diagnostics |
| `checkpoints` | Per-user ingestion progress |

## Paths

| Path | Status | Description |
| --- | --- | --- |
| Path A: manual save / collect | Built | Save one durable fact or a selected conversation chunk. |
| Path C: recall | Built | Retrieve compact memory context for a user query. |
| Path B: hybrid live mode | Planned | Future `observe_turn` / `observe_pack` style live observation. Not built yet. |

## MCP Tools

The MCP endpoint exposes three tools:

| Tool | Use |
| --- | --- |
| `save_memory` | Save a single durable fact in the user's words. |
| `save_conversation` | Save a recent conversation batch after digesting it into durable facts. |
| `recall_memory` | Recall relevant context about the user. |

MCP identity is resolved from a per-tool `uml_live_...` token in the connector URL path. Treat generated MCP URLs and tokens as secrets. The older base64url `userId:API_KEY` connector format is retained only for hidden dev/admin mode and tests.

## Auth And Identity

UML now has a first-party account/session model:

- `POST /auth/signup` creates a user and logs them in.
- `POST /auth/login` verifies email/password with Worker-compatible PBKDF2-SHA256.
- `GET /auth/me` returns the current browser profile.
- `POST /auth/logout` revokes the current session.
- `POST /auth/logout-all` revokes all browser sessions for the account.
- `GET /auth/tokens` lists masked per-tool tokens.
- `POST /auth/tokens` creates one-time API/MCP tokens.
- `POST /auth/tokens/:id/revoke` revokes a token.

Normal dashboard requests derive `userId` from the HttpOnly session cookie. API and MCP requests derive `userId` from the token owner. The legacy `x-api-key + userId` flow remains for dev/admin compatibility and tests, but it is not exposed in the normal product UI.

## HTTP API

| Route | Method | Auth | Purpose |
| --- | --- | --- | --- |
| `/health` | `GET` | No | Basic service health check. |
| `/v1/save` | `POST` | Session, bearer token, or legacy dev key | Manual memory or conversation save. |
| `/v1/recall` | `POST` | Session, bearer token, or legacy dev key | Recall compact context for a query. |
| `/v1/graph` | `GET` | Session, bearer token, or legacy dev key | Load nodes, slices, events, edges, candidates, stats, and model metadata. |
| `/v1/receipts` | `GET` | Session, bearer token, or legacy dev key | Load recent save receipts. |
| `/v1/status` | `GET` | Session, bearer token, or legacy dev key | Return graph counts and checkpoint state. |
| `/v1/ingest` | `POST` | Session, bearer token, or legacy dev key | Batch message ingestion through the Durable Object. |
| `/v1/actions/repair-graph` | `POST` | Session or legacy dev key | Organize clusters, preview/clean junk with confirmation, repair safe page titles, and return a receipt. |
| `/v1/actions/clean-junk` | `POST` | Session or legacy dev key | Preview junk-looking nodes/candidates; archives/suppresses only with `CLEAN JUNK`. |
| `/v1/actions/delete-all` | `POST` | Session or legacy dev key | Reset the authenticated user's memory rows only with `DELETE ALL`. |
| `/mcp/<token>` | MCP | Per-tool URL token | Streamable HTTP MCP endpoint. |

## Dashboard

The web product shell is served from `public/index.html`.

- Public landing page with UML branding, "One memory for every AI you use", and Save/Recall diagram.
- Login and sign up forms backed by real D1 users and sessions.
- Private dashboard at `/app`.
- Home tab with account welcome, stats, and quick actions.
- Graph tab with backend-computed spaced positions, procedural canvas cluster hulls, memory-page card nodes, UI-only related-concept guide lines, clean/all/focus/debug modes, fitting, selection focus, and empty/error states.
- Memories tab with latest-first pages/nodes and search.
- Save tab for "Save a fact" and "Collect a conversation".
- Recall tab for querying memory.
- Connect tab for one-time MCP/API token generation, masked token list, revoke, and practical setup cards.
- Help, Profile, Settings, and Danger Zone / Reset sections.
- Hidden dev/admin mode keeps legacy manual `userId` and global API key controls out of the normal UI.

## Local Development

Install dependencies:

```bash
npm install
```

Create local development secrets:

```bash
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` and set a local `API_KEY`. Do not commit `.dev.vars`.

Run tests:

```bash
npm test
```

Run the Worker locally:

```bash
npx wrangler dev
```

## Deployment

This project uses `wrangler.jsonc` for Cloudflare configuration. Configure your own D1 database, Durable Object migration, Vectorize index, Workers AI binding, and secrets before deploying.

Set the production API key as a secret:

```bash
npx wrangler secret put API_KEY
```

Deploy:

```bash
npx wrangler deploy
```

If you change bindings in `wrangler.jsonc`, regenerate types:

```bash
npx wrangler types
```

## Environment Variables And Secrets

| Name | Type | Notes |
| --- | --- | --- |
| `API_KEY` | Secret | Legacy dev/admin key for hidden manual `x-api-key + userId` flows and older encoded MCP URLs. Never commit it. |
| `USE_VECTORS` | Var | Enables Vectorize-backed embedding and recall behavior. |
| `ENABLE_PASS2` | Var | Enables pass-2 summary enrichment. |
| `LLM_PROVIDER` | Var | Currently configured for Workers AI. |
| `LLM_MODEL` | Var | Extraction model. Current deployment uses Qwen3 30B A3B FP8. |
| `LLM_MAX_TOKENS` | Var | Output budget for extraction. |
| `LLM_SUMMARY_MODEL` | Var | Smaller summary/pass-2 model. |
| `LLM_DIGEST_MODEL` | Var | Conversation digest model. |
| `EMBED_MODEL` | Var | Embedding model for semantic search. |

## Security Warning

Never commit:

- Cloudflare API tokens or Wrangler auth tokens.
- `.env`, `.dev.vars`, or local secret files.
- Production API keys.
- Browser session cookies.
- API/MCP user URLs or tokens.
- Raw logs, screenshots, PDFs, or transcripts that contain secrets.

If a key or MCP URL was exposed in chat, screenshots, logs, or a public repo, rotate it before using the project in a public demo.

## Current Status

- Product shell auth is implemented in this repo: public landing page, login, sign up, browser sessions, per-user memory isolation, per-tool API/MCP tokens, private dashboard tabs, and session-scoped reset.
- Run 3.4.4 is implemented in this repo: memory page identity, dynamic semantic clusters, evidence dedupe, sidebar latest-first ordering, graph spacing/color/living hull polish, safer cleanup/reset UX, graph repair, and title-quality fixes.
- Tests pass locally.
- Active extraction model is `@cf/qwen/qwen3-30b-a3b-fp8`.
- Manual saves, conversation saves, memory page recall, graph loading, receipts, and MCP tools are built.
- Graph view supports clean, all, focus, and debug modes. Clean is the default.
- Safe reset/delete-all requires the exact confirmation string `DELETE ALL` for the selected user.
- Path B live observation is intentionally not built yet.

## Roadmap

- Path B `observe_turn` / `observe_pack` live memory mode.
- Key rotation UI and per-user credential management.
- Memory edit, delete, and merge flows.
- Password reset and account deletion flows.
- Better graph clustering and relationship discovery.
- Export/import for memory portability.
- Richer audit and review workflows for proposed memories.

## License

Apache License 2.0. See [LICENSE](LICENSE).
