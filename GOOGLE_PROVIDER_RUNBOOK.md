# Google Vertex provider release runbook

**Status (2026-08-23): dark-code release candidate; live Google activation is HOLD.**

This adapter is detachable. `AI_ROUTING="off"` prevents **new policy resolution** but does not override a durable provider pin or an explicit admin health probe. A zero-Google hold therefore also requires no Google credentials/policies/pins, no live health probe, and a disabled provider override or `AI_ROUTING_KILL="1"` until the corrected removal gate is green. Missing, null, empty, malformed, or non-string-member account allowlists are deny-all at both the admin write door and policy read path; no Google policy has an implicit all-account meaning.

The routing vocabulary is `cloudflare_only`, `google_only`, `shadow`, and `canary`, but legality is lane-specific. Extraction/generation lanes may use the tested modes; interactive retry-unsafe lanes and the space-bound `embed`/`embed_profile` lanes are `cloudflare_only`. Embedding shadow is deliberately not advertised because the current comparison outbox exists only for extraction. Do not write or restore the retired `cf_primary_google_fallback` or `google_primary_cf_fallback` values: runtime fallback is not implemented, the policy door rejects them, and any historical row containing either value resolves Cloudflare-only. The removal gate still recognizes both strings solely to prevent legacy Google dependencies from escaping the removal census.

## Dark schema/code release gate

Before applying migrations 0055 and 0056:

1. Confirm the deployed Worker reports `AI_ROUTING="off"`, has no Google service-account secret/project configuration, and has no active Google routing policy.
2. Confirm there are no nonterminal shadow jobs, active provider reservations, or duplicate `ai_shadow_jobs.primary_run_id` values.
3. Because pre-0056 Workers use the old shadow lease protocol and pre-0055 Workers use the old reservation state machine, do not overlap an old active drainer or provider invocation with the migration. Keep routing dark, stop new admission, wait at least the longest old lease/reservation window, and require zero running/leased jobs and zero active reservations before applying 0055/0056 and deploying the matching Worker.
4. Take a D1 Time Travel bookmark, apply migrations through Wrangler, verify the migration ledger and new columns/indexes, then deploy the matching code.
5. Canary `/health`, the ordinary Workers AI save/recall path, and the admin removal gate. The expected Google call count remains zero.

Read-only preflight queries:

```sql
SELECT COUNT(*) AS duplicate_primary_runs
FROM (
  SELECT primary_run_id
  FROM ai_shadow_jobs
  GROUP BY primary_run_id
  HAVING COUNT(*) > 1
);

SELECT status, COUNT(*) AS count
FROM ai_shadow_jobs
GROUP BY status;

SELECT status, COUNT(*) AS count
FROM ai_provider_reservations
GROUP BY status;

SELECT capability, mode, primary_provider, shadow_provider, disabled
FROM ai_routing_policies
ORDER BY capability;
```

## Runtime invariants that must not be weakened

1. `ai_provider_reservations.status='invoking'` is the single durable owner of
   an external Google call. The `reserved -> invoking` CAS must keep validating
   server-derived deletion, account, project-epoch, retention, and owner-run
   provenance in the same D1 transaction. A preflight check is not a substitute.
2. Destructive workflows install their fence first and return a retryable hold
   while a matching `invoking` row exists. Do not treat lease expiry as proof
   that Google did not receive a POST; only the conservative reaper may retire
   an expired invocation as `ambiguous_charged`.
3. Terminal reservation rows are the exact replay/idempotency fence. Do not add
   age-only deletion without explicitly changing the product contract to a
   bounded idempotency window and proving shadow/atomic retry owners cannot
   still depend on the row. Tenant provenance may be scrubbed after erasure;
   the stable operation ID and terminal state remain.
4. The complete Google URL authority must be validated before OAuth token mint
   or bearer attachment. Only the canonical OAuth token host, the configured
   regional Vertex host, and the exact Discovery Engine host are allowed.
5. Synthetic provider health is the sole lifecycle exemption and must retain a
   fixed non-user prompt. User-content lanes without a durable lifecycle owner
   remain Cloudflare-only.

## Live activation gate (currently HOLD)

Do not set `AI_ROUTING` to `track`/`on`, add a Google routing policy, or run the live health call until all of these are complete:

1. Select currently supported Vertex model IDs and locations. The pinned Gemini 2.5 generation models in the dark adapter retire on **2026-10-20**; migrate and test the intended Gemini 3.x request contract separately before activation. Do not silently change a model under an existing pin.
2. Revalidate model parameters, response schema behavior, token accounting, retry semantics, regions, quotas, and public prices. Update the versioned rate card if any SKU changes.
3. Provision a dedicated Google Cloud project/service account with only the required Vertex permissions. Enable required APIs, Data Access audit logs, quota clamps, and budget alerts. Store credentials only as a Worker secret; never in source, vars, logs, D1, or test fixtures.
4. Run the one-shot admin health check with an explicit idempotency key. Prove authentication, a single provider invocation, reservation/settlement, audit output, and billing attribution.
5. Run a quota-zero denial drill and emergency-disable drill. Both must fail closed without provider invocation or budget leakage.
6. Start with synthetic/benchmark identities in shadow-only mode. Every enabled Google policy must carry an explicit, non-empty list of server-owned account IDs; verify a listed identity routes and an unlisted identity does not. Promote only after paired quality, latency, cost, deletion, retry, and rollback gates pass.

## Emergency and removal sequence

1. Use the admin emergency disable first (D1 propagation, no deploy).
2. Set `AI_ROUTING_KILL="1"` and deploy for the hard stop, including durable pins and explicit health probes. Restoring `AI_ROUTING="off"` stops only new policy resolution and must not be represented as equivalent to the kill switch.
3. Drain or cancel all pinned/running work and reservations. The removal gate must report zero policies, pins, nonterminal shadow work, active reservations, and half-open probe leases.
4. Remove the Google secret/config only after the gate is green. A previous Worker version remains the hard code rollback.

Never interpret a green offline suite as proof that Google IAM, quota, billing, or a live model-region pair works. Those require the controlled live activation drill above.
