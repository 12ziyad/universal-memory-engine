# V3-D04 - INTERRUPTED MULTI-CHUNK CAPTURE REPLAY

Status: **HIGH - IMPLEMENTED AND FULLY GATED; PRODUCTION REATTACK PENDING**

## Discovery boundary

The frozen Stage E product process completed all 272 sessions / 5,882 messages,
then stopped before any answer, reference, judge, or score phase. Its strict
reference-blind state audit found two accepted packets with incomplete atomic
capture accounting. The global benchmark lock was released; no answer or score
artifact exists.

Production-primary inspection proved the same shape for both packets:

- one atomic sub-chunk was `completed` with 11 / 8 stored candidates;
- one later sub-chunk remained `running`, attempts 1, stored 0, beyond the
  15-minute interruption margin;
- the parent extraction run was durably `failed` with
  `inference_outcome_unknown`;
- an exact replay had nevertheless left the memory job falsely `enriched` with
  no repair attempt.

This reclassifies the original V3-I04 infrastructure symptom as a product HIGH:
an accepted multi-chunk packet could lose the interrupted suffix permanently.

## Root cause

Four individually reasonable mechanisms composed into data loss:

1. failed settlement added message identities to the Durable Object `seen` set;
2. exact failed replay reset job status but did not restore
   `payload.remaining`;
3. the replay reused the original handoff identity and was skipped by `seen`;
4. stale atomic runs were marked `interrupted_unknown` but could not be
   reclaimed, and a late old attempt had no attempt fence.

The resulting replay could settle `enriched` without re-running the missing
chunk. A second race existed after the D1 repair compare-and-set but before the
winner's Durable Object handoff: a follower did not join the active repair
generation and could take the same zero-write path.

## Repair

- Failed extraction settlement no longer records identities as successfully
  seen.
- Exact repair reopens the same job with a bounded monotonic
  `repair_generation`, restores the exact accepted message IDs in
  `payload.remaining`, stages the original scrubbed text, and uses a
  generation-bound handoff identity.
- Concurrent replays join an already-active durable repair generation.
- Durable Object held/queued ownership is generation-aware. Older local queue
  state is superseded without inference, and per-message D1 settlement rejects
  every generation other than the one currently bound in `payload_json`.
- An `enriched` job may reopen only when a tenant-, packet-, and project-bound
  atomic ledger proves a stale/known-interrupted zero-candidate chunk.
- Atomic interrupted chunks are reclaimed one at a time. Candidate inserts,
  terminal run updates, and failure updates are fenced by the current attempt;
  a late superseded invocation cannot publish or overwrite the repair.
- Repair is bounded to five job generations / six atomic attempts. Erasure and
  ordinary terminal idempotency remain immutable.

No schema or migration is required.

## Failing-first and regression evidence

`test/interrupted_capture_replay.spec.js` deterministically reproduced and now
proves nine boundaries without Workers AI:

1. failed identities are not marked seen;
2. a legacy polluted failed replay performs a real write;
3. a follower joins the active post-CAS repair generation;
4. a falsely enriched job reopens only with exact interrupted-ledger proof;
5. ordinary enriched replay remains immutable;
6. another project's ledger cannot authorize repair;
7. a superseded atomic attempt cannot publish after reclamation.
8. stale older-generation Durable Object queue ownership cannot absorb or
   settle the repair;
9. stale settlement is a no-op against a newer durable repair generation.

Authoritative pre-deploy gates:

- exact V3-D04: **9/9 pass**;
- replay/erasure/rules/secret/project/source focused slice: **18 files / 192
  tests pass** before the final race hardening;
- full serialized Worker: **112 files / 1,322 tests pass**;
- unit/cross-door: **539 pass / 1 intentional skip**;
- `npm audit`: **0 vulnerabilities**;
- `git diff --check`: pass;
- Wrangler 4.120 dry deployment: pass.

## Production reattack contract

Deploy the exact gated code with the existing Stage E feature allowlists. Then
exact-replay only the two original frozen packet identities. Before any answer
or score phase, production-primary evidence must prove:

- both jobs terminal `enriched`, repair generation/attempt 1;
- exactly one successful terminal extraction after the bounded failed
  predecessor;
- every atomic run terminal `completed` or `empty`;
- completed first chunks were replayed, not re-inferred;
- only the two stale zero-candidate chunks were reclaimed;
- candidate/projection/provenance accounting is exact;
- no cross-tenant/project state, duplicate explosion, or nonterminal job.

Only after that proof may the same frozen Stage E manifest proceed to reader and
judge inference. Any inconsistency stops the run rather than salvaging it.
