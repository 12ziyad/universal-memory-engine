# n8n-nodes-itsuki — implementation plan (Phase 1 gate output)

## File ownership announcement

This campaign owns **`packages/n8n-nodes-itsuki/**` only**. It will NOT touch:
`public/index.html`, `public/docs/index.html`, `src/index.js`, root `package.json`, `migrations/*`, or any pipeline file. The dashboard/docs gain a "Native node" variant **only after** the package is published and registry-install-tested (the no-dead-commands tests forbid it sooner). Working tree at start: clean at `cefecb6`; one pre-existing user stash (July) left untouched.

## Verified facts this plan stands on

- **Registry**: `n8n-nodes-itsuki` and `@itsuki/n8n-nodes-itsuki` both 404 on npm — name available, nothing squatted.
- **n8n official requirements** (docs.n8n.io, fetched today): scaffold `npm create @n8n/node`; name must start `n8n-nodes-` (or scoped); keyword `n8n-community-node-package`; nodes/credentials registered under the `n8n` attribute; **verification requires zero runtime dependencies** and (since 2026-05-01) GitHub-Actions provenance publishing. Community nodes install on self-hosted only; n8n Cloud carries only n8n-verified nodes.
- **`usableAsTool` / `N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE`**: docs pages moved; to be **verified empirically** in the runtime test (set the env var, observe the tool panel) rather than asserted.
- **Backend contracts** (verified live against itsuki.app this hour):
  - `POST /v1/save` → keys `[command_mode, counts, fired, memory_scope, mode, ok, processing, receipt, receipt_id, source, source_packet_id, summary]`
  - Conversation mode `{mode:"conversation", messages:[{role, content}...]}` with bounded batches (`GET /v1/ingest/limits`: 30 msgs / 4,000 cp / 120,000 cp / 512 KiB) — enforce locally before sending
  - `POST /v1/recall {query}` → `{ok, count, context, items[]}` — count 0 is a result, not an error
  - `GET /v1/memories?limit&cursor` → `{ok, memories, next_cursor?}`; `GET /v1/memories/:id` → `{ok, kind, memory}`; unknown prefix → 400 with named message
  - `DELETE /v1/memories/:id`; bulk `DELETE /v1/memories` defaults **dry_run**, destroys only with `confirm=true`
  - `GET /v1/packets/:id/status` + terminal statuses; SDK `waitFor` (sdk/js/index.js:314) is the proven poll pattern: deadline, bounded interval, honest `{..., timed_out: true}` on expiry
  - `GET /v1/status` → counts only (content-free) — credential-test endpoint
  - Errors already carry `retry-after` + `ratelimit-limit` on 429, quota refusals `ai_quota_exhausted`/`ai_capacity_paused`, `queue_full` 429s — the node maps each to friendly structured errors
  - `idempotencyKey` accepted on save/ingest

## Mem0-parity matrix

| Mem0 n8n concept | Itsuki reality | Decision |
|---|---|---|
| Add | `POST /v1/save` | **Build** (Save Memory) |
| Add multi-message | conversation mode | **Build** (Save Conversation, order-preserving, roles validated, local batch limits) |
| Wait for Completion, default on | packet status + waitFor pattern | **Build** — default on for saves + standalone Wait op; timeout returns honest "accepted/still processing" |
| Search | `POST /v1/recall` | **Build** (Recall) — context + structured items; empty ≠ failure |
| Get Many + Return All | cursor pagination | **Build** — Return All with max-items cap + loop detection |
| Get | `GET /v1/memories/:id` | **Build** |
| Update | **no safe backend contract** (provenance/graph/FTS/vector consistency undesigned) | **OMIT** — explicit backend follow-up; never a dead operation |
| Delete | `DELETE /v1/memories/:id` | **Build** — destructive warning; not-found reported honestly |
| (Mem0 has no Delete All in the node) | bulk delete, dry_run default | **Build & exceed** — preview by default, explicit confirm field, never exposed as AI tool |
| (Mem0 has no health op) | `/v1/status` (+ usage quota) | **Build & exceed** (Who Am I) |
| Entity IDs (user/agent/app/run, OR-combined) | credential-bound tenancy + `userId` sub-tenant + attribution scope (conversation/thread/source) | **Map, not clone** — tenancy comes from the credential, never OR-widening; expose User ID (sub-tenant), Conversation/Thread/Source IDs |
| Infer on/off | extraction is project-governed; no verbatim toggle | **Omit**, document why |
| Metadata (JSON) | no arbitrary metadata on save | **Omit**, document |
| Custom instructions / categories per call | governed at project level (`/v1/rules`) by design | **Omit per-call**, point to governed path |
| Includes/Excludes per call | conversation `scope` (full/lastN/topic/summary) + `topic`, `contentScope` — real request narrowing that cannot broaden policy | **Expose these** on Save Conversation |
| usableAsTool | same flag | **Build** — safe set only (Recall, Save, Save Conversation, List, Get, Who Am I); destructive ops never tool-enabled |
| Credential + Base URL | Bearer + base URL | **Build** — HTTPS-only (loopback exempt), no creds/query/fragment in URL, test via `/v1/status`, redaction everywhere |

## Package design

- `packages/n8n-nodes-itsuki/` — standalone package, own lockfile, **zero runtime dependencies** (n8n helpers for HTTP), TypeScript, programmatic-style node (pagination/polling/structured errors need `execute()`).
- `credentials/ItsukiApi.credentials.ts` — apiKey (password-masked), baseUrl (default `https://itsuki.app`), `authenticate` → Bearer header, `test` → `GET /v1/status`.
- `nodes/Itsuki/Itsuki.node.ts` — one node, `resource: memory`, 9 operations (Save Memory, Save Conversation, Recall, List, Get, Delete, Delete All, Who Am I, Wait For Packet).
- Reliability: bounded timeouts, abort propagation, Retry-After honoured with jittered backoff, retries only for safe reads or idempotency-keyed writes, no retry of deletes, pagination caps, no unbounded buffering, secrets redacted from every error path.
- Tests inside the package: unit (schemas, mapping, validation, redaction, pagination, wait, error mapping), security (the brief's list), runtime (packed tarball into a clean local n8n via `npx n8n`, workflows executed, export checked for credential leakage), canary against production with synthetic data + cleanup.

## Checkpoints

- **A**: baseline suite green on `cefecb6` (running), contracts verified (done above), plan written (this file).
- **B**: package complete, all local gates green, tarball inspected (`npm pack` file list, no secrets, no postinstall, licenses).
- **C**: full repo suite still green (no shared files touched — expected trivially green), canary evidence, GO/NO-GO report. **No npm publish, no deploy, no dashboard/docs edits — those wait for explicit approval.**
