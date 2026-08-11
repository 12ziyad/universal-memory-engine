# V3 DECISION LOG

## 2026-08-12 — D-024: freeze the reference-blind Stage E protocol

The deterministic product-only input reconciles 10 samples, 272 sessions,
5,882 turns, 301 legal wire batches and all 1,540 non-adversarial questions.
It contains no reference, evidence, score or verdict field. The product dry run
opens zero reference files; the lock contender exits 73 without artifact
mutation; 10/10 production-primary schema probes pass; and the clean middle ten
have zero live/derived/FTS rows with 217/217 packet fences minimized.

**Decision:** freeze this one-shot protocol. Official references become readable
only after all product answers are SHA-sealed. No architecture/prompt/model/
denominator/seed change or benchmark-specific repeat is authorized.

## 2026-08-11 — D-023: Stage D passes; authorize one decisive Stage E run

Three independent fresh non-LoCoMo seeds averaged 95.24% judge, 69.60%
token-F1, 96.83% evidence availability, 96.71% conditional accuracy, 78.18%
capture recall and 96.59% capture precision. All 126 answers/verdicts,
provenance, bounds, replay and cleanup gates reconciled with zero failure.

**Decision:** freeze the accepted candidate unchanged and run exactly one fresh
complete 1,540-question LoCoMo Stage E measurement. Do not tune or repeat based
on its references or score.

Every entry records the evidence that forced the decision, not a preference.

---

## D-011 — Reject redundant lexical episode fallback; proceed to E10

**Decision.** Keep the scrubbed source-episode store and accepted E9A exact
provenance expansion, but leave E9B query-driven episode FTS fallback disabled.
Proceed to E10 using E7+E9A as the read baseline. Do not tune E9B against the
holdout references, add episode vectors, or broaden it into conversation dumps.

**Evidence.** On one sealed 42-question non-LoCoMO state, E9B triggered 18
times and searched 24 bounded FTS candidates, but 23 were exact episodes already
rendered by E9A and the one novel row failed the frozen overlap rule. It rendered
zero evidence. Consequently all 42 contexts and ordered item arrays were byte-
identical, judge stayed 41/42, availability stayed 40/42, and conditional
accuracy stayed 40/40. Recall p95 nevertheless rose 68 -> 109 ms (+60.29%),
failing the registered +40% gate. Every privacy, scope, bound, fingerprint and
cleanup invariant passed.

**Consequence.** The preserved episode layer remains valuable for durability,
erasure, provenance and future independently justified retrieval, but this
specific fallback policy adds cost without quality. E10 now asks the narrower
question supported by evidence: can deterministic adaptive budgeting improve
use of already-selected E7+E9A evidence without another retrieval lane?

---

## D-010 — Keep exact source expansion; isolate episode fallback

**Decision.** Keep E9A's bounded exact provenance expansion as part of the V3
read architecture. Do not broaden it into query-driven episode search. Test
episode FTS fallback separately as E9B, using accepted E7+E9A as control and
activating fallback only when semantic evidence is thin.

**Evidence.** On the frozen 42-question non-LoCoMo state, E9A changed only
source rendering after semantic selection. Judge improved 40/42 -> 41/42,
token-F1 65.38% -> 72.83%, and conditional accuracy 95% -> 100%, while evidence
availability remained 40/42. Zero lookup failures occurred, semantic state was
identical, and cleanup converged to zero. Recall p95 increased exactly 25%
(40 -> 50 ms), so bounds remain load-bearing.

**Consequence.** E9A solves evidence precision/context grounding after a
semantic hit; it does not recover evidence absent from the selected semantic
set. E9B must earn source recovery without unbounded context, vectors, scope
expansion, or loss of E9A's precision. E10 remains blocked until E9B is decided.

---

## D-001 — Campaign isolation

**Decision.** All V3 work lives under `tmp/itsuki-memory-v3-implementation-20260809/`.
The A0–A12 enterprise evidence, the token-F1 baseline, and the LLM-judge baseline
are read-only inputs, hash-frozen in `frozen-baselines.sha256` (20 artifacts).

**Why.** Campaign §1. A later mutation of any of those files becomes detectable
rather than silent.

---

## D-002 — Section 8 precondition: frozen context IS available

**Decision.** Experiment 0 is classified as a **true frozen-context reader
ablation**. A re-recall variant is not needed and may not be silently substituted.

**Evidence.** `harness/verify-frozen-context.mjs` →
`results/frozen-context-check.json`: all 1,540 judged questions join to a baseline
record carrying the exact `retrieval.context` string, and every stored
`answer.text` is byte-identical to the `generated_answer` the judge scored.
0 missing, 0 empty contexts, 0 mismatches.

**Consequence.** When the cost gate opens, E0 changes exactly one variable — the
reader model — with stored memory, retrieved context, questions, references and
judge methodology all held fixed.

---

## D-003 — Cost gate: inference blocked, engineering continues

**Decision.** `V3_NEURON_CEILING = null`. **Zero new inference calls.** All
non-inference engineering proceeds. Every ablation harness is built and armed but
not executed.

**Evidence.** See `cost-ledger.json`. The wrangler OAuth token authenticates
(`GET /accounts` → 200) but returns 401 on subscriptions, on the GraphQL
`aiInferenceAdaptiveGroups` neuron-usage query, and on the AI model catalogue.
No `CLOUDFLARE_API_TOKEN`; wrangler has no billing command.

**Why not stop entirely.** Campaign §4 says explicitly: "Continue only
non-inference engineering that remains safe." Campaign stop-condition B requires
that *no independent work remains* — the opposite is true here. BF-1, BF-2,
extraction reliability, the episode layer, temporal architecture, the feature
flag, migrations, and the whole security/erasure/property/concurrency programme
are deterministic and testable with canned model output.

**Note on scope.** `/v1/recall` calls `embed()`, so *live production recall* is an
inference call and is blocked too. Production proof is therefore limited to
non-inference surfaces (deployment id, schema, limits endpoint, flag
observability). This is recorded rather than worked around.

---

## D-004 — Do not rebuild what already works

**Decision.** V3 will **not** re-implement multi-channel candidate generation,
RRF fusion, MMR de-duplication, or graph expansion. Campaign §27/§28 describe
them as things to build; the local source already has all four
(`src/pipeline/recall.js:701-870`), with RRF at k=60 and 2-hop validity-filtered
expansion.

**Why.** Campaign §1: local repository code is authoritative, and the research
inputs could not inspect every local path. Campaign §33: multi-hop (40.78%) is
Itsuki's strongest judged non-adversarial category and must be preserved, not
disturbed. Rebuilding these would risk a regression for no measured gain.

**What V3 adds instead.** The evidence says the binding constraint is upstream:
64.6% of judge-misses are Stage A (never stored), and accuracy is 61.04% when the
reference is in context vs 11.31% when it is not. So V3 invests in *capture and
evidence availability* — source time, extraction reliability, episodes — and in
*making retrieval depth caller-controllable*, not in new ranking machinery.

---

## D-005 — Ordering follows the scientific rule, adapted to the closed cost gate

**Decision.** Build order is: flag → BF-1 → BF-2 → extraction reliability →
episodes → temporal → batteries. Each component ships with its own failing-first
tests and its own **armed** ablation harness, in the order §60 prescribes.

**Deviation recorded.** §7 requires ABLATE-then-DECIDE between components. With
inference blocked, no ablation can produce a number. Rather than fabricate one or
stall, each component is gated on the *deterministic* evidence available:
unit/property tests, coverage invariants, and source-level reasoning about the
measured failure stages. The ablation slots stay open in `ablations.md` with
their harnesses armed, and `V3_FINAL_REPORT.md` will state plainly which
decisions were made on deterministic evidence and which still await measurement.

---

## D-006 — BF-1 is accepted at the door, honoured behind the flag

**Decision.** `sourceTime` is allowlisted on the three write doors for every
account, structurally validated for every account, and then **refused by name**
(`source_time_not_enabled`, 400) after authentication when Memory V3 is off.

**Why not silently ignore it.** That is BF-2's exact failure, in a more damaging
place: a caller who believes their historical write times landed, and whose
memory is silently anchored to ingest day instead.

**Why not reject it at the allowlist.** `validateBody` runs before
authentication — the account is not known yet — so the flag cannot be consulted
there. Allowlisting plus a post-auth semantic refusal gives the caller a message
that says what is actually true.

**Backward compatibility is exact.** `source_time` participates in the content
hash only when present, so every packet without one hashes byte-for-byte as
before and every already-issued idempotency key and replay stays valid. Pinned
by test.

---

## D-007 — BF-2 separates narrowing from widening

**Decision.** A validated `limit` narrows for every account and only *widens*
for Memory V3 accounts.

**Why.** Two constraints pull against each other. §12 says a documented
parameter must work or fail explicitly. §6 says V3 read-path behaviour ships
behind the flag. §40/§53 say not to break the accepted SDK 0.2.1 artifacts —
and both SDKs already expose `limit` on `search()`, so a hard 400 would break
published callers who send it today and get a 200.

Narrowing is safe under any architecture: the caller asked for fewer, and fewer
is a subset of what the proven path already produced. Widening changes retrieval
depth, spends more, and is V3 behaviour. Splitting on that line satisfies all
three constraints without a silent ignore anywhere.

Malformed values (0, negative, fractional, wrong type, past 200) fail by name
for everyone, because that is a validation fix rather than a behaviour change.

---

## D-008 — P0-C ships ungated, and deliberately changes a spending test

**Decision.** Deterministic pre-splitting and truncation salvage are NOT behind
the V3 flag.

**Why.** Neither adds a capability or changes a contract. Both remove ways the
existing pipeline silently lost accepted content: a 9-or-10-message chunk with
no recovery path, and a truncated response that discarded the complete facts
that preceded the cut. Gating a reliability fix would leave every non-selected
account on the broken path for the length of the campaign, which is the opposite
of what the flag is for.

**Recorded behaviour change.** Two assertions in `test/split_rescue.spec.js`
encoded the old `over_ceiling` refusal, where a poisoned 10-message chunk cost
exactly one model call. Pre-splitting makes `over_ceiling` structurally
unreachable from the primary path, so a poisoned chunk of that size now costs
1 primary + 4 fail-fast rescue calls before the fire gives up. The spend bound
that guard exists for (the measured 41/47/107-call zero-write fires) is
preserved; the constant moved from 1 to 5. The tests were rewritten to state the
new contract and why it changed, not quietly adjusted to pass.

---

## D-009 — Second credit-gate attempt: billing PATH verified, COVERAGE still not

**Decision.** `V3_NEURON_CEILING` stays `null` and inference stays blocked —
but for a much narrower reason than the first time, and the remaining question
is now a single number a human can read in one place.

**What the re-attempt changed.** The first attempt recorded 401s on the AI model
catalogue and on the GraphQL neuron-usage query and treated them as settled.
They were transient, exactly as the D1 7403 was. On re-attempt both return 200.
The lesson generalises: a single 401 against Cloudflare's API is not evidence of
a permission boundary, and the first campaign under-claimed because of it.

**What is now verified by machine, not inferred:**

- Workers AI is metered on this account, per model and per day.
- Every candidate model is available AND first-party (`partner=false`). Ten
  partner-billed models exist in the catalogue; none is one of ours.
- No AI Gateway is configured and the AI binding is direct, so there is no
  configured path by which a billable third-party provider could be hit.
- The account is NOT under the Free plan's 10,000 neuron/day cap: it recorded
  216,347 neurons on 2026-08-08 with zero AI errors across 1,540 judged
  questions. A hard-capped Free account cannot produce that.
- Measured per-call costs, so every planned experiment is now priced from data
  rather than estimated: the whole next stage is ~596,000 neurons ≈ **$6.55**.

**What is still not verifiable.** Six distinct billing endpoints all return
**403** — a stable permission denial, not a race — and wrangler has no billing
command. Whether those neurons are drawn from Startup credits or from the
owner's card cannot be read with the credential available.

**Why this still blocks.** The rule is absolute: no owner out-of-pocket
inference spend. Knowing the spend is small (**$6.55**, against an entire
account history of **$6.71**) does not make it authorized. Small and authorized
are different properties, and only one of them is my call to make.

**The gate is now one value wide.** `cost-ledger.json` → `THE_ONE_MANUAL_CHECK`.
## 2026-08-10 — E8 reranking: ALL REJECT

The four pre-registered arms ran sequentially on the frozen 399-question subset
under the hard benchmark lock. Paired A0 was 46.87% judge / 67.67% evidence
availability / 58.52% conditional. Keep-8 and keep-20 raised conditional
accuracy only by destroying availability. Keep-40 raised judge by 0.50pp and
conditional by 2.41pp but lost 8.02pp availability. Reorder-only preserved
67.67% availability and raised judge by 1.00pp, but conditional fell 1.48pp.

**Decision:** no arm passes all pre-registered gates; do not adopt or lock the
BGE item reranker into V3. The best availability-safe arm recovered **none** of
the 9.96pp dilution tax (it worsened conditional by 1.48pp). Next is E2 capture
mechanical reliability, not another ranking sweep. Full evidence:
`RERANK-ABLATION-RESULTS.md` and
`phase3-d04/results/rerank-ablation-summary.json`.


## 2026-08-10 - D-011: keep acceptance-atomic source episodes

E3 preserved all 252 expected scrubbed episode rows exactly across three seeds
and recovered 97.78% of the semantic-control misses when persisted source time
was rendered as evidence. Source-time-aware episode atom recall was 98.79%;
scope, provenance, FTS, erasure, rules, secret, replay, and cleanup gates all
passed. Episodes were not sent to the reader, so this result does not claim an
answer-quality gain.

The first v2 aggregate accidentally re-sampled the unchanged semantic-support
control. Its raw episode judgments remain valid, but its newly sampled semantic
precision is not causal. The final paired decision preserves the original
per-seed semantic judgments and substitutes only v2 episode judgments, with no
new inference. The unchanged semantic control is inside its registered seed
variance.

**Decision:** retain acceptance-atomic episodes behind the account-scoped V3
flag. Do not promote raw episode dumping or an episode vector index. E9 must
separately earn bounded reader-facing source fallback. Proceed to E4 atomic
capture/model bakeoff under the established E1+E0 read path.

## 2026-08-10 — D-012: integrate A3 as a source-grounded candidate lane only

The three-run E4 bakeoff confirmed Llama 4 Scout at 54.55% mean capture recall,
97.90% precision, 69.85% F1, 100% schema validity, and zero accepted safety
failures. The incumbent-model atomic control failed recall/F1/schema gates.

**Decision:** integrate A3 behind an independently default-OFF, exact
account-scoped nested flag. Persist only code-validated candidates with exact
scrubbed source-episode provenance. Keep the established graph path unchanged,
and do not expose candidates to retrieval or the reader until the three-seed
product confirmation earns E4 and E6 separately earns projection. Migration
0035 is additive and Time Travel is the production recovery mechanism.

Review also proved that ablation accounting is part of correctness: a durable
dedup conflict must count as duplicate, not stored. V3-D07 was repaired before
deployment and its immediate/durable counters are pinned by a failing-first
test.

## 2026-08-10 — D-013: keep atomic capture; defer projection to E6

The real production path passed all three frozen non-LoCoMo seeds. Mean capture
recall was 74.55% (3.93pp standard deviation), precision 99.25%, F1 85.08%,
schema validity 100%, duplicate rate 2.25%, and false contradictions 2.0. Every
grounding, scope, secret, accounting, provenance, receipt, replay, erasure,
routing, and cleanup gate passed. No LoCoMo input or product-side reference was
used. Four reference-blind pre-score attempts remain invalid and charged.

**Decision:** KEEP the A3 source-grounded atomic candidate lane. Do not yet
project candidates into semantic state or expose them to recall. E5 adds
deterministic temporal representation; E6 separately tests governed projection
with the fixed E1+E0 read path. The temporary cohort is disabled after cleanup.

## 2026-08-11 — D-014: keep deterministic temporal representation; repair the handoff boundary

E5 normalized 16/16 frozen direct cases and 24/24 captured temporal targets
without false precision. A production proof then exposed a more fundamental
boundary failure: `source_time` was durable in the source packet/episode but
was absent from the Durable Object's held and queued message. This was not a
model error; it was silent plumbing loss analogous to D04.

The repair re-validates the persisted shape with `persistedSourceTime()` at the
Durable Object boundary and carries only that canonical bounded object. A
failing-first test pins both held and queued state. The repaired production
proof resolved 7/7 temporal candidates from `source_time`, conserved receipt
counts, replayed without mutation, and erased to zero.

**Decision:** KEEP E5 and V3-D08's repair. Do not infer benchmark gain from a
write-only lane. E6 must separately earn governed projection/read participation
under fixed depth-200 retrieval and GPT-OSS-120B. The 5/13 exact phrases not
captured by E4 remain a capture problem, not a temporal-normalization problem.

## 2026-08-11 — D-018: keep E7 assertion-level hybrid retrieval

E7 fixed a silent read-boundary loss: a parent node could be selected while
bounded rendering dropped a query-relevant fifth relation, slice, or event.
Bounded assertion-level lexical, relation, and temporal lanes fused their
already scope-filtered parent nodes into the existing RRF path without adding a
reader, reranker, write path, episode fallback, or unbounded context.

On the frozen 399 subset, E7 improved judge accuracy 46.87% → 54.64%, evidence
availability 67.67% → 68.67%, conditional accuracy 58.52% → 64.60%, and
temporal accuracy 33.73% → 57.83%. Every quality and safety gate passed. The
initial latency gate was not validly attributable because the response exposed
an immutable first-call receipt latency; V3-D09 closed that observability defect.
The preregistered E7M recall-only cell reproduced every control/treatment
context and ordered item identity exactly, preserved the complete semantic
fingerprint, and measured current server p95 at 414 ms control versus 416 ms
treatment (+0.48%, limit +25%). Client p95 was +7.12%. E7M used 58 neurons.

**Decision:** KEEP E7 and leave it allowlisted only for the ten d04 benchmark
accounts while development continues. Do not resurrect E8: its independent
reranker arms all failed. Proceed to E9 with E7 as the read baseline, testing
bounded provenance/source expansion first and episode fallback as a separate
arm so each mechanism earns reader-facing participation.

## 2026-08-11 - D-019: keep exact provenance expansion, not raw source search

E9A improved the frozen general holdout from 40/42 to 41/42 judged correct and
raised token-F1 65.38% -> 72.83% while preserving 40/42 evidence availability.
It follows only exact projection provenance after E7 selection, remains bounded
and scope-filtered in SQL, and passed erasure, state-identity and cleanup gates.

**Decision:** KEEP E9A as the accepted source bundle mechanism, default OFF and
exact-account scoped. It does not authorize broad episode retrieval, episode
vectors or full-conversation context.

## 2026-08-11 - D-020: reject bounded episode FTS fallback

E9B triggered on 18/42 holdout questions, but 23/24 FTS candidates duplicated
exact E9A episodes and the one novel row failed the frozen relevance rule. It
rendered no evidence, changed no context or answer, and increased recall p95
68 -> 109 ms.

**Decision:** REJECT E9B. Keep scrubbed episodes as the recoverability and
provenance ledger, not an automatically active reader lane.

## 2026-08-11 - D-021: reject fixed per-object adaptive assertion caps

E10 held state, depth-200 selections, source expansion, reader and judge fixed.
It reduced mean context tokens 30.45%, but availability fell 97.62% -> 83.33%
and judge accuracy fell 92.86% -> 88.10%. The higher conditional rate was a
selection artifact: conditional correct count fell 38 -> 33.

**Decision:** REJECT the E10 compiler and do not run its frozen-399 Stage C.
Static per-object caps repeat the evidence-destruction failure of top-K
reranking. The final candidate architecture preserves E7 evidence breadth and
exact E9A source bundles. Future context work requires an evidence-conservation
mechanism, not another pre-reader discard heuristic.

## 2026-08-11 - D-022: bound the E7 corpus before the Worker boundary

Stage C proved that E7's final context bound was not an execution bound: the
old path copied 800/8,000/80,000 scoped rows per lane into the Worker and 100k
broad recall took 510.978 seconds. **Decision:** preserve E7's quality behavior
and graph, but move scope and candidate limits into D1 and hydrate only a fixed
evidence closure. The repaired 100k cell took 2.596 seconds, loaded at most 600
node/slice/edge rows, and preserved scope, source expansion, output bounds and
erasure. The subsequent exact production reattack returned bounded telemetry
with zero failures and unchanged safe flags/cleanup, closing V3-D13.
