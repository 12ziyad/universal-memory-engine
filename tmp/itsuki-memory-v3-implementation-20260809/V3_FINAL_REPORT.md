# ITSUKI MEMORY V3 — FINAL REPORT

## 2026-08-11 Stage C bounded-recall repair - authoritative interim status

V3-D13 is **CLOSED**. The repaired production-schema 1k/10k/100k cells all pass
with zero inference and zero final fixture state. At 100k, broad recall fell
from 510,978 ms failing-first to 2,596 ms (about 196.8x), while the maximum
node/slice/edge evidence load remained 600 and the reader-facing output stayed
bounded to 200 items / 24,000 characters. Scope, exact source expansion,
deletion and both FTS erasure gates passed. Full Worker 1,313/1,313, unit 539/
539 + one skip, audit and dry-deploy gates pass. Commit/origin `5f11d75` is live
at Worker `052d9b68-b131-45cb-b792-1804c86a50d6`; 20/20 propagation and the
exact bounded production reattack passed, with cleanup still zero. Stage D
repeated holdout and the final full LoCoMo validation have not started.

## 2026-08-11 final Stage B closure — authoritative interim status

Final live security/isolation/erasure/concurrency/bounded-soak validation is
**PASS**. The valid run had zero accepted loss, zero cross-scope evidence, zero
secret/rules survival, zero post-erasure recall/FTS/content residue and zero
final V3/job state. Its 10-write/200-recall soak drained and held a 30-second
grace; valid burn was 2,227 neurons (ending 1,914,246 / 3,000,000). V3-D10,
V3-D11 and V3-D12 HIGH are closed; no CRITICAL/HIGH is open at this boundary.
Stage C local scale, repeated holdout, final full LoCoMo and final cleanup remain.
Full evidence: `final/STAGE-B-FINAL.md`.

The validated lanes were then safely closed at Worker version
`2cb1f213-0f3f-4cbc-87e1-e5d04ddabb17`, deployment
`33986e9a-65c4-48ef-9f5b-cc595675bd12`: 20/20 propagation checks passed,
write/source/rejected lanes are OFF/0, E7 hybrid is historical d04 only, live
treatment state is zero and all 809 packet fences are content-free.

## 2026-08-11 E9B closure / E10 next — authoritative

## 2026-08-11 E10 closure / final validation next - authoritative

This remains an interim campaign report, not the final verdict. E10 adaptive
context is **REJECT**. On a sealed 42-question non-LoCoMo state, it preserved
identical selected items but compressed context 30.45% by removing useful
assertions: availability fell 97.62% -> 83.33%, judge fell 92.86% -> 88.10%
and token-F1 fell 68.59% -> 63.13%. The frozen-399 E10 stage was not run.

The final-validation candidate keeps E7 assertion-level fusion and E9A exact
source expansion, while excluding reranking, E9B fallback and E10 caps. Repo
and origin are `aa16f8a1eded327aaa2af95a933dcc88032b6433`; production deployment
is `eaae0273-d09d-4e97-af95-f336315d040e`, Worker version
`7bb3ac6b-8c50-48e7-aa33-b3250deef657`. All E10/E9A/write flags are OFF/0,
E7 is restored to its d04 ten, synthetic E10 state is zero, and health is 20/20.
Settled burn is 1,904,127 / 3,000,000. Final security, erasure, replay,
cross-door, concurrency, soak, scale, repeated holdout, complete LoCoMo and
cleanup remain pending.

Full E10 evidence: `e10/E10-ADAPTIVE-CONTEXT-RESULT.md`.

This remains an interim campaign report, not the final verdict. E9A exact
source expansion is **KEEP**; E9B bounded episode FTS fallback is **REJECT**.
On the frozen general holdout, E9B left judge at 41/42, availability at 40/42
and conditional accuracy at 40/40. It triggered 18 times but rendered zero
episodes because 23/24 FTS hits were already exact E9A duplicates; all 42
contexts were byte-identical while recall p95 rose 68 -> 109 ms (+60.29%).

Repo/origin is `6282988c92dba786d3b988fdb851861acb0a7319`; production Worker is
`b7fffb0e-357a-4f90-9f0e-31a644c6814c`, deployment
`9daefc1d-a017-4d1d-9ac1-003b60f6c49e`. Every write flag, E9A and E9B are
OFF/0; E7 is restricted to its prior ten benchmark tenants. Cleanup is zero.
Settled campaign burn is 1,896,203 / 3,000,000. E10 adaptive context, final
security/concurrency/soak/scale, final holdout, complete LoCoMo and final
cleanup remain pending.

Full current evidence: `e9/E9A-SOURCE-EXPANSION-RESULT.md` and
`e9b/E9B-EPISODE-FALLBACK-RESULT.md`.

Campaign root `tmp/itsuki-memory-v3-implementation-20260809/` · 2026-08-09
Current deployed commit `6282988c` · Worker version `b7fffb0e-357a-4f90-9f0e-31a644c6814c`

## 2026-08-10 campaign continuation — authoritative interim status

This report is not yet the final verdict. The historical cost-gate narrative
below is retained as evidence but is superseded by owner authorization and the
3,000,000-neuron fail-closed ceiling.

Current validated progression:

- V1 judge 25.65% / availability 28.83% / temporal 6.23%.
- D03+D04 judge 27.92% / availability 30.45% / temporal 16.51%.
- E1+E0 full judge 46.75% / token-F1 27.45% / availability 65.97% /
  conditional 58.27%.
- E8 tested reranker: all four arms rejected.
- E2: B0 reliability kept; B1 behavior rejected.
- E3: acceptance-atomic episodes kept; 100% exact source coverage and 97.78%
  paired recovery of semantic misses; no episodes entered reader context.
- E4 source-grounded atomic lane: KEEP after three production-path seeds;
  capture recall 74.55%, precision 99.25%, F1 85.08%, schema 100%, with zero
  accepted safety/provenance/replay/erasure failures. It remains write-only.
- E5 deterministic temporal representation: KEEP. Direct frozen cases 16/16,
  captured targets 24/24, repaired production proof 7/7 source-time anchored.
  V3-D08 HIGH (source time dropped at the Durable Object handoff) is closed.
- Current repo/origin `525d4abe3a53771c6ab4ba59abf9af8661f514ea`;
  Worker `46990d10-410e-4e17-b36d-a50583323d5d`; burn
  1,716,541 / 3,000,000. Atomic capture is OFF/count 0 on both domains.

E6–E10, final security/concurrency/soak/scale, final
holdout, final LoCoMo, and complete cleanup are still pending. No
production-wide enablement is authorized.


---

## THE HEADLINE, STATED FIRST

**The V3 write path is built, deployed, and OFF. No benchmark number moved,
because no benchmark was run.**

The campaign requires a numeric neuron ceiling, derived from a *verified* credit
situation, before the first new inference call (§4). That verification was
attempted and failed, so the ceiling is `null` and **zero inference calls were
made** — no extraction, no embedding, no reader, no judge, no bakeoff, no
recall. Every ablation harness is built and armed; none has been executed.

What that leaves is everything that is deterministic, and it turned out to
contain three real defects, two of which are mechanical causes of the exact
weaknesses the baselines measured.

### VERDICT

| dimension | verdict |
|---|---|
| ARCHITECTURE | **CONDITIONAL** — built, tested, deployed, flag OFF. Unmeasured. |
| SECURITY | **PASS** (deterministic). Live re-attack blocked by the cost gate. |
| DURABILITY | **PASS** (deterministic). Soak blocked by the cost gate. |
| ERASURE | **PASS** — including the new episode layer and its FTS index. |
| TENANT ISOLATION | **PASS** |
| PROJECT ISOLATION | **PASS** |
| SUB-TENANT ISOLATION | **PASS** |
| GENERAL HOLDOUT | **PARTIAL** — 16/16 frozen temporal targets pass. Capture and recall portions need inference. |
| LOCOMO TOKEN-F1 | 15.40% → **NOT MEASURED** |
| LOCOMO LLM-JUDGE | 25.65% → **NOT MEASURED** |
| EVIDENCE AVAILABILITY | 28.83% → **NOT MEASURED** |
| CONDITIONAL READER ACCURACY | 61.04% → **NOT MEASURED** |
| TEMPORAL | 6.23% → **NOT MEASURED** |
| INFERENCE / NEURON USE | **0** |
| STORAGE DELTA | 3 nullable columns; 1 new table, empty in production |
| PRODUCTION ENABLEMENT | **DO NOT ENABLE V3 YET.** The defect fixes are already live and ungated; V3 itself needs its ablations first. |

I am not going to report a projected score. The 60–70% target in the prompt is
explicitly not a release gate, and an estimate presented next to real baselines
would be indistinguishable from a measurement.

---

## 1. THE COST GATE — why nothing was measured

`cost-ledger.json` holds the evidence. Every probe was read-only:

| probe | result |
|---|---|
| `wrangler whoami` | OAuth token, account `b6009ce8…`, scopes include `account (read)`, `ai (write)`, `d1 (write)` — **no billing scope** |
| `GET /client/v4/accounts` | **200** — the token is live and valid |
| `GET /accounts/{acct}/subscriptions` | **401** |
| GraphQL `aiInferenceAdaptiveGroups` (neuron usage) | **401** |
| `GET /accounts/{acct}/ai/models/search` | **401** |
| `CLOUDFLARE_API_TOKEN` in environment | absent |
| wrangler billing/credit command | does not exist |

The prior LLM-judge campaign reached the same conclusion independently.

**`V3_NEURON_CEILING = null`. Verdict: CREDIT COVERAGE / COST CEILING UNVERIFIED.**

Campaign §4 says plainly what to do next: *"Continue only non-inference
engineering that remains safe."* Stop-condition B requires that no independent
work remains, and the opposite was true — BF-1, BF-2, extraction reliability,
episodes, temporal architecture, the flag, the migrations and the entire
deterministic security programme were all available. So the campaign continued,
and the inference-gated half is left armed rather than guessed at.

One consequence worth naming: `/v1/recall` calls `embed()`, so *live production
recall* is an inference call and was blocked too. Production proof was therefore
limited to surfaces that spend nothing.

---

## 2. WHAT SHIPPED

Five components, each with failing-first tests, in the order §60 prescribes.

### The flag — `ITSUKI_MEMORY_V3`

`off` / `allowlist` / `on`, **off** in production and verified live. Fails
closed on any unrecognised value, so no typo can enable it. Resolved from
`(env, userId)` only — there is no request body, header, query parameter or
scope object that reaches it, which is what makes cross-tenant bleed impossible
by construction rather than by care. Allowlist membership is whole-string and
case-sensitive: `user_1` never matches `user_10`. `GET /health` reports the mode
and how many accounts are selected, never which ones.

### BF-1 — the source-time contract

`/v1/ingest`, `/v1/save` and `/v1/turn` accept an optional `sourceTime`, at the
batch level and per message. Absent, everything behaves exactly as before,
**including the content hash** — so every already-issued idempotency key and
every replay stays valid, pinned by test.

Three things it refuses rather than guesses:

- a date-time with no UTC offset, because the same text means a different
  instant on every machine that parses it;
- a timestamp on or before the Unix epoch day, because that is how an
  uninitialised field looks, not a memory;
- anything more than 48 hours ahead of the server clock.

The offset is kept rather than folded away. "Yesterday" said at `00:30+09:00`
means the previous day *in Tokyo*, and the UTC date of that instant is a day
earlier again. A bare `YYYY-MM-DD` keeps precision `day` and is never promoted
to midnight.

### BF-2 — the recall limit

The parameter was allowlisted, documented, exposed by both SDKs, and dropped one
line short of the code that could use it. It now works or fails by name, and
every response reports `limit_requested`, `limit_applied`, `limit_mode` and
`evidence_budget` so a mismatch is visible.

Narrowing and widening are separated deliberately. Legacy accounts get narrowing
only — `limit` can reduce what the proven path returned but never raise it — so
a published SDK caller sending `limit: 200` today keeps the behaviour they have,
and nobody's retrieval gets deeper without being selected for it. V3 accounts
get real depth to 200, with the internal candidate budget scaled alongside and
still bounded by constants the caller cannot move (Vectorize topK 100, BM25 200,
graph expansion 200, context 24,000 characters, event scan 4,000).

### P0-C — extraction mechanical reliability (ungated)

Splitting is now a pure function bounded by message count **and** characters,
because eight messages at the 4,000-character wire limit are 32,000 characters
and counting messages alone was never a budget. Being pure buys three properties
that can be stated and tested: every accepted message lands in exactly one
sub-chunk, sub-chunks are contiguous and ordered, and a retry re-derives the
same sub-chunks with the same identities. Coverage is verified on every real
extraction, not only in tests.

It also closed a hole between two guards: the old threshold split only chunks
*longer* than 10 messages while the rescue refused *more than 8*, so a chunk of
exactly 9 or 10 whose response came back truncated had no recovery path and the
fire wrote nothing.

And a truncated response no longer discards the facts that completed before the
cut. The parser walks the objects array, keeps every element that closed,
discards the one still open, and marks the proposal truncated so the receipt
says the response was cut off instead of the save just looking small.

Schema-constrained output is wired but **default OFF**: whether a given Workers
AI model honours `response_format` is a live fact about that model, and
asserting it from a config file would be a guess.

### P0-D — searchable source episodes

Source preservation is now separate from semantic promotion. Every permitted
accepted message is written at accept time, before the model is consulted at
all, and is searchable by BM25 over FTS5. Extraction stays free to decline;
declining no longer erases.

This is the most dangerous thing V3 adds, because it is durable searchable user
text, so it is bounded on every side: secrets are already gone before it runs,
exclude rules are enforced by the writer, tool and system turns are not
preserved, rows and reads are capped, replay is idempotent, and project scope is
filtered **in SQL** rather than after the fact — a post-filter lets another
project's rows fill the LIMIT before the requested one is seen.

Erasure is a hard delete. Everywhere else a tombstone is right because the row
is derived memory with support value; this row is the user's own words, and a
soft-deleted episode is retained text with a flag on it. The FTS triggers drop
the tokens in the same statement, and the erasure convergence loop counts
episodes too.

### P1 — temporal architecture

Deterministic normalization anchored on when content was *written*. No model
call is made or needed, so it is free, identical on replay, and testable without
spending anything. It resolves against the source's own civil day, not UTC's,
and it refuses "someday", "eventually", "soon" and "recently" outright — a wrong
date presented as certain is worse than no date, because the graph will rank it
and the reader will believe it. Precision travels with every result: "last week"
is a week, not a Thursday.

---

## 3. THE DEFECTS — the part that was not planned

### V3-D03 (HIGH) — the extractor's event date never reached storage

```
/^s*(d{4})-(d{2})-(d{2})s*$/
```

The backslashes are missing. That pattern matches the literal text
`sssd{4}-d{2}-d{2}` and never a date. The extraction system prompt has always
instructed the model to copy an explicit date out of the source; the gate that
reads it has always thrown it away — silently, because the fallback is the
message timestamp. **Every event ever written carried the moment Itsuki was
told, not the moment the thing happened.** Both `happened_at` sites had the same
line; the second was found only because the failing test still failed after the
first fix.

This is a mechanical cause of temporal recall at 6.23% — the one LoCoMo category
that gets *worse* under semantic judging, which had already ruled out wording as
the explanation and pointed somewhere exactly like this.

### V3-D01 (HIGH) — an unreadable rules store meant "no rules"

`getMemoryRules` caught every read error and returned defaults, so the
fail-closed handling in `staged_text.js` and in the new episode writer could
never fire. A transient D1 failure on one `SELECT` converted an account's
`excludes: ["salary"]` into "keep everything" — durably in `staged_memories`
(recallable) and, with V3 on, in `source_episodes` (searchable). Admission now
fails closed; a missing *table* still means defaults, because a table that does
not exist cannot hold a rule.

### V3-D02 (LOW) — a delete that reported six of two

`deleteSourceEpisodes` trusted the driver's changed-row count, which includes
FTS trigger churn. It counts before and after instead.

Full lifecycle records for all three are in `defects.md`.

---

## 4. WHAT IS PROVEN, AND WHAT IS NOT

**Proven deterministically** (99 files / 1173 Workers tests, 33 / 539 unit
tests, all passing; from a 91/987 and 32/522 baseline):

tenant, sub-tenant and project isolation of episodes and their FTS index ·
secret scrubbing end to end through the real ingest door · rules enforcement
including the fail-closed path · erasure convergence with the index queried
directly · flag isolation and fail-closed defaults · replay stability of chunk
identity and content hashes · timezone and DST correctness · refusal to
fabricate temporal precision · 16/16 frozen holdout temporal targets.

**Proven in production, without spending a neuron:** the flag reads `off` live;
`limit: 0` is refused with a named 400 *before* any retrieval work; `sourceTime`
is refused by name while V3 is off; a malformed `sourceTime` returns a 422 about
the timestamp rather than about entitlement; the migrations applied and the
schema reads back correct.

**Not proven, all for the same reason:** every benchmark, every ablation, the
extraction model bakeoff, concurrency and soak at volume, and live re-attack of
any defect. All need inference. The gate is closed.

---

## 5. WHAT I WOULD DO NEXT, IN ORDER

1. **Confirm Workers AI credit coverage and state a neuron budget.** Everything
   below is blocked on this one sentence from the owner.
2. **Run E0, the reader ceiling.** The frozen-context precondition is verified —
   all 1,540 judged questions retain the exact context that produced them — so
   it is a true reader ablation, and its branch (§10) decides how much of the
   rest is even worth building.
3. **Re-run the LoCoMo baseline on the fixed date parser alone.** V3-D03 was
   live during the 15.40% / 25.65% runs. Some part of the 6.23% temporal figure
   is that bug, and nobody knows how much. This is the cheapest informative
   experiment available and it needs no V3 account.
4. Then E1 (depth), E2 (capture), E3 (episodes), E5 (temporal) in that order,
   each against the frozen holdout as well as LoCoMo.
5. Enable V3 for one benchmark tenant only. Not for users.

---

## 6. HONEST CAVEATS

- **No number in this report is a measurement of V3's quality**, because none
  was taken. The baselines quoted are the prior campaigns', unmodified and
  hash-frozen.
- **The chunk-size constants are unvalidated.** `EXTRACT_CHUNK_MAX_CHARS = 6000`
  is a reasoned guess against an output budget, not a measured optimum. It is an
  env dial precisely so evidence can move it.
- **The V3 flag has never been on in production.** Its ON path is proven by
  test, not by production traffic.
- **§7's build→test→ablate→decide loop was followed as far as the gate allows.**
  Components were gated on deterministic evidence — coverage invariants,
  property tests, and the measured failure-stage analysis — and the ablation
  slots remain open rather than being filled with reasoning.
- **One test's contract was deliberately changed** (`split_rescue.spec.js`), and
  the change is documented in the test, in `decision-log.md` D-008, and in the
  commit rather than quietly adjusted to pass.
