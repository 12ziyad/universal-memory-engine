# Changelog

Itsuki ships as several artifacts on independent version lines: two editor
plugins, two SDKs, and the hosted service. Each section below covers one of them.

The hosted service has no public version number — it is a Worker, identified by
its deployment. Service changes are listed by what they mean for a caller, and
the documentation at <https://itsuki.app/docs/> is the contract.

---

## OpenClaw plugin — openclaw-itsuki 0.1.0 — 2026-08-15

First release of the native OpenClaw integration, published to npm with SLSA
provenance from this repository's GitHub Actions workflow.

### Added

- **Memory joins the agent turn.** Recall runs in `agent_turn_prepare` and
  arrives through `prependContext` before the model reads anything; capture
  runs in `agent_end` for genuinely settled turns. Cron and heartbeat runs are
  never captured — automation output is not conversation.
- **Coexists with built-in memory.** `MEMORY.md`, daily notes and
  `memory_search` keep working; the plugin never claims OpenClaw's exclusive
  memory slot (which would disable memory-core for every agent). A packaging
  gate greps the tarball to keep that promise honest.
- **Exactly-once capture** under a content-derived `openclaw:v1` idempotency
  key with a crash-safe local spool: Gateway restarts, handler re-entry,
  concurrent `agent_end`, compaction rewrites and offline periods all collapse
  to one write. Watermarks carry a digest of the owned prefix, so compaction
  is detected rather than double-captured.
- **Privacy-safe per-sender tenancy** (optional): each channel-scoped sender
  gets an isolated sub-tenant hashed one-way from channel + sender id. A turn
  without derivable sender identity skips memory entirely — never a silent
  fallback into the owner's space.
- Requires the operator to set
  `plugins.entries.itsuki.hooks.allowConversationAccess: true` — OpenClaw's
  own gate for conversation-reading plugins, surfaced as a first-class install
  step and a loud startup warning when missing.
- `itsuki_recall` / `itsuki_save` tools; no destructive surface of any kind;
  local credential scrubbing byte-identical to the server's canonical lane;
  zero runtime dependencies. Validated against OpenClaw 2026.7.1-2 on Node
  24.15.0, including a live `sessions_spawn` subagent proof with distinct
  parent/child attribution.

The dashboard's OpenClaw tab now leads with the native route; the prompt and
manual MCP routes remain as fallbacks.

---

## Pi extension — pi-itsuki 0.1.0 — 2026-08-15

First release of the native Pi integration, published to npm with SLSA
provenance from this repository's GitHub Actions workflow.

### Added

- **Memory joins Pi's own lifecycle.** Recall runs in `before_agent_start`, so
  relevant context is in the prompt before the first model call of every turn;
  capture runs in `agent_settled`, the only event Pi documents as "will not
  continue running automatically". No tool-choosing, no curl.
- **Exactly-once capture.** Each settled turn is staged to a crash-safe local
  spool under a content-derived idempotency key before any network call.
  Retries, crashes, `/resume` and `/fork` produce the same key; the server
  collapses them. Offline turns wait on disk and deliver on recovery.
- **Honest state everywhere.** Saves report "queued" until a receipt exists;
  `/itsuki status` and `/itsuki doctor` show spool depth, drop counts, last
  receipt, and breaker state — never the key. Recalled memory is injected
  behind an explicit stored-context-not-instructions label, and injected lines
  are never re-captured (including across `/resume`).
- **No destructive surface.** The extension contains no delete call of any
  kind; the tools are `itsuki_recall` and `itsuki_save` only.
- Local credential scrubbing byte-identical to the server's canonical lane,
  pinned by the shared security corpus plus a differential parity suite; a new
  language-neutral lifecycle corpus (`test/fixtures/agent_lifecycle_corpus.json`)
  pins identity, injection, error taxonomy, batching, and URL-safety vectors
  for this and every future native agent adapter.
- Zero runtime dependencies; Node ≥ 22.19.0 (Pi's own floor); Windows and
  Linux CI legs both green before publication.

The dashboard's Pi tab now leads with the native route; the REST-through-shell
route remains as the documented fallback.

---

## Hosted service — 2026-08-21 (MCP OAuth)

### Added

- **Sign in to connect, instead of pasting a key.** Itsuki's MCP server now
  supports OAuth 2.1 with PKCE. A compatible MCP client discovers the
  authorization server, sends you to Itsuki to sign in, and shows a consent
  screen naming the client, your account, and the project it will reach —
  with permanent deletion called out separately. Approve, and the client
  connects; deny, and nothing is created.
- **Permissions you choose, not one all-or-nothing key.** Connections can be
  read-only, read-and-write, or read-write-and-delete. **Deleting now requires
  its own permission**: a connection that can write can no longer erase.
  A connection is only shown the tools it is allowed to use.
- **Revoke and re-authorize at any time.** Refresh credentials rotate on every
  use, a replayed one revokes the whole authorization, and revoking takes
  effect immediately — including mid-request, so an operation already in
  flight cannot land after you revoke it. Losing project access, a project
  being deleted, or erasing your account all revoke connections too.

### Unchanged

- **Existing API keys and MCP links keep working exactly as before**, with
  their current permissions. They are a documented compatibility path;
  nothing about them was narrowed or broadened.
- Dashboard sign-in (including Continue with Google) is a separate system and
  is untouched.

---

## Hosted service — 2026-08-21 (Conversation Pages)

### Added

- **Conversation Pages.** A conversation now has ONE page. Pass a stable
  `conversationId` (or `threadId`) to `save_conversation` (MCP) or
  `POST /v1/save` with `mode: "conversation"` (the JS/Python SDKs'
  `addConversation`/`add_conversation`, the n8n Save Conversation node), and
  every later explicit save of that conversation ADVANCES the same page as a
  forward revision instead of creating a duplicate. Within one account and
  project, at most one live page owns a given conversation — enforced by a
  database uniqueness rule, not by best-effort matching, so concurrent saves of
  the same conversation converge rather than fork. Omit the id and each
  explicit save keeps its own page, exactly as before; exact retries still
  replay safely either way.
- **The REST conversation door builds pages too.** Previously only the MCP
  door produced a page; SDK and n8n conversation saves produced graph memories
  alone. Both doors now behave the same way.
- **Each page lists the saves behind it.** Every accepted batch is linked to
  its page, so a page can state truthfully which conversations, packets, and
  extracted memories it came from — and deleting one source rebuilds the page
  from the sources that survive rather than deleting a page that still has
  independent support.

### Changed

- **One name: Conversation pages.** The dashboard, docs, and receipts used
  "Notes", "notes page", "memory page", and "capture pages" for the same
  object. All of it is now "Conversation page(s)".
- **"Never build pages" now means it.** With capture set to Graph only, an
  explicit conversation save extracts facts and relationships but writes no
  Conversation page, and the receipt says so.
- **Your edits survive an advance.** If you have edited a page's text, a later
  save of that conversation adds its memories and leaves your wording alone
  instead of regenerating over it.
- The deprecated whole-chat digest lane is retired from the public API.
  `scope: "summary"` is now an ordinary conversation save (engine extraction
  plus a Conversation page) rather than a flat generated digest page.

---

## Hosted service — 2026-08-14

### Added

- **Every door is rate limited, and the numbers are published.** The MCP tools
  (saves, deletes, inventory reads) and the REST inventory routes now share the
  same per-credential buckets as the rest of the API; a new unauthenticated
  `GET /v1/limits` publishes every bucket, what it applies to, and how a
  refusal looks. REST 429s carry `retry-after`, `ratelimit-limit`, and a
  `bucket` field; MCP refusals are readable tool results, so the connection
  never drops. Bulk import moved to its own roomier bucket (300/min), so
  workspace imports no longer throttle against ordinary saves.
- **A monthly AI plan, enforced and visible.** Each account gets a calendar-month
  budget of AI-processed writes (launch plan: 1000), counted exactly in D1
  against the authenticated account — rotating `userId` neither resets a bucket
  nor a budget. Over-budget saves refuse with `ai_quota_exhausted` and the reset
  date; `/v1/turn` keeps answering recall and reports the capped capture
  instead. Usage and remaining quota surface in `GET /v1/usage`, the dashboard's
  new AI-plan card, and Settings → General.
- **An account-wide inference circuit breaker.** A daily neuron ceiling halts
  extraction before a runaway day becomes a surprise bill, with copy that never
  blames the user for an account-wide event.
- **The Integrations door.** Get started grew its fifth door: Python frameworks
  (LangChain/LangGraph, CrewAI, AutoGen, Agno, OpenAI Agents SDK, Google ADK,
  LlamaIndex via the path-token route), TypeScript (Mastra, Vercel AI SDK), n8n
  (HTTP Request and MCP Client routes), Dify (native MCP, no plugin), and
  Convex (the `itsuki` SDK inside a Convex backend) — with five matching docs
  pages. LangChain and LlamaIndex were verified end to end against production;
  frameworks whose shapes could not be verified (Camel AI, ChatDev) do not
  appear at all.

---

## Claude Code plugin — 0.7.0 (prepared, not yet published)

The first release since the plugin was hardened against a full acceptance
campaign. Nothing here changes how you install or configure it.

### Fixed

- **Over-redaction in capture.** The scrubber shared a rule set with the Codex
  adapter but had drifted from it, so some ordinary technical writing was
  redacted as if it were a credential — losing meaning that should have been
  kept. Both adapters now run one canonical rule set, verified against a single
  shared corpus of credential and non-credential cases.

### Changed

- **Session start is a lookup, not a search.** Opening a session used to run a
  similarity search for a generic phrase like "project decisions, conventions
  and architecture", which reliably retrieved nothing for ordinary project
  content. It now asks for a deterministic listing of the project's most
  salient and recent memory, and project memory is ordered ahead of
  account-global memory so a busy global store cannot crowd out the project you
  actually opened.

### Added

- **`/itsuki:doctor` reports the plugin version** it is running, read from the
  installed manifest so it cannot drift from the copy that is executing.
- **`/itsuki:doctor` reports the project identity** this directory derives.
  "My project memory is missing" is nearly always a question about which
  project id a directory maps to, and that id was previously not visible
  anywhere. The directory path is identity material and is never printed; the
  opaque id and the folder name are.

---

## Codex plugin — 0.3.0 (prepared, not yet published)

### Added

- **A diagnostic, finally.** Codex plugins register hooks rather than slash
  commands, so there was no equivalent of `/itsuki:doctor` — and a user whose
  setup was broken had no way to find out which part. Run it directly:

  ```
  node <plugin-root>/hooks/codex-doctor.mjs
  node <plugin-root>/hooks/codex-doctor.mjs --json
  ```

  It checks the installed version, hook registration, service and MCP targets,
  credential presence, connectivity, the protected local outbox and its
  backlog, credential-binding mismatches left by a key rotation, and the
  project id the current directory derives. It never prints your API key.

### Changed — read this one

- **Project identity now matches the Claude Code plugin.** The two adapters
  derived *different* project ids for the same directory, so a project captured
  in one was invisible to the other. They now agree.

  **Consequence:** captures delivered by an earlier Codex build remain under the
  old project id. They are not lost and are still reachable account-wide, but
  they will not appear under the converged project id. There is no migration,
  because no version of this plugin has been published — if that changes before
  this release ships, this note becomes a migration instead.

### Fixed

- **One corrupt envelope can no longer block delivery forever.** If a queued
  capture file was damaged on disk (disk fault, third-party interference), the
  delivery pass threw on reading it and gave up entirely — every valid capture
  behind it stayed queued on every future session, while the diagnostics
  showed a healthy-looking queue. A damaged envelope is now quarantined with
  its bytes preserved for review, exactly like a server-rejected one, and
  delivery continues. Found by this release's randomized state-machine tests.
- **AWS temporary credentials are redacted** before capture leaves the machine.
  Session tokens and the temporary access-key form were not covered by the
  previous prefix rules, which were also brittle about key length.
- **Scrubber parity with the Claude adapter**, against one shared corpus.
- **Session-start recall no longer fails on a slow first response.** The budget
  was a fixed 700 ms cliff that real network latency crossed routinely, so
  recall silently produced nothing; it is now sized from measured latency.
- **Delivery latency budgets** reflect real-world conditions rather than an
  optimistic local assumption.

---

## JavaScript SDK — `itsuki` 0.2.1 (current; no upgrade needed)

**0.2.1 is the verified current version. There is no 0.2.2.**

It was re-verified end to end against the live service after the deletion and
erasure work landed on the server, including the erasure flow and the
cancellation path. No client change was required: the service expresses the new
cancellation outcome through a terminal state this version already understands
(`failed`) plus additional response fields, and additive fields pass through
untouched.

Two things are worth knowing when you use it against the current service — both
documented in the README:

- A save cancelled by your own erasure arrives as `status: "failed"` with
  `cancelled_by_delete: true` and `outcome_reason: "cancelled_by_delete"`.
  Do not retry it; submit new content instead.
- The service accepts `GET /v1/jobs?cancelled=true|false`, but this client
  rejects `cancelled` as an unknown option. Filter on the returned
  `cancelled_by_delete` field, or call the endpoint directly.

## Python SDK — `itsuki` 0.2.1 (current; no upgrade needed)

Same status, same two notes, same verification: re-verified end to end against
the live service after the erasure work, with no client change required. The
`cancelled` filter is likewise not accepted by `jobs()`; read the
`cancelled_by_delete` field on each job instead.

---

## Hosted service

No public version number — the deployment is the identity. What changed for
callers, newest first:

### Memory management surface + six agent integrations

- **The MCP server grew from three tools to eight.** Alongside `save_memory`,
  `save_conversation`, and `recall_memory`, every MCP client now gets the
  management half: `list_memories` (browse newest-first, keyset cursor),
  `get_memory` (one object with its history and events), `delete_memory`,
  `delete_all_memories` (previews by default; only an explicit
  `confirm: true` destroys), and `whoami` (identity, scopes, project binding,
  live counts — the verify step of every install guide). In managed projects
  the delete tools require the project's distinct delete permission, not just
  write, matching the REST contract.
- **`GET /v1/memories` and `GET /v1/memories/:id` are new** — the read-only
  inventory behind those tools, for API keys that could write and delete but
  never see what they had.
- **Get started grew an Agents door** (OpenClaw with prompt-install and
  manual-config routes, Hermes Agent, Pi Agent) **and three editor tabs**
  (Cursor moved beside Claude Code and Codex; OpenCode and Antigravity added).
  Every flow shown works today against the shipped MCP and REST doors; no tab
  shows an install command for a package that does not exist yet.
- **Docs gained six Connect-a-tool pages** (Cursor updated; OpenCode,
  Antigravity, OpenClaw, Hermes, Pi new) and the MCP reference now documents
  all eight tools.

### Operator visibility

- **`GET /v1/ops/overview`** is new: one account-scoped call that rolls up your
  root and your sub-tenants and lists each one — live counts, job states,
  backlog depth and age, stuck work, retries, erasure barriers, latency
  percentiles, and cancellations counted separately from real failures. Every
  other read endpoint is scoped to a single memory user, so there was previously
  nowhere to see an account. Metadata only: no memory content, no labels, no
  project display names. Requires a Bearer token or a session; the legacy
  `x-api-key` lane is refused with `account_scope_required` because it has no
  account relationship to roll up.
- **Jobs distinguish cancellation from failure.** Every job now carries
  `cancelled_by_delete` and `outcome_reason`, and `GET /v1/jobs` accepts
  `?cancelled=true|false`. Triaging failures no longer means substring-matching
  an error message.

### Deletion and erasure

- **A confirmed unscoped delete is an erasure.** It records a barrier, sweeps to
  convergence, and cancels accepted work that has not yet committed, so nothing
  erased can reappear afterwards. A scoped delete remains curation: work already
  in flight finishes and lands, and the preview tells you how much is coming.
- **Cancelled work is terminal and honest.** It reports `failed` with
  `cancelled_by_delete: true` — deliberately not a new status word, because
  every released client treats the existing three terminal states as complete
  and a fourth would make older clients poll a finished job forever.
- **New writes after an erasure land normally.** Erasure clears the past; it
  does not lock the memory space.
- Confirmed responses gained `cancelled_runs` and `convergence_passes`.

### Retrieval

- **Session-start retrieval is deterministic** (`recallMode: "project_bootstrap"`)
  rather than a similarity search against a generic opening phrase.
- **Project memory is ordered ahead of account-global** under
  `project_then_global`, so a session opened in a project leads with that
  project's context.
- **One project identity across doors**, so a directory means the same project
  whichever editor captured it.

### Privacy and scrubbing

- Credential redaction covers AWS temporary credentials and is no longer
  brittle about key length. Its documented limits are on the
  [privacy page](https://itsuki.app/docs/#/privacy): an unlabelled
  high-entropy string, or a labelled passphrase of ordinary words, can still be
  stored.
