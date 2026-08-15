# Itsuki Six Native Framework Integrations — IMPLEMENTATION REPORT

Branch `native-frameworks-six`, pushed to origin. Base `ee2fcff` (master, unchanged). Implementation date 2026-08-15.

**Nothing was published, deployed, or pointed at production.** No npm or PyPI release, no `wrangler deploy`, no production API key, no production canary, no ChatDev pull request, no install commands added to the site, and no merge to master.

---

## 1. Verdict

**GO for independent audit.** All six packages are implemented, tested against their real hosts where the host is installable, packaged, and green. Five logical commits, 125 files, +24,074 / −327.

Four defects were found by the tests and fixed rather than shipped — two of them the kind that only surface in production (§8). One host behaviour contradicted the frozen report and the design changed to match reality (§8, M-1).

The one package that cannot be called production-ready is `chatdev-itsuki`, and it is labelled accordingly everywhere it is described: ChatDev 2.0 is an application repository, not an installable framework, so no real workflow run was executed. That is stop-gate **G-7** from the frozen report, hit exactly where the report predicted.

---

## 2. Commits

| SHA | Title |
|---|---|
| `6c78a8c` | Add the async Python client and the shared adapter kernels |
| `8133487` | Add ai-sdk-itsuki: Itsuki memory as AI SDK middleware |
| `644d80a` | Add mastra-itsuki, and move the shared runtime into the kernel |
| `8f62488` | Add the four Python adapters: Agno, LlamaIndex, CAMEL, ChatDev |
| `148fecf` | Prove tenant isolation at a thousand identities |

## 3. Files changed

**Prerequisites and shared code**
- `sdk/python/itsuki/__init__.py` — `AsyncMemoryClient`, plus `list_memories`/`get_memory` on both clients; version 0.3.0
- `sdk/python/pyproject.toml`, `sdk/python/tests/{test_client,type_contract}.py` — version pin, async type contract
- `sdk/python/tests/test_async_client.py` — new
- `packages/_kernel/ts/*` (11 files) — transport, errors, scrub, inject, batching, hash, idempotency, events, memory, types, index
- `packages/_kernel/py/_kernel.py` — the Python half
- `scripts/sync-kernel.mjs`, `test/kernel-parity.spec.js` — the vendoring mechanism and its gate
- `vitest.config.mjs`, `vitest.unit.config.mjs` — register the parity spec in the Node config

**Packages** (each: source, tests, README, CHANGELOG or equivalent, LICENSE, manifest, `.gitignore`)
- `packages/ai-sdk-itsuki/` — 7 source, 8 test files
- `packages/mastra-itsuki/` — 8 source, 3 test files
- `packages/agno-itsuki/`, `packages/llama-index-memory-itsuki/`, `packages/camel-itsuki/`, `packages/chatdev-itsuki/`

**CI**
- `.github/workflows/publish-ai-sdk-provider.yml`, `publish-mastra-integration.yml`, `publish-pypi.yml`

**Untouched:** `src/`, `migrations/`, `public/`, `wrangler.jsonc`, `plugins/`, and the three shipped adapters (`n8n-nodes-itsuki`, `pi-itsuki`, `openclaw-itsuki`).

---

## 4. Per-package summary

### `ai-sdk-itsuki` (npm, 0.1.0)
`LanguageModelV4Middleware` over `wrapLanguageModel`. Recall in `transformParams` injects a marker-fenced system block; capture in `wrapGenerate`, and in `wrapStream` via a tap that enqueues each chunk before doing any bookkeeping and only acts on flush. `withItsuki(model, config)`, `createItsuki(config)`, `itsukiMiddleware(config)`, plus `retrieveMemories`/`getMemories`/`saveMemories`/`waitForMemory`. Zero runtime dependencies; no provider SDK bundled — the deliberate inverse of Mem0's provider factory, which bundles five. Capture modes `background` (with `waitUntil` support for freeze-after-response platforms) / `blocking` / `off`. Per-call tenancy via `providerOptions.itsuki`, stripped before the provider sees it.

### `mastra-itsuki` (npm, 0.1.0)
Two tiers. `ItsukiRecall` implements `processInput`; `ItsukiCapture` implements `processOutputResult`. Tools via `createTool`: search, save, list, get, and delete only when `enableDelete: true` and only with `confirmed: true`. Identity maps Mastra's own `resource`/`thread`, overridable server-side through `RequestContext`. No tool accepts a tenancy parameter. Zero runtime dependencies.

### `agno-itsuki` (PyPI, 0.1.0)
A real `Toolkit` with six operations; save/search/list/get on by default, both delete tools off. Identity is constructor → `run_context.user_id` → readable refusal, never a tool argument. Honestly labelled model-called memory, not an automatic lifecycle.

### `llama-index-memory-itsuki` (PyPI, 0.1.0)
`BaseMemoryBlock[str]` implementing async `_aget`/`_aput`/`atruncate`, plus `itsuki_memory()` and `itsuki_memory_block()` factories. Uses `AsyncMemoryClient`. The API key is a pydantic private attribute, so it never appears in a dump or serialized agent state.

### `camel-itsuki` (PyPI, 0.1.0)
`ItsukiStorage(BaseKeyValueStorage)` with a **lossless** local mirror (atomic replace, bounded, corrupt-file safe) that also stages to Itsuki, plus `ItsukiContextBlock(MemoryBlock)` for semantic recall. `clear()` never touches server memory without `allow_remote_clear=True`.

### `chatdev-itsuki` (PyPI, 0.1.0) — operator-wired
`ItsukiMemoryStore` with `retrieve`/`update`/`load`/`save`/`clear`, `ItsukiMemoryConfig` with `${VAR}` expansion and credential-free serialization, and `register()` against the documented registry hook. User input only; pipeline headers stripped; `clear()` gated by `allow_clear`.

---

## 5. Test counts and commands

| Suite | Tests | Command |
|---|---|---|
| Python SDK (sync + async) | **147** | `cd sdk/python && python -m pytest -q` |
| Python SDK strict types | clean | `python -m mypy --strict itsuki tests/type_contract.py` |
| `ai-sdk-itsuki` | **133** | `cd packages/ai-sdk-itsuki && npm test` |
| `mastra-itsuki` | **40** | `cd packages/mastra-itsuki && npm test` |
| `agno-itsuki` | **25** | `cd packages/agno-itsuki && python -m pytest tests -q` |
| `llama-index-memory-itsuki` | **18** | `cd packages/llama-index-memory-itsuki && python -m pytest tests -q` |
| `camel-itsuki` | **21** | `cd packages/camel-itsuki && python -m pytest tests -q` |
| `chatdev-itsuki` | **28** | `cd packages/chatdev-itsuki && python -m pytest tests -q` |
| **New tests total** | **412** | |

Python package suites need the workspace SDK on the path: `PYTHONPATH=sdk/python`.

### Regression (unchanged code must stay unchanged)

| Suite | Result |
|---|---|
| Repo Workers pool (`npx vitest run --no-file-parallelism`) | see §6 |
| Repo Node config (`npx vitest run --config vitest.unit.config.mjs`) | **572 passed, 1 skipped (573)**, 34 files |
| `openclaw-itsuki` | **151 passed** |
| `pi-itsuki` | **150 passed** |
| `n8n-nodes-itsuki` | **40 passed** |
| `git diff --check` | clean |
| `node scripts/sync-kernel.mjs --check` | in sync |
| Typecheck, both TS packages | clean |

---

## 6. Full-repository result

Baseline before any change (recorded at `ee2fcff`): **140 files, 1761 tests, all passing**, 522s.

After every change, same command, same machine: **140 files, 1761 tests, all passing**, 533s.

```
 Test Files  140 passed (140)
      Tests  1761 passed (1761)
```

Identical counts, zero regressions, zero new failures. The Workers-pool total is unchanged because the one repo-level test added — `test/kernel-parity.spec.js` — reads the filesystem and therefore belongs to the Node config, where it is registered alongside `migrations_append_only.spec.js` for the same reason. It contributes 27 of the Node config's 572.

No test was weakened, no timeout was raised, and no production behaviour was changed to satisfy an adapter.

---

## 7. Enterprise matrix — what was executed

Executed locally, without production mutation:

| §9 row | Status | Evidence |
|---|---|---|
| Clean install from built artifacts | **PASS** | Fresh venv installed all four wheels + SDK; every package imports and constructs. Fresh npm project installed both tarballs + `ai@7`; every export resolves and the middleware reports `specificationVersion: v4`. |
| Windows | **PASS** | Every suite above ran on Windows 11. Linux legs are declared in CI, not yet executed (§9). |
| Python 3.12 / Node 24 | **PASS** | Local toolchain. 3.10/3.13 and Node 22 legs declared in CI. |
| Current host versions | **PASS** | `ai@7.0.66`, `@mastra/core@1.59.0`, `agno 2.9.0`, `llama-index-core 0.14.23`, `camel-ai 0.2.90` — the exact versions the frozen report predicted. |
| Real-host lifecycle | **PASS ×5** | Real `generateText`/`streamText` with `MockLanguageModelV4`; a real `@mastra/core` `Agent` with both processors; a real `agno` `Toolkit`; a real `Memory` + block; a real `ChatHistoryMemory`. ChatDev is the exception (§9). |
| Streaming and cancellation | **PASS** | Stream parts asserted identical to unwrapped; abort captures nothing; a streamed provider error captures nothing; consumer-cancel-but-model-finishes DOES capture, and that distinction is pinned. |
| Concurrency and retries | **PASS** | 1000 concurrent identities; a retry storm; one-in-seven write failures with all turns still succeeding. |
| Exactly-once capture | **PASS** | Same exchange → same key across repeats, retries and reconnects; 1000 tenants → 1000 distinct keys; tool-level and block-level replay dedupe. |
| Tenant / project / agent isolation | **PASS** | 1000-identity crossing test; two-user Mastra runs; two-agent CAMEL societies; two ChatDev workflows. |
| Read-only / insufficient scope | **PASS** | 403 `insufficient_scope` maps to non-retriable `auth`; recall continues, writes refuse readably. |
| Oversized payload bounds | **PASS** | 70-message span splits into distinctly-keyed batches with nothing dropped; a 50,000-character message is clamped and says so. |
| Offline / timeout / DNS / TLS / 5xx | **PASS** | Each maps to its `ErrorClass`; recall and capture both fail open; the agent answers. |
| Prompt injection and poisoning | **PASS** | Five poisoned-memory vectors fenced and labelled as data; forged markers cannot close the fence; recalled text the model echoes is suppressed before capture; a model-authored fake block captures nothing. |
| Credential leakage | **PASS** | Absent from logs, error surfaces, event payloads, pydantic dumps, ChatDev config serialization, tarballs and wheels. **One real defect found and fixed here (§8, D-3).** |
| Safe / bulk delete | **PASS** | Off by default everywhere; `confirmed` required; bulk previews first and is scoped to the adapter's own source lane; CAMEL `clear()` is local-only by default. |
| Package contents and dependencies | **PASS** | Zero runtime dependencies for both npm packages; Python deps are the SDK plus the host only; no postinstall; no bundled provider; no Node built-ins in the edge-targeted kernel; LICENSE present; kernel vendored. |
| Install / uninstall | **PASS** | Clean install proven; uninstall leaves no daemon and no state beyond CAMEL's documented mirror file. |

**Not executed** (production or external, correctly out of scope for this phase): SBOM generation, `pip-audit`/`npm audit` in CI, provenance attestations, production save→wait→recall→delete canaries, zero-residue verification, credential revocation/rotation against a live key, circuit-breaker degradation against staging.

---

## 8. Defects found and fixed, and one corrected premise

**D-1 — a tool-only step stored half an exchange.** `ai-sdk-itsuki` captured the user turn alone when a model step produced only tool calls. In a tool loop the first call returns tool calls and a later one answers, so the same exchange was stored twice under two different keys — once bare, once complete. Capture now requires both a user turn and settled assistant prose. Found by the real `generateText` tool-loop test.

**D-2 — Mastra capture had no user turn.** `processOutputResult` is handed only the messages the model just produced. Capturing from that alone would have stored every answer with no question attached. Capture now reads the conversation from the host's `MessageList`, with a defensive fallback. Found by the real `Agent` test; see M-1.

**D-3 — the Agno toolkit echoed the server's error message verbatim.** A server that reflected the API key back in an error would have put the credential into a tool result, into the model's context, and potentially into stored memory. Every error surface is now redacted against the known key. Found by an adversarial 401 test.

**D-4 — the Agno get tool returned the response envelope** instead of the memory inside it.

**M-1 — corrected premise (frozen report §6.4 item 4).** The report specified reading the user turn from `processOutputResult`'s `messages`. The host does not put it there. The blueprint's intent is preserved; the mechanism changed.

**M-2 — kernel hash.** The report assumed the OpenClaw port's `node:crypto`. The kernel now carries a small in-repo SHA-256 so it runs on edge runtimes and Workers, pinned against both the NIST vectors and `node:crypto` over a randomized corpus.

**M-3 — new backend gap.** The Python SDK had no `list_memories`/`get_memory` despite the REST surface having them since launch. Added to both clients through the shared plan. The frozen report's prerequisite ledger listed inventory as "sufficient as-is"; it was sufficient at REST, not in the SDK.

**M-4 — sequencing.** Per the campaign instruction, packages were built against the local workspace SDK; no SDK was published first.

---

## 9. Remaining external blockers

1. **npm / PyPI publication approval** — owner-gated. Both npm workflows and the PyPI workflow default to `dry_run: true`.
2. **Trusted Publisher configuration** — PyPI supports a *pending* publisher before a project exists, so all four Python packages can be tokenless from the first release. npm cannot: the two first publishes need `NPM_TOKEN`, after which the Trusted Publisher should be configured and the token revoked.
3. **Dry-run CI could not be dispatched.** GitHub only allows `workflow_dispatch` for workflows present on the **default branch**, and merging to master before the audit is forbidden. Every gate in those workflows was therefore executed locally instead (§7). Dispatch becomes possible the moment the branch merges.
4. **Linux CI legs** — declared in all three workflows, not executable locally.
5. **Production canary credentials** — a dedicated key and canary `userId` per package, owner-minted.
6. **ChatDev upstream submission** — the patch set is prepared in `chatdev-itsuki`; the PR is not opened.
7. **Real ChatDev workflow run** — needs a checkout on Python 3.12. Until then the package stays "operator-wired".
8. **Site deployment** — no install commands were added; proposed copy is not written into `public/`.

---

## 10. Recommended publication order (after audit)

1. `itsuki` Python SDK **0.3.0** to PyPI — the four Python packages depend on it, so nothing else can go first.
2. `itsuki` npm **0.2.1** — housekeeping; the TS packages vendor the kernel and do not depend on it.
3. `ai-sdk-itsuki` — largest audience, no backend prerequisite.
4. `agno-itsuki` — sync, smallest surface.
5. `mastra-itsuki`.
6. `llama-index-memory-itsuki` — after the SDK release lands.
7. `camel-itsuki`.
8. `chatdev-itsuki` — last, labelled operator-wired, alongside opening the upstream PR.

Site doors update **only after** each package's canary passes, in the same commit as the two contract specs.

---

## 11. Verdict for audit

**GO / NO-GO: GO for independent Fable audit.** Not for production release.

Suggested audit focus, in the order I would attack it:
1. The capture-settlement rule in both TS packages — D-1 was found there and adjacent cases may remain.
2. `conversationMessages()` in `mastra-itsuki` — it reads a host-owned accessor defensively; verify the fallback cannot silently capture the wrong thing.
3. Redaction coverage across every Python error surface, since D-3 existed in one of them.
4. The kernel SHA-256, independently.
5. Whether "operator-wired" is stated everywhere `chatdev-itsuki` is described.
