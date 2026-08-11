# V3 DECISION LOG

Every entry records the evidence that forced the decision, not a preference.

## D-025 - repair interrupted atomic suffixes from durable proof, never from terminal status alone

**Decision.** Preserve normal terminal idempotency. Permit an exact `enriched`
packet to reopen only when its tenant-, packet-, and project-bound atomic ledger
proves a stale or known-interrupted zero-candidate chunk. Bind repair to a
bounded monotonic generation, restore the original accepted message IDs, join
concurrent followers, fence every atomic publication by attempt, and fence
Durable Object ownership plus D1 settlement by the same generation.

**Evidence.** Stage E completed 272 writes then stopped reference-blind on two
packets whose first chunks stored 11 / 8 candidates and whose second chunks
remained stale `running` with zero rows. The old replay had falsely terminalized
both jobs. Failing-first tests separately reproduced failed-seen pollution,
missing remaining payload, terminal false success, cross-project authorization,
post-CAS follower divergence, and a late superseded writer. The exact repair is
9/9; full Worker 1,322/1,322 and unit/cross-door 539/539 pass. The last two
regressions prove an older local queue entry is discarded without inference and
cannot settle a newer durable repair generation.

**Consequence.** Deploy without migration, exact-replay only the two original
Stage E packet identities, and require production-primary complete accounting
before reader or judge inference. An ordinary enriched replay, another scope's
ledger, an erasure, or an exhausted generation can never trigger another model
call.

---

## D-024 — freeze the reference-blind one-shot Stage E protocol

**Decision.** Freeze one complete 1,540-question Stage E run on the accepted
candidate and clean middle/control ten. Product generation receives only the
mechanically derived reference-free input; official references become readable
only after the 1,540-answer product is SHA-sealed. Source time uses exact day
precision because LoCoMo supplies local clock times without a timezone; the
original local timestamp remains verbatim in source text.

**Evidence.** Deterministic reconstruction reconciles 10 samples, 272 sessions,
5,882 turns, 301 legal wire batches and category counts 282/321/96/841. The
reference-boundary proof opens zero reference files, the atomic global-lock
contender exits 73 before artifact mutation, all 10 production-primary schema
probes pass, and the selected cohort has zero live/derived/FTS state with all
217 historical packet fences minimized. No inference or flag change occurred.

**Consequence.** The next product result is measurement, not a development
screen. Harness repair may resume exact durable identities, but no changed
architecture, prompt, model, denominator, ingestion seed or benchmark-specific
repeat is authorized.

---

## D-023 — accept the final candidate for one decisive Stage E measurement

**Decision.** Stage D passes and authorizes exactly one fresh complete LoCoMo
run of the already frozen candidate. No component, prompt, threshold, model,
reranker, fallback or context cap may change before that measurement.

**Evidence.** Across three independent fresh non-LoCoMo seeds, mean judge was
95.24%, evidence availability 96.83%, conditional accuracy 96.71%, token-F1
69.60%, capture recall 78.18%, and capture precision 96.59%. All 126 products
and verdicts reconciled; safety, scope, provenance, replay, bounded retrieval,
assembly and cleanup gates had zero failures. Judge range was 92.86–100.00%,
availability range 95.24–97.62%, and capture precision range only 0.08pp.

**Consequence.** General quality is strong enough to spend the protected final
reserve on Stage E. The single full result is a measurement, not a tuning set;
below-baseline performance will be reported without a benchmark-specific rerun.

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

## 2026-08-10 - D-010: keep E2-B0, reject and disable E2-B1

Three paired holdout seeds show B1 is not robust enough to earn the LoCoMo
screen. Mean capture recall improved 3.03pp and end-to-end holdout judge improved
7.94pp, but semantic precision fell 1.35pp, beyond the frozen 1.0pp safeguard;
seed 2 also regressed capture by 5.45pp. This is not rounded into a pass.

**Decision:** retain B0's correctness/security mechanics for every path. Set the
nested B1 production flag back to OFF, do not run the E2 96Q/399 screens, and do
not carry B1 into E3. E3 evaluates recoverable source episodes under the old
semantic extraction behavior plus B0, preserving causal attribution.


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
routing, and cleanup gate passed. The result is stronger than the isolated
bakeoff and used no LoCoMo input, retrieval, reader, or benchmark reference in
the product path.

Four reference-blind pre-score attempts exposed harness assumptions and are
retained as invalid rather than silently rewritten. Their calls and neurons are
charged; none contributes to quality. The final confirmation consumed 14,758
neurons total and ended at 1,715,211 / 3,000,000.

**Decision:** KEEP the A3 source-grounded atomic candidate lane. Do not yet
project candidates into current/historical semantic state and do not expose
them to recall. E5 first adds deterministic temporal representation; E6 then
tests governed projection with the fixed E1+E0 read path. The temporary E4
cohort is disabled after cleanup; production remains atomic OFF/count 0.

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

## 2026-08-11 — D-015: E6 projects through existing authority, never around it

E4/E5 candidates have excellent source precision but are still proposals. A
direct candidate-retrieval lane would mix the write-path and read-path causes,
skip proven semantic conflict behavior, and make deletion/provenance enforcement
different from legacy memory. E6 therefore loads only the current capture
runs' exact episode-backed candidates, converts them deterministically to the
existing node/assertion vocabulary, and submits them to the established gates.

The graph write, candidate terminal outcome, exact source mapping, and semantic
object mapping commit in one deletion-fenced D1 transaction. Same-batch copies
from legacy and atomic extraction coalesce. Explicit cardinality applies to the
semantic attribute rather than a blanket slice kind, and deterministic temporal
precision survives to reader rendering without a fabricated day.

**Decision:** implement and deploy this governed path behind a third nested,
default-off, exact-account flag. Do not add candidate-direct retrieval, new
relationship edges, episode fallback, reranking, or adaptive context in E6.
This is an implementation decision only: the three-seed holdout ablation must
still KEEP/MODIFY/REJECT projection mechanically before E7 begins.

## 2026-08-11 — D-016: modify projection to remove same-source paraphrase duplication

E6 strongly validated the projection hypothesis: treatment increased capture
recall by 34.55pp, evidence availability by 27.78pp and judge accuracy by
29.37pp over three paired seeds, with 264/264 projections accounted for and no
safety or cleanup failure. Conditional correctness fell only 1.90pp.

The preregistered duplicate gate failed. Its absolute score also classified
41.33% of control graph claims as duplicates because it mixes intentional
node/assertion views with duplicate assertions. Treatment's additional 7.76pp
is still actionable: legacy and atomic extraction can emit paraphrases from
the same source packet in one batch, while current gates coalesce exact text
only.

**Decision:** preserve E6 as **MODIFY**. Before E7, implement E6M as a
conservative source-aware same-batch coalescer. It may merge only an atomic
proposal into an already planned legacy assertion when node, assertion class,
source evidence and high lexical containment agree; distinct facts in one
message must remain separate. Preregister corrected measures for physical or
source-identity duplicates, representation overlap and final rendered-context
duplication before inference. If E6M does not retain the E6 quality gains or
cannot reduce treatment-added redundancy without false merges, reject the
coalescer and redesign projection rather than weakening the gate after seeing
results.

## 2026-08-11 — D-017: do not adopt destructive write-time coalescing

E6M reduced the intended same-source paraphrase construct from 8.10% to 3.58%
(55.87% relative), preserved evidence availability, and registered zero false
merges. Mean holdout judge accuracy improved 1.59pp. It nevertheless failed the
precommitted precision and rendered-context gates: precision fell 6.73pp and
the final context still contained 9.74% duplicate assertion fragments.

This result does not invalidate E6's large capture/evidence gain. It shows that
discarding a semantic view during write-time projection is the wrong boundary
for solving reader dilution: source-backed views are useful, extraction is
stochastic, and the remaining duplicates are produced after storage as well as
within it.

**Decision:** classify E6M as **MODIFY**, disable every E6M cohort, and do not
adopt the coalescer in the winning path. Preserve E6's governed projection as
an experimental input to E7. Solve duplication non-destructively after lane
generation—using source identity, assertion identity, fusion, and the later
context compiler—so evidence can be grouped without being erased. E8 remains
rejected and receives no additional inference.

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

Stage C proved that a bounded final context did not imply bounded execution:
E7 first loaded 800/8,000/80,000 scoped rows per lane, and 100k broad recall
took 510.978 seconds and about 898 MB locally. Scope and output correctness were
intact, isolating V3-D13 to pre-fusion candidate generation.

**Decision:** KEEP E7's measured assertion-level quality behavior, but replace
its unbounded corpus materialization with D1-first bounded lanes and bounded
evidence hydration. Do not remove the graph, lower reader evidence breadth, or
change legacy accounts to solve a resource-boundary defect. The exact repaired
100k cell completed broad recall in 2.596 seconds (~196.8x faster), loaded at
most 600 node/slice/edge rows, and preserved scope, source expansion, context
bounds and erasure. The subsequent exact production reattack returned bounded
telemetry with zero failures and unchanged safe flags/cleanup, closing V3-D13.
