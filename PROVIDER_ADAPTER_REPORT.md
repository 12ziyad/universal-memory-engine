# Provider-Adapter Campaign — Delivery Report

**Date:** 2026-08-22 · **Scope:** Phases 0A, 0B, 1, 2 of the approved rev-3 architecture plan — built in one pass, deployed dark behind `AI_ROUTING="off"`.

Google Vertex AI now exists as a fully detachable provider beside Cloudflare Workers AI. **Nothing routes to it.** No Google credentials exist, no GCP project exists, and production behavior is provably unchanged except one documented accounting fix. Turning Google on is a config decision (secret + var + policy row) — never a build.

---

## What shipped

### Phase 0A — accounting completeness (one documented behavior change)
- `ai_calls` gained `provider / capability / model_version / error_class / retry_count / call_role` (migration **0052**), all nullable — NULL reads as the legacy meaning (Workers AI, primary).
- The six unmetered lanes are now metered: digest (both callers), MCP title pass, manual action router, playground preview + chat. `withFlushedAiMeter` in [ai_meter.js](src/lib/ai_meter.js) is the shared one-shot scope.
- **The documented behavior change:** `playground_chat` — published in `GET /v1/limits` `counted_scopes` since migration 0021 but never actually recorded — now counts: one scope_id per turn. A playground turn whose capture also fires can therefore count as up to 2 of the monthly 1000 writes (chat + save), which is the published contract finally enforced. `rules_preview` stays unmetered **by its own module contract** ("a preview must not create usage rows"); Google spend control does not depend on ai_calls coverage (reservations are the enforcement), so this exception is safe and documented.

### Phase 0B — the provider layer, provably byte-identical
- `src/ai/`: dispatch, registry, policy, pin, capabilities. `runAi` keeps its exact signature; `env.AI.run` now exists in exactly ONE file ([cloudflare.js](src/ai/providers/cloudflare.js)), byte-for-byte the two lines that lived in ai_meter.js, options-arity branch included.
- **Proof, not claim:** `test/ai_golden_forwarding.spec.js` replays one flow through every input shape and structured-output mechanism against fixtures captured BEFORE the refactor ([ai_forwarding_golden.json](eval/fixtures/ai_forwarding_golden.json)) — the binding receives identical bytes, both lanes green.
- **Deterministic pins** (migration **0053**): `extraction_runs.provider/model/pin_json` + `semantic_atom_capture_runs.provider`. Policy is resolved once at claim time inside the existing inference fence ([db.js](src/lib/db.js) `claimExtractionRun`); every re-claim executes the ROW's pin (row-wins); the throw is reserved for a forced contradiction. **A run id never changes provider.** The atomic lane's pre-existing gap — model recorded but the constant invoked — is closed: reclaims replay the row's model.
- **Routing policy**: lane-keyed D1 table + audit, read through a 30s isolate cache with stale grace; any read failure resolves cloudflare-only. Master gate `AI_ROUTING` var (off/track/on, default **off** — zero D1 reads) + `AI_ROUTING_KILL`. Legality matrix enforced at the admin door AND at read time: write lanes can never have fallback modes; embedding lanes can never reach a foreign space.
- **Architecture census** ([ai_call_census.js](src/lib/ai_call_census.js) + gate spec): binding invocation only in the CF provider; Google AI hostnames only under `src/ai/providers/google/`; providers imported only via the registry; the direct-`runAi`-importer set pinned.

### Phase 1 — Google adapter + hard cost control (dead code without credentials)
- [src/ai/providers/google/](src/ai/providers/google/): auth (WebCrypto RS256 JWT → OAuth exchange, isolate cache, single-flight, enum-only errors), client (per-lane AbortController timeouts, 2 jittered transient retries honoring Retry-After, one 401 re-auth, structural redaction), map (system→systemInstruction, thinking off on flash, BLOCK_NONE safety, JSON-Schema→responseSchema translator that hard-fails on `$ref`/untranslatable, responses normalized to the shapes `responseText`/`readUsage`/`responseRefused` already parse — **no call site ever learns a Google shape existed**), models (pinned ids — verify against the live catalog at enablement).
- **Reserve/settle spend ledger** ([provider_budget.js](src/ai/provider_budget.js), rev-3 design): one fenced D1 batch per reservation (fence_guard poisons the batch at any ceiling), attempt-token idempotency (a retried batch can never double-count), CAS settle/release, cron reaping of expired reservations. Unit classes separate (`gen_tokens`/`embed_tokens`/`rank_units` daily ceilings) + monthly `cost_micros` ceiling on the pinned rate card ([rate_cards.js](src/ai/rate_cards.js) — **conservative estimates; verify against live Vertex pricing before any non-shadow spend**). Circuit breaker: 2 billing-class or 5 generic consecutive failures trip; doubling cooldown; single half-open probe; D1 health-row convergence. Fails CLOSED for Google everywhere.
- Admission taxonomy is exact: refused **new** work → `admission_reroute` to Workers AI; refused **pinned** work → typed throw into the run's normal retry ladder (never a provider switch); read lanes keep their existing degrade floors.

### Phase 2 — shadow-extraction outbox (inert until a policy row exists)
- Migration **0054** `ai_shadow_jobs`: content-minimized (pointers + pin + content-free metrics; no prompt, no output), user-scoped, in `PURGE_SPACE_TABLES`.
- **Enqueue is atomic with settlement**: a shadow-sampled `wrote` commit carries the outbox INSERT in the same D1 batch ([write.js](src/pipeline/write.js)); deterministic reconciliation in the cron creates any sampled job other settlement paths missed. Sampling decided once per run, at claim, into the pin.
- **Drain** (5-min cron): claim/lease/attempts(≤2)/dead-letter; input re-derived from immutable scrubbed `source_episodes`; deletion barrier checked before AND after the model call (`cancelled_erased`); the shadow call runs the SAME `proposeMemory` path under a shadow pin so dispatch routes it — comparison is the normalized proposal vs the primary's committed counts + hashed-label Jaccard, stored content-free. 30-day retention purge. Metered as scope `shadow_extract`, excluded from receipts and the monthly quota.
- **Control plane**: `GET/POST /v1/admin/ai-routing` (CAS + audit), `POST .../emergency-disable` (≤60s propagation, no deploy, can only reduce Google usage), `POST .../health-check` (one tiny live call, admin-only), `/health` exposes modes only, and an "AI providers" card on the admin health tab with the red button.
- **Removal gate** ([admin.js](src/ai/admin.js) `removalGate`): zero nonterminal Google runs/atomic runs/shadow jobs/active reservations/admitting policies — mechanized in `test/ai_removal.spec.js`; the Google-less default test env makes every suite run a standing removal drill.

## Verification

- Golden forwarding green in both lanes **after** the refactor (byte-identical proof).
- New spec files: `ai_meter_extension` (6), `ai_golden_forwarding` (1×2 lanes), `ai_architecture_gate` (1), `ai_pinning` (5), `ai_reservation` (8), `ai_shadow` (6), `ai_removal` (4), `ai_taxonomy` (4), `google_adapter` (13), `ai_credential_scan` (1) — all green.
- Full regression: **Workers pool 167 files / 2,111 tests, unit lane 40 files / 633 tests — green.** (Two first-pass failures, both mechanical and fixed: migration 0054 initially unregistered in CHECKSUMS.json; test/index.spec.js's exact-match `/health` expectation extended with the new `ai_routing` block.)
- Migrations 0052/0053/0054 applied remotely after a D1 Time Travel bookmark; read-back verified. Deploy dark; `/health` canary shows `ai_routing: { mode: "off" }`.

## Deviations from the plan file (all conservative)

1. `rules_preview` left unmetered (its own no-persistence contract; documented above).
2. `evals/locomo/ai_cost.js` rate-card import deferred (CJS↔ESM friction); the shared constant exists in rate_cards.js, wiring is a follow-up.
3. Shadow drain recomputes the shortlist at drain time and uses account rules defaults — comparison conditions approximate the primary's (documented in shadow.js); the promotion instrument remains the paired LoCoMo run, not the online metric.
4. waitUntil accelerator not wired — cron-only delivery (≤5 min latency) for an observational lane; D1+cron is the durability mechanism per rev 3 regardless.
5. Policy rows are LANE-keyed (extract, digest, rerank, …) with legality derived from the lane's contract capability — finer control than contract-keyed, matching the plan's per-capability independence requirement.
6. Provider id canonicalized as `workers-ai` (matches ai_calls NULL semantics and the LLM_PROVIDER var), not "cloudflare".

## What the owner does next (nothing else moves without you)

1. **One browser step**: install gcloud (`winget install Google.CloudSDK`), then `gcloud auth login`.
2. I then run the scripted provisioning (plan §appendix): project, APIs, service accounts, **minimum custom role**, Data Access audit logs, quota clamps LOW, budget alarms (informational), key → `wrangler secret put GCP_SERVICE_ACCOUNT`, set `GCP_PROJECT_ID` var.
3. Phase 1 exit: admin health-check green + live billing drill (quota-clamp-to-zero) + broad dev-role removal.
4. Phase 2 shadow: allowlist = **synthetic canaries + LoCoMo users only**; your own account joins only on your explicit post-disclosure opt-in (Vertex is not zero-retention by default — data-caching disable + abuse-monitoring terms review are on the checklist).
5. Promotion is gated by the plan §10 numbers — the 90-day credit clock is not a criterion.

## Rollback levers, fastest first

1. Admin **emergency-disable** (D1, ≤60s, phone-friendly, reduce-only).
2. `AI_ROUTING_KILL="1"` or `AI_ROUTING="off"` + deploy.
3. Previous Worker version (hard rollback); D1 Time Travel bookmark covers schema.
