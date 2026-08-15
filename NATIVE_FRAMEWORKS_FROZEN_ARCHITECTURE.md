# Itsuki Six Native Framework Integrations — FROZEN ARCHITECTURE REPORT

Research date: **2026-08-15**. Repo state at research time: branch `master`, HEAD `ee2fcff` ("Offer the published OpenClaw plugin as the first-class route"), working tree clean, origin `https://github.com/12ziyad/universal-memory-engine.git`.

Every claim in this report is labeled **[verified]** (read from source/registry/docs on 2026-08-15, with URL in §15), **[inferred]** (follows from verified facts but not directly read), or **[proposed]** (a design decision this report freezes). Nothing was implemented, committed, published, or deployed during this research.

---

## 1. Executive verdict

All six integrations are buildable as genuinely native experiences, but **three of the six premises in the tasking were stale and are corrected below** (§3). The most important corrections:

1. **Vercel AI SDK is now v7** (`ai@7.0.66`, provider spec v4). Mem0's provider (`@mem0/vercel-ai-provider@3.0.1`) is pinned to **AI SDK v6** and bundles five upstream provider SDKs as hard dependencies. Itsuki should not copy that architecture: the native, forward-compatible extension point is **`wrapLanguageModel` + `LanguageModelV4Middleware`**, which works over *any* provider with zero bundled dependencies. **[verified]**
2. **LlamaIndex has deprecated the `BaseMemory`-era memory classes.** The current architecture is the `Memory` class + **`BaseMemoryBlock`** plug-in interface (`_aget`/`_aput`/`atruncate`, async-first), and the host docs mark the Mem0 example as part of the deprecated generation. Itsuki should ship a **memory block**, not a `BaseMemory` clone. This creates one hard backend prerequisite: an **async Python client** (the published `itsuki` SDK is sync-only). **[verified]**
3. **Mastra deleted its Mem0 integration from the monorepo.** `@mastra/mem0@0.1.12` on npm is orphaned: it peer-pins `@mastra/core >=0.15.3-0 <0.17.0-0` while core is at **1.59.0**, its docs page 404s, and `integrations/` in the repo no longer contains `mem0`. Matching "what Mem0 provides" for Mastra means matching a dead package — Itsuki should instead target Mastra's **current** extension surfaces: `createTool` tools plus the **Processor** interface (`processInput`/`processOutputResult`), which gives true automatic lifecycle that Mem0 never had. **[verified]**
4. **ChatDev is not a stale JSON-configured project anymore.** ChatDev 2.0 (internally "DevAll", released 2026-01-07, Python 3.12-only) is YAML-workflow-driven and ships a **first-class memory-store registry** with built-in `type: simple | file | blackboard | mem0` backends and a documented third-party route: `Config + Store (subclass MemoryBase), register via register_memory_store()`. A genuine `type: itsuki` is achievable, ideally by upstream PR. **[verified]**
5. Agno (2.9.0) and CAMEL (0.2.90) match the tasking's classification: model-called Toolkit for Agno; `BaseKeyValueStorage` backend consumed by `ChatHistoryBlock`/`ChatHistoryMemory` for CAMEL. Both accept externally-packaged implementations with **zero upstream changes**. **[verified]**

**Verdict: GO on all six**, with two backend prerequisites (§4: async Python client release; JS/Python SDK version sync), one long-lead item (ChatDev upstream PR), and per-package stop-gates in §12. All six proposed package names are available on their registries as of 2026-08-15 (§6/§15). Existing MCP integrations remain the universal fallback path for every host — nothing in this plan removes or weakens the MCP door.

---

## 2. Verified current Itsuki baseline

Everything in this section was read directly from the repository at HEAD `ee2fcff` on 2026-08-15. **[verified]** throughout unless marked.

### 2.1 SDKs

| Surface | Repo state | Published state |
|---|---|---|
| JS SDK (`sdk/js`) | `itsuki` **0.2.1** (`index.js`/`index.d.ts`), Node ≥18, zero runtime deps | npm `itsuki` latest = **0.2.0** → **drift: 0.2.1 unpublished** |
| Python SDK (`sdk/python`) | `itsuki` **0.2.x** source, `httpx` (sync client only), typed via TypedDicts, py.typed | PyPI `itsuki` latest = **0.1.1** (published 2026-08-01, owner 12ziyad) → **drift: current source unpublished** |

JS SDK public contract (from `sdk/js/index.d.ts`, v0.2.1):

- Writes: `add`/`save(content, opts)`, `addConversation(messages, opts)`, `ingest(messages, opts)` (batch door with `delivery` envelope + `captureEvidence`), `turn(messages, opts)` (recall + optional auto-collect in one call).
- Reads: `search`/`recall(query, opts)` → `RecallResult { context, count, items, nodes, pages, recall_scope }`; `graph()`, `status()`, `receipts()`, `usage()`, `getRules()`/`setRules()`, `exportAll()`.
- Lifecycle: `packetStatus(sourcePacketId)`, `jobs({status,since,limit})`, `waitFor(sourcePacketId, {timeoutMs,intervalMs})` → terminal statuses `enriched | failed | completed` (full set: `queued | staged | processing | enriched | failed | completed`).
- Deletion: `delete(memoryId)`, `deleteBySource({source,before,after,confirm})` — **dry-run by default**, returns `would_delete` counts.
- Errors: `MemoryAPIError { status, code, body, retryAfterMs }`.
- Idempotency: `newIdempotencyKey()`; writes retry only when carrying an idempotency key.
- Tenancy: `userId` (default on client or per call; `null` explicitly selects the key owner's root space); `MemoryScope { projectId, projectName, workspaceId, appId, … }`; `recallScope: "global" | "project_only" | "project_then_global"`.
- Source events: `SourceEvent` schema `itsuki.source-event/v1` with 16 kinds (`user_prompt`, `assistant_prose`, `tool_call`, … `unresolved_issue`) and outcomes.

Python SDK mirrors this surface (sync only): `add`, `add_conversation`, `turn`, `ingest`, `search`, `graph`, `status`, `receipts`, `usage`, `get_rules`/`set_rules`, `export_all`, `delete`, `delete_by_source`, `packet_status`, `jobs`, `wait_for`, `new_idempotency_key`, `close`/context-manager; `MemoryAPIError`. **There is no `AsyncMemoryClient`** — this is the one hard backend gap for the Python-side integrations (§4, P-1).

### 2.2 MCP door (universal fallback; must remain available)

`src/mcp/server.js`, server name `itsuki-memory` **0.7.0**. Eight tools, exact registry:

| Tool | Inputs (zod) | Behavior |
|---|---|---|
| `save_memory` | `content` (req), `recentContext`, `conversationId`, `threadId`, `sourceId`, `idempotencyKey`, `memoryScope` | Direct-save lane, MCP lens, light path |
| `save_conversation` | `messages[{id?,role?∈user\|assistant,content,ts?}]` (req), `conversationId`, `threadId`, `sourceId`, `idempotencyKey`, `scope∈full\|lastN\|topic\|summary`, `n`, `topic`, `contentScope`, `memoryScope` | Receipt-first staging (<1 s), Engine v2 extraction in background DO |
| `recall_memory` | `query` (req), `recallScope`, `memoryScope`, tracking ids | Returns memory text itself in `content`, full payload in `structuredContent` |
| `list_memories` | `kind∈all\|node\|page`, `limit` 1–200 (default 50), `cursor`, `q` (substring), `memoryScope` | Inventory, newest first, opaque cursor pagination |
| `get_memory` | `id` (`node_`/`page_`/`slice_`/`cand…`) | One memory + slices + dated events |
| `delete_memory` | `id` | Single-object delete + tombstone; capability-gated |
| `delete_all_memories` | `confirm` (default false → **dry-run preview**), `source` | Bulk delete only with `confirm=true`; capability-gated |
| `whoami` | — | Identity, scopes, bound project, live counts |

Door-level behavior that every native package must reproduce or respect:
- **Tenancy is server-owned**: caller `memoryScope` is attribution only; the authenticated connection's project binding overwrites it (`projectBoundMemoryScope`). Forged owner/user ids cannot enter provenance.
- **Scopes**: `memory.read` / `memory.write` per token; managed-project capability `project.memory.delete` gates deletion separately.
- **Refusals are results, not transport errors**: rate limits (`rate_limited`, `retry_after_s`), monthly AI-write quota (`ai_quota_unavailable` fails CLOSED when the quota store is unreadable), and `queue_full` backpressure all return `ok:false` payloads with readable summaries.
- Per-actor rate buckets: `mcp-save` / `mcp-read` / `mcp-del` keyed by credential + bound project, never caller-supplied scope.

### 2.3 REST surface (from `src/index.js` route table)

Write/read core: `POST /v1/save` (modes incl. `conversation`), `POST /v1/recall`, `POST /v1/turn` (degrades to **recall-only** when the write quota is exhausted rather than refusing), `POST /v1/ingest`, `GET /v1/graph`, `GET /v1/status`, `GET /v1/jobs`, `GET /v1/receipts`, `GET /v1/usage`, `GET /v1/export`, `GET/POST /v1/exports(+/download)`, `GET/POST /v1/rules`, `GET /v1/packets/:id/status` (used by shipped adapters' `waitFor`).
Inventory/deletion: `GET /v1/memories(/:id)`, `DELETE /v1/memories(/:id)` (dry-run default), `GET /v1/candidates`, `POST /v1/actions/*` (delete-last-extraction, delete-object, archive-object, delete-all, clean-junk, clear-failed-receipts, organize-clusters, repair-graph).
Settings/enterprise: `/v1/settings/{organization,project,rules(+preview),categories,retention(+preview,process),invitations(+accept,describe),members}`, `/v1/webhooks` (CRUD), `/v1/mcp/choose`.
Auth: Bearer `itsuki_live_…` (legacy `uml_live_…` accepted forever); MCP path tokens `/mcp/<base64url(userId:key)>` for headerless clients; ≤50 active connection tokens per project. Sessions are cookie-based (dashboard only — never used by integrations).

### 2.4 Proven integration kernel (the architecture to reuse)

Three shipped packages — `n8n-nodes-itsuki@0.1.0`, `pi-itsuki@0.1.0`, `openclaw-itsuki@0.1.0`, all on npm with SLSA provenance — share a copied, audited TS kernel (`packages/openclaw-itsuki/src/*` is the newest audited copy):

- `transport.ts` — zero-dependency client: base-URL validation (HTTPS except loopback; no userinfo/query/fragment), key only in `Authorization` header, `redirect: "error"` (a redirect can never replay the header), total time budget including retries, `Retry-After` honored exactly, **reads retry / writes retry only under an idempotency key**, every error surface scrubbed of the key, injectable `fetch/sleep/random/now` for tests. Endpoints wrapped: `recall`, `saveConversation` (`POST /v1/save` mode=conversation, always idempotency-keyed), `packetStatus`, `status`.
- `errors.ts` — taxonomy `ErrorClass = auth | not_found | invalid | conflict | too_large | confirmation | quota | capacity | backlog | rate_limit | unavailable | transport | timeout | cancelled`, `mapApiError(status, body, headers)`, `computeBackoffMs(attempt, retryAfter, random)`, `redactSecrets`.
- `scrub.ts` — outbound content scrubbing (credential-shaped strings) before capture.
- `spool.ts` — durable offline spool (atomic rename; Windows-proven) for capture that failed transport.
- `inject.ts` — bounded context injection + echo suppression (recalled text is remembered per session so the model's echo of it is not re-captured).
- `batching.ts`, `coordinator.ts` (lifecycle orchestration: recall in the pre-turn hook, capture on settled turns), `identity.ts` (tenant mapping), session stores.
- Tests: unit + contract + lifecycle + adversarial `corpus.spec.ts` (injection/poisoning strings) + `scale.spec.ts` + `tenancy.spec.ts`.

CI/publish pattern (`.github/workflows/publish-*.yml`): `workflow_dispatch` with `dry_run` **default true**; matrix `ubuntu-latest` + `windows-latest`; pinned Node (24.15.0) and npm@11; typecheck → tests → build → **zero-runtime-deps gate** → `npm audit --omit=dev --audit-level=high` → tarball gates (manifest present, no credential-shaped strings, no postinstall, no `DELETE` HTTP method in shipped code, host-specific safety greps) → `npm publish --provenance --access public` (trusted publishing once configured; token only for first publish — npm cannot OIDC a first publish).

Site contract (from `AGENTS.md`): `public/index.html` `installMethods()`/`installSnippets()` and the docs Connect-a-tool nav are contract-tested together (`test/get_started.spec.js`, `test/docs_connect_tool.spec.js`); **no install verb may appear for an unpublished package** ("no dead commands" tests enforce by name).

Other standing constraints from the project record: run vitest with `--no-file-parallelism`; deploys are pre-authorized but **package/marketplace publication requires explicit owner approval**; the Playground admission path must never be modified for integration convenience; repo is public.

---

## 3. Corrected Mem0/host ownership matrix

Classification given in the tasking → what is actually true on 2026-08-15:

| Host | Tasking's premise | Verified reality | Correction |
|---|---|---|---|
| Vercel AI SDK | "Mem0-authored AI SDK provider package" | `@mem0/vercel-ai-provider@3.0.1`, **Mem0-owned** (mem0 monorepo `integrations/vercel-ai-sdk`), built for `ai@^6` while host is at `ai@7.0.66`; bundles `@ai-sdk/{openai,anthropic,google,groq,cohere}` as hard deps; retrieval auto-injected, capture is manual `addMemories()` | Premise ownership correct; **one-major version drift**, heavyweight dependency architecture, and no automatic capture — do not copy |
| LlamaIndex | "host-native `BaseMemory` package" | `llama-index-memory-mem0@2.0.0` (2026-05-20) lives in the **host monorepo** (`llama-index-integrations/memory/`); `Mem0Memory → BaseMem0 → BaseMemory`; requires `llama-index-core >=0.13,<0.15`, `mem0ai >=2.0,<3` | Ownership correct, but the host has **deprecated that whole memory generation** (`ChatMemoryBuffer`, `SimpleComposableMemory`, …); current interface is `Memory` + `BaseMemoryBlock` (async `_aget/_aput/atruncate`); docs list the Mem0 example under deprecated usage |
| Agno | "host-built toolkit; model-called memory tools, not automatic lifecycle" | **Correct.** `Mem0Tools(Toolkit)` in host repo (`libs/agno/agno/tools/mem0.py`): `add_memory`, `search_memory`, `get_all_memories`, `delete_all_memories`; user_id = constructor > `run_context.user_id` > error; `infer=True` default | Premise accurate. Agno is at **2.9.0**; toolkits are plain `Toolkit` subclasses passed to `Agent(tools=[…])`, so an external package needs no upstream change |
| Mastra | "partner-namespaced integration plus Mastra tools" | `@mastra/mem0@0.1.12` exists on npm but is **orphaned**: peer `@mastra/core >=0.15.3-0 <0.17.0-0` vs core `1.59.0`; `integrations/` dir in the repo now contains only brightdata/livekit/opencode/perplexity/tavily; `mastra.ai/docs/integrations/mem0` → 404 | **Premise stale.** There is no living Mem0-Mastra integration to match. Target Mastra 1.x surfaces: `createTool` + `Processor` (`@mastra/core/processors`: `processInput`, `processOutputResult`, `processOutputStream`, attached via `inputProcessors`/`outputProcessors` on `Agent`) |
| CAMEL | "host-native storage backend used by `ChatHistoryMemory`" | **Correct.** `Mem0Storage(BaseKeyValueStorage)` in host repo (`camel/storages/key_value_storages/mem0_cloud.py`): `save(records)` → `client.add()`, `load()` → `client.get_all()` reconstruction, `clear()` → `client.delete_users()`; consumed by `ChatHistoryBlock(storage=…)`; `mem0ai` is an optional `storage` extra | Premise accurate. Note honestly: Mem0's `load()` is **lossy** (reconstructs from extracted memories, violating the base class's "without any loss of information" contract) — Itsuki must not copy that flaw |
| ChatDev | "built-in YAML memory backend with automatic lifecycle" | **Correct for ChatDev 2.0** (released 2026-01-07; repo active; Apache-2.0; Python `>=3.12,<3.13`): YAML workflow configs declare `memory[]` nodes with `type: simple\|file\|blackboard\|mem0`; agents attach via `memories:[{name, retrieve_stage, top_k, similarity_threshold, read, write}]`; manager calls `retrieve()` on stage entry (injects a "Related Memories" block) and `update()`/`save()` after completion; third-party route documented: Config + Store subclass `MemoryBase`, `register_memory_store(name, config_cls=…, factory=…)` | Premise accurate **only for 2.0** — the old JSON/`ecl` architecture is gone. `Mem0Memory` store: sync, user_id/agent_id OR-filter dual scope, strips pipeline headers before add, captures **user input only**, errors degrade (empty retrieval / silent add failure) |
| (excluded) CrewAI | excluded pending compatibility spike | Not researched; stays excluded | — |
| (guide-level) LangChain/LangGraph/AutoGen/OpenAI Agents SDK, Google ADK | guide/recipe level | Not researched this campaign; no packages invented | — |

`mem0ai` reference versions for behavior comparison: PyPI **2.0.18**, npm **3.1.6**. **[verified]**

---

## 4. Backend prerequisite ledger

Separated into true prerequisites (block a package) and optional parity work (do not).

### True prerequisites

| ID | What | Why | Blocks | Work |
|---|---|---|---|---|
| **P-1** | **`AsyncMemoryClient` in the Python SDK** (`httpx.AsyncClient`-based, same surface + `aclose()`, same validation/backoff/Retry-After/redirect-refusal semantics as sync) and release to PyPI as `itsuki` **0.3.0** | LlamaIndex `BaseMemoryBlock` is async-first (`_aget`/`_aput` are `async def`); calling the sync client would block the host event loop. CAMEL/Agno/ChatDev are sync and unaffected | LlamaIndex package only | `sdk/python/itsuki/__init__.py` (+ tests); no server change |
| **P-2** | **Publish current SDKs** — npm `itsuki` 0.2.0 → 0.2.1 (adds `packetStatus`/`waitFor`, base-URL validation, redirect hardening already in source), PyPI `itsuki` 0.1.1 → 0.3.0 (with P-1) | Python integration packages will depend on the published `itsuki` PyPI package (frozen decision F-3); the published artifact must match the audited source | All three Python packages; JS packages unaffected (they vendor the kernel) | Owner-approved publish runs of existing workflows/equivalents |

### NOT prerequisites (verified sufficient as-is)

- **Safe delete / bulk delete**: `DELETE /v1/memories(/:id)` + actions + dry-run-default semantics already exist and are what the guarded tools wrap.
- **Async receipt/status**: `/v1/packets/:id/status`, `/v1/jobs`, `waitFor` already exist.
- **Batch ingest**: `POST /v1/ingest` with delivery envelope exists.
- **Rules/policy narrowing, project categories, retention**: exist under `/v1/settings/*` and door-level `authz.rules`.
- **List/get for CAMEL/Agno "get_all" parity**: `GET /v1/memories` inventory with cursor pagination is the correct mapping.

### Optional parity (record, do not build now)

| Item | Status | Note |
|---|---|---|
| Versioned memory **update** API (Mem0 has `update(memory_id, …)`) | Not needed by any of the six (verified: none of Mem0's six integration surfaces calls update) | Itsuki's supersession/corrections lane covers the semantic need; revisit only if a host adds an update hook |
| Metadata-filtered recall (arbitrary key-value filters) | Optional | `memoryScope` attribution + `recallScope` + project filters cover the six designs |
| Entity operations, graph export per-entity | Optional | Not used by any host surface here |
| Webhook push of job completion to integrations | Optional | Polling `waitFor` is sufficient at the six hosts' lifecycles |

---
## 5. Shared architecture

Principle: **share by vendoring + parity tests, not by runtime dependency**, on the TS side (preserves the zero-runtime-deps publish gate that three shipped packages already enforce); **share via the first-party `itsuki` PyPI SDK** on the Python side (depending on your own published SDK is the Python-normal shape and keeps one audited transport). Do not force one lifecycle abstraction across hosts — lifecycle stays per-package in a `coordinator`-style module; only the mechanical layers are shared.

### 5.1 Shared TS kernel (`packages/_kernel/ts/`) **[proposed]**

Source of truth for the modules already proven ×3, parameterized only by `USER_AGENT` and source name:

```
packages/_kernel/ts/
  transport.ts     # as shipped in openclaw-itsuki (validated baseUrl, redirect:error,
                   # header-only key, budgeted retries, Retry-After, redaction)
  errors.ts        # ErrorClass taxonomy + mapApiError + computeBackoffMs + redactSecrets
  scrub.ts         # outbound secret scrubbing before capture
  inject.ts        # bounded context formatting + echo suppression
  batching.ts      # message batching for /v1/ingest
  idempotency.ts   # NEW: stable key derivation sha256(userId|conversationId|digest(messages))
  events.ts        # NEW: content-free event hook (see 5.4)
scripts/sync-kernel.mjs   # copies kernel into each package's src/, stamps USER_AGENT
test/kernel-parity.spec.js # CI gate: package copies are byte-identical to the kernel
                           # modulo the stamped constants
```

Consumed by: `ai-sdk-itsuki`, `mastra-itsuki` (and, at the owner's option, retrofitted into pi/openclaw/n8n later — out of scope here). `spool.ts` is **not** part of the default kernel for the two new TS packages: Vercel/Mastra commonly run serverless where a disk spool is wrong; capture failure there is fail-open + counted (see per-blueprint item 17).

### 5.2 Shared Python layer

- Transport/client: published `itsuki` SDK (P-2), sync `MemoryClient` + new `AsyncMemoryClient` (P-1). All three-plus Python packages pin `itsuki >=0.3,<0.4`.
- Vendored micro-kernel `_kernel.py` per package (synced by `scripts/sync-kernel.mjs` from `packages/_kernel/py/`): context bounding/formatting, idempotency-key derivation, scrub patterns, content-free event hook. Small by design (< ~300 lines) because transport lives in the SDK.

### 5.3 Shared semantics (identical in every package)

- **Error taxonomy**: the 14-class `ErrorClass` above; Python maps `MemoryAPIError` into the same classes.
- **Retry/backoff**: reads retry; writes retry only under an idempotency key; `Retry-After` wins over computed backoff; one total time budget per logical call.
- **Receipt waiting**: never block a host turn on extraction; `waitFor` is used only by tests/canaries and explicit "wait" tools.
- **Tenant identity**: host identity → `userId` (isolated sub-space under the API key), host workspace/app/agent/session → `memoryScope` attribution; the server's project binding is authoritative; **no model-controllable field ever selects the tenant** (Agno/Mastra tools must not expose `user_id` as a tool parameter).
- **Context bounding**: recall injection bounded by chars (default 4,000) and item count (default 10); one format: a titled block (`Relevant memory for this user:`) matching the MCP door's phrasing.
- **Telemetry**: content-free only (§5.4). No OpenTelemetry runtime dependency in v0; the event hook is OTel-bridgeable by the host app.
- **Adversarial corpus**: one shared corpus (injection/poisoning/secret-shaped strings) reused from `packages/*/test/corpus.spec.ts`, ported to Python fixtures.

### 5.4 Content-free instrumentation contract **[proposed]**

Every package accepts an optional `onEvent(event)` callback (TS) / `event_hook` (Py). Events carry **names, counts, durations, error classes, and ids only — never content, never keys**: `recall.ok {ms, count, injectedChars}`, `recall.fail {errorClass}`, `capture.staged {packetId, messages}`, `capture.fail {errorClass}`, `capture.skipped {reason}`, `inject.truncated {fromChars, toChars}`. An `examples/otel.ts|py` shows bridging to OpenTelemetry without adding a dependency.

### 5.5 Dependency graph

```
Backend prerequisites            Shared libraries                Packages
──────────────────────           ─────────────────               ────────
P-2 publish itsuki (js 0.2.1) ─┐
                               ├─> packages/_kernel/ts ──┬─> ai-sdk-itsuki (npm)
                               │   (vendored copies)     └─> mastra-itsuki (npm)
P-1 AsyncMemoryClient ─────────┤
P-2 publish itsuki (py 0.3.0) ─┴─> itsuki PyPI dep ──┬─> llama-index-memory-itsuki (PyPI)
                                   + _kernel/py      ├─> agno-itsuki (PyPI)
                                   (vendored)        ├─> camel-itsuki (PyPI)
                                                     └─> chatdev-itsuki (PyPI, fallback lane)
                                                         └─> ChatDev upstream PR (type: itsuki)

Docs surfaces: public/index.html installMethods() + public/docs Connect-a-tool nav
  (contract-tested pair; updated ONLY after each package publish — "no dead commands")
CI/publication: one workflow per package, cloned from publish-openclaw-plugin.yml
  (npm) / new pypa publish template (PyPI, Trusted Publishing from day one)
Production verification: per-package canary (§9) after publish, before site update.
```

---

## 6. Six frozen blueprints

Conventions used by all six (stated once, apply to every blueprint):
- **Auth resolution order**: explicit config value → environment `ITSUKI_API_KEY` (+ optional `ITSUKI_BASE_URL`) → hard fail at construction with the setup hint ("Create a key at https://itsuki.app under API Keys…"). Key shape validated (`(itsuki|uml)_live_[A-Za-z0-9_-]{8,}`). Keys never appear in URLs, logs, errors, or serialized state.
- **HTTP handling** (item 15 in each blueprint): 401/403 → non-retriable `auth` (one warning, then integration goes inert rather than hammering); 404 → `not_found`; 409 → `conflict` (idempotent replay: treat "duplicate" success payloads as success); 413 → `too_large` (halve batch and retry once, else drop + count); 429 → `rate_limit` honoring `retry_after_s`; 5xx → retriable per budget; `queue_full` → treat as 429-with-retry-after.
- **Fail-open/closed** (item 16): recall fail-OPEN (host proceeds without memories; one rate-limited warning); capture fail-OPEN (never break the host turn; count + optionally spool); deletion fail-CLOSED (never guess); quota-unreadable on writes fail-CLOSED server-side (already server behavior).
- **Privacy/telemetry** (item 19): §5.4 contract; scrub before capture; never log message content.
- **Rollback/uninstall** (item 24): uninstalling the package removes all behavior (no daemons, no state left except an optional spool directory documented for manual removal); memories persist server-side and remain manageable via dashboard/MCP/REST; `deleteBySource(source=<package source tag>)` gives clean data rollback per integration.
- **Definition of done** (item 26 baseline, plus per-package additions): all §9 matrix rows green for the package; clean install from the real registry on Windows + Linux; real-host lifecycle test green on pinned current + previous host minor; production canary save→wait→recall→list/get→delete completed with **zero residue** (list shows none of the canary's objects; `deleteBySource` dry-run reports 0); README + site doors updated post-publish; owner approved publication.

### 6.1 Vercel AI SDK — `ai-sdk-itsuki`

1. **Target UX**: one wrapper makes any AI SDK model memory-aware:
   ```ts
   import { withItsuki } from "ai-sdk-itsuki";
   const model = withItsuki(openai("gpt-5.2"), { userId: "u_42", conversationId: "thread_9" });
   const { text } = await generateText({ model, prompt: "…" }); // memories in, turn captured
   ```
   Recall is injected automatically pre-call; the settled turn is captured automatically post-call. Also usable as raw middleware (`itsukiMiddleware(cfg)`) in a `wrapLanguageModel({ model, middleware: [...] })` chain, and via standalone helpers for Mem0-parity: `retrieveMemories`, `getMemories`, `saveMemories`.
2. **Install/config**: `npm install ai-sdk-itsuki` (zero runtime deps; `ai` ≥7 is a peer). Config: `{ apiKey?, baseUrl?, userId, conversationId?, projectId?, recallScope?, maxContextChars?, maxItems?, capture?: "both" | "off", timeoutMs?, onEvent? }`. Per-request override via `providerOptions: { itsuki: {...} }` (the documented middleware metadata channel; middleware reads `params.providerMetadata.itsuki`). **[verified mechanism]**
3. **Package name**: npm **`ai-sdk-itsuki`** (available 2026-08-15). Follows the repo's `<host>-itsuki` convention.
4. **Host interfaces implemented**: `LanguageModelV4Middleware` (`transformParams`, `wrapGenerate`, `wrapStream`) via `wrapLanguageModel` from `ai@^7`; no provider re-implementation, no bundled provider SDKs — the deliberate inverse of Mem0's design. **[verified interface]**
5. **Public API**: `withItsuki(model, config)`, `itsukiMiddleware(config)`, `createItsuki(config)` (returns `{ middleware, retrieveMemories, getMemories, saveMemories, client }`), types `ItsukiConfig`, `ItsukiCallOptions`, `ItsukiError` (= kernel `ItsukiError`). All typed, ESM + CJS builds, `exports` map.
6. **Recall/injection point**: in `transformParams` — derive the query from the latest user message's text parts (fallback: whole prompt tail), `POST /v1/recall` with `recallScope` (default `project_then_global` when `projectId` set, else `global`), inject the bounded context block as (a) an addition to the existing system message when present, else (b) a leading system message. Injection is echo-suppressed per `conversationId` (kernel `inject.ts`).
7. **Capture point**: `wrapGenerate` — after `doGenerate` resolves, stage `[settled user turn, settled assistant prose]` via `saveConversation` (mode=conversation). `wrapStream` — tap the stream and stage on the **finish** part only. Frozen answer to "incoming vs settled vs both": **both the user turn and the settled assistant output are sent; the server's user-anchored extraction stores user facts only** (matches the platform's capture contract; assistant content provides reference-resolution context). Aborted/errored streams: **no capture** (abort signal observed; a partial answer is not a settled exchange).
8. **Automatic vs model-controlled**: recall and capture fully automatic; nothing is model-called. `capture: "off"` gives recall-only mode.
9. **Tenancy mapping**: `userId` (required; refuse to construct without it — silent shared-space writes are the classic multi-tenant bug), `conversationId` → `conversationId`, host app/workspace via `memoryScope { appId, workspaceId, projectId }`; per-request `providerOptions.itsuki.userId` override allowed because it comes from the calling server code, never the model.
10. **Auth**: conventions header. Browser/edge guard: constructor throws if `typeof window !== "undefined"` unless `dangerouslyAllowBrowser: true` (key must stay server-side).
11. **Idempotency**: key = `sha256(userId | conversationId | digest(ordered message ids ⊕ contents) | "v1")`. Stream reconnects and SDK-level retries reproduce identical params → identical key → server-side dedupe. `newIdempotencyKey()` fallback when messages carry no stable ids.
12. **Async receipts**: capture is fire-and-forget with `ctx`-less await (the middleware awaits staging (<1 s door) but never extraction); `saveMemories` returns the receipt (`source_packet_id`); `client.waitFor` exposed for tests/CLIs only.
13. **Pagination/bounding**: recall bounded per §5.3; helpers expose `limit` (≤50) and pass cursors through for `list` parity via `client`.
14. **Timeouts/retries**: kernel defaults — 10 s budget/call (recall), 15 s (capture), ≤2 retries, jittered backoff capped by budget; all overridable.
15–19. Conventions header. Specific: recall failure inside `transformParams` returns params **unmodified** (fail-open); capture failure in `wrapStream` must never corrupt the pass-through stream (tap, don't transform).
20. **Compatibility**: `ai ^7` (peer), `@ai-sdk/provider` spec v4, Node ≥22 (matches host engine), TS ≥5.5. CI matrix: `ai@7.0.x` current + latest 7.x at run time; forward gate documented for v8 (middleware type rename expected, as v6→v7 renamed V3→V4).
21. **File map**:
    ```
    packages/ai-sdk-itsuki/
      package.json  tsconfig.json  vitest.config.ts  README.md  CHANGELOG.md  LICENSE
      src/index.ts          # withItsuki, createItsuki, exports
      src/middleware.ts     # transformParams/wrapGenerate/wrapStream
      src/capture.ts        # settled-exchange detection, both-sides staging
      src/helpers.ts        # retrieveMemories/getMemories/saveMemories
      src/config.ts         # config resolution + env + guards
      src/(kernel: transport|errors|scrub|inject|batching|idempotency|events).ts  # vendored
      test/middleware.spec.ts  capture.spec.ts  stream.spec.ts  config.spec.ts
      test/transport.spec.ts  corpus.spec.ts  host-runtime.spec.ts  # real ai@7 + MockLanguageModelV4
    ```
22. **Tests**: unit (kernel + query derivation + injection placement); contract (recorded `/v1/recall`,`/v1/save` fixtures + error taxonomy); host-runtime (real `ai` package with its mock provider: generateText, streamText incl. mid-stream abort, tool-call turns, structured output — assert tool calls/usage/providerMetadata pass through untouched); exactly-once (retry storm reuses one idempotency key); production canary (§9).
23. **Publication**: workflow cloned from openclaw template (npm, provenance, dry-run default, win+linux matrix); first publish token-based, then Trusted Publisher + revoke.
24–25. Conventions header. Risks: AI SDK majors move fast (v6→v7 in under a year) — pin peer to `^7`, add the version gate to CI; middleware ordering with user middlewares (document: itsuki innermost-first is not required but injection runs on transformed params).
26. **Done** (additions): streaming abort test proves zero capture; a chained-middleware test proves compatibility with `extractReasoningMiddleware`-style middleware; providerMetadata carries `{ itsuki: { injected, packetId } }` for observability.

### 6.2 LlamaIndex — `llama-index-memory-itsuki`

1. **Target UX**:
   ```python
   from llama_index.memory.itsuki import ItsukiMemoryBlock, itsuki_memory
   memory = itsuki_memory(user_id="u_42", session_id="thread_9")   # Memory with Itsuki block
   response = await agent.run("…", memory=memory)                  # FunctionAgent/ReActAgent/AgentWorkflow
   ```
   Long-term facts flow to Itsuki automatically when short-term history flushes; recall content appears in the system-message template slot the `Memory` class already manages. Works identically for chat engines that accept `memory=`.
2. **Install/config**: `pip install llama-index-memory-itsuki` (deps: `llama-index-core>=0.14,<0.16`, `itsuki>=0.3,<0.4`). Env `ITSUKI_API_KEY`. Factory `itsuki_memory(user_id, session_id=None, project_id=None, recall_scope=…, max_context_chars=…, priority=…, token_limit=…)` returns a configured host `Memory`; the block is also usable directly in `memory_blocks=[…]`.
3. **Package name**: PyPI **`llama-index-memory-itsuki`** (available 2026-08-15), namespace package `llama_index.memory.itsuki` — the exact convention the host's integration tree uses.
4. **Host interfaces**: `BaseMemoryBlock[str]` (fields `name="itsuki"`, `description`, `priority`, `accept_short_term_memory`) implementing `async _aget(messages, **kwargs) -> str`, `async _aput(messages) -> None`, `async atruncate(content, tokens_to_truncate) -> Optional[str]`. **[verified interface]** No `BaseMemory` subclass is shipped (that generation is deprecated); a migration doc maps `Mem0Memory.from_client(context={user_id,agent_id,run_id})` calls onto the factory.
5. **Public API**: `ItsukiMemoryBlock`, `itsuki_memory()` factory, `ItsukiConfig` (pydantic), re-exported `MemoryAPIError`. Serialization: the block is a pydantic model; the API key is excluded from `model_dump` (stored as `SecretStr`, resolved from env on rehydrate).
6. **Recall/injection**: `_aget` builds the query from the tail user messages (limit configurable, default 5 — Mem0-parity `search_msg_limit`), calls `AsyncMemoryClient.search`, returns the bounded context string; the host inserts it via its own template into the system message (or latest user message per host `insert_method`) — the block never touches message lists itself. `atruncate` trims to the token budget, dropping whole items from the tail.
7. **Capture**: `_aput` receives messages being flushed from short-term memory (host-driven); stage via `AsyncMemoryClient.ingest` with `conversationId=session_id`. `accept_short_term_memory=True` so the block sees the full flushed window.
8. **Automatic vs tool-driven**: fully automatic on both sides through the host lifecycle; no tools.
9. **Tenancy**: `user_id` → SDK `userId` (required); `session_id` → `conversationId`; `agent_id`/`run_id` (Mem0-context parity) → `memoryScope.agentId` / `sourceId` attribution; `project_id` → `memoryScope.projectId` + `recall_scope` default `project_then_global` when set.
10. **Auth**: conventions header.
11. **Idempotency**: `_aput` flushes can replay (agent retries/re-runs) — key = `sha256(user_id|session_id|digest(flushed messages)|"v1")`; the SDK sends it so replays dedupe server-side.
12. **Receipts**: `_aput` awaits staging only; `packet_status`/`wait_for` via the SDK for tests; never awaited in the agent loop.
13. **Bounding**: §5.3 + host token budgeting via `atruncate` (must honor `tokens_to_truncate` honestly).
14. **Timeouts/retries**: SDK defaults (10 s/2 retries) shortened to 6 s inside `_aget` (an agent step waits on it).
15–19. Conventions header. `_aget` failure returns `""` (fail-open, host template skips empty blocks).
20. **Compatibility**: Python ≥3.10; `llama-index-core` current 0.14.23, CI matrix on 0.14.x + latest at run; host agents: `FunctionAgent`, `ReActAgent`, `AgentWorkflow`, plus `SimpleChatEngine`-style `memory=` consumers.
21. **File map**:
    ```
    packages/llama-index-memory-itsuki/
      pyproject.toml  README.md  CHANGELOG.md  LICENSE
      llama_index/memory/itsuki/__init__.py   # exports
      llama_index/memory/itsuki/block.py      # ItsukiMemoryBlock (_aget/_aput/atruncate)
      llama_index/memory/itsuki/factory.py    # itsuki_memory()
      llama_index/memory/itsuki/_kernel.py    # vendored bounding/idempotency/scrub/events
      tests/test_block.py  test_factory.py  test_contract.py  test_host_runtime.py
      tests/test_corpus.py  test_serialization.py
    ```
22. **Tests**: unit; contract against a local `httpx.MockTransport` fixture set mirroring the recorded REST fixtures; host-runtime: real `llama-index-core` running `FunctionAgent` + `Memory` + block end-to-end with a mock LLM (assert injection lands in system message, `_aput` fires on flush, truncation honored); async-safety test (no sync client call ever executes in the loop — assert via `asyncio` debug mode); serialization round-trip excludes the key.
23. **Publication**: new PyPI workflow (template §10) with **Trusted Publishing configured as a pending publisher before first release** (PyPI supports this pre-publish, unlike npm) — tokenless from day one. **[verified capability]**
24–25. Conventions header. Risks: host memory API is newly stabilized — pin `<0.16`; the deprecated-generation `Mem0Memory` comparison in docs must not claim Itsuki "replaces" host memory (it is one block inside it).
26. **Done** (additions): agent-visible behavior proven on both current and previous `llama-index-core` minors; a `Memory.from_defaults(memory_blocks=[block])` snippet in the host's documented style runs verbatim from the README.
### 6.3 Agno — `agno-itsuki`

1. **Target UX**:
   ```python
   from agno.agent import Agent
   from agno_itsuki import ItsukiTools
   agent = Agent(tools=[ItsukiTools()], ...)   # user id flows from run_context
   ```
   The model calls memory tools when relevant — the same experience `Mem0Tools` provides, with honest labeling: this is **model-called memory, not automatic lifecycle** (Agno's own built-in memory remains the automatic layer; this toolkit coexists with it, exactly as the OpenClaw plugin coexists with `memory-core`).
2. **Install/config**: `pip install agno-itsuki` (deps: `agno>=2.9,<3`, `itsuki>=0.3,<0.4`). Constructor: `ItsukiTools(api_key=None, base_url=None, user_id=None, project_id=None, recall_scope=None, enable_save=True, enable_search=True, enable_list=True, enable_get=True, enable_delete=False, enable_delete_all=False, instructions=None, **toolkit_kwargs)` — per-tool enable flags mirror `Mem0Tools`' pattern; destructive tools are **off by default** (Mem0 ships `delete_all_memories` enabled — declined, see §13 F-9).
3. **Package name**: PyPI **`agno-itsuki`** (available 2026-08-15). Secondary route: upstream PR adding `ItsukiTools` to `libs/agno/agno/tools/` (host convention keeps toolkits in-repo) — optional, not gating; the external package is fully native because `Agent(tools=[Toolkit])` accepts any `Toolkit` subclass. **[verified]**
4. **Host interface**: `agno.tools.Toolkit` (constructor contract verified: `name`, `tools`, `instructions`, `add_instructions`, `include_tools`/`exclude_tools`, `requires_confirmation_tools`, `cache_results`, …). Registered functions are plain callables; sync functions are correct here (Agno routes sync/async automatically).
5. **Public API / tools** (exact set):
   - `save_memory(run_context, content: str) -> str` — one durable fact; JSON receipt back to the model.
   - `search_memory(run_context, query: str, limit: int = 10) -> str` — recall; returns the context block plus item list as JSON.
   - `list_memories(run_context, cursor: str | None = None, limit: int = 20) -> str` — inventory page (maps `GET /v1/memories`).
   - `get_memory(run_context, memory_id: str) -> str`.
   - `delete_memory(run_context, memory_id: str) -> str` — registered in `requires_confirmation_tools` by default.
   - `delete_all_memories(run_context, confirm: bool = False) -> str` — dry-run preview unless `confirm=True` AND `enable_delete_all=True`; mirrors the MCP door.
   No tool takes `user_id`/`project_id` parameters — the model cannot select a tenant (Mem0 matches this; frozen here as a hard rule).
6. **Recall/injection**: model-called `search_memory`; results return as the tool result (the host injects tool results natively). Optional `add_instructions=True` ships the same recall-first guidance the MCP server instructions use.
7. **Capture**: model-called `save_memory` (direct-save lane, light path). No hidden automatic capture — labeling stays honest.
8. **Automatic vs model-controlled**: all tools model-controlled; confirmation-gated destructive tools additionally require host-side confirmation flow.
9. **Tenancy**: `user_id` = constructor > `run_context.user_id` > **error string returned to the model** ("no user identity configured") — the verified `Mem0Tools` resolution order, minus any model-supplied fallback. `session_id` from `run_context` → `conversationId`; agent name → `memoryScope.agentId`.
10. **Auth**: conventions header (env `ITSUKI_API_KEY`).
11. **Idempotency**: model retries of `save_memory` with identical content in one session derive the same key (`sha256(user|session|content)`); cross-session duplicates are the server's dedupe/supersession problem, not the toolkit's.
12. **Receipts**: `save_memory` returns the staged receipt JSON (`source_packet_id`, counts); a `wait` parameter is deliberately not exposed to the model.
13. **Bounding**: search returns ≤ `limit` items and ≤ 4,000 context chars; list pages are cursor-bounded (host models handle cursors well as opaque strings).
14. **Timeouts/retries**: SDK defaults; per-tool budget 8 s so a tool call cannot stall an agent step.
15–19. Conventions header. Tool errors return **readable JSON error strings** to the model (never raise through the host loop) — the verified Mem0Tools/MCP behavior.
20. **Compatibility**: Python ≥3.10 (host allows ≥3.9; the SDK floor governs); `agno` 2.9.x current + previous minor in CI. Multimodal: **deferred** — Agno tool results are text; Itsuki capture is text-first (frozen; revisit only with a real user need).
21. **File map**:
    ```
    packages/agno-itsuki/
      pyproject.toml  README.md  CHANGELOG.md  LICENSE
      agno_itsuki/__init__.py   # ItsukiTools export
      agno_itsuki/toolkit.py    # Toolkit subclass + six tools
      agno_itsuki/_kernel.py    # vendored helpers
      tests/test_toolkit.py  test_identity.py  test_guarded_delete.py
      tests/test_contract.py  test_host_runtime.py  test_corpus.py
    ```
22. **Tests**: unit (tool registration set matches enable flags; identity resolution matrix incl. missing-identity error path); guarded-deletion tests (no `confirm` → dry-run; disabled flag wins over confirm); contract; host-runtime: real `agno` Agent with a scripted model driving tool calls end-to-end; adversarial: model attempts `user_id` smuggling via content — assert tenancy unchanged.
23. **Publication**: PyPI Trusted Publishing template (§10).
24–25. Conventions header. Risks: Agno 3.0 (fast-moving project) — pin `<3`; `run_context` field shapes are host-owned, read defensively (OpenClaw audit lesson).
26. **Done** (additions): a live Agno agent session demonstrates save → recall round-trip; confirmation flow proven with `requires_confirmation_tools`.

### 6.4 Mastra — `mastra-itsuki`

1. **Target UX** (two tiers, both first-class):
   ```ts
   // Tier 1 — automatic lifecycle via processors (beyond anything Mem0 shipped):
   import { ItsukiRecall, ItsukiCapture, itsukiTools } from "mastra-itsuki";
   const agent = new Agent({
     inputProcessors:  [new ItsukiRecall({ /* resource→userId mapping */ })],
     outputProcessors: [new ItsukiCapture()],
     tools: itsukiTools(),          // Tier 2 — model-called tools (Mem0 parity)
   });
   ```
   Recall is injected before the LLM call from the agent's `resource` identity; the settled response is captured after it. Tools give the model explicit save/search when the app wants that instead (or additionally).
2. **Install/config**: `npm install mastra-itsuki` (zero runtime deps; peers: `@mastra/core ^1.59`, `zod ^3 || ^4`). `createItsukiClient({ apiKey?, baseUrl?, defaultUserId?, projectId?, onEvent? })`; processors/tools accept the client or construct from env.
3. **Package name**: npm **`mastra-itsuki`** (available 2026-08-15). `@mastra/*` is partner-namespaced and not ours to claim — do not target it (the stale `@mastra/mem0` shows why partner-namespace without partner ownership rots).
4. **Host interfaces**: `Processor` from `@mastra/core/processors` — implement `processInput` (recall injection; messages are `MastraDBMessage[]` where text lives in `content.parts[type==="text"]`) and `processOutputResult` (capture settled output); tools via `createTool` from `@mastra/core/tools` with zod schemas. **[verified interfaces]** `processOutputStream` is NOT used for capture (stream chunks are not settled output).
5. **Public API**: `ItsukiRecall`, `ItsukiCapture` (Processor classes), `itsukiTools({ enableDelete?: false })` → `{ itsukiRecall, itsukiSave, itsukiList, itsukiGet, itsukiDelete? }` tool map, `createItsukiClient`, full TS types.
6. **Recall/injection**: `processInput` derives the query from the latest user message parts, recalls, prepends a bounded system-part memory block, and records the echo key. Identity: `RequestContext`/run options `resource` → `userId`, `thread` → `conversationId` (Mastra's own memory semantics — verified naming from host docs).
7. **Capture**: `processOutputResult` stages `[user turn, settled assistant text]` (same both-sides frozen rule as 6.1; server extracts user-anchored facts). Errors/aborted runs skip capture.
8. **Automatic vs model-controlled**: processors automatic; tools model-controlled; either usable alone.
9. **Tenancy**: `resource` (required for processors — construct-time `defaultUserId` or per-run resource; refuse silently-shared spaces), `thread` → `conversationId`, workflow/agent ids → `memoryScope` attribution. Tools never expose tenant parameters to the model.
10. **Auth**: conventions header; server-side only guard as 6.1.
11. **Idempotency**: per-run key from `sha256(userId|threadId|runId|digest(messages))`; Mastra retries/step re-execution replay the same key.
12. **Receipts**: staging only in the hot path; `client.waitFor` for tests/scripts.
13. **Bounding**: §5.3; list tool cursor-paginated.
14. **Timeouts/retries**: kernel defaults; `processInput` budget 6 s.
15–19. Conventions header. A processor throw would break the agent run — both processors wrap everything; worst case they no-op.
20. **Compatibility**: `@mastra/core ^1.59` pinned peer with CI on current + previous minor; Node ≥22.13 (host engine). Explicitly documented: NOT compatible with the abandoned `@mastra/mem0` config shape; a migration note maps `Mem0Integration`-era usage to tools/processors.
21. **File map**:
    ```
    packages/mastra-itsuki/
      package.json  tsconfig.json  vitest.config.ts  README.md  CHANGELOG.md  LICENSE
      src/index.ts  src/client.ts  src/processors/recall.ts  src/processors/capture.ts
      src/tools.ts  src/identity.ts
      src/(vendored kernel modules).ts
      test/processors.spec.ts  tools.spec.ts  identity.spec.ts  contract.spec.ts
      test/host-runtime.spec.ts  corpus.spec.ts
    ```
22. **Tests**: unit; contract; host-runtime with real `@mastra/core`: an Agent with both processors + a mock model — assert injection present in the LLM request, capture fired once per run, `content.parts` handling correct for multi-part messages; streaming run captures once at settle; tool tier driven via scripted model. Exactly-once under step retry.
23. **Publication**: npm template (§10).
24–25. Conventions header. Risks: Mastra 1.x is young and ships fast — the Processor interface is the stability bet; if `processInput`/`processOutputResult` signatures move in a 1.x minor, CI's previous+current matrix catches it (stop-gate §12 if broken).
26. **Done** (additions): both tiers proven in one example app; README shows the processors pattern first (differentiator), tools second (Mem0 parity).

### 6.5 CAMEL — `camel-itsuki`

1. **Target UX**:
   ```python
   from camel.memories import ChatHistoryMemory
   from camel_itsuki import ItsukiStorage
   memory = ChatHistoryMemory(context_creator, storage=ItsukiStorage(user_id="u_42", agent_id="researcher"))
   ```
   Drop-in storage backend: the agent's chat history persists locally with **lossless** semantics while every settled record is mirrored to Itsuki for durable cross-session memory; a second component, `ItsukiContextBlock`, adds semantic recall of that memory into agent context.
2. **Install/config**: `pip install camel-itsuki` (deps: `camel-ai>=0.2.90,<0.3` optional-extra-free core import, `itsuki>=0.3,<0.4`). Env `ITSUKI_API_KEY`.
3. **Package name**: PyPI **`camel-itsuki`** (available 2026-08-15). Upstream contribution (`camel/storages/key_value_storages/itsuki.py`, mirroring how `mem0_cloud.py` sits in-repo) is an optional follow-up for discoverability; the external package is fully functional without it because `ChatHistoryBlock(storage=…)` accepts any `BaseKeyValueStorage` instance. **[verified]** Frozen: **external package first; upstream PR after production proof.**
4. **Host interfaces**: `BaseKeyValueStorage` — `save(records: List[Dict]) -> None`, `load() -> List[Dict]`, `clear() -> None` (exact abstract contract verified from source). Optionally `ItsukiContextBlock` subclassing the host's `MemoryBlock` (`retrieve() -> List[ContextRecord]`, `write_records`, `clear`) for `LongtermAgentMemory`-style composition — base-class import path to be re-verified at implementation time **[inferred from ChatHistoryBlock's verified shape]**.
5. **Public API**: `ItsukiStorage(user_id, agent_id=None, project_id=None, api_key=None, base_url=None, mirror=…)`, `ItsukiContextBlock(...)`, `MemoryAPIError` re-export.
6. **Recall/injection**: `ItsukiContextBlock.retrieve()` recalls semantically against the current context and returns bounded `ContextRecord`s (host scores/assembles context). `ItsukiStorage.load()` itself does **not** perform recall — it returns the locally mirrored verbatim records.
7. **Capture**: `save(records)` appends to the local verbatim mirror (JSON file under a state dir, atomic rename — spool pattern) AND stages user-role records to Itsuki via `ingest` (batched). Honest divergence from Mem0, frozen: Mem0's `load()` reconstructs "history" from extracted memories — lossy and contract-violating; Itsuki keeps history lossless locally and uses the server for what it is (semantic memory), which is why the block exists.
8. **Automatic vs model-controlled**: fully automatic through `ChatHistoryMemory`'s write/read lifecycle; nothing model-called.
9. **Tenancy**: `user_id` → SDK `userId`; `agent_id` → `memoryScope.agentId` (attribution; multi-agent societies give each agent its own storage instance, Mem0-parity); `project_id` → `memoryScope.projectId` + `project_then_global` recall; CAMEL run/session id (when available from the caller) → `conversationId`.
10. **Auth**: conventions header.
11. **Idempotency**: record UUIDs from CAMEL's `MemoryRecord.to_dict()` seed the key (`sha256(user|agent|record uuids)`) so `save()` replays dedupe.
12. **Receipts**: staging only; `wait_for` in tests/canary.
13. **Bounding**: block retrieval ≤10 records/4,000 chars; local mirror windowed (configurable max records, default 5,000) with explicit truncation note.
14. **Timeouts/retries**: SDK defaults; `save()` mirror-first (local write succeeds even if the network call fails — capture fail-open with spool-retry on next save).
15–19. Conventions header. `clear()`: clears the **local mirror always**; deletes server-side memories **only** when constructed with `allow_remote_clear=True` (deleting a tenant's semantic memory because an agent restarted its history is the destructive-op trap; Mem0's `clear()` → `delete_users()` does exactly that — declined, §13 F-9).
20. **Compatibility**: Python 3.10–3.14 (host `<3.15`); `camel-ai` 0.2.x current + previous in CI; sync-only (host is sync) — uses sync `MemoryClient`.
21. **File map**:
    ```
    packages/camel-itsuki/
      pyproject.toml  README.md  CHANGELOG.md  LICENSE
      camel_itsuki/__init__.py  storage.py  block.py  mirror.py  _kernel.py
      tests/test_storage.py  test_mirror.py  test_block.py  test_clear_guard.py
      tests/test_contract.py  test_host_runtime.py  test_corpus.py
    ```
22. **Tests**: unit (mirror atomicity, Windows rename semantics); lossless round-trip (`save→load` byte-equal — the test Mem0's backend cannot pass); clear-guard matrix; contract; host-runtime: real `camel-ai` `ChatHistoryMemory` + `ChatHistoryBlock` conversation loop, plus `ItsukiContextBlock` retrieval scoring path; multi-agent isolation (two agents, two storages, no cross-reads).
23. **Publication**: PyPI Trusted Publishing template (§10).
24–25. Conventions header. Risks: CAMEL pre-1.0 moves module paths — the block's base import is the soft spot (re-verify at build); mirror file growth (windowed, documented).
26. **Done** (additions): losslessness test green; a two-agent society example persists and recalls across process restarts.

### 6.6 ChatDev 2.0 — upstream `type: itsuki` + `chatdev-itsuki`

1. **Target UX** (upstream lane):
   ```yaml
   memory:
     - name: team_memory
       type: itsuki
       config:
         api_key: ${ITSUKI_API_KEY}
         user_id: acme_team
         project_id: proj_shop
   # per-agent attachment (host schema, unchanged):
   #   memories: [{ name: team_memory, retrieve_stage: ["gen"], top_k: 5, read: true, write: true }]
   ```
   Retrieval happens automatically at the configured stages (host injects a "Related Memories" block); post-stage writes capture automatically. Dual scope `user_id`/`agent_id` with OR-filter retrieval, matching the built-in `mem0` backend's semantics.
2. **Install/config**: upstream lane — nothing to install beyond ChatDev itself once merged. Fallback lane — `pip install chatdev-itsuki` in the ChatDev deployment + **one operator-owned import** (`import chatdev_itsuki.register`) in the deployment entrypoint, which calls `register_memory_store("itsuki", config_cls=ItsukiMemoryConfig, factory=…)`. No fork required, but it IS a deployment edit — labeled honestly (see item 8/§12; not "native" until upstream merges or ChatDev grows plugin discovery).
3. **Package/module names**: upstream files `entity/configs/node/memory.py` (add `ItsukiMemoryConfig`, extend the `type` discriminator) + `runtime/node/agent/memory/itsuki_memory.py` + registration in `builtin_stores.py`; fallback PyPI **`chatdev-itsuki`** (available 2026-08-15).
4. **Host interfaces**: `MemoryBase` store contract as exercised by the manager: `retrieve() -> List[MemoryItem]`, `update()`, `save()`, `load()`, `clear()` (the built-in `mem0` store implements retrieve/update with load/save as service-side no-ops — Itsuki mirrors that shape); config class inheriting the host's `BaseConfig` registered through the schema registry (`register_memory_store`, `iter_memory_store_schemas`). **[verified]**
5. **Public API / config schema**: `ItsukiMemoryConfig { api_key: str (env-expanded ${…}), base_url: str | None, user_id: str | None, agent_id: str | None, project_id: str | None, top_k: int = 5, timeout_s: float = 8.0, allow_clear: bool = False }`. At least one of `user_id`/`agent_id` required (host falls back to `agent_role` as `agent_id` — kept for parity).
6. **Recall/injection**: `retrieve()` → sync `MemoryClient.search` with OR-scope parity (when both ids set, run recall in the user space with agent attribution filter; **[proposed]** mapping: `user_id` → tenant `userId`, `agent_id` → `memoryScope.agentId`), returns `MemoryItem`s (id, content_summary, score); host's memory manager injects them under "Related Memories" at the attachment's `retrieve_stage`s.
7. **Capture**: `update()` — capture **user input only**, after stripping ChatDev pipeline headers (the verified built-in behavior; assistant/stage outputs are workflow noise). Multimodal `MemoryContentSnapshot` blocks: text captured; attachments recorded as name/mime descriptors only (Itsuki is text-first — frozen).
8. **Automatic vs model-controlled**: fully automatic (stage-driven) — the only one of the six with host-scheduled lifecycle on both sides. Fallback-lane honesty rule: docs call it "ChatDev integration (operator-wired)" until the upstream PR merges; only the merged upstream lane may be marketed as "built-in `type: itsuki`".
9. **Tenancy**: as item 6; workflow name → `memoryScope.workspaceId`; run id → `conversationId`. The server enforces tenant ownership regardless of YAML contents (a YAML file cannot forge another key's space).
10. **Auth**: `${ITSUKI_API_KEY}` env expansion in YAML (host-native pattern); key never serialized into workflow exports (config `api_key` field excluded from any dump the schema registry produces — verify the host's dump path at implementation).
11. **Idempotency**: key = `sha256(user|agent|run_id|node_id|stage|digest(input))` — stage re-execution (loop nodes, retries) dedupes.
12. **Receipts**: staging only; the store never blocks a workflow stage on extraction.
13. **Bounding**: `top_k` ≤ 20; injected block ≤ 4,000 chars; `similarity_threshold` honored by dropping below-threshold items client-side if the host filters expect it.
14. **Timeouts/retries**: `timeout_s` (default 8 s) per call, SDK retry semantics.
15–19. Conventions header. Verified host expectation: memory errors must degrade (empty retrieval, silent-but-logged add failure) — never fail a workflow stage.
20. **Compatibility**: ChatDev 2.0 `main` (Python **3.12 only** — `>=3.12,<3.13`); pin the tested commit/tag in the PR and in `chatdev-itsuki` metadata. `clear()`: no-op unless `allow_clear: true` (then `deleteBySource` dry-run→confirm, never `delete_all`).
21. **File map**: upstream PR (3 files above + `tests/` addition following host test layout) ; fallback:
    ```
    packages/chatdev-itsuki/
      pyproject.toml  README.md  CHANGELOG.md  LICENSE
      chatdev_itsuki/__init__.py  config.py  store.py  register.py  _kernel.py
      tests/test_store.py  test_registry.py  test_contract.py  test_host_runtime.py  test_corpus.py
    ```
22. **Tests**: unit; registry test (schema appears in `iter_memory_store_schemas()` after import); contract; host-runtime: run a minimal `yaml_instance` workflow with a memory node `type: itsuki` against a scripted LLM, assert stage-driven retrieve/update calls and "Related Memories" injection; header-stripping corpus; 3.12-only tox env.
23. **Publication**: PR to `OpenBMB/ChatDev` (Apache-2.0, CLA if any — check at PR time) opened EARLY (longest lead); `chatdev-itsuki` to PyPI via template.
24–25. Conventions header. Risks: single-maintainer review latency; `MemoryBase` is 2.0-fresh and may move; Python-3.12-only pin conflicts with the shared kernel's ≥3.10 floor (kernel is compatible; CI just pins 3.12 here).
26. **Done** (additions): upstream lane — PR merged + a `yaml_template` example accepted; fallback lane — a documented deployment with the one-line import runs the example workflow green. The package may not be called production-ready while both lanes are pending (§12 gate).

---
## 7. File/directory change map

Everything new; **no existing file is modified except the four site/docs files, each only after its package publishes**, and the two SDK directories for P-1/P-2.

```
sdk/python/itsuki/__init__.py        # P-1: add AsyncMemoryClient (+ tests in sdk/python/tests/)
sdk/js/                              # P-2: version/publish only, no code change expected

packages/_kernel/ts/…                # §5.1 (new)
packages/_kernel/py/_kernel.py       # §5.2 (new)
scripts/sync-kernel.mjs              # (new)
test/kernel-parity.spec.js           # (new, repo test suite)

packages/ai-sdk-itsuki/…             # §6.1 (new)
packages/llama-index-memory-itsuki/… # §6.2 (new)
packages/agno-itsuki/…               # §6.3 (new)
packages/mastra-itsuki/…             # §6.4 (new)
packages/camel-itsuki/…              # §6.5 (new)
packages/chatdev-itsuki/…            # §6.6 fallback lane (new)
(external) OpenBMB/ChatDev PR        # §6.6 upstream lane

.github/workflows/publish-ai-sdk-provider.yml     # cloned npm template
.github/workflows/publish-mastra-integration.yml  # cloned npm template
.github/workflows/publish-pypi-<pkg>.yml ×4       # new PyPI template (§10)

public/index.html                    # installMethods()/installSnippets(): +6 entries, post-publish only
public/docs/index.html               # Connect-a-tool nav: +6 entries, same commit
test/get_started.spec.js             # contract expectations for the new entries
test/docs_connect_tool.spec.js       # same commit (the pair is contract-tested together)
```

## 8. Compatibility matrix

| Package | Host pin | Host runtime | Itsuki dep | OS CI | Verified host version (2026-08-15) |
|---|---|---|---|---|---|
| `ai-sdk-itsuki` | `ai ^7` (peer), provider spec v4 | Node ≥22 | vendored kernel | win+linux | `ai@7.0.66` |
| `mastra-itsuki` | `@mastra/core ^1.59` (peer) | Node ≥22.13 | vendored kernel | win+linux | `@mastra/core@1.59.0` |
| `llama-index-memory-itsuki` | `llama-index-core >=0.14,<0.16` | Python ≥3.10 | `itsuki>=0.3,<0.4` (needs P-1/P-2) | win+linux | `llama-index-core 0.14.23` |
| `agno-itsuki` | `agno >=2.9,<3` | Python ≥3.10 | `itsuki>=0.3,<0.4` | win+linux | `agno 2.9.0` |
| `camel-itsuki` | `camel-ai >=0.2.90,<0.3` | Python 3.10–3.14 | `itsuki>=0.3,<0.4` | win+linux | `camel-ai 0.2.90` |
| `chatdev-itsuki` / upstream | ChatDev 2.0 `main`, pinned commit | Python 3.12 only | `itsuki>=0.3,<0.4` | linux (+win best-effort) | repo state 2026-08-15 (2.0, DevAll 0.1.0) |

CI runs each package against **pinned current + latest-at-run** host versions; a red "latest" leg is a release blocker for that package only.

## 9. Enterprise security and test matrix

One matrix, executed per package (rows marked ⬥ are shared-infrastructure runs executed once and reused). Tests prove **behavior** — every row is an executed scenario with an asserted outcome, not a source grep.

| # | Scenario | Proof required |
|---|---|---|
| 1 | Clean install from the real registry (post-publish) | `npm i` / `pip install` in a bare container + bare Windows runner; import + construct + one mocked call green |
| 2 | Windows + Linux | full suite both platforms (existing workflow matrix) |
| 3 | Node 22/24 LTS; Python 3.10/3.12/3.13 (3.12 only for ChatDev) | matrix legs |
| 4 | Current + previous host minor | §8 matrix legs |
| 5 | Real-host lifecycle | each blueprint's host-runtime spec (real host package, scripted/mock model) |
| 6 | Streaming + cancellation | 6.1/6.4: mid-stream abort → passthrough intact, zero capture, no unhandled rejection |
| 7 | Concurrency + retries | 100 parallel turns per process against a fault-injecting mock (drops, 500s, 429+Retry-After); budgets honored, no key leakage in any surfaced error |
| 8 | Exactly-once capture | retry/reconnect storm replays → server receives one logical packet per idempotency key (assert via mock's key ledger + live `jobs` count in canary) |
| 9 | Tenant/project/user/agent isolation | two identities through one process: recalls never cross; list/get scoped; forged `memoryScope` ignored server-side (existing tenancy spec pattern) |
| 10 | 1,000-user scale simulation ⬥ | extend the proven 50-user harness: 1,000 synthetic users × save+recall through one integration path against staging; assert p95 latency, zero cross-tenant hits, rate-limit refusals are readable results |
| 11 | Credential revocation/rotation | revoke mid-run → `auth` class surfaces once, integration goes inert (no hammering), new key resumes without restart where config is re-read |
| 12 | Capability restrictions | read-only token: writes refuse with `insufficient_scope` result; `project.memory.delete=false`: delete tools refuse; recall continues |
| 13 | Quota/rate-limit handling | monthly AI cap + limiter refusals surface as readable results; `/v1/turn`-style degrade honored where used |
| 14 | Circuit-breaker degradation ⬥ | unreadable quota store → writes fail closed (server contract test against staging) |
| 15 | Timeout/DNS/TLS/offline | fault-injected transport: each maps to the right `ErrorClass`; recall fail-open; capture fail-open (+ CAMEL mirror intact) |
| 16 | Host restart / process crash | kill mid-capture; restart: no corruption (CAMEL mirror atomic-rename test; others stateless), no double-capture on replay |
| 17 | Prompt-injection & memory-poisoning ⬥ | shared adversarial corpus through each capture path; injected instructions in recalled content are inert data (injection block framing test); tenancy-smuggling attempts (6.3 item 22) fail |
| 18 | Oversized payloads | >413-sized batches: halve-once-then-drop verified; injected context never exceeds bounds |
| 19 | Secret leakage | key-shaped strings asserted absent from: logs, error messages, serialized state (LlamaIndex `model_dump`), YAML dumps (ChatDev), event-hook payloads, packed tarballs/wheels (CI gate) |
| 20 | Safe delete / bulk delete | dry-run defaults proven; `confirm` required; disabled-by-default flags proven (6.3/6.5/6.6 guards) |
| 21 | Package tampering / dependency risk | zero-runtime-deps gate (TS); Python deps = `itsuki` + host only; lockfile-free publishes from CI with pinned toolchain; `npm audit` / `pip-audit` high fails the run |
| 22 | SBOM / license / vulnerability scans | CycloneDX SBOM artifact per release job; Apache-2.0 headers; license files present in artifacts |
| 23 | Provenance | npm `--provenance` (both TS packages); PyPI Trusted Publishing attestations (all Python packages) |
| 24 | Production canary | per package post-publish: real key, dedicated canary `userId`: save → `waitFor` terminal `enriched` → recall finds it → list/get show it → delete → recall/list empty |
| 25 | Zero-residue cleanup | after 24: `deleteBySource(source=<pkg tag>)` dry-run reports 0 objects; canary `userId` `status` counts return to baseline |

## 10. CI / publication / deployment plan

1. **Workflow templates**: npm — clone `publish-openclaw-plugin.yml` verbatim mechanics (dispatch-only, `dry_run` default true, win+linux matrix, pinned Node 24.15.0 + npm@11, gates: typecheck→test→build→zero-deps→audit→tarball greps→provenance publish from ubuntu leg only). PyPI — new `publish-pypi.yml` template: dispatch-only, `dry_run` default true, matrix win+linux for tests, build with `python -m build`, `twine check`, wheel-content gates (no key-shaped strings, LICENSE present, no unexpected top-level modules), publish via `pypa/gh-action-pypi-publish` on the ubuntu leg with **Trusted Publishing** (`id-token: write`), configured as a *pending publisher* on PyPI before the first release — tokenless from day one, unlike npm.
2. **Authentication ledger**: npm first publishes of `ai-sdk-itsuki`/`mastra-itsuki` need the granular `NPM_TOKEN` once; immediately after each first publish the owner configures the Trusted Publisher and the token is revoked (same outstanding task already open for the three shipped packages). PyPI needs no token at any point.
3. **Publication order** = build order (§11); each publish is a separate owner-approved dispatch (standing rule: publication always needs explicit approval).
4. **Site/docs deployment**: after each successful canary (matrix row 24–25), one commit updates `public/index.html` + `public/docs/index.html` + the two contract specs together, then `wrangler deploy` (pre-authorized). Never before publish — the "no dead commands" tests exist to make that impossible to merge.
5. **SDK releases (P-1/P-2)** ride the same discipline: JS 0.2.1 via existing npm process; Python 0.3.0 via the new PyPI template with pending Trusted Publisher on the existing `itsuki` project.

## 11. Ordered Opus implementation checklist

Phase 0 — prerequisites (serial, everything else hangs off it):
- [ ] 0.1 `sdk/python`: implement `AsyncMemoryClient` (mirror sync surface; `httpx.AsyncClient`; shared validation; `aclose`/async context manager). Tests: `sdk/python/tests/test_async_client.py` mirroring `test_client.py` + loop-safety. Exit: `pytest sdk/python -q` green on 3.10/3.12/3.13, mypy clean.
- [ ] 0.2 Extract `packages/_kernel/{ts,py}` from `packages/openclaw-itsuki/src` (transport/errors/scrub/inject/batching + new idempotency/events), write `scripts/sync-kernel.mjs` + `test/kernel-parity.spec.js`. Exit: parity spec green; openclaw/pi/n8n untouched.
- [ ] 0.3 Owner gate: publish `itsuki` 0.2.1 (npm) and 0.3.0 (PyPI, pending Trusted Publisher configured first). Exit: §9 row 1 for both SDKs.

Phase 1 — TS lane (parallel with Phase 2):
- [ ] 1.1 `ai-sdk-itsuki` per §6.1. Commands: `npm run typecheck && npm test && npm run build` in the package. Exit: blueprint item 26.
- [ ] 1.2 Independent audit gate A (fresh session, adversarial review of 1.1 — tenancy, exactly-once, stream tap, key hygiene). Exit: findings fixed or accepted in writing.
- [ ] 1.3 Owner publish + canary + site pair-commit + deploy.
- [ ] 1.4 `mastra-itsuki` per §6.4 (reuses 1.1 patterns). Same audit gate (B) → publish → canary → site.

Phase 2 — Python lane (parallel with Phase 1; needs 0.1/0.3):
- [ ] 2.1 `agno-itsuki` per §6.3 (sync; no P-1 dependency — may start immediately after 0.2). Audit gate C → publish → canary → site.
- [ ] 2.2 `llama-index-memory-itsuki` per §6.2 (needs 0.1+0.3). Audit gate D → publish → canary → site.
- [ ] 2.3 `camel-itsuki` per §6.5 (verify `MemoryBlock` base import path first — 30-minute source check before coding `block.py`). Audit gate E → publish → canary → site.

Phase 3 — ChatDev (start the PR the moment Phase 0 lands; longest external latency):
- [ ] 3.1 Draft upstream PR (config + store + builtin registration + host-style tests + `yaml_template` example) against a pinned ChatDev commit; open early, iterate with maintainers.
- [ ] 3.2 In parallel: `chatdev-itsuki` fallback package per §6.6. Audit gate F → publish (labeled "operator-wired") → canary on a real ChatDev 2.0 deployment → site entry labeled honestly.
- [ ] 3.3 If/when the PR merges: relabel to "built-in `type: itsuki`", add upstream version pin to §8, site copy update.

Phase 4 — ecosystem reattack (after all publishes):
- [ ] 4.1 Re-run §9 rows 1, 8, 9, 17, 24, 25 for all six from clean environments in one session (the "final ecosystem reattack").
- [ ] 4.2 1,000-user scale run (§9 row 10) through the two highest-traffic paths (Vercel, LlamaIndex).
- [ ] 4.3 Close the ledger: memory-file updates, README index, final report to owner.

Justification of order: Vercel first (largest audience, zero backend prerequisites, kernel already proven in TS); Agno first on the Python side (sync, no P-1 wait); Mastra after Vercel (shares capture/injection design); CAMEL after LlamaIndex-adjacent work only in audit order — CAMEL and LlamaIndex are independent and may swap freely; ChatDev spans the whole campaign because its critical path is maintainer review, not code.

## 12. Risks and stop-gates

A package **must not** be called native or production-ready if any gate below trips; the documented fallback for every host is the existing MCP door plus an executable guide (honest labeling, no invented packages).

| Gate | Trigger | Package(s) | Fallback |
|---|---|---|---|
| G-1 host interface instability | `LanguageModelV4Middleware`/`Processor`/`BaseMemoryBlock`/`MemoryBase` signature breaks in the pinned range during build | any | pin one minor tighter; if the host has no stable range, ship as "experimental" or hold |
| G-2 doc/source contradiction | any behavior relied on that source disproves (log it in the report addendum) | any | redesign against source; docs never win over source |
| G-3 namespace loss | a frozen name gets claimed before publish | any | fall back to `itsuki-<host>` variants; never squat partner scopes (`@mastra/*`, `llama-index` org ownership not required — PyPI names are flat) |
| G-4 tenant enforcement | any path lets model- or YAML-supplied input choose the tenant | all | hard blocker, no fallback — fix before publish |
| G-5 idempotency | a host lifecycle turns out to re-fire capture without stable inputs to key on | 6.1/6.4 streams, 6.6 loops | capture off by default for that path + documented |
| G-6 destructive bounds | any deletion path reachable without explicit operator/user opt-in + confirm | 6.3/6.5/6.6 | ship with the tool/flag removed |
| G-7 host runtime untestable | real-host lifecycle test cannot be executed in CI (e.g., ChatDev CI cannot run a workflow) | 6.6 primarily | downgrade label to "adapter recipe", keep MCP as the supported path |
| G-8 canary residue | production canary cleanup cannot reach zero residue | any | publication blocked until residue path fixed |
| G-9 upstream rejection | ChatDev maintainers decline the PR | 6.6 upstream lane | fallback lane stays "operator-wired integration"; never claim built-in |
| G-10 SDK drift | published `itsuki` SDK ≠ audited source at build time | Python packages | block on P-2 |

## 13. Frozen decisions

- **F-1** Vercel = middleware over `wrapLanguageModel` (spec v4), zero bundled providers; never Mem0's provider-factory-with-bundled-SDKs shape.
- **F-2** LlamaIndex = `BaseMemoryBlock[str]` + `Memory` factory; no new `BaseMemory` subclass.
- **F-3** Transport sharing: TS packages vendor the kernel (zero runtime deps, parity-tested); Python packages depend on the published first-party `itsuki` SDK.
- **F-4** Capture rule for conversational hosts (6.1/6.4): send both settled sides; the server's user-anchored extraction is the filter. No capture on abort/error.
- **F-5** Tenant identity is never model-selectable and never defaulted to a shared space; missing identity is a construction/readable-tool error.
- **F-6** Idempotency keys are content-derived (`sha256(identity|conversation|digest)`), so replays dedupe without client state.
- **F-7** Recall fail-open, capture fail-open, deletion fail-closed, unreadable-write-quota fail-closed (server).
- **F-8** Injection format matches the MCP door's phrasing and is bounded (4,000 chars / 10 items default).
- **F-9** Destructive parity with Mem0 is deliberately **declined** where Mem0 is unsafe: Agno `delete_all` disabled by default; CAMEL `clear()` never deletes server memory without `allow_remote_clear`; ChatDev `clear()` gated by `allow_clear`.
- **F-10** CAMEL `load()` stays lossless via the local mirror; semantic recall is a separate block — Mem0's lossy reconstruction is not copied.
- **F-11** ChatDev "native" labeling is earned by the upstream merge; the registry package is "operator-wired" until then.
- **F-12** Six frozen names: `ai-sdk-itsuki`, `mastra-itsuki` (npm); `llama-index-memory-itsuki`, `agno-itsuki`, `camel-itsuki`, `chatdev-itsuki` (PyPI). All verified available 2026-08-15.
- **F-13** No OpenTelemetry dependency; content-free event hook only.
- **F-14** MCP remains the universal, always-supported fallback for every host; no native package removes or wraps it.
- **F-15** Text-first capture everywhere; multimodal deferred (ChatDev attachments become descriptors; Agno multimodal not claimed).

## 14. Remaining questions that truly require user/vendor input

1. **Owner approvals** (standing rule): each of the eight publishes (2 SDK releases + 6 packages) and the ChatDev PR submission need explicit owner sign-off at dispatch time.
2. **npm token window**: owner must be available to configure Trusted Publishers and revoke `NPM_TOKEN` right after the two npm first-publishes (same open task exists for the three shipped packages).
3. **ChatDev maintainers**: CLA/contribution requirements and appetite for a `type: itsuki` backend — unknowable until the PR conversation starts (G-9 covers rejection).
4. **Canary credentials**: a dedicated production API key + canary `userId` naming convention for §9 rows 24–25 (recommended: one key per package, revoked after each campaign phase — owner to mint).
5. **Marketing copy for the site doors** (six new entries): owner voice preferred; the contract tests will hold whatever copy is chosen to the published-package rule.

## 15. Official source index (all verified 2026-08-15)

**Itsuki repository (HEAD `ee2fcff`)**: `sdk/js/index.d.ts`, `sdk/js/index.js`, `sdk/python/itsuki/__init__.py`, `sdk/python/pyproject.toml`, `src/mcp/server.js`, `src/index.js` (route table), `src/auth.js`, `src/lib/{scopes,rate,ai_budget,memory_inventory}.js`, `src/pipeline/{commands,mcp_engine,cleanup}.js`, `packages/{openclaw-itsuki,pi-itsuki,n8n-nodes-itsuki}/**`, `.github/workflows/publish-*.yml`, `AGENTS.md`, `test/{get_started,docs_connect_tool}.spec.js`.

**Registries**
- https://registry.npmjs.org/ai/latest — `ai@7.0.66`, Node ≥22, `@ai-sdk/provider@4.0.7`
- https://registry.npmjs.org/@mem0/vercel-ai-provider/latest — 3.0.1, `ai ^6.0.199`, bundled provider deps, repo dir `integrations/vercel-ai-sdk`
- https://registry.npmjs.org/@mastra/core/latest — 1.59.0, Node ≥22.13
- https://registry.npmjs.org/@mastra/mem0/latest — 0.1.12, peer `@mastra/core >=0.15.3-0 <0.17.0-0`, dep `mem0ai ^2.1.36`
- https://registry.npmjs.org/itsuki/latest — 0.2.0 (ours)
- https://registry.npmjs.org/mem0ai/latest — 3.1.6
- https://pypi.org/pypi/llama-index-core/json — 0.14.23, Python ≥3.10
- https://pypi.org/pypi/llama-index-memory-mem0/json — 2.0.0 (2026-05-20), `llama-index-core >=0.13,<0.15`, `mem0ai >=2,<3`
- https://pypi.org/pypi/agno/json — 2.9.0, Python ≥3.9
- https://pypi.org/pypi/camel-ai/json — 0.2.90, Python ≥3.10,<3.15, `mem0ai>=0.1.73` under `storage` extra
- https://pypi.org/pypi/itsuki/json — 0.1.1 (ours, 2026-08-01)
- https://pypi.org/pypi/mem0ai/json — 2.0.18
- Availability 404-checks (2026-08-15): npm `ai-sdk-itsuki`, `vercel-ai-itsuki`, `mastra-itsuki`, `itsuki-ai-provider`; PyPI `llama-index-memory-itsuki`, `agno-itsuki`, `camel-itsuki`, `chatdev-itsuki` — all available.

**Host docs/source**
- https://ai-sdk.dev/docs/ai-sdk-core/middleware — `LanguageModelV4Middleware`, `wrapLanguageModel`, per-request `providerOptions` namespace
- https://raw.githubusercontent.com/run-llama/llama_index/main/llama-index-core/llama_index/core/memory/types.py — `BaseMemory` (legacy interface)
- https://raw.githubusercontent.com/run-llama/llama_index/main/llama-index-core/llama_index/core/memory/memory.py — `Memory`, `BaseMemoryBlock` (`_aget`/`_aput`/`atruncate`, `InsertMethod`)
- https://developers.llamaindex.ai/python/framework/module_guides/deploying/agents/memory/ — current memory guide; deprecation notes incl. Mem0 example
- https://raw.githubusercontent.com/run-llama/llama_index/main/llama-index-integrations/memory/llama-index-memory-mem0/llama_index/memory/mem0/base.py — `Mem0Memory` behavior
- https://raw.githubusercontent.com/agno-agi/agno/main/libs/agno/agno/tools/toolkit.py — `Toolkit` contract
- https://raw.githubusercontent.com/agno-agi/agno/main/libs/agno/agno/tools/mem0.py — `Mem0Tools` behavior + identity resolution
- https://raw.githubusercontent.com/camel-ai/camel/master/camel/storages/key_value_storages/base.py — `BaseKeyValueStorage` abstract contract
- https://raw.githubusercontent.com/camel-ai/camel/master/camel/storages/key_value_storages/mem0_cloud.py — `Mem0Storage` behavior
- https://raw.githubusercontent.com/camel-ai/camel/master/camel/memories/blocks/chat_history_block.py — `ChatHistoryBlock` storage consumption
- https://github.com/OpenBMB/ChatDev — 2.0 (2026-01-07), YAML workflows, active
- https://raw.githubusercontent.com/OpenBMB/ChatDev/main/entity/configs/node/memory.py — `MemoryStoreConfig` discriminator (`simple|file|blackboard|mem0`), `Mem0MemoryConfig`, schema registry
- https://raw.githubusercontent.com/OpenBMB/ChatDev/main/docs/user_guide/en/modules/memory.md — memory node YAML, attachment schema, lifecycle, custom-store route
- https://raw.githubusercontent.com/OpenBMB/ChatDev/main/runtime/node/agent/memory/registry.py — `register_memory_store(name, config_cls=…, factory=…)`
- https://raw.githubusercontent.com/OpenBMB/ChatDev/main/runtime/node/agent/memory/memory_base.py — `MemoryContentSnapshot`, `MemoryItem`
- https://raw.githubusercontent.com/OpenBMB/ChatDev/main/runtime/node/agent/memory/mem0_memory.py — built-in `mem0` store behavior (sync, OR-filter, user-input-only capture, degrade-on-error)
- https://raw.githubusercontent.com/OpenBMB/ChatDev/main/pyproject.toml — `DevAll 0.1.0`, `requires-python >=3.12,<3.13`
- https://mastra.ai/docs/memory/overview — Memory/resource/thread semantics; no third-party memory-provider interface documented
- https://mastra.ai/docs/agents/processors — `Processor` interface (`processInput`, `processOutputResult`, `processOutputStream`, …), attachment via Agent arrays
- https://mastra.ai/docs/integrations/mem0 — **404** (drift evidence)
- https://docs.mem0.ai/integrations/vercel-ai-sdk — install `@mem0/vercel-ai-provider ai@^6`, auto-retrieval, manual `addMemories`
- GitHub API listings: `mastra-ai/mastra/contents/integrations` (no mem0), `run-llama/llama_index/contents/llama-index-integrations/memory` (mem0 + bedrock-agentcore), `OpenBMB/ChatDev` memory module contents

---

*End of frozen report. Research-only campaign: no source code, tests, configs, workflows, or migrations were modified; no commits, publishes, or deployments were made.*

