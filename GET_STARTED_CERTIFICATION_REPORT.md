# Get Started integration certification — final report

Date: 2026-08-19 · Campaign: complete certification of every Get Started setup route.
Baseline: commit `affa39b` · Final tree: this commit · Production: https://itsuki.app

Proof levels: **RH** real-host verified · **P** protocol verified (real upstream client library against production) · **CB** configuration/build verified · **H** held. A route's row lists the strongest proof attained *this campaign*; "pub. campaign" marks real-host proof carried from that package's publication campaign on this machine (2026-08-15/16), not re-run today.

## Verdict: **GO** (with the explicit HOLD list below)

All 38 routes accounted for; every attainable proof completed; 1 defect found and fixed (OC-VERSION-GAP); final suite green; production canaries passed; cleanup verified.

## Route-by-route results

Static/unit/build, clean-install, and cleanup columns were green for every row unless noted; they are omitted for width. "Canary" = disposable-account production save→settle→recall→isolation→cleanup battery (23/23 + F 4/4 PASS).

| # | Product · route | Proof | Key evidence | Result |
|---|---|---|---|---|
| 1 | Claude · MCP | P | path-token /mcp initialize+whoami (C1–C2); host UI steps account-gated | **PASS** (external UI enrollment H) |
| 2 | ChatGPT · MCP | P | same door; UI honestly requires Business/Enterprise workspace | **PASS** (external UI enrollment H) |
| 3 | Claude Code · Plugin | RH | SessionStart hook run live against production w/ canary key; fail-closed containment verified; full flow per enterprise A0–A12 + daily use | **PASS** |
| 4 | Codex · Plugin | CB (RH pub. campaign) | plugin manifest tests green; hooks.json parses; marketplace source intact; Codex host not installed today | **PASS** |
| 5 | Cursor · MCP | P/CB | deeplink base64 config parse-verified; mcp.json parses; MCP door proven; Cursor host not installed | **PASS** |
| 6 | OpenCode · Native | CB + suite (RH pub. campaign) | opencode-itsuki 0.1.0 = repo byte-identical; 122 tests green; opencode.json parses | **PASS** |
| 7 | OpenCode · MCP | P | path-token door proven; config parses | **PASS** |
| 8 | Antigravity · Native CLI | **RH** | published npx doctor on this machine: CLI 1.1.13 floor met, Desktop IDE detected + honestly HELD, no key leakage, DACL verified | **PASS** (capture stays held pending transcript contract — as displayed) |
| 9 | Antigravity · MCP | P | path-token door; mcp_config.json parses; plaintext-credential caveat displayed | **PASS** |
| 10 | OpenClaw · Native | CB vs 2026.7.1-2 source (RH pub. campaign) | 151 tests green; artifact byte-identical; `plugins inspect --runtime --json` + `allowConversationAccess` confirmed in validated host source; **fix: version floor now displayed** | **PASS** |
| 11 | OpenClaw · Guided prompt | CB | prompt contract tests; ingest door + limits live-verified; `mcp add` confirmed on validated host | **PASS** |
| 12 | OpenClaw · Manual MCP | CB/P | `openclaw mcp add` verb confirmed (2026.7.1-2); MCP door + /v1/ingest live-proven | **PASS** |
| 13 | Hermes · Native provider | CB + suite | hermes-itsuki 0.1.0 published, byte-identical; 10-file suite green incl. verbatim host-contract stubs; Hermes host unavailable | **PASS** (real-host leg H until a Hermes install is available) |
| 14 | Hermes · MCP | P/CB | YAML shape verified; path-token door proven | **PASS** |
| 15 | Pi · Native extension | CB + suite (RH pub. campaign) | pi-itsuki 0.1.0 byte-identical; 150 tests green; env-only key contract pinned | **PASS** |
| 16 | Pi · REST | RH-equivalent | piPrompt's exact curl sequence = battery A (status/save/recall live PASS) | **PASS** |
| 17 | LangChain/LangGraph · MCP | **P** | langchain-mcp-adapters, exact snippet, 8 tools live | **PASS** |
| 18 | CrewAI · MCP | **P** | crewai-tools[mcp] MCPServerAdapter, exact snippet, 8 tools | **PASS** |
| 19 | AutoGen · MCP | **P** | autogen-ext StreamableHttpServerParams, 8 tools | **PASS** |
| 20 | Agno · Native toolkit | CB + suite | agno-itsuki 0.1.1 byte-identical; toolkit tests (tenancy-weighted) green on real agno | **PASS** |
| 21 | Agno · MCP | **P** | agno MCPTools streamable-http, 8 tools | **PASS** |
| 22 | OpenAI Agents · MCP | **P** | MCPServerStreamableHttp, 8 tools | **PASS** |
| 23 | Google ADK · Native | **RH** | adk-itsuki 0.1.0 on real google-adk 2.7.1: 42 tests + exact wire snippet constructs App/Runner/plugin | **PASS** |
| 24 | LlamaIndex · Native memory | CB + suite | llama-index-memory-itsuki 0.1.1 byte-identical; tests green on real llama-index | **PASS** |
| 25 | LlamaIndex · MCP | **P** | BasicMCPClient with path token (no headers — as documented), 8 tools | **PASS** |
| 26 | CAMEL · Native storage | CB + suite | camel-itsuki 0.1.1 byte-identical; tests green on real camel | **PASS** |
| 27 | Mastra · Native processors | CB + suite | mastra-itsuki 0.1.0 byte-identical; 42 tests green | **PASS** |
| 28 | Mastra · MCP | **P** | @mastra/mcp 1.16.0, exact snippet incl. `listTools()` (confirmed real method), 8 tools | **PASS** |
| 29 | Vercel AI · Native middleware | CB + suite | ai-sdk-itsuki 0.1.0 byte-identical; 135 tests green | **PASS** |
| 30 | Vercel AI · MCP | **P** | @ai-sdk/mcp 2.0.33 createMCPClient http transport, 8 tools | **PASS** |
| 31 | n8n · Native node | CB + suite (RH pub. campaign) | n8n-nodes-itsuki 0.1.0 byte-identical; 40 tests green; self-hosted-only claim intact | **PASS** |
| 32 | n8n · HTTP | RH-equivalent | node config = exact /v1/save//v1/recall battery, live PASS | **PASS** |
| 33 | n8n · MCP | P | MCP Client Tool config = header-bearer door, live-proven (B1–B6) | **PASS** |
| 34 | Dify · MCP | P | header-bearer door proven; Dify workspace UI account-gated | **PASS** (external UI enrollment H) |
| 35 | Convex · SDK | RH-equivalent | `memory.add(content,{userId})` exact Convex-snippet shape live against production | **PASS** |
| 36 | Python SDK · SDK | **RH** | pip itsuki 0.3.0 clean env; exact snippets; live save→settle→recall + turn | **PASS** |
| 37 | TypeScript SDK · SDK | **RH** | npm itsuki 0.2.1 clean env; exact snippets; live round trip + turn | **PASS** |
| 38 | REST API · cURL | **RH** | exact curlAdd/curlSearch shapes live; idempotency + conflict + isolation batteries | **PASS** |

## The ten verdicts

1. **Catalog completeness — PASS.** 26 cards / 38 routes derived from installCatalog()/installMethods(); graph equality holds and is pinned by contract test (every leaf reachable exactly once, every route resolves to steps). Exclusions intact: Zapier absent, chatdev-itsuki unpublished + absent, Antigravity Desktop/IDE and n8n Cloud not promoted.
2. **Setup-instruction correctness — PASS after 1 fix.** Every displayed command/config executed or parse-verified; one defect (OpenClaw version floor missing from UI) found and fixed with a pinning test. All JSON/YAML/curl bodies parse; no placeholders, no dead commands on validated hosts, no install verb for any unpublished package.
3. **Package/publication correctness — PASS.** All 14 referenced artifacts published; all byte-identical to the repo tree (8 npm tarballs, 6 PyPI wheels); versions match repo exactly.
4. **Protocol correctness — PASS.** MCP initialize/tools/call over header-bearer and path-token doors; 8 tools advertised; oversize/invalid inputs previously gated by suite; 8 real upstream client libraries each retrieved all tools using the exact displayed snippet shapes.
5. **Real-host correctness — PASS with honest holds.** Fresh real-host proof today: Claude Code hooks, Antigravity doctor (incl. Desktop hold behaving as displayed), Google ADK 2.7.1. Carried real-host proof (publication campaigns, this machine): OpenClaw, OpenCode, Pi, Codex, n8n. Unavailable hosts (Hermes install, Cursor app, account-gated Claude/ChatGPT/Dify UIs) stay at protocol/config level and their rows say so.
6. **Save/extraction/recall correctness — PASS.** Direct + conversation saves settle (no stuck extraction observed; recall within ≤8 polls); recall returns the exact canary; receipts in /v1/requests.
7. **Cross-door correctness — PASS.** Same-key replay stable (same source packet), same-key/different-payload → 409, 3-way concurrent same-key clean, turn+save distinct identities preserved, concurrent two-door delivery clean.
8. **Security and tenant isolation — PASS.** Cross-account recall isolated; subtenant (userId) isolation holds; forged x-itsuki-project → 403/404; revoked key → 401; whoami never echoes the key; hook containment refuses undocumented data dirs; no canary or key in any log/output captured this campaign.
9. **UX/accessibility — PASS.** 26 cards render live; route pickers with recommended-first; copy affordances gated on key existence (contract-tested); a11y/tablist/aria assertions in suite; Fustat + theme + mobile behavior covered by the green UI suites.
10. **Production deployment and cleanup — PASS.** Deploy details below; canary projects purged (terminal), cert project permanently deleted via the lifecycle door (fences observed working: default-project protection, purge-before-delete conflict); sessions revoked; two content-free account shells remain (no self-serve account erasure — same documented residue class as prior campaigns; removable via admin route).

## Held (explicit, non-blocking)

- **Antigravity Desktop/IDE**: unsupported, displayed as such; doctor actively holds it. (Backlog item 5.)
- **n8n Cloud**: self-hosted-only claim intact pending n8n verification. (Backlog item 6.)
- **ChatDev**: unpublished on both registries; zero catalog presence. (Backlog item 7.)
- **Hermes real-host leg**: package + stub-host contract green; a live Hermes ≥0.19.0 install wasn't available this session.
- **Account-gated external UIs** (Claude connectors, ChatGPT workspace apps, Dify workspace): protocol-level proven; in-product enrollment requires human-held accounts.

## Deployment record

- Fresh full-suite release run on final tree: 147 files / 1,907 tests green (see checkpoint).
- Change shipped: OpenClaw version-floor hint (public/index.html) + pinning test. No migrations. No binding changes.
- Wrangler dry-run: clean. Deploy + version id: recorded in the checkpoint after deploy.
- Rollback: Worker-only change; a rollback restores the prior hint text with no data-plane coupling.

## Disposable-resource ledger (final)

Created: 2 accounts, 3 projects (1 explicit + 2 defaults), 3 keys (1 revoked mid-test as a test), ~15 canary saves (GSCERT-* markers), MCP sessions. Removed: all memory purged to terminal on every project; cert project permanently deleted; keys gone with project deletion / revocation; sessions revoked via logout-all. Remaining: two zero-content account shells + their empty default projects (deletion refused by design — root memory identity), disposable creds live only in the session scratchpad.
