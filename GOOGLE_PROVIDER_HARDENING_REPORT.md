# Google Vertex provider hardening report

**Date:** 2026-08-23  
**Verdict:** **dark-code release candidate; live Google activation remains HOLD**

This report supersedes the readiness and test-count claims in
`PROVIDER_ADAPTER_REPORT.md`. It describes the audited worktree, not the
currently deployed Worker. No Google request, Google credential write,
Cloudflare migration, Worker deployment, production database mutation, or
cloud-credit spend was performed during this campaign.

## Safety posture during the audit

- Production and the local configuration remained `AI_ROUTING="off"`.
- The production configuration exposes no `GCP_PROJECT_ID`; the audit did not
  install or use a `GCP_SERVICE_ACCOUNT`.
- Google transport tests used injected local fakes. They did not contact OAuth,
  Vertex AI, Discovery Engine, or any other Google host.
- Production checks were read-only. The deployed Worker version was not
  changed, and pending migrations 0055/0056 were not applied remotely.

## Reproduced defects fixed

1. **Reservation/accounting races:** stable logical operation IDs, immutable
   price snapshots, reserve/invoke/settle CAS ownership, conservative charging
   for ambiguous outcomes, Retry-After handling, and D1-backed breaker leases.
2. **Primary privacy race:** deletion, account erasure, project lifecycle, and
   retention could previously overtake a preflighted Google call. The
   `reserved -> invoking` transition is now the external-call linearization
   point and atomically validates server-derived memory/account/project/run and
   retention provenance. Equal-millisecond fences fail closed.
3. **Shadow privacy/replay races:** one claimant owns a durable invocation;
   erase/lifecycle fences cancel non-invoking work and wait retryably for true
   in-flight work. Ambiguous invocations are never replayed.
4. **Credential exfiltration:** poisoned region/project/token-URI values could
   redirect a bearer-authenticated request. Project and region syntax are now
   strict, OAuth uses the canonical Google token endpoint, and the complete API
   authority is checked before token minting or attachment.
5. **Policy concurrency:** policy audit rows now belong to the exact winning
   mutation; same-timestamp concurrent writers cannot create ghost audit
   events.
6. **Account-erasure residue:** provider controls retain global routing/kill
   state while scrubbing erased allowlist members, actors, nested audit
   snapshots, notes, and override attribution. Commit-time tombstone fences
   prevent resurrection.
7. **Provider/model pinning:** stored row pins win retries; missing or malformed
   Google pins fail closed. Per-task operation ordinals prevent unrelated calls
   from shifting idempotency identities.
8. **Unsupported routing modes:** fake cross-provider fallback modes and
   metadata-only embedding shadow were removed from the writable policy
   surface. Unsafe interactive lanes remain Cloudflare-only.
9. **Removal correctness:** the removal gate now scans policies, nested pins,
   shadows, reservations, health probes, and historical fallback references.
10. **Lifecycle provenance erasure:** after live-invocation proof, account,
    memory, project-delete/purge, and retention flows scrub tenant identifiers
    from reservation evidence while retaining model/rate/spend truth and the
    exact duplicate-execution fence.
11. **Account rollout boundary:** Google policies no longer interpret a missing
    or malformed allowlist as all accounts. Every active Google route requires
    a syntactically valid, non-empty explicit allowlist at write and read time;
    runtime membership uses only the server-owned account lifecycle identity.
12. **Model/rate-card boundary:** only the explicitly priced, capability-valid
    Google model IDs are accepted. Moving aliases, unknown future models, and
    cross-capability model IDs fail closed before admission or billing.
13. **Test-secret isolation:** the Workers pool now uses a dedicated test
    configuration and controlled process-environment fakes. Full-suite output
    proves it did not load `.dev.vars`, a Google project ID, or a Google service
    account while exercising OAuth and provider transport behavior.

## Broad-suite defect fixed outside the Google adapter

The complete regression run also reproduced a host outbox defect: when a
custom HTTP transport returned headers but a response body ignored the request
AbortSignal and never closed, the locked body reader was left pending. The
reader now observes the same deadline, is explicitly cancelled once, and
returns the existing retry-safe timeout outcome. The focused outbox regression
is **56/56 passed**. Two Windows filesystem stress assertions were also made
timing-safe without weakening their ordering, durability, or nontermination
requirements; the batching regression is **32/32 passed**.

## Deterministic race proofs

- Erase-first at the same millisecond prevents the provider invocation.
- Invoke-first makes the destructive operation return a retryable hold; lease
  expiry alone is insufficient, and only conservative reservation retirement
  unblocks it.
- Stale project epoch, inactive project, equal retention cutoff, cancelled save
  owner, and cancelled atomic owner all fail admission.
- Account erasure, project archive/delete, and retention preserve content while
  a matching invocation is live, then complete with the documented archive or
  deletion semantics after the call is settled.
- A policy write paused before commit loses to an account tombstone and cannot
  recreate erased identity data.

## Verification completed on the final tree

- Consolidated Google/security/lifecycle gate: **16 files / 210 tests passed**.
- Concrete model-pinning gate after fixture hardening: **1 file / 6 tests passed**.
- Full unit lane: **41 files / 651 passed / 1 intentionally skipped**.
- Full Workers lane: **173 files / 2,214 tests passed**.
- Migration/checksum/schema policy gate: **3 files / 12 tests passed**.
- Migration checksums match the pending files:
  - 0055: `f49bd94d3833315718dc381c0f72d63ace24a92cd144fac26e566602153920f8`
  - 0056: `846b9f9b72772b3c0609d9628e23c914243c6dac516141dfa5124e2a7b451ae1`
- All **63** changed/untracked JavaScript and MJS files pass `node --check`.
- `git diff --check` is clean; the only message is a line-ending advisory for
  an existing Windows working-copy file.
- `wrangler types --check` confirms generated binding types are current.
- `npm audit --omit=dev --audit-level=high` reports **0 vulnerabilities**.
- `wrangler deploy --dry-run` succeeds and confirms the release configuration
  still carries `AI_ROUTING="off"` with no Google project/service-account
  binding. This was packaging validation only; nothing was deployed.

## Deliberate HOLDs and limits of the evidence

Offline tests cannot prove live Google IAM, API enablement, region/model
availability, quota behavior, billing attribution, Data Access logging, or
credit coverage. The currently pinned Gemini 2.5 generation models are also
scheduled to retire on **2026-10-20**. Live activation therefore remains HOLD
until a separately controlled Gemini 3.x contract test and the runbook's
health/quota/billing/rollback drills pass.

Terminal provider-reservation rows are retained intentionally: they are the
exact replay/idempotency fence as well as spend evidence. Deleting them after
an arbitrary age would permit the same logical operation to execute and bill
again. A bounded retention window may be introduced only as an explicit
product contract; it was not silently added during hardening.

## Authoritative next gate

Follow `GOOGLE_PROVIDER_RUNBOOK.md`. A safe dark schema/code deployment is a
separate owner-authorized operation. Live routing must remain off until the
model, IAM, quota-zero, billing, deletion, emergency-disable, and removal drills
are demonstrated against the intended Google project.

Official references used for the time-sensitive parts of this audit:

- [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Vertex AI generative pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing)
- [Vertex AI Search and ranking pricing](https://cloud.google.com/generative-ai-app-builder/pricing)
- [Google model lifecycle](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions)
