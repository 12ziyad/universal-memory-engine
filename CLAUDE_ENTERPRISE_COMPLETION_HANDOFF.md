# ITSUKI — ENTERPRISE PLAYGROUND, SETTINGS, PROJECT LIFECYCLE, AND CONNECTOR COMPLETION HANDOFF

**Cold-start execution prompt for Claude Code**

**Repository:** `C:\Users\ziyad\uml`

**Prepared:** 2026-08-13 (Asia/Calcutta)
**Scope:** complete the product-management and onboarding stages that follow the finished Memory V3 campaign. Do not reopen or retune Memory V3.

> Paste this entire file into a new Claude Code task. It is intentionally self-contained. The new task must still verify all mutable facts—Git state, deployment, migrations, credentials, current CLI behavior, and production health—before changing anything.

---

## 0. Role, objective, and execution authority

You are the lead engineer completing Itsuki's enterprise product layer. The memory-quality architecture is already built, benchmarked, secured, activated as a low-volume public beta, and terminally documented. Your job is **not** to invent Memory V4, rerun LoCoMo, or redesign the proven memory core.

Complete these remaining product stages in order:

1. **Playground memory-policy enforcement:** make “remember only …” and “never remember …” reliable, inspectable, replay-stable, and scoped only to the selected managed project and Playground chat.
2. **Enterprise Settings:** extraction configuration, categories, retention, organization profile, members, roles, and invitations.
3. **Complete managed-project lifecycle:** archive/restore/delete safeguards, ownership transfer, quotas, and audit history.
4. **Fresh-user production onboarding acceptance:** clean Claude Code and Codex install, configure, trust, connect, capture, recall, failure/recovery, and cleanup.
5. **Final product polish:** WCAG 2.2 AA accessibility, mobile/responsive behavior, and measured performance.

For each stage use:

```text
VERIFY CURRENT STATE
→ WRITE FAILING TESTS
→ IMPLEMENT THE SMALLEST COHERENT COMPONENT
→ RUN LOCAL/INTEGRATION/SECURITY GATES
→ COMMIT ONLY OWN CHANGES
→ PUSH AND VERIFY ORIGIN
→ MIGRATE SAFELY IF NEEDED
→ DEPLOY THE EXACT COMMIT
→ VERIFY DEPLOYMENT ID AND PROPAGATION
→ RUN SCOPED PRODUCTION PROOF
→ CLEAN SYNTHETIC DATA
→ CHECKPOINT
→ NEXT STAGE
```

Do not pause for routine progress reports. Stop only for a genuine credential/login/2FA action, a spend or safety guard, a failed production migration, an irreversible decision not defined here, or an unsafe production condition. Never publish packages or marketplace releases without separate owner approval.

### Non-negotiable safety constraints

- Preserve tenant, managed-project, nested memory-scope, erasure, replay, durability, provenance, rules, and secret-scrubbing guarantees.
- All schema changes are additive. Never edit an applied migration. Never perform an unattended destructive schema repair.
- Before every production migration: verify the full chain, run locally, run migration regressions, capture exact before-schema, record the currently supported D1 Time Travel bookmark, hash the migration, and write a durable ledger. This database contains FTS5 virtual tables; do not claim a conventional SQL-export rollback.
- If a production migration fails, stop with `PRODUCTION MIGRATION FAILURE — HUMAN REVIEW REQUIRED` and include migration, failure, recovery bookmark, schema state, and safe next action.
- Keep changes behind an appropriate default-safe feature flag/allowlist until each stage earns production activation. Do not overload the Memory V3 flag with unrelated product rollout state.
- Use only direct first-party Cloudflare Workers AI where inference is truly required. No AI Gateway, partner model, third-party API, or silent fallback. Ordinary deterministic engineering should not invoke inference.
- Do not expose keys. Credential diagnostics may report only `LOADED`, `MISSING`, or a typed rejected/unavailable state without the value.
- Never use benchmark references, LoCoMo answers, or benchmark-specific behavior in product logic. No new benchmark is authorized by this handoff.
- Preserve the user-owned dirty `AGENTS.md`; do not edit, stage, revert, or commit it.

---

## 1. Mandatory cold-start verification and read order

Before editing, independently verify rather than assuming this snapshot still holds.

### 1.1 Read repository instructions and current source

Read:

- `C:\Users\ziyad\uml\AGENTS.md`
- `C:\Users\ziyad\uml\wrangler.jsonc`
- `C:\Users\ziyad\uml\package.json`
- `C:\Users\ziyad\uml\public\index.html`
- `C:\Users\ziyad\uml\src\index.js`
- `C:\Users\ziyad\uml\src\lib\managed_projects.js`
- `C:\Users\ziyad\uml\src\pipeline\playground.js`
- `C:\Users\ziyad\uml\src\pipeline\playground_settings.js`
- `C:\Users\ziyad\uml\src\pipeline\rules.js`
- source acceptance, episode, extraction, gate, retrieval, cleanup, export, webhook, auth, and vector code touched by the proposed work
- all relevant migrations, especially `0011_memory_rules.sql`, `0018_playground_threads.sql`, `0030_deletion_barriers.sql`, `0033_source_episodes.sql`, `0035`–`0037`, and `0038_managed_projects.sql`
- all related tests before changing a contract

Read both plugin implementations and their public onboarding:

- `C:\Users\ziyad\uml\.claude-plugin\plugin.json`
- `C:\Users\ziyad\uml\.claude-plugin\marketplace.json`
- `C:\Users\ziyad\uml\hooks\`
- `C:\Users\ziyad\uml\commands\doctor.md`
- `C:\Users\ziyad\uml\plugins\itsuki\.codex-plugin\plugin.json`
- `C:\Users\ziyad\uml\plugins\itsuki\.mcp.json`
- `C:\Users\ziyad\uml\plugins\itsuki\hooks\`
- `C:\Users\ziyad\uml\plugins\itsuki\README.md`
- `C:\Users\ziyad\uml\public\docs\index.html`
- `C:\Users\ziyad\uml\sdk\js\`
- `C:\Users\ziyad\uml\sdk\python\`

For Cloudflare or Codex implementation work, retrieve current official documentation first. The repository explicitly requires current Cloudflare docs because platform APIs and limits can change. For Codex installation/plugin behavior, use current official OpenAI/Codex documentation and the installed CLI's own help; do not assume old commands remain valid.

### 1.2 Read terminal Memory V3 evidence

The durable V3 root is:

`C:\Users\ziyad\uml\tmp\itsuki-memory-v3-implementation-20260809\`

At minimum read:

- `V3_FINAL_REPORT.md`
- `V3_ARCHITECTURE.md`
- `V3_DECISION_LOG.md`
- `V3_DEFECTS.md`
- `V3_ABLATIONS.md`
- `V3_BENCHMARK_REPORT.md`
- `V3_HOLDOUT_REPORT.md`
- `V3_SECURITY_REPORT.md`
- `V3_MIGRATION_LEDGER.md`
- `V3_COST_LEDGER.json`
- `V3_CLEANUP_LEDGER.md`
- `V3_PUBLIC_BETA_ACTIVATION.md`
- `checkpoint.md`

Some append-only evidence files retain earlier provisional language such as “NEXT” or pre-judge conditional verdicts. The **terminal sections of `V3_FINAL_REPORT.md`, `V3_BENCHMARK_REPORT.md`, and `V3_ABLATIONS.md` supersede those historical lines**. Never erase the history; interpret it chronologically.

Read the managed-project production ledger:

`C:\Users\ziyad\uml\tmp\production-migrations\0038-managed-projects\migration-ledger.md`

### 1.3 Reverify mutable state

Record:

- `HEAD`, `origin/master`, branch, clean/dirty tree, and owner changes;
- latest Worker deployment/version and 100% traffic target;
- canonical and legacy `/health` status;
- complete D1 migration chain and pending migrations;
- production feature modes without private identifiers;
- related local processes;
- current Worker, host/plugin/unit, JS SDK, and Python SDK gates relevant to changed code;
- current Claude Code and Codex versions before relying on plugin commands.

As verified while this handoff was written:

| Item | Verified snapshot |
|---|---|
| Branch | `master` |
| `HEAD` / `origin/master` | `697abfc9f9ac23b0402ab8d795557708616a6174` / same |
| Worktree | only pre-existing user-owned `AGENTS.md` modified |
| Latest deployment | deployment `9f01b558-12dd-4b0c-b406-aaccb45da466` |
| Worker version at 100% | `4ef519b9-b595-4978-8cdb-9b16674e53d7` |
| Health | HTTP 200 at `https://itsuki.app/health` and legacy workers.dev health |
| D1 | migrations through `0038_managed_projects.sql` applied; none pending |
| 0038 recovery bookmark | `00000cc0-00000000-000050c5-5ff527923a93da28d8afe7e0b9bb434b` |
| 0038 SHA-256 | `c1041760f5c4ffa36cac79dc55437d33a4ace1c2049acd4a2c99862d13c6ec9e` |
| V3 production mode | ON for all accounts as owner-authorized low-volume beta |
| Accepted V3 lanes | atomic capture ON, atomic projection ON, hybrid retrieval ON, exact source expansion ON |
| Rejected lanes | extraction B1 OFF, atomic coalescing OFF, episode fallback OFF, adaptive context OFF; tested reranker rejected |
| Benchmark/judge process | none running; do not start one |

This is a snapshot, not permission to skip verification.

---

## 2. What is already complete — do not rebuild it

### 2.1 Memory V3 terminal architecture

The accepted product pipeline is:

```text
authenticated, scope-bound source
→ validation and supported source-time contract
→ rules admission and secret scrubbing
→ acceptance-atomic scrubbed source packet + source episodes
→ deterministic Unicode-safe splitting and bounded model input
→ source-grounded zero-to-many atomic capture
→ deterministic temporal representation
→ governed typed/cardinality-aware projection into the existing graph
→ exact + lexical + vector + entity + temporal + graph candidate lanes
→ bounded assertion-level RRF/MMR fusion at retrieval depth 200
→ exact provenance source expansion (E9A)
→ de-duplicated hard-bounded context (24,000 chars / about 6,000 tokens)
→ GPT-OSS-120B reader in the benchmark/evaluation reader path
```

Important architectural facts:

- Scrubbed episodes are the recoverability/provenance/erasure layer. They are **not** an unscrubbed shadow archive.
- Episodes are not vector-indexed. E9B episode fallback was measured and rejected; do not turn it on casually.
- The existing graph remains valuable, especially for multi-hop retrieval. It was not replaced with a flat memory store.
- E7 assertion-level hybrid retrieval and E9A exact source expansion are accepted.
- The tested BGE reranker, extraction B1 behavior, destructive coalescing, episode fallback, and adaptive per-object context caps are rejected and remain off.
- The historical fixed eight-item funnel is gone from the winning read path; final context remains bounded, not unlimited.
- D03 fixed event-date persistence. D04 fixed valid dates being dropped during context assembly. The lesson is permanent: trace every boundary for silent information loss.

### 2.2 Terminal benchmark and holdout evidence

These numbers are final and must be reported exactly if context is needed. They are not a request for another run.

| Metric | Historical V1 | Final V3 | Change |
|---|---:|---:|---:|
| Official LoCoMo token-F1 | 15.40% | **36.08%** | +20.68pp |
| LLM-judge | 25.65% (395/1540) | **60.45%** (931/1540) | +34.80pp |
| Evidence availability | 28.83% | **73.77%** (1136/1540) | +44.94pp |
| Correct given evidence | 61.04% | **71.13%** (808/1136) | +10.09pp |
| Correct without reference evidence | 11.31% | **30.45%** (123/404) | +19.14pp |
| Temporal token-F1 | 6.81% | **33.63%** | +26.82pp |
| Temporal judge | 6.23% | **55.14%** (177/321) | +48.91pp |

The causal progression that led to the final system was:

| Milestone | Judge | Token-F1 | Evidence availability | Conditional accuracy |
|---|---:|---:|---:|---:|
| Historical V1 full | 25.65% | 15.40% | 28.83% | 61.04% |
| D03 + D04 full | 27.92% | not separately recorded in the terminal comparison | 30.45% | 59.91% |
| E1 depth-200 + E0 GPT-OSS-120B full | 46.75% | 27.45% | 65.97% | 58.27% |
| E7 frozen 399 confirmation | 54.64% | 28.95% | 68.67% | 64.60% |
| Final V3 full | **60.45%** | **36.08%** | **73.77%** | **71.13%** |

The E7 row is a frozen 399-question confirmation and must not be presented as a full-dataset score. Historically, 64.6% of misses had been attributed to facts not stored, which correctly motivated capture work; that old classification must not be substituted for the final measured loss funnel below. D04 also proved that a small context-rendering defect can be disproportionately expensive: fixing lost date fields produced the large temporal jump even though overall availability moved modestly. Future product work must continue to audit every persistence, selection, and rendering boundary rather than assuming all misses are “retrieval.”

Final category judge scores:

- single-hop: **62.90%**;
- multi-hop: **67.73%**;
- temporal: **55.14%**;
- open-domain: **35.42%**.

Final general non-LoCoMo holdout across three fresh seeds:

- mean judge **95.24%**;
- token-F1 **69.60%**;
- evidence availability **96.83%**;
- conditional accuracy **96.71%**;
- capture recall **78.18%**;
- capture precision **96.59%**.

Final evidence funnel and operating measurements:

- source stored: **94.61%**;
- semantic candidate available: **85.32%**;
- selected before render: **75.65%**;
- rendered: **70.91%**;
- final context evidence: **73.77%**;
- loss classes: 83 source-not-stored, 226 capture misses, 332 stored-but-not-retrieved, 73 assembly losses, and 44 exact-source recoveries;
- mean context: 77.06 items, 14,268 characters, about 3,567 tokens;
- p95 context: 121 items, 21,094 characters, about 5,274 tokens;
- duplicate rendered-line rate: zero;
- recall server mean/p95: 274/481 ms;
- recall client mean/p95: 797/1361 ms;
- reader mean/p95: 4.75/11.01 seconds;
- ingest request mean/p95: 558 ms/1.54 seconds;
- asynchronous extraction settlement mean/p95: 73.4/149.1 seconds.

Campaign inference settled at **2,444,870 / 3,000,000 neurons**, approximately **$26.89**, using direct first-party Workers AI. The V3 campaign is terminal; do not consume its remaining reserve as if this work were another V3 experiment.

### 2.3 E0–E10 scientific record

Preserve the numbering and decisions:

| Cell | Terminal result |
|---|---|
| E0 reader | complete; stronger reader earned adoption in the evaluated read path |
| E1 retrieval depth | complete; depth 200 materially increased evidence availability |
| early reranking / E8 | all four valid arms rejected; do not use corrupted earlier trials |
| E2-B0 | keep correctness/security/instrumentation repairs |
| E2-B1 | reject the tested behavior-changing extraction treatment |
| E3 source episodes | keep |
| E4 atomic source-grounded capture | keep |
| E5 temporal representation | keep |
| E6 governed projection | keep; destructive E6M coalescing rejected |
| E7 assertion-level hybrid retrieval/fusion | keep |
| E8 tested reranker | all reject |
| E9A exact provenance source expansion | keep |
| E9B episode FTS fallback | reject |
| E10 adaptive per-object caps | reject |
| final Stage E | complete, judged, scored, secured, cleaned, and reported |

### 2.4 Security and reliability core

Terminal V3 verdicts are PASS for architecture, security, durability, erasure, tenant isolation, and project isolation. Open CRITICAL/HIGH/MEDIUM defects are 0/0/0. Preserve:

- tenant, sub-tenant, project, rules, and deletion predicates inside every lane;
- no cross-scope FTS/vector/reranker/source expansion;
- secret scrub before durable source evidence;
- source/provenance conservation;
- replay idempotence and no resurrection after confirmed deletion;
- deletion barriers and late-write handling;
- bounded retries, terminal dead-letter outcomes, no infinite poison loops;
- privacy-safe observability with no raw model output or private user content in routine logs.

### 2.5 Managed-project Stage 1

Commit `697abfc` and migration 0038 already provide the core security boundary. Do not replace it with a cosmetic `project_id` filter.

Current model:

```text
account user id
  ├─ deterministic default managed project
  │    └─ memory owner = historical account user id (no data rewrite)
  └─ non-default managed project
       └─ immutable derived memory owner id (`mem_...`)
```

The derived memory owner is the hard storage/index namespace. A managed project already partitions:

- nodes, slices, events, edges, pages, candidates, and governed atomic state;
- source packets, source episodes, source FTS, and Vectorize namespace;
- rules and Playground threads/messages;
- API/MCP keys;
- requests, receipts, jobs, queues, exports, webhooks, and deliveries;
- recall, graph, operator rollup, and account erasure.

New credentials are immutably bound to one selected managed project. Historical `connection_tokens.project_id IS NULL` credentials are permanently interpreted as default-project credentials; NULL never means “caller may select any project.” A hostile `x-itsuki-project` mismatch returns 403. A foreign project id is not exposed as an authorization oracle.

The nested source/repository `memoryScope.projectId` from migration 0028 is provenance below the managed-project boundary. It is **not** the enterprise project security boundary. Do not conflate the two.

Current managed-project limits and UI:

- maximum 50 active projects per owner;
- name max 80 characters; description max 500;
- one active default project;
- project selector in the top app header;
- create, list, select, rename, and description edit implemented;
- project switch aborts stale requests, increments an epoch, clears project-bound UI state, and blocks unsafe switches during in-flight create/send/export/webhook/secret states.

Verified release gates for Stage 1 were Worker 1351/1351, host/plugin/unit 539/539 plus one intentional skip, Python SDK 99/99, and npm audit with zero vulnerabilities. Re-run only affected gates plus the full required release gate after changes.

What is **not** complete: organization/team ownership, role-based access, invitations, archive/restore UI/API, safe project deletion, ownership transfer, project quotas, and durable project audit history.

### 2.6 UI foundation already complete

Do not replace the app with a framework or imitate Mem0 pixel-for-pixel. The current single-file product shell is intentionally compact and already received a design pass.

Typography:

- all ordinary product UI uses self-hosted **Fustat** variable font, weights 200–800, under SIL OFL 1.1;
- code, keys, URLs, receipts, and machine identifiers use self-hosted **Geist Mono**, with JetBrains Mono fallback;
- no font CDN or third-party font request;
- body: 14px / 1.55;
- page title: 28px, weight 600, line-height 1.18, letter spacing -0.025em;
- section title: 16px, weight 600;
- normal help/body: 13.5px / 1.55;
- hints: 12.5px / 1.6;
- code: 13px / 1.5.

Layout and spacing:

- desktop rail: 240px;
- normal content max: 1180px;
- wide content max: 1460px;
- responsive horizontal gutter: `clamp(24px, 3vw, 52px)`;
- view padding: 32px top, responsive gutter, 56px bottom;
- page header bottom gap: 32px;
- cards generally use 14px radius, 20–22px padding, 20px grid gap;
- navigation rows use 9px vertical / 11px horizontal padding and 9px radius;
- at <=900px the rail becomes a drawer and content uses 24px 18px 36px;
- visible focus ring uses a two-pixel accent outline with two-pixel offset.

Light theme:

- background `#f3f4f6`;
- panel `#fbfbfc`;
- secondary panel `#eef0f3`;
- text `#17191f`;
- muted text `#5f6672`;
- accent `#5b4fcf`.

Dark theme:

- background `#111216`;
- panel `#17181d`;
- secondary panel `#1e2026`;
- text `#f3f4f6`;
- muted text `#a7adb8`;
- accent `#8b7cf6`.

Light, dark, and system modes are implemented; system follows OS changes. Theme controls currently live in Settings. Preserve Fustat everywhere except code/machine values.

Current project-selector geometry:

- button min/max width 190/280px and min height 36px;
- menu begins 8px below the button, max width 360px, 12px radius, 10px padding;
- create modal max width 560px, 14px radius, 20px padding;
- modal actions are bottom-right with 8px gap.

Current Playground geometry:

- desktop columns: 236px chats/settings, flexible conversation, 320px memories; 16px gap;
- settings-open left column: 380px;
- <=1100px: two columns and Memories moves below;
- <=780px: one column;
- textarea min height 96px;
- current Settings tab has free-text custom instructions, custom categories, an empty Advanced section, Apply, and Reset.

Current Settings is only a responsive card grid (`minmax(280px, 1fr)`, 20px gap) containing Project, Appearance, Account, Security, Connections, Memory Controls, Data & Privacy, Support, Legal, current capture rules, and account-memory reset. It is not yet the requested enterprise settings information architecture.

### 2.7 SDK and plugin foundation already complete

Onboarding UI already has three top methods:

- App Connect: Claude, ChatGPT, Cursor;
- SDK integration: Python, TypeScript, cURL;
- Plugin: Claude Code and Codex.

The obsolete Node.js label was replaced with TypeScript. Current local SDK source versions are JavaScript/TypeScript `itsuki` 0.2.1 and Python `itsuki` 0.2.1. Do not bump or publish automatically.

Claude plugin:

- manifest version 0.7.0;
- requires selected Node 22/24 LTS executable and a masked `itsuki_api_key` user setting;
- canonical MCP server name `itsuki`;
- SessionEnd scrubs and atomically queues locally without network wait;
- SessionStart drains bounded ordered batches, then recalls project memory;
- `/itsuki:doctor` reports install/config/network/outbox/REST/MCP state without printing the key;
- protected outbox is bounded at 128 raw envelopes / 64 MiB / 2 MiB each, with reserved mutation headroom, ordering, quarantine, explicit auth pause, and no silent eviction.

Codex plugin:

- manifest version 0.3.0;
- direct MCP config uses `ITSUKI_API_KEY` and canonical server `itsuki`;
- SessionEnd/SessionStart lifecycle hooks, protected bounded outbox, explicit hook trust, doctor script, auth pause, retry/quarantine, and stable project override are implemented;
- developed against Codex CLI `0.146.0-alpha.9.2`; this is historical evidence, not proof against the current CLI;
- local marketplace discovery/install and untrusted-hook behavior were tested;
- clean-machine/Desktop environment propagation and live production end-to-end acceptance remain unproven.

Canonical install snippets currently shown by the app include:

```text
claude plugin marketplace add 12ziyad/universal-memory-engine
claude plugin install itsuki@itsuki-plugins
```

and:

```text
codex plugin marketplace add 12ziyad/universal-memory-engine
codex plugin add itsuki@itsuki-plugins
```

These commands are historical evidence only. Fresh-user Claude Code/Codex production-install acceptance is outside this completion plan. If that work is revisited separately, verify current CLIs and official docs first. A legacy MCP registration named `uml` may exist for old users; never silently delete it or allow it to create duplicate capture.

---

## 3. Remaining execution sequence

The remaining sequence is intentionally product-led and contains no LoCoMo stage:

```text
Stage 2: Playground policy enforcement
→ Stage 3: Enterprise Settings and RBAC
→ Stage 4: Project lifecycle, ownership, quotas, audit
→ Stage 6: Accessibility, mobile, and performance polish
→ final enterprise-completion report and cleanup
```

Use one durable evidence root for this completion campaign, separate from the immutable V3 evidence—for example:

`tmp/itsuki-enterprise-product-completion-20260813/`

Create at least:

- `checkpoint.md`
- `work-ledger.json`
- `defects.md`
- `decision-log.md`
- `architecture.md`
- `migration-ledger.md`
- `security.md`
- `playground-policy-report.md`
- `settings-rbac-report.md`
- `project-lifecycle-report.md`
- `accessibility-responsive-performance.md`
- `cleanup-ledger.md`
- `hashes.sha256`
- `FINAL_REPORT.md`

Do not delete or rewrite the Memory V3 evidence root.

---

## 4. Stage 2 — reliable Playground “remember / never remember” policy

### 4.1 Current defect and precise scope

The current implementation stores only `customInstructions` and `customCategories` in `playground_threads.settings_json`. It merges those over project/account rules. Free text is sent to the extractor as guidance. A narrow regex also compiles phrases shaped like:

```text
never|do not|don't + save|store|capture|keep|record|remember + [anything about] X
```

into hard deny terms. Exact account-level `includes` and `excludes` are hard gated, but Playground does not expose structured includes/excludes and does not compile “only remember X.” Consequently:

- `Never save anything about politics` can work when the literal term appears;
- `Only remember thesis decisions` is guidance only;
- broader or differently phrased exclusions can be misunderstood;
- custom categories guide extraction but are not a strict admission/classification contract;
- async extraction loads/merges settings but no explicit immutable policy-version identity is attached to each accepted turn;
- deleting a Playground thread deletes transcript rows but does not offer deletion of memories captured from that thread;
- applying a new policy affects future capture only, but the UI does not explain pre-existing memories clearly;
- `retentionDays` exists in the rule model but has no deletion engine.

The requirement is:

> A policy configured in one Playground chat inside one managed project must affect only future memory capture from that chat. It must never weaken account/project rules or secret scrubbing, must not leak to another chat or project, and must be enforceable beyond prompt compliance.

### 4.2 User-visible contract

The UI and API must distinguish four things:

1. **Playground transcript:** the visible chat messages retained so that the chat can continue.
2. **Memory source evidence:** scrubbed, policy-permitted source episodes used for durable memory/provenance.
3. **Semantic memory:** atoms/nodes/slices/events/edges promoted from permitted evidence.
4. **Policy configuration:** the selected chat's rules and their version.

“Never remember cats” means cat content must not survive in memory source episodes, semantic objects, FTS, vectors, graph state, source expansion, memory recall, or memory export. It does **not** silently erase the visible Playground transcript that the user just typed. The UI must say this plainly. Transcript deletion/retention is a separate control. Never claim “nothing is stored” while the transcript row still exists.

“Apply to this chat” means:

- selected managed project only;
- selected Playground thread only;
- future accepted turns only;
- no effect on SDK, REST, MCP, Claude Code, Codex, or another Playground thread;
- no retroactive mutation unless the user separately chooses a reviewed “remove prior memories from this chat” action.

### 4.3 Policy model

Do not try to make arbitrary prose magically enforceable. Build a two-layer model:

**Layer A — structured enforceable policy**

- `captureMode`: `standard`, `only_topics`, or `off`;
- `includeTopics[]` for “only remember” allowlists;
- `excludeTopics[]` for “never remember” denylists;
- `customCategories[]` with stable ids, names, descriptions, and optional color;
- optional capture density using the existing supported values;
- transcript-retention preference if Stage 3 retention is not yet available;
- deny always wins over include;
- global/project mandatory rules and secret policy always win over thread policy;
- a chat policy may narrow its parent project, never loosen it.

**Layer B — free-text extractor guidance**

- remains available for preferences such as “prefer concise architecture decisions”;
- is visibly labelled `Guidance` unless it was successfully compiled into structured rules;
- never receives an “enforced” badge merely because it was inserted into a prompt.

The natural-language compiler must recognize and test common forms:

- “remember only X”;
- “only remember X”;
- “only save/store/capture/extract X”;
- “do not/never remember/save/store/capture X”;
- multiple topics joined by commas, `and`, or `or`;
- quoted phrases;
- Unicode punctuation and apostrophes;
- mixed include and exclude statements.

After parsing, show the result as editable chips before/after save:

```text
Capture: Only these topics
Include: thesis decisions, architecture facts
Exclude: cats, romance
Guidance only: prefer concise wording
```

If prose cannot be compiled safely, do not guess. Preserve it as guidance and show `Not enforceable yet—add topics below`. The user must always be able to add/remove structured include/exclude chips directly. This is how reliability is earned without pretending an LLM prompt is a policy engine.

### 4.4 Enforcement order and invariants

For every Playground turn:

```text
authenticate account session
→ resolve managed project to immutable memory owner
→ resolve thread within that memory owner
→ load project/account policy fail-closed
→ load active chat policy version
→ validate and snapshot the effective policy
→ apply secret scrubbing and mandatory system exclusions
→ apply parent project/account restrictions
→ apply chat include/exclude restrictions
→ persist only policy-permitted source evidence
→ extract/promote/index only permitted evidence
→ attach policy version/hash to source packet, job, receipt, and visible capture status
```

Required invariants:

- An unreadable parent or chat policy store fails closed for memory capture. The conversational reply may still succeed, but UI must say memory capture was blocked.
- A policy change during async extraction cannot alter an already accepted turn. Replay uses the immutable accepted snapshot/hash.
- A retry or late write cannot use newer looser rules.
- A thread from project A cannot be named while project B is selected.
- Denied content cannot enter source episodes and later leak through FTS/source expansion even when semantic extraction obeyed the rule.
- A model cannot override a deny, include allowlist, secret scrub, or scope.
- Empty or malformed policies fail explicitly; no silent reset to defaults.
- Policy changes are idempotent and use optimistic concurrency/version checks so two tabs cannot silently overwrite each other.
- Logs and audit events store policy ids/hashes/outcomes, not private instruction text.

### 4.5 Mixed-message behavior

A message may contain both allowed and denied facts, for example:

```text
I love cats, and my thesis now uses Postgres logical replication.
```

with `only thesis` or `never cats`.

Do not persist the full raw sentence as a searchable episode and then merely suppress the cat atom. Choose and document one safe implementation:

- deterministically segment into bounded source spans, persist only permitted spans with original message/offset provenance and explicit redaction markers; or
- when a safe permitted span cannot be established, omit that message from memory entirely and show `Not captured because it mixed excluded content`.

The visible transcript may retain the original message under its separate transcript policy. Memory/source export must not include the denied span. Never use an LLM-only classification as the sole privacy boundary. If semantic policy matching is added, use it as a conservative additional gate around deterministic structured terms and fail closed on uncertainty for exclusions.

### 4.6 Additive persistence design

Reverify the schema first, then use the next unused migration number. A defensible minimal design is:

- immutable `playground_policy_versions` rows keyed by id and thread, containing normalized policy JSON, SHA-256 hash, version number, creator account id, managed-project/memory-owner binding, and timestamps;
- `playground_threads.active_policy_version_id` additive column;
- source packet or a dedicated policy-binding table containing `policy_version_id` and `policy_hash` for every accepted Playground turn;
- optional `playground_messages.policy_version_id` and typed `memory_capture_status` for honest UI;
- no duplicate private prose in audit events;
- every new row included in thread/project/account erasure.

It is acceptable to use existing `raw_meta_json` for a version id/hash if that remains replay-stable and testable, but do not hide the only authoritative policy snapshot in ephemeral job payloads. Keep the current `settings_json` readable for backward compatibility and migrate lazily; never rewrite all historical threads unattended.

### 4.7 Playground UI specification

Preserve the existing three-column shell and Fustat design. Improve the left Settings panel rather than making a new top-level page.

Desktop, settings open:

- left panel remains 380px;
- conversation remains flexible with a minimum usable width;
- memory panel remains 320px;
- 16px column gaps;
- settings panel internal padding 16px;
- section spacing 20px;
- labels 13.5px/600; helper text 12.5px; fields 14px;
- sticky action bar at the bottom of the settings panel with a subtle top border;
- primary `Apply to this chat` button at bottom-right of that panel;
- secondary `Reset draft` beside it;
- destructive/retroactive actions are not placed beside Apply.

Panel content, top to bottom:

1. Scope banner: project name + chat name + `This chat only` badge.
2. Capture mode segmented control: `Standard`, `Only selected topics`, `Off`.
3. `Remember only` topic-chip field, shown/required for allowlist mode.
4. `Never remember` topic-chip field.
5. Free-text `Extraction guidance` textarea, explicitly labelled as guidance.
6. `Interpreted policy` preview showing enforced includes/excludes and unparsed guidance.
7. Custom categories editor.
8. Collapsible Advanced: density and transcript/memory distinction; no empty placeholder.
9. Saved/dirty/version state and sticky actions.

The existing long explanatory paragraph claiming all natural language is enforced must be replaced with precise copy. Use concise copy such as:

```text
Topic rules are enforced before memory is stored. Other instructions guide extraction.
This applies only to future turns in this chat.
```

After Apply, show:

- `Saved to <project> / <chat>`;
- policy version/time;
- no optimistic success before the server commit;
- fields preserved on failure;
- conflict UI if another tab updated the policy.

For each sent message, the capture receipt should show one of:

- `Captured N memories`;
- `Processing`;
- `Not captured — outside this chat's remember-only topics`;
- `Not captured — excluded by this chat`;
- `Not captured — blocked by project policy`;
- `Not captured — secret/sensitive value removed`;
- `Memory capture unavailable; your chat reply still completed`;
- `Failed terminally; source handling status available in History`.

At <=1100px retain the current two-column arrangement and move Memories below. At <=780px use one column with explicit `Chats`, `Conversation`, and `Memories` sections; do not rely on horizontal overflow.

### 4.8 Thread deletion and retroactive cleanup

Replace the ambiguous single delete action with a reviewed modal:

- `Delete chat transcript only`;
- `Delete chat and memories captured from it`.

The second option must run a source-bound preview, show object counts without private content, require explicit confirmation, install a deletion barrier, cancel/retire pending work, delete episodes/FTS/vectors/semantic state/provenance/candidates/indexes, prevent late resurrection, and verify zero recall/export. It must not delete memories from another thread/project merely because text is similar.

Policy changes are not retroactive. If the user adds `never cats` after cat memory exists, offer a separate `Review prior memories from this chat` action; never silently delete data on Apply.

### 4.9 Stage 2 tests and production proof

Write failing tests first. Cover at minimum:

**Compiler/unit**

- every phrase form above;
- Unicode/apostrophes/case/spacing;
- exact include/exclude precedence;
- generic unsafe phrases;
- empty, malformed, huge, duplicate, and conflicting policies;
- deterministic normalized JSON and SHA-256 hash;
- unknown guidance clearly uncompiled.

**Pipeline/storage**

- `only thesis` captures a thesis fact and rejects a cat fact from the same and separate messages;
- `never love`, `never cats`, custom categories, and capture off;
- denial survives a model proposal that explicitly tries to write it;
- zero denied text in episodes, source FTS, semantic atoms, nodes, slices, events, edges, vectors, provenance expansion, memory export, and recall;
- transcript remains visible only according to transcript policy;
- account/project deny cannot be loosened by chat includes;
- policy snapshot remains stable across delayed extraction, retry, replay, crash, and policy edits;
- late write after chat+memory delete cannot resurrect;
- thread A vs B, project A vs B, account A vs B, and nested user/subtenant A vs B;
- concurrent Apply from two tabs returns a conflict, not last-write-wins silence;
- project switch during load/save cannot render or submit the previous project's policy;
- all new tables/columns participate in project/account erasure.

**UI/accessibility**

- keyboard-only chip editing, tabs, Apply, modal, and confirmation;
- focus trap/return, labels, live-region save/error status;
- no color-only enforcement state;
- narrow desktop/mobile layouts;
- dirty form survives API failure and project-switch block.

**Production canary**

Use one dedicated synthetic account/project and unique canaries. Apply policies, send allowed/denied/mixed turns, wait for terminal jobs, prove every storage/search/export layer, switch project/thread, test retry/replay/delete, and clean to zero. Never use the owner's real memory. Record only redacted ids/hashes and `LOADED/MISSING` credential state.

Stage 2 is complete only when the UI promise exactly matches hard storage behavior. A prompt-only improvement is a FAIL.

---

## 5. Stage 3 — full enterprise Settings, organization, members, roles, invitations

### 5.1 Goal and design principle

Replace the current collection of settings cards with a coherent settings workspace while preserving the visual foundation. Settings must make scope obvious:

- **Personal:** appearance, profile, sessions/password.
- **Organization:** organization profile and organization members.
- **Selected project:** general details, extraction, categories, retention, project members, integrations, audit, and danger controls.

Every server mutation must authorize against the target organization/project. Hiding a control in the browser is not authorization. A selected-project header is not trusted when a project-bound credential already determines the scope.

### 5.2 Information architecture and exact layout

Use one `Settings` top-level rail entry. Inside the page, add a secondary settings layout instead of adding many top-level rail items.

Desktop (>980px):

- page content max 1180px;
- secondary navigation column 216px;
- main settings column `minmax(0, 1fr)`, preferred max 860–920px;
- 32px gap between secondary nav and main content;
- page title at top-left and the effective scope (`Organization / Project`) below it;
- context-sensitive primary action at the top-right only where a page-level action exists (`Invite member`, `Create category`);
- ordinary Save button at the bottom-right of each form section or a sticky save bar when a form is long;
- destructive actions only in the last `Danger zone` section.

Secondary navigation:

```text
PROJECT
  General
  Memory extraction
  Categories
  Retention
  Members
  Integrations
  Audit history

ORGANIZATION
  General
  Members & invitations

PERSONAL
  Profile & security
  Appearance
```

Use 12px uppercase group labels with restrained letter spacing, 36px minimum nav rows, 9px radius, and the existing accent-tinted active state. Keep section headings 16px/600 and normal text 13.5px. Use 16px vertical field gaps, 24px between logical groups, and 32px between page sections. Fields should not stretch beyond about 680px when extra width hurts readability. Tables may use the full main-column width.

At <=980px, replace the persistent settings nav with a labelled select or horizontally scrollable accessible tab list above the content. At <=640px, forms become one column, tables become stacked labelled rows, and sticky action bars must not cover fields or system navigation.

Do not clone Mem0's labels or layout blindly. Preserve Itsuki's purple accent, Fustat, calm dim light theme, dark theme, and existing shell spacing.

### 5.3 Project → General

Show:

- project name;
- description;
- immutable project id with copy button in Geist Mono;
- default/non-default badge;
- lifecycle status;
- created/updated time;
- organization owner;
- current user's role;
- usage summary against quota;
- `Save changes` bottom-right;
- links to Archive/Transfer/Delete in the bottom Danger zone according to permission.

The existing rename/description API may be reused but must gain RBAC, optimistic concurrency, audit, and archived-state behavior. Do not change memory-owner identity when renaming.

### 5.4 Project → Memory extraction

Use the existing `memory_rules` capabilities instead of creating a competing rules engine. Present structured controls:

- capture enabled / disabled where supported;
- default capture mode (`auto` vs graph-only/whole-chat page behavior) with human copy;
- capture density (`standard` vs `dense`) with consequences;
- auto-collect on supported `/v1/turn` flow;
- `Only remember` structured topics (`includes`);
- `Never remember` structured topics (`excludes`, always wins);
- free-text extraction guidance with honest “guidance” label;
- category assignment behavior;
- current effective policy summary;
- last changed by/time/version;
- `Test with sample` dry-run that returns proposed allow/deny/category outcomes without writing memory;
- no user-selectable extraction model until model choice is a supported, versioned product contract.

Project policy is stored under the managed project's immutable memory owner. A per-key policy may further narrow it; a request/chat policy may further narrow it. Define and show precedence:

```text
system safety + secret scrub
  > organization mandatory policy (if implemented)
  > project memory policy
  > credential policy
  > request / Playground-chat narrowing policy
```

Lower layers may never weaken higher-layer deny rules. The current general `mergeRuleOverride()` replacement semantics were designed for SDK profiles; enterprise policy composition must not accidentally allow a child to replace a parent's deny list. Implement a separate explicit narrowing composition function where needed, and prove it.

Every rules save needs a version or ETag. A stale tab receives 409 with current metadata and preserves the user's draft.

### 5.5 Project → Categories

The current custom categories are JSON embedded in `memory_rules`. Enterprise category management needs stable identity and lifecycle while remaining backward compatible.

Each project category should have:

- immutable id;
- normalized unique slug within project;
- display name;
- description;
- optional accessible color token from a bounded palette;
- active/archived status;
- created/updated by/time;
- optional usage count;
- no arbitrary executable prompt/template content.

UI:

- page-level `Create category` top-right;
- searchable table/list with name, description, usage, status, and overflow actions;
- create/edit side panel or modal max 560px;
- archive instead of destructive delete when in use;
- deleting an unused category requires confirmation;
- deleting/inactivating an in-use category requires explicit reassignment or `Uncategorized` fallback preview;
- built-in categories are read-only and visually identified;
- custom category names/slugs are sanitized and bounded.

Migration strategy:

- add a normalized project-category table;
- leave historical `custom_categories_json` readable;
- lazily materialize or dual-read during rollout;
- feature-flag writes until parity and rollback are proven;
- never silently reinterpret existing category text.

Category enforcement must reach both legacy and atomic capture/projection paths consistently. A category is classification metadata, not a permission boundary; never use it as a substitute for include/exclude policy.

### 5.6 Project → Retention

The existing `retention_days` column is currently configuration only; repository search found no deletion scheduler consuming it. Do not present it as active retention until the lifecycle is implemented and proven.

Define separate retention classes because one number cannot safely govern all data:

- Playground transcripts;
- scrubbed source episodes/source FTS;
- semantic current/historical memory;
- completed export blobs;
- webhook delivery records/payloads;
- operational receipts/jobs;
- security/audit events.

Defaults must preserve current behavior. No existing data may begin expiring simply because the UI shipped. Suggested UI choices may include `Keep until deleted`, 30, 90, 180, or 365 days, plus bounded custom values where safe. The actual supported choices must follow product/legal requirements, not a copied competitor default.

Retention engine requirements:

- policy version and effective date;
- dry-run preview/count before shortening a policy;
- explicit confirmation for a policy that will delete existing data;
- scheduled bounded batches with checkpoints;
- deletion barrier before asynchronous convergence;
- tenant/project predicates in every statement/index call;
- convergence across episodes, FTS, vectors, semantic state, graph, provenance, candidate/projection rows, source expansion, transcript rows where selected, and exports;
- concurrent extraction/delete/late commit/retry tests;
- no resurrection;
- content-free audit event for policy change and each retention run;
- operator-visible progress/failure/retry without private content;
- restore of the policy does not resurrect deleted data;
- archived projects remain subject to their explicit retention contract.

Do not automatically delete security audit records under a user memory-retention setting. Audit retention must be separately defined and privacy-reviewed.

### 5.7 Organization → General

Introduce an organization ownership layer additively. Existing accounts must continue to work without a migration-time fan-out or forced team setup.

A safe compatibility model is:

- lazily create one personal organization for each existing account when organization APIs are first used;
- existing managed projects initially belong to that personal organization;
- keep immutable memory-owner ids unchanged;
- organization name, optional description, and stable id;
- organization owner cannot be removed until ownership transfer completes;
- organization deletion is a separate future/destructive workflow and should not be added casually if not required for this stage.

Fields:

- organization name;
- description;
- immutable organization id;
- owner;
- created time;
- default project or project count;
- member count and plan/quota summary if available.

Do not collect unnecessary company data. Do not put billing controls in this stage unless billing exists as a real backend contract.

### 5.8 Members, roles, and invitations

Use a small, explicit role model. Recommended split:

**Organization roles**

- `owner`: all organization/project administration, ownership transfer;
- `admin`: organization profile, members/invitations, project creation and administration, except owner-only actions;
- `member`: no implicit access to every project; receives project roles explicitly.

**Project roles**

- `admin`: project settings, members, keys/integrations, archive/restore, data operations; destructive delete/transfer remains owner/org-owner gated;
- `developer`: use memory/API/MCP, manage project-scoped keys and ordinary integrations if policy permits, read operational history; cannot manage members, lifecycle, or retention destruction;
- `viewer`: read dashboard memory/graph/history/audit metadata and export only if explicitly allowed; no writes, keys, policy changes, or destructive actions.

Do not rely on these names alone. Implement a centralized capability matrix and test every endpoint. At minimum distinguish:

| Capability | Org owner | Org admin | Project admin | Developer | Viewer |
|---|---:|---:|---:|---:|---:|
| Edit org profile | Yes | Yes | No | No | No |
| Invite/remove org member | Yes | Yes | No | No | No |
| Create project | Yes | Yes | Policy | No | No |
| Edit project settings | Yes | Yes | Yes | No | No |
| Manage project members | Yes | Yes | Yes | No | No |
| Create/revoke project key | Yes | Yes | Yes | Yes if allowed | No |
| Write/recall memory | Yes | Yes | Yes | Yes | Read only |
| View audit | Yes | Yes | Yes | Scoped operations | Scoped read |
| Archive/restore | Yes | Yes | Yes | No | No |
| Transfer/delete project | Yes | Explicit policy only | No by default | No | No |

Final capabilities may be stricter, but never broader without tests and documentation.

Invitation requirements:

- target organization and optional preselected project roles;
- normalized email and no account enumeration in public responses;
- cryptographically random token stored only as a hash;
- single use;
- explicit expiry (for example seven days, but verify product policy);
- revoke and resend create auditable state transitions;
- accepting as the wrong signed-in email fails safely unless an explicit admin flow supports it;
- rate limits per actor/org/IP;
- duplicate pending invite handling;
- cannot invite beyond quota;
- cannot assign a role the inviter lacks authority to grant;
- removed/suspended users lose session/project access promptly and project credentials they own are reviewed/revoked according to policy;
- email transport must not be faked. If transactional email is not configured, implement a secure copy-once invitation link flow and mark email delivery pending rather than claiming it was sent.

Members UI:

- `Invite member` top-right;
- table with member, organization role, project role, status, joined/last activity where privacy-safe, and overflow actions;
- pending invitations in a separate section with expiry, resend, revoke;
- role selector disabled for unauthorized actors;
- owner row cannot be removed/demoted casually;
- all status/error changes accessible and server-confirmed.

### 5.9 Suggested additive data model

Reverify current schema and choose the smallest coherent set. A likely model includes:

- `organizations`;
- `organization_members`;
- `organization_invitations`;
- additive `managed_projects.organization_id` or a project-organization mapping;
- `project_members`;
- `project_settings_versions` or version fields on existing policy rows;
- `project_categories`;
- `retention_policies` and `retention_runs`;
- `audit_events` (content-free);
- lifecycle/quota tables described in Stage 4.

Every table needs appropriate owner/org/project indexes, bounded text fields, created/updated metadata, and complete account/project erasure semantics. Avoid foreign-key assumptions that D1 or existing data cannot satisfy. Prefer explicit application invariants plus tests where adding a constraint would require a destructive rewrite.

### 5.10 Audit design shared with Stage 4

Audit events must answer who changed what and whether it succeeded without becoming a private-memory archive. Record:

- immutable event id;
- organization and project ids;
- actor account id and actor type;
- action code;
- target type/id;
- before/after **metadata diffs only**, with allowlisted fields;
- outcome/reason code;
- request/correlation id;
- timestamp;
- privacy-safe network/session metadata only if justified and documented.

Never record:

- API keys or invitation tokens;
- full MCP URLs;
- memory/source/transcript text;
- free-form extraction instructions unless a separately protected configuration history requires them;
- raw request bodies;
- secrets scrubbed from user content.

Audit viewing is paginated, time-filtered, action-filtered, project-scoped, and exportable only under explicit permission. It is append-only from ordinary product APIs. Operator repair must be separately privileged and audited.

### 5.11 Stage 3 acceptance tests

At minimum:

- lazy organization bootstrap is idempotent under concurrency;
- historical default/non-default project data and keys remain unchanged;
- every role/capability/API combination, including forged headers and ids;
- membership removal, role downgrade, invitation expiry/replay/revoke/race;
- two organizations, same project/member names, no cross-scope discovery;
- project policy cannot weaken parent denies;
- category CRUD, collision, in-use archive/reassignment, erasure;
- retention dry-run, execute, retry, concurrent late write, no resurrection, all storage lanes;
- stale settings ETag/version conflict;
- audit completeness and secret/content absence;
- session UI and APIs refresh authorization immediately after role change;
- project switch flushes settings caches/drafts and stale responses;
- mobile and keyboard operation of the new settings navigation/tables/modals;
- full prior managed-project isolation suite remains green.

Stage 3 is not complete if Settings is only a visual mock. Every visible control must have a server-authoritative, isolated, audited, tested behavior—or be clearly disabled as unavailable.

---

## 6. Stage 4 — complete managed-project lifecycle

### 6.1 Core rule: preserve the immutable memory namespace

The current non-default memory namespace is derived from account owner + project id at runtime, even though `managed_projects.memory_owner_user_id` is stored. **Do not implement ownership transfer by simply changing `owner_user_id`.** That would make the resolver derive a different namespace and orphan or cross-wire data.

Before transfer:

1. make `memory_owner_user_id` an immutable authoritative value returned by project lookup;
2. verify every project resolution path uses the stored value for non-default projects;
3. prove it matches current derived values for every existing project;
4. prohibit mutation of that field through ordinary APIs;
5. add regressions proving rename, organization assignment, owner transfer, archive, and restore do not change it.

The default project maps directly to the historical account user id and should not be transferable like a normal non-default project. Keep it owner-bound unless a separately designed migration proves safety.

### 6.2 Lifecycle state machine

Migration 0038 constrains `status` to `active|archived`. Do not rewrite that table to expand the CHECK. Add a compatible lifecycle column/table if more states are needed.

Recommended state machine:

```text
ACTIVE
  → ARCHIVED
  → ACTIVE (restore)

ACTIVE or ARCHIVED
  → DELETE_PENDING
  → DELETING
  → DELETED_TOMBSTONE

DELETE_PENDING
  → prior state (cancel, only before destructive convergence begins)
```

Keep `managed_projects.status` active/archived for compatibility and use an additive lifecycle record/column for deletion state.

### 6.3 Archive and restore

Archive behavior must be explicit:

- available for non-default projects to authorized roles;
- confirmation modal names project and describes effect;
- immediately blocks new writes, key creation, webhooks, Playground sends, and background enrichment;
- project-bound credentials return a typed `project_archived`, not generic auth failure;
- ordinary recall may be disabled; administrative read-only metadata/export access may remain through a dedicated authorized route;
- pending jobs are settled/cancelled safely according to the acceptance contract, never silently lost;
- selector hides archived projects by default but offers `Show archived`;
- archived project page has `Restore` and permitted export/delete controls;
- restore re-enables access without changing memory namespace or credentials unless security policy revoked them;
- archive/restore is audited and idempotent;
- project quota and retention remain observable.

Decide credential behavior before implementation: retaining but disabling keys during archive is usually safer than revoking irreversibly. The API must make the distinction visible.

The default project cannot be archived unless the product first supports a safe default-project handoff. The simplest safe v1 contract is `default project cannot be archived or deleted`.

### 6.4 Safe project deletion

Deletion is a convergent workflow, not one SQL statement.

UI flow:

1. Danger zone at the bottom of Project → General.
2. `Delete project…` opens a modal showing project name, immutable id, lifecycle state, member/key counts, pending job count, and privacy-safe object inventory.
3. Explain that project keys stop immediately and memory cannot be recovered through the product after confirmed deletion.
4. Require typing the exact project name and a second explicit confirmation.
5. Optionally require recent reauthentication for owner-level destructive actions.
6. Start a server-side deletion workflow and show progress; never claim completion on enqueue.

Server workflow:

- authorize owner-level capability and re-resolve project;
- atomically mark delete-pending and install a project-wide deletion barrier before accepting more work;
- disable/revoke project credentials, webhooks, invitations, and scheduled actions;
- prevent new UI/API/MCP/SDK writes and make retries return a stable terminal reason;
- cancel/retire queued/extracting work and handle a late commit with the established erasure fence;
- delete Playground messages/threads/policies according to the confirmed option;
- delete episodes, source FTS rows, atomic candidates/runs/projections, graph state, pages, staged/suppressed data, receipts/jobs where policy allows, exports, webhook deliveries, rules/categories/settings, project memberships, and every other project-derived row;
- delete the Vectorize namespace and prove query zero;
- preserve only a minimal content-free deletion tombstone/audit record required to prevent replay/resurrection and document outcome;
- repeatedly reconcile until D1, FTS, Vectorize, recall, source expansion, export, and operator live-state counts are zero;
- mark complete only after convergence;
- ensure account deletion can still handle archived/deleting/tombstoned projects idempotently.

Because D1 Time Travel is an operator recovery mechanism, not an end-user per-project undo feature, do not promise the user a rollback that does not exist. If a cooling period is implemented, cancellation is allowed only before deletion begins and must be unambiguous.

### 6.5 Ownership transfer

Only non-default projects with an immutable stored memory owner are eligible.

Recommended transfer contract:

- destination is an existing organization member in the same organization, or an explicit organization transfer workflow;
- current owner initiates;
- recipient accepts within a bounded expiry, or an organization owner performs an audited administrative transfer under policy;
- project id, memory owner, source identity, indexes, keys, and URLs remain stable;
- roles are recalculated transactionally: recipient becomes owner/admin as defined; prior owner becomes a selected role or is removed only after confirmation;
- transfer cannot proceed during delete, retention purge, export mutation, or unresolved security hold;
- invitations/tokens are hash-only and single-use;
- current owner's account deletion cannot delete a transferred project's immutable memory space;
- destination cannot access before commit, source cannot retain unauthorized access after commit;
- session/project authorization caches invalidate immediately;
- all before/after metadata is audited without content.

If projects are organization-owned rather than user-owned after Stage 3, prefer transferring organization/project governance metadata while leaving the storage namespace immutable. Do not physically rewrite hundreds of memory rows merely to change a display owner.

### 6.6 Quotas and usage

Existing quota: 50 active managed projects per owner. Add project-level quotas only where the system can measure and enforce them consistently.

Track privacy-safe usage such as:

- semantic memory objects;
- scrubbed episode count and bytes;
- Vectorize item count where measurable;
- Playground messages/threads;
- API/MCP keys;
- webhooks;
- pending/running jobs;
- recent request and inference usage;
- export storage;
- members/invitations.

Requirements:

- organization defaults with optional project override;
- hard vs soft limits explicit;
- enforcement server-side before accepting work where possible;
- accepted source is never silently lost because enrichment quota was reached: either reject before durable acceptance or accept to a bounded explicit pending/dead-letter state with remediation;
- idempotent retries do not double-count;
- reservations for asynchronous jobs avoid concurrent oversubscription;
- usage reconciliation can repair drift;
- UI shows current/limit and reset window where applicable;
- warnings at defined thresholds;
- no unbounded query/count on every request;
- archived/deleting project behavior defined;
- quota changes audited.

Do not fabricate plan/billing entitlements. Start with internal product defaults and clearly label them until commercial plans exist.

### 6.7 Lifecycle UI details

Project selector:

- preserve its top-header importance;
- show project status badge when archived/read-only;
- include search, `Create project`, and a separated `Archived projects` section;
- switching project must continue to abort prior requests, clear project-bound state, and fetch new permissions/settings before enabling actions;
- if permissions were revoked, fall back to the default/first authorized project with a clear message;
- never briefly render old project memory under the new project title.

Project General danger zone:

- full main-column width at bottom;
- muted danger background/border tokens from the existing theme;
- separate rows for Archive, Transfer ownership, Delete;
- action button aligned right on desktop and full-width below copy on mobile;
- each row states permission and consequence;
- disabled actions explain why.

Audit page:

- filters in a compact toolbar at top;
- paginated table with Time, Actor, Action, Target, Outcome;
- expandable metadata panel contains allowlisted ids/diffs only;
- Geist Mono for ids/request ids;
- no raw memory content.

Quota card:

- usage bars must include numeric text and not depend on color;
- show “soft warning” vs “hard limit” wording;
- link to the resource page rather than dumping all details in a tooltip.

### 6.8 Lifecycle failure/concurrency/state-machine tests

Exercise:

```text
CREATE → WRITE → ARCHIVE → WRITE/RECALL/EXPORT/KEY attempts → RESTORE
CREATE → INVITE → ROLE CHANGE → KEY CREATE → OWNER TRANSFER
ACTIVE → DELETE_PENDING → CANCEL
ACTIVE → DELETE_PENDING → DELETING → late extraction commit → retry/replay → DELETED
ARCHIVED → DELETE
TRANSFER vs ARCHIVE
TRANSFER vs DELETE
RETENTION vs DELETE
ACCOUNT DELETE vs PROJECT DELETE
ROLE REMOVAL vs in-flight request
PROJECT SWITCH vs stale response/secret/draft/send
```

Prove:

- zero cross-project/account access;
- zero accepted loss outside the explicitly deleted project;
- zero resurrection;
- zero duplicate deletion side effects;
- immutable memory-owner id;
- bounded job/backlog behavior;
- every terminal state can be diagnosed and, where intended, retried;
- audit events complete and content-free;
- all synthetic production rows cleaned.

Stage 4 is complete only when project lifecycle is a server-enforced state machine. Buttons that merely hide a project are not complete.

---

## 8. Stage 6 — accessibility, mobile/responsive, and performance polish

### 8.1 Accessibility standard

Target WCAG 2.2 AA for all authenticated product paths touched by Stages 2–5.

Audit and fix:

- one logical `h1`/page heading and ordered heading hierarchy;
- landmarks and labelled navigation;
- keyboard access to rail, project selector/search, settings nav, chips, tables, menus, dialogs, tabs, Playground composer, graph controls, and code-copy controls;
- visible focus in both themes;
- dialog focus trap, Escape behavior, initial focus, and focus return;
- ARIA names/states for menus, tabs, segmented controls, disclosure widgets, status badges, progress, and live errors;
- no color-only state;
- text and non-text contrast in light/dark/system themes;
- 44px practical touch targets on mobile for primary interactive controls;
- form labels, descriptions, required/error association, and error summary;
- live regions that do not chatter during polling;
- reduced-motion behavior for graph/animation/transitions;
- high zoom (200–400%) without lost controls or two-dimensional page scrolling except intentional tables/code;
- screen-reader reading order after responsive rearrangement;
- accessible table alternatives/stacked rows on mobile;
- copy buttons announce success without moving focus;
- icons are decorative or correctly named, never filename-based.

Use automated tools plus manual keyboard and at least one real screen-reader smoke. Automated zero violations alone is not a PASS.

### 8.2 Responsive acceptance matrix

Test at minimum widths 320, 375, 390, 768, 1024, 1280, 1440, and 1920px, plus landscape mobile where useful.

Required behavior:

- rail becomes an accessible drawer at <=900px;
- top project selector remains discoverable and never clips long names;
- project menu remains inside viewport and searchable;
- create/invite/delete modals fit height, scroll internally, and keep actions visible;
- Playground transitions from 3→2→1 columns without hidden composer, duplicated scrollbars, or memories covering chat;
- Settings secondary navigation changes form without losing selected section;
- member/audit/category tables remain understandable as stacked rows or controlled horizontal regions;
- code blocks scroll internally; the entire page does not;
- sticky action bars account for mobile safe areas and virtual keyboard;
- graph has a usable mobile fallback/list when canvas interaction is impractical;
- light/dark/system theme controls remain keyboard/touch accessible.

Project switching must remain a hard UI data boundary on every viewport. Test slow network while switching rapidly; old project names, rows, memories, settings, or statuses must never flash under the new selection.

### 8.3 Performance goals and measurement

Measure before optimizing. Use current official web performance guidance and record environment/network/device assumptions.

Target public/user-facing Core Web Vitals at p75 where traffic data becomes available:

- LCP <= 2.5 seconds;
- INP <= 200 ms;
- CLS <= 0.1.

For lab/product acceptance also record FCP, TBT, Speed Index, transferred bytes, JS parse/evaluation, long tasks, font timing, and route interaction latency. Do not claim field p75 from a single local run.

Likely product work to evaluate:

- preload only the Fustat/Geist subsets actually needed above the fold;
- preserve `font-display: swap` and prevent font-induced layout shift;
- cache immutable font/assets with fingerprinted URLs;
- avoid loading graph/visualization code until Graph is opened;
- paginate/virtualize large memories, requests, members, audit, category, and project lists;
- debounce search without delaying keyboard feedback;
- cancel obsolete project/route requests using the existing abort/epoch mechanism;
- avoid full app re-render for polling status changes;
- stop polling when no work is in flight or page is hidden;
- bound DOM size and event listeners;
- avoid repeated count-all queries in Settings/quotas;
- add/index only demonstrated hot queries;
- preserve static asset edge serving and Worker route behavior;
- do not trade privacy for client-side caching of sensitive memory.

Performance budgets should fail CI or release checks for material regressions on critical routes:

- first authenticated Overview;
- Get started;
- Playground empty and populated;
- Settings General/Members/Audit;
- project switch;
- Memories and Graph with realistic bounded data.

### 8.4 Stage 6 release proof

Run:

- automated accessibility suite;
- manual keyboard/focus pass in both themes;
- screen-reader smoke;
- responsive screenshot/interaction matrix;
- reduced motion and 200%/400% zoom;
- Lighthouse/DevTools traces or equivalent with saved artifacts;
- slow-network project-switch race;
- realistic large-list render/pagination;
- no-console-error check;
- regression suites affected by UI changes;
- production propagation and real-browser smoke after deployment.

Accessibility and performance work must not weaken CSRF/auth, expose keys in DOM/logs, cache private responses publicly, or bypass project reauthorization.

---

## 9. Cross-stage API, security, and engineering rules

### 9.1 Server is authoritative

- Resolve account session/token first, then organization/project membership and capability.
- Never accept a raw internal memory-owner id from an ordinary client.
- Never let a project-bound key switch project via header/body/query.
- Validate unknown fields and bounded lengths explicitly.
- Use 404 where appropriate to avoid foreign-resource discovery; use 403 for a known bound-credential mismatch.
- Mutations use idempotency or optimistic concurrency where retries/two tabs matter.
- Response errors are typed, stable, and contain no secrets/private content.

### 9.2 Scope propagation checklist

Every new feature must be traced through:

```text
browser session / API token / MCP token
→ managed project resolver
→ organization/project authorization
→ immutable memory owner
→ nested external user/subtenant scope
→ D1 predicates
→ FTS predicates
→ Vectorize namespace
→ Durable Object/job payload
→ webhook/export/receipt/audit metadata
→ deletion and account erasure
```

Add a checklist test for every new table/route rather than relying on reviewer memory.

### 9.3 Secret and privacy battery

Re-run canonical/adversarial secrets through new Playground, settings, invitations, audit, lifecycle, export, and diagnostics:

- AWS keys and temporary prefixes;
- tokens/API keys;
- private keys;
- `.env` text;
- JSON-quoted and labelled secrets;
- connection strings;
- synthetic canaries;
- invitation tokens;
- MCP URLs containing credentials.

No secret may appear in source episodes, semantic memory, FTS/vector, graph, provenance/source expansion, exports, audit, operator UI, logs, toasts, error bodies, or diagnostics where policy requires redaction. Configuration views show only masked status and metadata.

### 9.4 Erasure and replay

Extend existing account/project cleanup manifests whenever a table/index is added. Test:

- delete during extraction;
- late commit;
- retry and replay repair;
- new post-delete write under a valid remaining project;
- membership removal during request;
- archive/delete/retention races;
- plugin outbox delivery after project deletion;
- invitation acceptance after revocation/project deletion;
- export generated before deletion but downloaded after deletion.

After confirmed erasure, live recall, episodes, FTS, vectors, graph, source expansion, export, policy, categories, transcript (when selected), and project-scoped configuration must be zero. Minimal content-free tombstones/audit may remain only under a documented policy.

### 9.5 Migration and deployment discipline

For each milestone:

1. inspect dirty tree and preserve owner files;
2. write failing regression;
3. implement;
4. run focused then full affected gates;
5. run migration locally and snapshot exact schema;
6. record D1 recovery bookmark and migration SHA-256;
7. commit only campaign changes;
8. push without force;
9. verify origin contains exact commit;
10. apply production migration once;
11. if migration succeeds, deploy exact commit;
12. verify deployment and 100% version;
13. wait for propagation;
14. prove old/default-safe behavior and selected rollout behavior;
15. run scoped production attack/acceptance;
16. clean synthetic data and audit processes;
17. update checkpoint and hash manifest.

No migration may be applied merely to support a UI mock. The backing behavior and cleanup path must be ready first.

### 9.6 Feature rollout

Use separate, observable, account/project-bound flags as needed, for example conceptually:

- Playground policy v2;
- organization/RBAC settings;
- project lifecycle.

Follow the repository's established resolver/config pattern. Default safe/off while developing; allowlist synthetic/test accounts; prove no flag bleed; then enable only with recorded owner authorization. Normal Memory V3 mode stays as currently authorized unless a defect requires rollback.

### 9.7 Defect policy

For every real HIGH/CRITICAL:

```text
failing-first reproduction
→ severity and user consequence
→ root cause
→ smallest safe fix
→ exact rerun
→ affected regression/security gates
→ deploy
→ production reattack
→ cleanup
→ close with evidence
```

Do not hide a policy, isolation, deletion, or auth defect as a UI issue. Do not continue downstream with an open HIGH/CRITICAL.

---

## 10. Likely source areas by stage

This is a routing guide, not permission to edit before tracing callers.

### Stage 2

- `public/index.html`
- `src/index.js`
- `src/pipeline/playground.js`
- `src/pipeline/playground_settings.js`
- `src/pipeline/rules.js`
- `src/pipeline/source.js`
- `src/pipeline/episodes.js`
- `src/pipeline/staged_text.js`
- `src/pipeline/extract.js`
- `src/pipeline/gates.js`
- `src/pipeline/mcp_engine.js`
- cleanup/export/erasure manifests
- Playground/rules/managed-project tests
- one new additive migration if policy versioning requires it

### Stage 3

- `public/index.html`
- auth/session routes and `src/index.js`
- new focused organization/RBAC/category/retention libraries rather than inflating one file
- `src/pipeline/rules.js` and retention/cleanup worker paths
- webhook/export/key authorization
- cron reconciliation where retention is implemented
- organization/settings/RBAC/security tests
- additive migrations

### Stage 4

- `src/lib/managed_projects.js`
- auth/token resolution
- cleanup/deletion barriers
- source/semantic/FTS/Vectorize/project inventories
- jobs/DO handoff/reconciliation
- exports/webhooks/Playground/rules/categories/members/audit
- UI project selector/Settings danger zone
- lifecycle/property/state-machine/concurrency tests
- additive migration(s)

### Stage 6

- `public/index.html` and local assets
- dashboard/form-state/UI tests
- browser accessibility/responsive/performance harnesses
- caching/header configuration only after current Cloudflare docs are checked

---

## 11. Required final evidence and report

At terminal completion produce:

- `ENTERPRISE_PRODUCT_FINAL_REPORT.md`
- `PLAYGROUND_POLICY_REPORT.md`
- `ENTERPRISE_SETTINGS_RBAC_REPORT.md`
- `PROJECT_LIFECYCLE_REPORT.md`
- `PLUGIN_FRESH_USER_PRODUCTION_REPORT.md`
- `ACCESSIBILITY_RESPONSIVE_PERFORMANCE_REPORT.md`
- `ENTERPRISE_MIGRATION_LEDGER.md`
- `ENTERPRISE_SECURITY_REPORT.md`
- `ENTERPRISE_DEFECTS.md`
- `ENTERPRISE_CLEANUP_LEDGER.md`
- `ENTERPRISE_HASH_MANIFEST.sha256`
- updated `checkpoint.md`

Final report must state:

```text
ITSUKI ENTERPRISE PRODUCT COMPLETION — FINAL VERDICT

PLAYGROUND POLICY ENFORCEMENT: PASS / CONDITIONAL / FAIL
PROJECT SCOPE: PASS / CONDITIONAL / FAIL
ORGANIZATION/RBAC: PASS / CONDITIONAL / FAIL
RETENTION: PASS / CONDITIONAL / FAIL
PROJECT LIFECYCLE: PASS / CONDITIONAL / FAIL
OWNERSHIP TRANSFER: PASS / CONDITIONAL / FAIL
ERASURE/NO RESURRECTION: PASS / CONDITIONAL / FAIL
CLAUDE CODE FRESH USER: PASS / CONDITIONAL / FAIL
CODEX FRESH USER: PASS / CONDITIONAL / FAIL
ACCESSIBILITY: PASS / CONDITIONAL / FAIL
RESPONSIVE: PASS / CONDITIONAL / FAIL
PERFORMANCE: PASS / CONDITIONAL / FAIL

START COMMIT / END COMMIT:
START WORKER / END WORKER:
MIGRATIONS ADDED:
RECOVERY BOOKMARKS:
TEST GATES:
PRODUCTION CANARIES CREATED / CLEANED:
OPEN CRITICAL:
OPEN HIGH:
OPEN MEDIUM:
KNOWN LIMITS:
PRODUCTION ENABLEMENT STATE:
PUBLICATION RECOMMENDATION:
```

Also include:

- exact role/capability matrix;
- exact policy precedence;
- retention class/default table;
- project lifecycle state machine;
- accessibility manual and automated evidence;
- measured performance table with environment;
- all migration hashes/bookmarks;
- exact cleanup counts;
- no claim beyond evidence.

---

## 12. Final definition of done

The work is complete only when all of the following are true:

- “remember only” and “never remember” are represented as structured enforceable chat policy, not merely prompt text;
- chat policy is future-only, versioned, replay-stable, project/thread isolated, and cannot weaken parent policy;
- excluded Playground content is absent from every memory/source/index/export lane while transcript behavior is honestly disclosed;
- Settings has functional extraction, categories, retention, organization, members, roles, and invitations backed by server authorization;
- retention actually runs safely or is honestly disabled—no inert control presented as active;
- non-default projects can archive/restore and safely delete through a convergent state machine;
- ownership transfer preserves immutable memory namespace and leaves no unauthorized access;
- quotas and audit are bounded, scoped, privacy-safe, and enforced;
- stale project data never flashes or submits after a switch;
- Python, TypeScript, cURL, and MCP doors remain project-bound and interoperable within tested scope;
- WCAG, responsive, and performance evidence is measured and saved;
- all migrations are additive and recoverable through recorded D1 Time Travel references;
- no CRITICAL/HIGH remains open;
- production synthetic state is zero;
- user-owned `AGENTS.md` and immutable V3 evidence remain untouched;
- no package/marketplace publication occurred without explicit owner approval.

Do not confuse “the UI looks finished” with completion. The enterprise product is finished when the visible controls, authorization, storage boundaries, retries, audit, erasure, and production behavior agree.

---

## 13. Immediate first executable action for the receiving Claude task

Begin with a read-only cold-start audit and create the separate enterprise completion evidence root. Reverify the snapshot in Section 1. Then execute **Stage 2 only** through implementation, tests, flagged deployment, production policy canary, storage-layer attack, cleanup, and checkpoint. Proceed to Stage 3 only after Stage 2's hard-policy promise is proven.

Do not rerun LoCoMo. Do not retune Memory V3. Do not redesign the graph. Do not weaken the live V3 candidate. Build the enterprise controls around the proven memory system.
