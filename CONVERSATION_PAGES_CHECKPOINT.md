# Conversation Pages — Architecture Checkpoint (Campaign A)

Date: 2026-08-21. Baseline: commit `12cc980`, production Worker version
`0afd4dae-1521-439d-a779-5b5a425ecace`, D1 `uml-memory` (49 migrations applied;
next is 0050). Product owner explicitly started backlog items 1 (this campaign)
and 8 (MCP OAuth, runs second).

## What exists today (verified in code)

- `memory_pages` is the page store and is already the `page` kind in the
  safe-update system (revision CAS, bounded history via `memory_revisions`,
  editable title/short_summary/full_markdown, deletion-barrier + capability +
  credential fences) — `src/lib/memory_versions.js`.
- Three page-writing sites; two live lanes:
  1. **MCP `save_conversation`** (`src/pipeline/mcp_engine.js`) — receipt-first
     staged lane: provisional page (`source_mode='mcp_save'`,
     `enrich_status='staged'`) → DO enrichment via the full Engine v2 →
     finalize (`enriched`) or `failed`, or page deleted when nothing durable.
     **Mints a NEW page per accepted save; no conversation-ID convergence.**
     A grown re-send of the same conversation creates a second page.
  2. **Legacy digest lane** (`manual_collect.js`/`pages.js`) — deprecated;
     reachable only via `scope:"summary"` (non-managed) or a test hook;
     converges by fuzzy similarity, not identity.
- **REST `/v1/save` mode:"conversation"** (SDK `addConversation`, Python
  `add_conversation`, n8n Save Conversation) routes through the ingest engine:
  nodes + edges, **no page at all**.
- Automatic doors (`/v1/turn`, `/v1/ingest`, hooks/plugin, playground,
  `save_memory`) create **zero pages** — already contract-conformant.
- Naming today is inconsistent: docs say "Notes"/"notes page", dashboard says
  "memory page"/"pages"/"Conversation pages" (one place), workspace label is
  "Conversation".

## Frozen decisions

1. **Name**: "Conversation Pages" (UI capitalized "Conversation page(s)" in
   running copy). Remove "Notes", "notes page", "memory page" as
   conversation-artifact naming from docs, dashboard, receipts, labels.
   `memory_pages` table name stays (compat; storage is an implementation
   detail).
2. **One staged conversation lane for both explicit doors.** The MCP staged
   lane (`stageMcpConversation` + `enrichMcpConversation`) is generalized into
   the conversation-page lane. REST `mode:"conversation"` routes through it
   (keeping its own door limits, source_mode `conversation_collect`, manual
   extraction profile, and an optional wait-for-terminal within
   `waitBudgetMs` so small saves still return final receipts). MCP keeps
   `mcp_save` source_mode, profile "mcp", and immediate staged answers.
   The legacy digest lane is retired (code + test hook + `scope:"summary"`
   now behaves as a normal conversation save).
3. **Deterministic conversation identity.** New column
   `memory_pages.conversation_key` (canonical id = explicit `conversationId`
   else `threadId`; NULL when neither given — then one page per explicit
   batch, replay-safe by packet idempotency). Unique partial index on
   `(user_id, COALESCE(project_id,''), conversation_key) WHERE
   conversation_key IS NOT NULL AND deleted_at IS NULL` gives DB-level
   convergence; INSERT losers re-read and advance. Legacy rows keep
   `conversation_key` NULL (truthful unknown provenance); code performs **lazy
   adoption** only when exactly one live page carries the same
   `source_conversation_id` in scope (evidence-based, CAS-guarded, unique
   index enforced) — this also covers rows created between migration apply
   and code deploy.
4. **Advance = forward revision.** A later explicit batch for the same
   conversation links its packet and advances the same page through the
   existing revision machinery: staging + finalize CAS the revision they read
   (`applyFencedUpdate` participation), history integrity via the existing
   lazy system-snapshot capture, and `userAuthoredSummaryFence` so an advance
   never reverts user-authored title/markdown (in that case the advance links
   memories and says so on the receipt instead of rewriting text).
5. **Provenance via links, not copies.** New table
   `conversation_page_sources(user_id, page_id, source_packet_id, seq,
   created_at)` links each advance's packet. Ordered bounded messages and
   linked extracted memories are derived truthfully from linked packets and
   their extraction runs (existing workspace source surfaces). No second copy
   of customer content. Registered in `lifecycle_census.js`
   (`PURGE_SPACE_TABLES` + `CENSUS`) and deleted with the page
   (`deleteObject`), purge, project delete, erasure.
6. **Bounds (documented deterministic contract).** Door limits unchanged
   (REST ingest contract 30 msgs / 4k chars / 120k batch; MCP 200 msgs / 60k
   chars — refusal, never silent truncation). Per page: max 200 linked
   advances (then a clear refusal receipt); rendered markdown ≤ ~24k chars
   with oldest-advance-section trimming and a truthful trim marker (the tail
   is never silently lost; D1 row cap is 2MB, statement cap 100KB — verified
   from current docs).
7. **States stay truthful**: `enrich_status` on the page reflects the latest
   advance (`staged` → `enriched` | `failed`); AI failure marks `failed`,
   never fake success; job rows carry errors; nothing-durable first save
   deletes the staged page (existing behavior), nothing-durable advance keeps
   the prior enriched page and says so.
8. **Rules**: `captureDefault === "graph_only"` ("Never build pages") now
   suppresses Conversation Page creation entirely on explicit doors (graph
   extraction still runs; receipt says pages are off) — this is the explicit
   supported configuration the UI already advertises.
9. **Suppression**: deleting a Conversation Page suppresses its
   `conversation_key` (new suppression kind) so a re-save cannot silently
   re-materialize it — parity with the existing deleted-page contract.
10. **Feature flag `CONVERSATION_PAGES`**: `"track"` (deploy 1) = unified lane
    live but legacy per-save page behavior (no conversation_key claims, no
    REST pages); `"on"` = deterministic convergence + REST pages. Rollback is
    a flag flip; the previous Worker version remains the hard rollback.
11. **Packages**: wire contract unchanged (`conversationId` already exists on
    every surface). No SDK/n8n republication expected; docs copy only.
12. **Compat**: pre-deploy idempotency keys replay correctly across the lane
    switch (legacy `extract`-type job with same key + same content hash →
    terminal replay of the stored receipt, never a 409).

## Campaign B (queued, not started)

MCP OAuth is greenfield: `@cloudflare/workers-oauth-provider@0.10.3` (MCP auth
spec 2026-07-28, PKCE S256-only default, hash-only token storage, refresh
rotation, RFC 8414/9728/7591/8707/9207) requires an `OAUTH_KV` namespace.
Claude's client flow (401 → `WWW-Authenticate` `resource_metadata` → PRM →
DCR/CIMD → PKCE S256, loopback redirect for Claude Code) is documented in the
research notes. Existing bearer/path-token doors and Google dashboard login
remain untouched. Detailed design lands after Campaign A is GO.

## Sequence

1. Failing regression tests for each confirmed gap (MCP non-convergence, REST
   no-page, naming, graph_only, legacy-replay compat).
2. Migration 0050 (+ checksums, census, schema census green).
3. `src/pipeline/conversation_pages.js` + mcp_engine generalization +
   REST routing + digest-lane retirement + cleanup/suppression integration.
4. Naming sweep (docs, dashboard, workspace labels, receipts) with pinned
   tests updated in lockstep.
5. Mandatory 16-point test matrix; focused runs; one uninterrupted full run.
6. Dry-run → Time Travel bookmark → apply 0050 → deploy `track` → production
   canaries → flip `on` → full canary matrix → fixture cleanup + zero-residue
   proof → report → backlog update.
