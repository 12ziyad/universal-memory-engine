# Universal Memory Engine / UML

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

An external memory graph for AI assistants - one shared brain for ChatGPT, Claude, and your own apps.

UML is a Cloudflare-native memory engine that stores durable user facts as a graph. It gives assistants a shared long-term memory layer through HTTP APIs, an MCP endpoint, and a dashboard for inspecting what was saved.

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
| ChatGPT knows one set of facts and Claude knows another | Both can connect to the same MCP memory endpoint |
| Raw chat logs are noisy | The pipeline extracts durable facts, events, slices, and candidates |
| Memory is hard to inspect | The dashboard shows graph, table, cards, timeline, receipts, setup, and test views |
| Recall needs relevance | Recall combines structured graph data with Vectorize-backed semantic search when enabled |
| Long saves can time out | Saves return a receipt while Durable Objects continue background extraction |

## Features

- Manual memory save path for explicit "remember this" flows.
- Conversation save path that digests recent messages before extraction.
- Recall path that returns compact personal context for assistants.
- MCP Streamable HTTP endpoint for ChatGPT, Claude, and compatible clients.
- Dashboard with graph, node list, cards, table, timeline, receipts, setup, test, and model views.
- D1 relational storage for graph entities.
- Durable Object per user for batching, retries, and background extraction.
- Workers AI model configuration for extraction, digesting, summaries, and embeddings.
- Vectorize support for semantic recall and node embeddings.
- Receipt trail for saved memories and background processing states.

## Architecture

```text
AI assistant / app
        |
        | HTTP API or MCP tools
        v
Cloudflare Worker
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
| Workers | Public HTTP API, dashboard assets, auth gate, MCP routing |
| D1 | Nodes, slices, events, edges, candidates, checkpoints, receipts |
| Durable Objects | Per-user batching and background extraction continuity |
| Vectorize | Semantic shortlist and recall support |
| Workers AI | Extraction, digesting, summaries, embeddings |
| MCP endpoint | Remote tool door for assistants |

## Data Model

| Entity | Purpose |
| --- | --- |
| `nodes` | Stable memory objects such as "Grandmother", "Boxing", or a project |
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

MCP identity is encoded in the connector URL path as a per-user token. Treat generated MCP URLs as secrets.

## HTTP API

| Route | Method | Auth | Purpose |
| --- | --- | --- | --- |
| `/health` | `GET` | No | Basic service health check. |
| `/v1/save` | `POST` | `x-api-key` | Manual memory or conversation save. |
| `/v1/recall` | `POST` | `x-api-key` | Recall compact context for a query. |
| `/v1/graph` | `GET` | `x-api-key` | Load nodes, slices, events, edges, candidates, stats, and model metadata. |
| `/v1/receipts` | `GET` | `x-api-key` | Load recent save receipts. |
| `/v1/status` | `GET` | `x-api-key` | Return graph counts and checkpoint state. |
| `/v1/ingest` | `POST` | `x-api-key` | Batch message ingestion through the Durable Object. |
| `/mcp/<token>` | MCP | URL token | Streamable HTTP MCP endpoint. |

## Dashboard

The web dashboard is served from `public/index.html`.

- Graph view with category-colored nodes, fitting, selection focus, and empty/error states.
- Node list for quick navigation.
- Cards, table, and timeline views for inspecting saved memory.
- Saves/receipts view for save results and background processing.
- Setup view for API and MCP connection details.
- Test panel for manual save, conversation save, and recall checks.
- Model panel for seeing configured extraction model options.

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
| `API_KEY` | Secret | Required for `/v1/*` and encoded MCP URL auth. Never commit it. |
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
- MCP user URLs or tokens.
- Raw logs, screenshots, PDFs, or transcripts that contain secrets.

If a key or MCP URL was exposed in chat, screenshots, logs, or a public repo, rotate it before using the project in a public demo.

## Current Status

- Run 3.1 is deployed at `https://uml.gpmai.workers.dev`.
- Tests pass locally.
- Active extraction model is `@cf/qwen/qwen3-30b-a3b-fp8`.
- Manual saves, conversation saves, recall, graph loading, receipts, and MCP tools are built.
- Path B live observation is intentionally not built yet.

## Roadmap

- Path B `observe_turn` / `observe_pack` live memory mode.
- Key rotation UI and per-user credential management.
- Memory edit, delete, and merge flows.
- Multi-user auth beyond shared API key plus MCP URL token.
- Better graph clustering and relationship discovery.
- Export/import for memory portability.
- Richer audit and review workflows for proposed memories.

## License

Apache License 2.0. See [LICENSE](LICENSE).
