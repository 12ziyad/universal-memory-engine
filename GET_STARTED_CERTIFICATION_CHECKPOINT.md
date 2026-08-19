# Get Started certification checkpoint

Campaign: final certification of every Get Started integration route.
Started: 2026-08-19. Baseline commit: `affa39b` (lifecycle + memories workspace, pushed).
Dependency gate: Project Lifecycle campaign COMPLETE (backlog item 4, PRODUCTION GO 2026-08-19).

## Derived route matrix — 26 cards / 38 routes (equality check PASSED, manual count of installCatalog() 2026-08-19)

Legend: proof levels = Real-host (RH) / Protocol (P) / Config-build (CB) / Held (H). Status: ☐ pending, ◐ partial, ✓ certified, ✗ failed-open-defect, HOLD.

| # | Card | Route | Kind | Package / door | Registry state | Status |
|---|------|-------|------|----------------|----------------|--------|
| 1 | claude (apps) | MCP | App Connect | /mcp/<key> path token | n/a | ☐ |
| 2 | chatgpt (apps) | MCP | App Connect | /mcp/<key>; needs Business/Enterprise workspace | n/a | ☐ |
| 3 | claude-code | Plugin | lifecycle hooks | itsuki@itsuki-plugins (0.7.0) via GitHub marketplace | repo `plugins/itsuki` | ☐ |
| 4 | codex | Plugin | lifecycle hooks | itsuki@itsuki-plugins (0.3.0 codex) | repo | ☐ |
| 5 | cursor | MCP | deeplink + mcp.json | path token | n/a | ☐ |
| 6 | opencode | Native plugin | npm | opencode-itsuki | 0.1.0 npm ✓ | ☐ |
| 7 | opencode | MCP | opencode.json remote | path token | n/a | ☐ |
| 8 | antigravity | Native CLI | npx installer | antigravity-itsuki | 0.1.0 npm ✓ | ☐ |
| 9 | antigravity | MCP | mcp_config.json | path token | n/a | ☐ |
| 10 | openclaw | Native plugin | openclaw plugins install | openclaw-itsuki | 0.1.0 npm ✓ | ☐ |
| 11 | openclaw | Guided setup (prompt) | agent-driven MCP + ingest | path token | n/a | ☐ |
| 12 | openclaw | Manual MCP | openclaw mcp add | path token | n/a | ☐ |
| 13 | hermes | Native provider | pip + hermes-itsuki install | hermes-itsuki | 0.1.0 PyPI ✓ | ☐ |
| 14 | hermes | MCP | config.yaml / hermes mcp add | path token | n/a | ☐ |
| 15 | pi | Native extension | pi install npm:pi-itsuki | pi-itsuki | 0.1.0 npm ✓ | ☐ |
| 16 | pi | REST | guided prompt + curl | bearer (mcp key) | n/a | ☐ |
| 17 | langchain | MCP | langchain-mcp-adapters | header bearer | upstream pkg | ☐ |
| 18 | crewai | MCP | crewai-tools[mcp] | header bearer | upstream | ☐ |
| 19 | autogen | MCP | autogen-ext | header bearer | upstream | ☐ |
| 20 | agno | Native toolkit | pip agno-itsuki | agno-itsuki | 0.1.1 PyPI ✓ | ☐ |
| 21 | agno | MCP | agno MCPTools | header bearer | upstream | ☐ |
| 22 | openai-agents | MCP | openai-agents MCPServerStreamableHttp | header bearer | upstream | ☐ |
| 23 | google-adk | Native service | pip adk-itsuki (google-adk 2.5–2.7) | adk-itsuki | 0.1.0 PyPI ✓ | ☐ |
| 24 | llamaindex | Native memory | pip llama-index-memory-itsuki | llama-index-memory-itsuki | 0.1.1 PyPI ✓ | ☐ |
| 25 | llamaindex | MCP | llama-index-tools-mcp, PATH TOKEN (no headers) | path token | upstream | ☐ |
| 26 | camel | Native storage | pip camel-itsuki | camel-itsuki | 0.1.1 PyPI ✓ | ☐ |
| 27 | mastra | Native processors | npm mastra-itsuki | mastra-itsuki | 0.1.0 npm ✓ | ☐ |
| 28 | mastra | MCP | @mastra/mcp | header bearer | upstream | ☐ |
| 29 | vercel-ai | Native middleware | npm ai-sdk-itsuki | ai-sdk-itsuki | 0.1.0 npm ✓ | ☐ |
| 30 | vercel-ai | MCP | @ai-sdk/mcp | header bearer | upstream | ☐ |
| 31 | n8n | Native node | community node, SELF-HOSTED ONLY | n8n-nodes-itsuki | 0.1.0 npm ✓ | ☐ |
| 32 | n8n | HTTP | HTTP Request node /v1/save,/v1/recall | bearer | n/a | ☐ |
| 33 | n8n | MCP | MCP Client Tool | header bearer | n/a | ☐ |
| 34 | dify | MCP | Dify native MCP client | header bearer | n/a | ☐ |
| 35 | convex | SDK | npm itsuki + convex | itsuki | 0.2.1 npm ✓ | ☐ |
| 36 | python-sdk | SDK | pip itsuki | itsuki | 0.3.0 PyPI ✓ | ☐ |
| 37 | typescript-sdk | SDK | npm itsuki | itsuki | 0.2.1 npm ✓ | ☐ |
| 38 | rest-api | REST/cURL | /v1/save /v1/recall | bearer | n/a | ☐ |

Excluded (verified): Zapier (excluded), chatdev-itsuki (unpublished on npm+PyPI, absent from catalog ✓), Antigravity Desktop/IDE (explicit "not supported" in UI ✓ — keep), n8n Cloud (UI says self-hosted only ✓ — keep).

## Registry snapshot (2026-08-19)

npm: itsuki 0.2.1 · openclaw-itsuki 0.1.0 · pi-itsuki 0.1.0 · opencode-itsuki 0.1.0 · antigravity-itsuki 0.1.0 · n8n-nodes-itsuki 0.1.0 · ai-sdk-itsuki 0.1.0 · mastra-itsuki 0.1.0
PyPI: itsuki 0.3.0 · agno-itsuki 0.1.1 · llama-index-memory-itsuki 0.1.1 · camel-itsuki 0.1.1 · adk-itsuki 0.1.0 · hermes-itsuki 0.1.0

## Completed

- Dependency gate verified: lifecycle campaign GO (LATER_PHASE_BACKLOG.md item 4).
- Baseline commit `affa39b` pushed to origin/master.
- Route matrix derived and equality-checked: 26 cards, 38 routes — matches expectation; contract test `get_started.spec.js` pins the same graph equality (38 leaves, set-equal), plus docs pairing tests in `docs_connect_tool.spec.js`.
- Registry state for all 14 referenced packages verified published; chatdev-itsuki confirmed unpublished on both registries.
- **Published-artifact content proof**: all 8 npm tarballs and all 6 PyPI wheels downloaded and diffed byte-for-byte (line-ending-normalized) against the repo — 100% identical, zero drift, zero unexpected files.
- **Clean-env SDK contracts**: published `itsuki` npm 0.2.1 and PyPI 0.3.0 installed in fresh envs; every method the Get Started snippets call exists (addConversation/add_conversation, search, add, turn, newIdempotencyKey/new_idempotency_key); both fail closed on missing/empty API key.
- **Snippet config parsing**: every JSON config block (opencode, antigravity, cursor, opencodeNativeConfig, openclawNativeConfig) parses; hermes YAML shape correct; every curl `-d` body parses as JSON; quotes balanced.
- **Production canary battery A–E: 23/23 PASS (2026-08-19)** against https://itsuki.app with disposable accounts:
  - A: REST save→settle→recall (direct + conversation/userId=alex), subtenant isolation (root cannot read alex).
  - D: idempotent replay returns same source_packet id; same-key/different-payload → 409 idempotency_conflict; 3-way concurrent same-key storm settles clean.
  - B: MCP header-bearer /mcp — initialize (server itsuki-memory 0.7.0), 8 tools advertised, save→recall round trip, whoami reports project + scopes, key never echoed.
  - C: MCP path-token /mcp/<key> — initialize + whoami.
  - E: account B cannot recall account A's canary; forged x-itsuki-project → 403 (key) / 404 (session); revoked key → 401.

## Disposable canary resources (MUST be cleaned in Phase 10)

- Account A: user_82e6d67e…, project proj_5707a9e0… (deleted) (+ its default project proj_fb194bc8…), mcp+api tokens, canary saves (GSCERT-REST/CONV/IDEM/CONC/MCPH-54319bb8).
- Account B: user_a719a0e0…, default project, one revoked api token.
- Credentials in scratchpad canary_creds.json / canary_b.json only (never in repo).

## Completed since (all 2026-08-19)

- **Baseline full Workers suite: 147 files / 1,907 tests GREEN** (uninterrupted run, exit 0).
- **Package suites all green**: ai-sdk-itsuki 135, mastra-itsuki 42, n8n-nodes-itsuki 40, openclaw-itsuki 151, opencode-itsuki 122, pi-itsuki 150, antigravity-itsuki 119; Python: agno-itsuki, camel-itsuki, llama-index-memory-itsuki, hermes-itsuki (stub-host contract), sdk/python, adk-itsuki 42 on real google-adk 2.7.1 — all pass.
- **Framework-client protocol proofs (exact displayed snippets, clean envs, production)**: langchain-mcp-adapters, crewai-tools[mcp], autogen-ext, agno MCPTools, openai-agents MCPServerStreamableHttp, llama-index BasicMCPClient (path token), @mastra/mcp 1.16.0 (listTools confirmed real), @ai-sdk/mcp 2.0.33 — every route retrieved all 8 tools.
- **SDK production round trips (exact snippets)**: TS addConversation→search(context)→add(Convex shape)→turn; Python add_conversation→search→turn — all PASS with settled recall.
- **Cross-door Battery F**: /v1/turn + explicit /v1/save same words = both accepted as distinct identities; receipts observable in /v1/requests; concurrent two-door delivery clean.
- **Claude Code plugin real-host**: SessionStart hook run directly against production with canary key — fires, recalls, and fails CLOSED with honest actionable messages when the protected data dir or echo guard is absent (by design; guard is created by the documented /plugin configure + doctor flow). Security containment refuses undocumented data dirs. Full flow previously proven in enterprise A0–A12 campaign + live in daily use.
- **Antigravity real-host doctor (published package via npx)**: CLI 1.1.13 detected (floor met), Desktop IDE 1.16.5 detected and honestly HELD as unsupported, missing-credential message precise, key never printed, state-dir DACL verified.
- **OpenClaw host-contract verification**: local host 2026.3.1 is stale (no `plugins inspect`, no `mcp` command). Verified against openclaw@2026.7.1-2 package source (npm pack): `plugins.command("inspect").alias("info")` with `--runtime --json` EXISTS; `mcp add` EXISTS; `allowConversationAccess` is a real config key. Displayed commands are correct on the validated host.
- **UI (Phase 7, production)**: authenticated as canary account; 26 cards render in installCatalogGrid; OpenClaw detail shows 3 routes with native recommended; copy affordances present; app-mode renders correctly.
- **Cleanup (Phase 10)**: A default project memory purged (terminal); B default project purged (terminal); default-project deletion correctly refused (`default_project_protected` — by design); cert-project purge → delete fenced correctly (`lifecycle_conflict` while purging — correct), final delete running (finish_delete.mjs bp7l7ahrx); both accounts logout-all. Account shells remain (no self-serve erasure — documented residue, consistent with prior campaigns).

## Failures found → fixes made

1. **OC-VERSION-GAP (fixed)**: Get Started OpenClaw card never stated the OpenClaw version its commands need; a customer on an older CLI (e.g. 2026.3.1) hits `unknown command 'inspect'` / no `mcp` command with no hint. Fix: card hint now carries "Validated on OpenClaw 2026.7.1-2 — older CLIs lack the plugins inspect and mcp commands these steps use, so update OpenClaw first." + contract test pinning it (get_started.spec.js). Docs page already carried the validated-version claim; UI/docs now consistent. Both contract suites green (83 tests).

(No other product defects found: registries, artifact contents, snippets, protocol shapes, SDK contracts, idempotency, isolation, revocation all verified correct.)

## In progress

- Release gate: fresh full suite on final tree (b4ltnr5jx); cert-project final delete (bp7l7ahrx).

## Next action

1. On suite green: commit (public/index.html + test + checkpoint), push, `wrangler deploy` (dry-run already clean), record Worker version.
2. Post-deploy: verify hint text live + one more UI spot check; confirm cert project 404/410 terminal.
3. Write final route-by-route certification report + 10 verdicts; update LATER_PHASE_BACKLOG (absorb items 3 partially + 11 evidence); save memory.
