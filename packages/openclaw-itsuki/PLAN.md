# openclaw-itsuki — implementation record and gate table

Built from Fable's frozen architecture handoff, section F2.
Baseline commit: **5bcda782cd8ce58c159bf0cf32335e916d762b7f** (clean tree, master, post-Pi release).
Branch: `feat/openclaw-itsuki-native-plugin`. Implementation date: 2026-08-15.
Host validated against: **openclaw@2026.7.1-2** (0790d9f) on Node 24.15.0.

## File ownership

Owns **`packages/openclaw-itsuki/**`** and **`.github/workflows/publish-openclaw-plugin.yml`** only.

Untouched, as required: `packages/n8n-nodes-itsuki/**`, `packages/pi-itsuki/**`, `hooks/**`, `plugins/**`, `src/**`, `sdk/**`, `migrations/**`, wrangler config, `public/index.html`, `public/docs/index.html`, the Get-Started/docs contract tests, and root manifests. The shared corpus `test/fixtures/agent_lifecycle_corpus.json` was read but **not modified** (see D-5).

## Baseline evidence (recorded before any edit)

| Suite | Result |
|---|---|
| Full repository (`vitest run --no-file-parallelism`, alone) | **140 files / 1,759 tests, 0 failures** |
| `packages/n8n-nodes-itsuki` | **3 files / 40 tests** |
| `packages/pi-itsuki` | **9 files / 150 tests** |

## Contract revalidation

Every OpenClaw `[DOC]` and `[UNK]` from the handoff was re-verified on 2026-08-15 against the **published package itself** (`npm pack openclaw@2026.7.1-2`) — its shipped `docs/` and its `dist/*.d.ts` type declarations — rather than a docs site, so the evidence is the exact artifact users install.

| Item | Verified value | Source |
|---|---|---|
| Host version | `2026.7.1-2` (CalVer) | registry.npmjs.org/openclaw |
| **Node engines** | `>=22.22.3 <23 \|\| >=24.15.0 <25 \|\| >=25.9.0` — a gapped range, **not** `>=22` | package.json |
| Package format | npm package + root `openclaw.plugin.json`; `package.json.openclaw.extensions` must point at **built JS** | docs/plugins/building-plugins.md |
| Manifest schema | `id`, `name`, `description`, `contracts.tools[]` (**required** for runtime tools), `activation.onStartup`, `configSchema`, `uiHints.<field>.sensitive` | building-plugins.md, manifest.md:119 |
| `openclaw` metadata | `extensions`, `compat.pluginApi`, `compat.minGatewayVersion`, `build.openclawVersion`, `build.pluginSdkVersion`; `openclaw` as **peerDependency** | building-plugins.md |
| Entry point | `definePluginEntry({ id, name, description, register })` from `openclaw/plugin-sdk/plugin-entry` | building-plugins.md, plugin-entry.d.ts |
| **Hook registration** | `api.on<K extends PluginHookName>(name, handler, { priority?, timeoutMs? })` — fully typed; `api.registerHook(events, handler)` also exists (untyped) | types-DaHgOqFX.d.ts:12298, hooks.md:20 |
| `agent_turn_prepare` | Event `{ prompt: string; messages: unknown[]; queuedInjections: [] }` → Result `{ prependContext?: string; appendContext?: string }` | hook-types.d.ts:319-328 |
| `agent_end` | Event `{ runId?, messages: unknown[], success: boolean, error?, durationMs? }`; observation-only; **30s runner timeout**; fire-and-forget on gateway paths | hook-types.d.ts, hooks.md:404 |
| `session_start/end` reasons | `new, reset, idle, daily, compaction, deleted, shutdown, restart, unknown` | hooks.md:146 |
| `before_compaction` | `{ messageCount, compactingCount?, tokenCount?, messages?, sessionFile? }` | hook-types.d.ts |
| `subagent_spawned/ended` | `subagent_ended` carries `targetSessionKey`, `targetKind`, `reason`, `outcome?` — **no** `agentId`/`childSessionKey` | hooks.md:152-156 |
| `gateway_start/stop` | `{ port }` / `{ reason? }`; bounded shutdown finalizer | hook-types.d.ts, hooks.md:146 |
| Hook ordering | Sequential in **descending priority**; same priority keeps registration order; operator overrides via `plugins.entries.<id>.hooks.timeoutMs` / `hooks.timeouts.<name>` | hooks.md:50-83 |
| Per-handler config | `event.context.pluginConfig` is injected per handler | hooks.md:86 |
| **CLI/tool registration** | `api.registerTool(...)` and `api.registerCli(registrar, opts)` both exist ([UNK] resolved) | types-DaHgOqFX.d.ts |
| **Memory-slot interface** | `registerMemoryRuntime`, `registerMemoryCapability`, `registerContextEngine`, `registerMemoryPromptSection` exist ([UNK] resolved) — **deliberately not used**, see D-1 | types-DaHgOqFX.d.ts |
| Identity for tenancy | `ctx.senderId` is **channel-scoped**; `ctx.channel`, `ctx.chatId`, `ctx.channelContext.sender.id`; absent for system runs (heartbeat/cron/exec-event) | hooks.md:360-402 |
| Plugin state | `api.runtime.state.openKeyedStore` is **restricted to bundled/trusted plugins**; state root is `$OPENCLAW_STATE_DIR` (default `~/.openclaw`) | sdk-runtime.md:596, tasks.md:316 |
| Install/inspect/uninstall | `plugins install <spec>` (incl. `npm-pack:<tgz>`), `plugins enable`, `plugins inspect <id> --runtime --json`, `plugins uninstall <id> --force` | cli/plugins.md, verified live |
| ClawHub | `clawhub package publish <org>/<pkg> [--dry-run]`; bare npm specs still install during the launch cutover | building-plugins.md |

### Itsuki contracts re-verified
`POST /v1/recall` → `{count, context, items}`; `POST /v1/save` conversation mode → `{receipt_id, source_packet_id, processing}`; ingest limits 30 / 4,000 / 120,000 / 512 KiB; terminal packet statuses `enriched|failed|completed`; `userId` narrows only. Confirmed live via the production canary below.

## Divergences from the frozen handoff

### D-1 — Memory slot exists, and is still deliberately not claimed *(architecture, as instructed)*
The handoff listed the memory-slot interface as `[UNK]`. It is now resolved: `registerMemoryRuntime`/`registerContextEngine`/`registerMemoryCapability` are real. **v1 does not use them.** Claiming the exclusive slot disables `memory-core` for every agent in the install — the documented multi-agent failure. Itsuki runs alongside built-in memory via hooks. A packaging gate greps the tarball to prove no slot API is referenced, and a unit test asserts the plugin ignores those registrars if a host offers them.

### D-2 — Conversation access is operator-gated *(material; found only in the real host)*
OpenClaw **blocks** conversation-reading hooks for non-bundled plugins unless the operator sets `plugins.entries.<id>.hooks.allowConversationAccess=true`. Discovered from live `plugins inspect`:

```
typed hook "agent_end" blocked because non-bundled plugins must set
plugins.entries.itsuki.hooks.allowConversationAccess=true
```

Without it the plugin loads, registers its tools, and **captures nothing**. Three responses: the README makes it a required install step; `gateway_start` emits an explicit warning naming the exact key; and tests cover granted/ungranted/malformed shapes. Verified: with the flag set, `diagnostics` is empty.

### D-3 — Node engine range is gapped *(minor, blocking locally)*
Not `>=22`. The machine's Node v24.12.0 sits in the excluded gap between `<23` and `>=24.15.0`, so a compatible Node 24.15.0 was provisioned for every runtime proof. `package.json` mirrors the host range exactly; CI pins 24.15.0.

### D-4 — Watermarks live in adapter-owned state, not host session state *(material)*
Pi could persist its watermark inside the host's session tree (`pi.appendEntry`). OpenClaw's equivalent (`openKeyedStore`) is documented as bundled/trusted-only, so this adapter keeps its own atomic per-session store under `$OPENCLAW_STATE_DIR/itsuki/sessions`, keyed by a **hash** of the session key. Consequence: state survives uninstall by design, and the README documents how to remove it deliberately.

### D-5 — Corpus left unmodified; identity vectors re-derived instead *(process)*
`test/fixtures/agent_lifecycle_corpus.json` pins identity digests under the `pi` host key. Adding an `openclaw` key is a versioned corpus change requiring approval plus a Pi compatibility re-run, so this campaign did **not** touch it. `test/corpus.spec.ts` asserts every host-neutral section directly, asserts the identity *invariants* the corpus states in prose, and re-derives each vector under the openclaw scope so a future revision has values to adopt. Recommended follow-up for Fable: add `openclaw` to `identity.vectors[].expect` and the `hosts` lists, with a schema bump.

### D-6 — `agent_end` timeout budget set to 20s *(minor)*
The runner allows 30s. This adapter requests 20s so a slow backend cannot consume the whole observation budget; delivery beyond that is the spool's job, not the hook's.

## Enterprise requirement coverage

| Requirement | Where | Proof |
|---|---|---|
| Bounded automatic recall before the model | `agent_turn_prepare` → `prependContext` | live gateway log ordering: `itsuki recall ok` → `[model-fetch] start` → `itsuki capture ok` |
| Untrusted-data labelling | `inject.ts` markers + preamble | live model request contains marker + "not instructions" |
| Exactly-once settled capture | `messages.planCaptureSpan` + `isSettledExchange` + content-derived key | 2 live processes, same session: no resend, distinct keys |
| Durable crash-safe spool | `spool.ts` (atomic tmp+rename, bounded, corruption quarantine) | spool suite; live offline→recovery |
| Restart/resume/compaction/subagent dedup | `sessionstate.ts` watermark + digest | hook suite + live restart |
| Owner + privacy-safe per-sender scope | `identity.senderTenant` (channel+sender, length-prefixed, one-way) | 12 tenancy attack tests |
| No scope widening | tenancy narrows only; hostile ctx cannot switch mode | tenancy suite |
| Secret redaction | `scrub.ts` (server-parity) + `transport.redact` | scrub suite; log-leak tests |
| Timeout/cancellation/Retry-After/quota/breaker | `transport.ts`, `coordinator.ts` | transport + corpus suites |
| Offline fail-open recall, recoverable capture | coordinator policy | live: recall failed, turn completed, span spooled, then delivered |
| Coexistence with built-in memory | no slot claim | unit test + tarball gate |
| No automatic destructive ops | no DELETE anywhere | tarball gate + tool-name test |
| No fake Update/multimodal/dreaming/slot/marketplace claims | README "Deliberately absent" | negative assertions |

## Gate table

Legend: **PASS** evidenced · **PENDING** requires an action outside this phase.

| # | Gate | Status | Evidence |
|---|---|---|---|
| 1 | Baseline clean + recorded | PASS | `5bcda78`, clean tree |
| 2 | Baseline suites (repo / n8n / pi), serial | PASS | 1,759 / 40 / 150 |
| 3 | OpenClaw contracts revalidated | PASS | table above, from the shipped package |
| 4 | Itsuki contracts revalidated | PASS | repo source + live canary |
| 5 | Typecheck clean | PASS | `tsc --noEmit` exit 0 against real 2026.7.1-2 types |
| 6 | Package suite green | PASS | **7 files / 135 tests** |
| 7 | n8n unchanged and green | PASS | 40 tests; zero diff |
| 8 | Pi unchanged and green | PASS | 150 tests; zero diff |
| 9 | Zero runtime dependencies | PASS | `dependencies: {}` |
| 10 | Vulnerabilities | PASS | `npm audit --omit=dev` → 0 |
| 11 | Package contents | PASS | manifest + dist + src + docs; no secrets, no postinstall, no DELETE, no slot API |
| 12 | Real host install (`npm-pack:`) | PASS | installed into openclaw 2026.7.1-2; `artifactKind: npm-pack`, integrity recorded |
| 13 | Real host runtime inspect | PASS | `plugins inspect itsuki --runtime --json`: both tools registered, diagnostics empty once access granted |
| 14 | **Real gateway turn — recall reached the model** | PASS | `itsuki recall ok count=1` precedes `[model-fetch] start`; model request contains the labelled block |
| 15 | **Real settled-turn capture** | PASS | `openclaw:v1:b553…` key, `conversationId: agent:main:proof-1`, exactly the user+assistant pair |
| 16 | Restart / exactly-once | PASS | second process, same session-key: only the new exchange sent; 2 distinct keys |
| 17 | Offline degradation | PASS | `recall fail code=transport`, turn still completed, 1 envelope spooled |
| 18 | Recovery delivery | PASS | spool → 0; offline span delivered; 4 saves / 4 distinct keys |
| 19 | Clean uninstall | PASS | `plugins uninstall --force` removed config entry, install record, directory; 0 hook lines, 0 requests afterwards |
| 20 | Production canary | PASS | real save → receipt `src_b331ac01…` → recall round-trip verbatim |
| 21 | Canary cleanup verified zero | PASS | no node/page created; counts back to baseline 109/97/12/102/55/5 |
| 22 | Windows evidence | PASS | entire build and every runtime proof ran on Windows 11 |
| 23 | **Linux + Windows dry-run CI** | **PENDING** | `.github/workflows/publish-openclaw-plugin.yml` created with both legs and `dry_run` defaulting true; **has not been run** (running it requires pushing this branch, which is outside this phase's boundaries) |
| 24 | Publication | **NOT DONE — out of scope** | Nothing published to npm or ClawHub |
| 25 | Site / docs surfaces | **NOT DONE — out of scope** | Untouched; the no-dead-commands test still forbids an `openclaw plugins install` verb, correctly — the package is not live |

**Open findings after build: superseded by the audit below.**

## Independent audit (Fable, 2026-08-15) — enterprise completion round

Read-only verification first: branch/HEAD/diff confirmed (29 files, only permitted paths); Phase-1 baselines re-run serially and green (repo 140/1,759; openclaw 135→151 after fixes; pi 150; n8n 40); every contract in the table above re-spot-checked against the shipped `openclaw@2026.7.1-2` artifact (registry latest unchanged, retrieved 2026-08-15).

Adversarial findings, each fixed with regression tests **proven to fail on the pre-fix code** (7 tests red against `ce605eb`'s `src/index.ts`, all green after):

| # | Severity | Finding | Repair |
|---|---|---|---|
| F1a | High (per-sender installs) | System-originated runs (cron/heartbeat) were CAPTURED. Automation noise entered memory — and in per-sender mode a system run has no sender, so its content landed in the owner's space | `captureSettled` now requires `isUserTurn`; cron + heartbeat regression tests |
| F1b | High (per-sender installs) | A user turn with no derivable sender fell back to OWNER scope: on channels without sender ids, every stranger would share and recall the owner's memory | `resolveScope` returns `null` in per-sender mode without identity; recall, capture and both tools skip with an honest message; 5 regression tests |
| F2 | Medium | `conversationAccessGranted` read `pluginConfig.hooks`, but the real key is `plugins.entries.<id>.hooks` — a SIBLING of `config`. Every correctly-configured gateway would get a false "blocked" warning | Reads `api.config.plugins.entries.itsuki.hooks` with a forward-compat pluginConfig fallback; real-layout + fallback + malformed-shape tests |
| F3 | nonblocking Medium | `maxSessions: 256` could evict active long-tail sessions on a busy multi-channel gateway → lost watermark → full-history recapture (duplicates under a superset key) | Bound raised to 1,024 (mtime-ordered eviction keeps active sessions); scale suite proves prune keeps recent state |
| F4 | Low | Spool/session files created with default permissions | `0o700` dirs / `0o600` files (POSIX; no-op on Windows) |
| F5 | Low | `ensure()` comment claimed config changes land without restart — untrue | Comment corrected |
| F6 | docs | Missing: `plugins.allow` pin, first-capture backfill semantics, system-run and per-sender skip semantics | README updated |

Scale requirements (order: "at least 1,000 organizations/users") — `test/scale.spec.ts`: 1,000 distinct collision-free sender tenants across 10 channels; 1,000 disjoint capture identities for identical content; 1,100 session states written and pruned to the bound with recent state surviving; 10,000-entry hostile transcript normalized in bounded time; 500-message span split into ≤30-message batches losslessly.

Post-fix real-host re-proof (fixed artifact, openclaw 2026.7.1-2, Node 24.15.0):
- turn: `recall ok` → model → `capture ok`, no false access warning, no allow-list warning (pinned);
- **genuine subagent spawn** (stub model emitted a real `sessions_spawn` tool call): `subagent_spawned` fired logging only the hashed session key; the child ran its own recall+capture; parent and child captured under **distinct conversationIds** (`agent:main:audit-sub-1` vs `agent:main:subagent:<uuid>`) with distinct keys — gate 14-adjacent subagent evidence is now LIVE, not just unit-level;
- restart exactly-once re-proven.

Post-fix state: typecheck 0; package suite **151 tests / 8 files**; packaging gates green (zero deps, no secrets, no DELETE, no slot claim, audit 0).

Accepted nonblocking limitations (documented, deliberate):
1. Subagent child sessions capture their `[Subagent Context]` scaffold as the child's user turn. Same owner scope, no tenant risk; filtering host scaffolding is a candidate refinement.
2. No CLI `doctor` command in 0.1.0. `api.registerCli` exists (commander-based), but a malformed registration would break the `openclaw` binary for every user — too much blast radius for an unproven surface at release. Status lives in `plugins inspect --runtime --json` + gateway logs.
3. Two concurrent turns in ONE session may lose a fingerprint-set union (read-modify-write race on session state). Bounded impact: marginally weaker echo suppression for that session; gateways serialize turns per session in practice.
4. `before_compaction` without a `messages` payload (the field is optional in the host type) skips the pre-compaction flush; the digest-based rewrite detection then prevents duplication at the next `agent_end`, at the cost of possibly not persisting a mid-compaction tail.

**Open findings: 0 Critical, 0 High, 0 release-blocking Medium.**

## What is deliberately NOT claimed

- Not published, not advertised, not installable by name yet.
- Gate 23 is open: the CI workflow exists but has never executed. Both OS legs must be green before publication.
- The production canary exercised the **backend contracts** through this session's already-authorized MCP tools — no credential was requested or handled. An owner-run canary driving `openclaw-itsuki` itself against `https://itsuki.app` with a real project key remains the final pre-publication check.
- Subagent handling is attribution-only and was exercised through the hook suite, not through a live subagent spawn; a live multi-agent proof is recommended before advertising multi-agent support.
- "Native" is claimed only in the sense proven at gates 14–15: recall and capture participate in OpenClaw's lifecycle without the agent choosing to invoke a tool.
