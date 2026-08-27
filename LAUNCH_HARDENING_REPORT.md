# Launch Hardening Report — 2026-08-28

One pass over Itsuki before the public launch: the silent-write-loss bug, the
D1 read amplification, per-user quotas with a usage page, Huba AI, the admin
portal, the memory graph, a public-repo security audit, the docs, and a
rebuilt landing hero. Everything below is implemented, tested, and deployed.

## Security: nothing to rotate

A three-way audit (full git history across 491 commits and all refs, the
tracked working tree, and the production route/config surface) found **no
live secret anywhere** — every `itsuki_live_*`, `ghp_*`, `AKIA*`, `sk-*`,
JWT-shaped, or private-key-shaped string in the repo is a deliberate test
placeholder or a scrubber fixture, `.dev.vars`/`.env` were never committed,
and real key handling goes through Worker secrets and CI OIDC throughout.
**Nothing needed rotation.** What the audit did surface, all fixed in this
pass:

- **177 internal working files under `tmp/` were tracked** despite the
  ignore rule (the V3 campaign evidence tree — no credentials, but internal
  defect narratives and operational notes). Untracked (`git rm -r --cached
  tmp/`); the historical copies remain in public history, which is
  disclosure of working notes, not of secrets.
- **`HANDOFF.md` disclosed billing details and the owner's personal email**
  in the public repo. Untracked and added to `.gitignore`; the owner email
  was also redacted from `NATIVE_OPENCODE_ANTIGRAVITY_FINAL_REPORT.md`.
  (The in-app support-contact occurrences are deliberate and unchanged.)
- **`/oauth/register` and `/oauth/token` had no rate limiting** —
  unauthenticated-by-spec endpoints, one of which writes a D1 row per call.
  Both now ride the per-IP auth bucket ([oauth_routes.js](src/lib/oauth_routes.js)).
- **`/eval/llm` compared the operator key with plain `!==`** instead of the
  timing-safe comparison every other operator door uses. Fixed (it is also a
  404 in production — `EVAL_MODE` is not set).
- Verified: `ENABLE_TEST_OVERRIDES` absent from production config and inert
  by default; `EVAL_MODE` absent; all 8 (now 11) `/v1/admin/*` routes are
  session + `role='admin'` gated with no admin route missing the check; no
  hardcoded credentials; scripts/ not bundled; `AI_ROUTING` still `"off"`.
- Known scanner-noise, left deliberately: a synthetic `ghp_…` fixture in
  `evals/sdk_load/dataset.json` exists to test the credential scrubber and
  is tagged as such in the dataset.

## Task 0 — measured numbers

Measured on production D1 (95,305 `ai_calls` rows; only two scopes exist in
live history — `save` 69,222 and `recall` 26,083). Neurons are
binding-reported; embeddings never report and are near-free.

**Per model call** (scope.task · calls · avg neurons · avg in/out tokens):

| lane | calls | avg neurons | avg tokens in/out |
|---|---|---|---|
| save.extract (Qwen3-30B) | 17,470 | 44.97 | 2,584 / 1,083 |
| save.extract_atomic | 1,704 | 74.35 | 961 / 657 |
| save.reflexion | 13,220 | 8.29 | 993 / 121 |
| save.edges | 12,335 | 5.44 | 896 / 43 |
| save.embed | 24,493 | unreported | 92 / 0 |
| recall.embed | 21,346 | unreported | 16 / 0 |
| recall.rerank | 4,737 | 4.83 | 17,097 / 0 |

**Per save, by type** (receipts rollups, `ai_calls > 0`):

| source | saves | avg calls | avg measured neurons | avg messages |
|---|---|---|---|---|
| save_memory (direct) | 621 | 4.42 | **55.3** | 1 |
| ingest (auto) | 11,397 | 5.08 | 74.7 | 14.8 |
| plugin | 33 | 3.64 | 66.8 | 1.5 |
| **save_conversation** | 311 | 13.1 | **312.6** | 17.7 |
| recall | 7,659 | 1.0 | ~0 (embed only) | — |

Conclusions that sized everything else:

- **A conversation save costs ~5.7× a direct save** (312.6 vs 55.3 measured
  neurons — the brief guessed 2–5×). This is exactly why the daily quota's
  unit is **neurons, not a save count**: the weighting is inherent. At
  15,000/day a user gets ~270 direct saves, ~200 auto-ingests, or ~48 full
  conversation saves — the "about 100 saves a day" promise holds with margin
  for the current config (with V3 atomic capture ON, a current-config direct
  save sums to ~130–150 neurons: extract 45 + atomic 74 + reflexion 8 +
  edges 5, so 150/save remains the honest planning figure and the published
  `approx_saves` divisor).
- **Recall is measured at ~0–5 neurons** (one unreported embedding, plus
  ~4.8 when the reranker fires) — keeping it unmetered is correct and cheap.
- Historical `memory_jobs` was 6,907 rows of which only 49 were older than
  30 days at measurement time (the table is mostly recent eval traffic) —
  pruning's value is bounding growth, not a one-time purge.

## Task 1 — launch blockers

### 1a. Silent write loss — fixed in all three parts

**Capacity is no longer classified as failure.** A Workers AI
out-of-capacity refusal (code 3040 / "Out of capacity" / 429) is now
detected at classification time ([llm.js](src/pipeline/llm.js) `isCapacityError`,
`failureKind` → `"capacity"`), flows through extraction as a distinct
`llm_capacity` outcome ([extract.js](src/pipeline/extract.js)), and takes a
**patient retry ladder in the Durable Object** instead of the 3-attempt
poison ceiling: up to 12 attempts with jittered exponential backoff 30s →
15min (~2 hours of patience), counted separately from poison `attempts`
([user-memory.js](src/durable/user-memory.js) `MAX_CAPACITY_ATTEMPTS`,
`capacityBackoffMs`). The MCP enrichment lane got the same ladder. Two traps
found and closed while building it:

- The deterministic extraction-run id derives from `entry.attempts`; capacity
  retries don't consume attempts, so a naive retry would have re-claimed the
  previous attempt's failed run row and "recovered" its stored failure
  **without ever calling the model again** — an infinite no-op ladder. Each
  capacity attempt now mints a fresh attempt identity (`:cN` suffix), and the
  end-to-end test asserts one real extraction run per retry.
- A capacity error that *throws* out of the engine (rather than being
  classified) is also recognized in the DO catch and in the sync-throw
  recovery path (`workers_ai_capacity:` error prefix → `llm_capacity` on
  replay), so no path falls back to the poison ladder.

While retrying, the job stays visibly non-terminal in `/v1/jobs` and **no
llm_failed receipt is written per attempt** (the write hasn't failed).
Verified end-to-end by [capacity_retry.spec.js](test/capacity_retry.spec.js)
via a deterministic `_test.llmFault: "capacity"` fault (inert without
`ENABLE_TEST_OVERRIDES`): survives well past 3 attempts non-terminally,
re-attempts with fresh run ids, dead-letters loudly only when exhausted, and
a genuine poison input still dead-letters at 3.

**Failed writes are surfaced to the user.** The app now polls
`/v1/jobs?status=failed` on load and every 3 minutes: a red dot badges the
History tab while failures exist, and unacknowledged failures open a
plain-language report ("Itsuki accepted this write and then couldn't finish
processing it. That's on us, not you") with the failure time, a friendly
cause (capacity exhaustion, storage error, lost queue entry), and the job id
as the reference. Acknowledged ids are remembered in `localStorage`.

**One-click error report.** The popup's "Send report" posts to the existing
`/v1/error-report` door under scope `user_write_failed` with the job ids and
error summaries — which lands in the admin error log (Task 4). The job id is
the durable cross-reference (the original request's `x-request-id` is not
recoverable client-side after the fact; the job id is what the operator can
actually look up).

### 1b. Read amplification — indexes shipped, queries restructured, pruning added

- **Migration 0058** (applied remotely): `idx_memory_jobs_status_updated
  (status, updated_at)` and `idx_memory_jobs_status_completed
  (status, completed_at)` — every prior index led with `user_id`, so both
  5-minute-cron sweep queries were full scans, 576×/day over an ever-growing
  table.
- **Migration 0060** (applied remotely): expression partial indexes over
  `json_extract(scope_json, …)` on `extraction_runs` and `receipts`, plus
  `idx_memory_jobs_user_receipt` for retention's delete guard.
- **Retention discovery restructured** ([retention.js](src/lib/retention.js)):
  the three provenance queries were single ORs containing un-indexable JSON
  branches — SQLite's OR-optimization needs *every* disjunct indexable, so
  one bad branch forced full scans of `source_packets` (14,394 rows),
  `extraction_runs`, and `receipts` on every retention preview, activation,
  and run batch. They are now UNION arms, each independently index-served.
  The historical `raw_meta_json.managed_project_id` values were backfilled
  into the first-class column by 0058 (the insert path has set the column
  since 0040), so the JSON branch is gone entirely.
- **Pruning**: the reconciliation sweep gained a fourth duty — terminal job
  rows (`enriched`/`completed`/`skipped`/`failed`) older than 30 days are
  deleted in bounded batches of 400/slice per tick, riding the new indexes.
  The table can no longer grow forever. (Documented in `/api/jobs`: job
  history is bounded to 30 days.)
- **Proof**: `EXPLAIN QUERY PLAN` for all four hot shapes is now asserted
  *in the test suite* ([launch_hardening.spec.js](test/launch_hardening.spec.js)
  "query plans") — `SEARCH … USING INDEX idx_…`, no `SCAN`, against the same
  migration set production runs. A plan regression now fails CI instead of
  silently re-inflating the bill.

**Measured impact (Cloudflare D1 analytics, GraphQL):**

| window | rows read |
|---|---|
| 2026-08-26 (before, full day) | **5,675,555** |
| steady-state cron hours before the fix | **167,100 / hour** (= 12 ticks × 2 sweep scans × 6,907 rows — the arithmetic matches exactly) |
| first full hour after migration 0058 landed (2026-08-27 20:00Z) | **1,446** |

The sweep's scan load went **167,100 → 1,446 rows/hour (≈115×)** the hour
the indexes were applied — from ~4.0M rows/day of cron scans to ~35k/day,
which was the bulk of the measured 5.29–5.68M/day. (Later hours that day
show 96k–286k reads again: those are this campaign's own one-off
measurement queries over the 95k-row `ai_calls` table, not the cron.) The
remote query plans were also captured directly from production:
`SEARCH memory_jobs USING INDEX idx_memory_jobs_status_updated` /
`idx_memory_jobs_status_completed` for the two sweep queries.

### 1c. Rate limiter no longer fails open on writes

`allowRate` ([rate.js](src/lib/rate.js)) now takes a failure policy. An
**absent** binding still allows (tests and local dev deliberately omit
bindings). A binding that **throws** now refuses on every save/import/delete
call site (`{ fail: "closed" }` — 16 REST sites plus the MCP door's
write-shaped buckets), while auth/recall/read stay fail-open: they spend no
inference and mutate nothing, and a limiter blip must not lock people out of
signing in or reading their own memory. Rationale: a broken limiter under
write pressure is exactly when the brakes matter most, and every allowed
write spends real money. [limits.spec.js](test/limits.spec.js) pins both the
split policy and — via a source scan — that every write-shaped call site
passes fail-closed.

## Task 2 — per-user quota + usage page

- **`user_entitlements`** (migration 0059): per-user `daily_neurons`,
  `monthly_writes`, `huba_daily_messages`, `early_access`, `expires_at`,
  `note`, `granted_by`. Missing row/NULL column → env default. Expired
  numeric overrides are ignored at read time (grants lapse with no cleanup
  job); `early_access` survives expiry. Every pre-existing user was
  backfilled `early_access=1` by the migration, and both account-creation
  paths (password signup, OAuth/passwordless identity) stamp it until the
  fixed cutoff 2026-09-27 (launch+30d).
- **Daily neuron dimension** ([ai_budget.js](src/lib/ai_budget.js)):
  15,000 neurons/day per account (`AI_DAILY_NEURONS_PER_USER`), ≈100 direct
  saves at the measured ~150/save; reset 00:00 UTC; counted per-call as
  measured-neurons-else-token-derived — the same rule as the breaker — keyed
  on `account_user_id` so rotating a memory-scope userId buys nothing.
  **Fail closed**, same as the monthly quota. Refusal reuses the
  `ai_quota_exhausted` contract with `capped: "daily_neurons"` and
  `usage: { used, limit, unit, resets_at }`. Exemptions are an *exclusion*
  list (`recall`, `provider_health`, `shadow_extract`) so a future scope can
  never become an unmetered hole by omission. **Recall stays unmetered.**
- **Global breaker raised 750,000 → 1,500,000** (`wrangler.jsonc`): 50 users
  × 15,000 was exactly the old ceiling — the per-user cap and the
  account-wide breaker would have collided at precisely the planned
  headcount.
- **Usage page**: profile menu (top right) → "Usage & plan". Today's bar
  (neurons + "about N saves left"), live 00:00 UTC countdown, amber warning
  at 80%, red at the wall with "recall keeps working" copy, the monthly bar,
  Huba's bar, recent activity, and **Request more** — a modal that files an
  `upgrade_requests` row (one open request per user per kind; a second press
  refreshes the note instead of duplicating), snapshots the requester's live
  usage server-side, emails the owner (`OWNER_NOTIFY_EMAIL`) through the
  existing EMAIL binding with cron-retried delivery on the row's own
  mini-outbox columns, and lands in the admin queue. **No payment processor,
  no checkout, no prices.** `GET /v1/usage` gained `quota_daily` and `huba`
  blocks; `GET /v1/limits` publishes the daily allowance and Huba allowances
  (the account-wide operational ceiling remains unpublished).

## Task 3 — Huba AI

A collapsible assistant bar pinned bottom-right of the signed-in app
([huba.js](src/huba/huba.js), UI in `public/index.html`).

- **Grounding**: answers ONLY from (a) the 71-page docs corpus — extracted
  from `public/docs/index.html` at build time by
  [build-huba-corpus.mjs](scripts/build-huba-corpus.mjs) into a committed
  module, hash-pinned to the docs file so a docs edit without a corpus
  rebuild **fails CI** — and (b) a compact server-built snapshot of the
  signed-in account (recent saves, job health, live quota standing). No id
  from the client is ever trusted; the snapshot comes from the session.
  Retrieval is lexical scoring over the corpus: at 71 editorially
  self-contained pages this beats an embedding round-trip — zero neurons,
  zero latency, deterministic. If nothing relevant is found the system
  prompt requires "I don't know, see /docs/…" over a guess.
- **Model**: `HUBA_MODEL` = the proven extraction MoE
  (`@cf/qwen/qwen3-30b-a3b-fp8`). Chosen because its instruction-following
  is what holds the grounding/refusal contract, it is already validated on
  this account, and as an A3B mixture its per-token cost is near an 8B dense
  model. A measured live answer costs ~25–35 neurons.
- **Metering**: every call runs through `runAi` inside a flushed meter under
  scope `huba_chat` (importer registered in the AI-call census), fully
  account-attributed. Huba spend counts against the daily-neuron dimension;
  it does not consume monthly *writes* (it is not a save) — it has its own
  cap instead: **50 messages on the account's first UTC day, 20/day after**
  (`user_entitlements.huba_daily_messages` overrides), fail-closed, with the
  same Request-more flow on exhaustion.
- **Voice**: browser Web Speech API both directions — mic button
  (SpeechRecognition where available) and read-aloud toggle
  (speechSynthesis). Zero neuron cost, no audio leaves the browser, and the
  text bar always works where speech is unsupported.
- **A11y/UX**: collapsible, Escape closes, focus-visible rings,
  `prefers-reduced-motion` respected, full-width bottom sheet on mobile,
  light and dark via the theme tokens.
- Live-verified against real Workers AI in the dev worker: a question about
  account state + product concepts returned a grounded answer with correct
  docs citations and the live quota numbers.

## Task 4 — admin portal

Three new tabs plus deepened existing ones (all `/v1/admin/*` routes remain
session + admin-role gated):

- **Errors** (`GET /v1/admin/errors`): the full `error_reports` ledger —
  filter by text/side/since, noise excluded by default, reporter email
  joined in, and a one-click **Copy** that yields a paste-ready block (time,
  user, side, scope, report id, message).
- **Requests** (`GET /v1/admin/upgrade-requests` + extended
  `POST /v1/admin/users/action`): the upgrade queue with each requester's
  live usage snapshot and note; one-click grant presets (2×/4× for 30 days,
  4× forever) and a custom grant row (days × amounts), all through the new
  audited `grant_entitlement` action (entitlement upsert + request
  settlement in one batch); `dismiss_upgrade_request` closes without
  granting.
- **Spend** (`GET /v1/admin/ai-spend`): neurons per account per day,
  measured-else-derived, with call counts and a dollar estimate — the table
  a future price gets set from.
- **Overview** gained the signed-up → activated (has a receipt) → errored
  (failed job / error report, 14d) funnel, joined through the
  account-spaces mapping so managed-project saves count.
- **Health** gained the `GET /v1/ops/overview` rollup card (per-account job
  states, backlog, stuck, retries, latency) — the endpoint existed with no
  reader.
- **User journey** now stitches all the per-user ledgers — receipts,
  memory_jobs (+recent failures), ai_calls by day, error_reports,
  audit_events, entitlement, upgrade requests — into one chronological
  "what happened to this person" timeline.

Live-verified end to end locally: filed a request as a user, saw it in the
queue with the live snapshot, one-click granted 2×/30d, and the account's
`/v1/usage` limit moved to 30,000 immediately.

## Task 5 — memory graph

- **Conversation pages are squares at memory-dot scale** (~14–24px): shape
  alone now carries the type (round = memory, square = page); the oversized
  rectangle is gone. Labels render under the mark like every dot.
- **No overlaps, ever**: a deterministic pairwise-separation pass
  (`separateGraphNodes`, bounded sweeps, 16px minimum gap, golden-angle
  nudge for exact overlaps) runs over the precomputed layout before hulls
  are computed. Verified on the live graph: minimum edge-to-edge gap 59px,
  zero overlapping pairs.
- **Edges always visible**: resting alpha floor raised (the near-invisible
  `related_to` went .28 → .45), and hover **or selection** lights the
  connected subset fully while dimming the rest (`highlightConnectedEdges`,
  precomputed lit/dim colors, one batched DataSet update). Verified: color
  cycle restores exactly to base on blur/deselect.

## Task 6 — public-repo security audit

See the top of this report. Fixes beyond the audit: `tmp/` + `HANDOFF.md`
untracked, OAuth endpoints rate-limited, `/eval/llm` timing-safe.

## Task 7 — documentation

69 → **71 pages**, structure gates green, corpus rebuilt:

- `/api/limits`: the daily allowance as mechanism — what a neuron is, why
  the unit is compute not a flat count, why recall is free, the 00:00 UTC
  reset, the **exact** 429 body for `capped: "daily_neurons"`, the
  `/v1/turn` recall-only degrade, per-account overrides, and the updated
  `GET /v1/limits` sample.
- `/api/usage`: `quota_daily` + `huba` blocks and the dashboard pointer.
- **New** `/guides/usage` ("Usage & the daily allowance"): the dashboard
  how-to — the three bars, the 80% warning, the countdown, the wall, the
  Request-more flow.
- **New** `/guides/huba` ("Huba AI"): what it is, the grounding contract,
  account isolation, allowances, browser-side voice, "a dashboard surface,
  not an API".
- `/api/jobs`: the capacity ladder (visibly non-terminal while retrying,
  `workers_ai_capacity:` on terminal failure) and the 30-day job retention.
- `/api/errors`: all three `capped` dimensions with their `usage` object.

## Landing page (owner's addendum)

- Hero rebuilt: **centered** copy, new two-beat headline **"Your AI
  forgets. / Itsuki remembers."** (same enemy-claim structure as before,
  product named in the answer), a deck that says what Itsuki is in one
  breath (memory layer, 26 tools, save once/remembered everywhere,
  source-linked/versioned/reversible), and a quiet proof line (open source ·
  one key · free during early access). The イツキ mark survives as a narrow
  ink sliver on the right edge (~7% of the hero at desktop, 42px at 375px)
  instead of the old 30% panel — vertical-rl katakana, clipped glow.
- **Open source button** (GitHub mark + label) added top-right in the nav,
  linking the public repo.
- Page `<title>`/OG/meta description updated to match. Four test files that
  pinned the old hero were updated deliberately (the owner asked for the
  rebuild): `product_experience.spec.js`, `product_experience_css.unit.js`,
  `auth.spec.js`, `dashboard.spec.js`.
- Verified at desktop and 375px: zero horizontal scroll, sliver flush right,
  button visible.

## Found beyond the brief, fixed anyway

- The two OAuth endpoints and `/eval/llm` hardening (above).
- `GET /v1/usage` reported Huba's steady-state limit (20) for first-day
  accounts because `requireMemoryUser` wraps the session user one level
  deeper than the handler assumed — fixed and live-verified (50 on day one).
- The dashboard state object is now exposed as `window.S` (debugging aid; a
  no-build-step SPA with reachable state is what makes live smoke checks
  honest).
- `checkAiBudget`'s monthly refusal now also carries the `usage` object, so
  every quota dimension speaks the same shape.

## Could not fix / honest gaps

- **`wrangler d1 info` itself errors from this machine** (HTTP 401 on its
  analytics call with the stored OAuth token), and `wrangler d1 execute`
  proved unusably flaky tonight (minutes of startup, intermittent hangs and
  a transient account-level 7403). The before/after read-volume numbers
  above were therefore taken straight from the Cloudflare GraphQL analytics
  API and the D1 REST query API with the same local credentials — same
  data, sturdier path. Migrations were applied with `wrangler d1 migrations
  apply --remote` (which worked) before any of this.
- The user-facing failure popup references the **job id**, not the original
  request's `x-request-id` — the request id is not recoverable client-side
  after the fact, and the job id is what the operator can actually look up
  in the admin log and jobs ledger. The error report the user sends carries
  its own request id.
- The admin UI was live-verified on the dev worker with a locally-promoted
  admin (production admin verification requires the owner's session; every
  admin *route* is covered by tests).
- Retention discovery's `extraction_runs`/`receipts` UNION arms are
  index-served (proven by EXPLAIN in CI); their absolute cost only matters
  once retention policies are active, which none are yet in production.
- `tmp/` and `HANDOFF.md` remain in public git *history* (rewriting a
  public repo's history is more disruptive than the exposure warrants — no
  credentials are in them).

## Verification

1. **Full test suite** — `npx vitest run --no-file-parallelism`:
   **187 files passed, 2,365 tests passed, 0 failed** (the suite grew from
   185/2,334 with the new `launch_hardening.spec.js` and
   `capacity_retry.spec.js`). The node-env config
   (`vitest -c vitest.unit.config.mjs`): **43 files, 666 passed, 1 skipped**.
   Tests updated deliberately, each because behavior genuinely changed:
   - `limits.spec.js` — the allowRate fail-policy split (plus a new source
     scan pinning fail-closed on every write call site) and the published
     daily/Huba blocks in `/v1/limits`.
   - `ai_budget.spec.js` — `aiBudget()` gained three fields; the default
     global ceiling pin moved 750k → 1.5M.
   - `product_experience.spec.js`, `product_experience_css.unit.js`,
     `auth.spec.js`, `dashboard.spec.js` — the owner-requested hero rebuild
     (headline, centered layout, css `?v=8`, `usage` in APP_VIEWS).
   - `lifecycle_census.js` gained classifications for the two new tables
     (schema census requires every table to declare erasure behavior).
   - `retention.spec.js` unchanged — my first UNION rewrite dropped the
     caller-claimed-project conflict signal from the projection and the
     suite caught it; the projection keeps the JSON fallback (per-matched-row,
     no scan) and the test passes unmodified.
2. **Docs structure** — script parses (`new Function` gate), 71 NAV entries
   ↔ 71 pages 1:1, every internal `href="#/…"` resolves, banned vocabulary
   at zero, `conversation_pages_naming` 12/12 and `docs_connect_tool` 22/22
   green, Huba corpus hash-pinned to the docs file and rebuilt.
3. **EXPLAIN QUERY PLAN** — captured from **production** via the D1 API:
   both sweep queries `SEARCH memory_jobs USING INDEX
   idx_memory_jobs_status_updated` / `…_status_completed`. Also asserted
   permanently in CI (four plan-shape tests, including the prune slices and
   the retention UNION arms).
4. **rows_read before/after** — see Task 1b: 167,100/hr steady cron load →
   1,446/hr the hour the indexes landed; 5.68M/day baseline before.
5. **Live smoke test** — see Deployment below.
6. **Light + dark, mobile 375px** — verified in the running app: theme
   tokens resolve on every new surface in both themes (usage bars, Huba
   panel/fab, modals), landing + app at 375px with **zero horizontal
   scroll**, Huba panel becomes a full-width bottom sheet.
7. **Email** — invitation outbox + passwordless suites green; the
   upgrade-request owner notification exercised with the fake binding
   (exactly-once delivery under concurrent drains, skip-not-queue-forever
   when unconfigured) and delivered through the real local binding in dev.
8. **`AI_ROUTING` still `"off"`**, the Vertex/provider-adapter lane
   untouched (no file under `src/ai/providers/` or the routing/admin/shadow
   modules changed; `git diff --stat` confirms), and the AI-call census
   passes with the one deliberate addition (`src/huba/huba.js`).

## Deployment

<!-- DEPLOYMENT -->
