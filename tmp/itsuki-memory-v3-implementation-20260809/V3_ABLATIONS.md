# V3 ABLATION LEDGER

**STATUS: TERMINAL. E0–E10, final repeated holdout, and the single Stage E
product/official score are complete; E7/E9A KEEP; E8/E9B/E10 REJECT. The final
semantic judge stopped at the preregistered hard Stage E spend guard and is not
reported partially.** Historical armed definitions below remain immutable protocol evidence;
later dated sections contain the valid measured results. The cost gate is open
and fail-closed at `V3_NEURON_CEILING = 3,000,000` for direct first-party
Workers AI only.

## Frozen reference row

| | token-F1 | LLM-judge | evidence availability | conditional accuracy |
|---|---|---|---|---|
| **V1 BASELINE** | **15.40%** | **25.65%** (395/1540) | **28.83%** (444/1540) | **61.04%** |

Per category (judge): multi-hop 40.78% · single-hop 28.42% · open-domain 21.88% ·
temporal 6.23%. Adversarial excluded (Mem0 protocol), and its 86.77% token-F1 is
an abstention artefact.

## FINAL V3 — Stage E terminal measurement (2026-08-12)

| Cell | Token-F1 | LLM-judge | Evidence availability | Conditional |
|---|---:|---:|---:|---:|
| V1 historical | 15.40% | 25.65% | 28.83% | 61.04% |
| E1+E0 full | 27.45% | 46.75% | 65.97% | 58.27% |
| **Final V3 full** | **36.08%** | **NOT COMPLETED (960/1540)** | **73.77%** | **NOT AVAILABLE** |

Final V3 used the accepted E7 assertion-level hybrid retrieval and E9A exact
source expansion at bounded depth 200 with GPT-OSS-120B. Rejected E8 reranking,
E9B episode fallback and E10 adaptive caps remained off. The product and
official scorer completed all 1,540 questions. The judge stopped fail-closed at
491,280 / 500,000 Stage E neurons; its 960-row prefix is retained but neither
scored nor extrapolated. Official category token-F1 was multi-hop 27.72%,
temporal 33.63%, open-domain 17.56% and single-hop 41.94%.

Complete attribution: source stored 94.61%, atomic candidate stored 85.32%,
selected-before-render 75.65%, semantic-rendered 70.91%, final context 73.77%.
The final write/read system therefore adds +20.68pp official token-F1 and
+44.94pp evidence availability over V1 while preserving zero-residue cleanup.
Verdict: **architecture CONDITIONAL, security/durability/erasure/isolation PASS,
global production enablement NOT recommended** because the complete final
semantic-judge metric is unavailable.

---

## E0 — reader ceiling (frozen context)

- **Classification: TRUE FROZEN-CONTEXT ABLATION.** Precondition verified, D-002.
- **Held fixed:** stored memory, retrieved context (`retrieval.context` verbatim
  from `b1.conv-*.t1.questions.jsonl`), questions, references, judge model and
  prompt (`@cf/openai/gpt-oss-120b`, temp 0, `json_object`, 5 retries).
- **Changed:** the answer reader model only. Baseline reader was
  `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, temp 0, max_tokens 128.
- **Candidates to verify for availability AND credit coverage before use:**
  `@cf/openai/gpt-oss-120b` (discussed, unverified), plus whatever the account's
  model catalogue actually exposes. Availability was **not** confirmable — the
  model-search API returned 401 with the available credential.
- **Measures:** overall judge accuracy; single-hop / multi-hop / temporal /
  open-domain; conditional accuracy when the reference is present in context;
  reader failure count; variance over repeats; latency; neurons.
- **Cost shape:** 1,540 reader calls + 1,540 judge calls per arm, ~1,180-char
  contexts. This is the single most expensive armed experiment; run it first
  only because §10's branch changes everything downstream.
- **Harness:** `harness/e0-reader-ceiling.mjs` (armed).
- **Result:** _NOT RUN — cost gate closed._

### E0 decision branch (§10) — pre-committed, so the result cannot be rationalised

- **CASE A** — conditional accuracy rises to ≈≥80%: reader quality was a major
  binding constraint. Prioritise capture/evidence availability; keep source
  expansion but cut speculative context/reader engineering.
- **CASE B** — conditional accuracy stays near 61% or materially below 80%:
  evidence quality and context assembly remain load-bearing. Implement source
  expansion fully, implement episode fallback, prioritise evidence precision and
  reranking.
- **CASE C** — unstable: resolve reader/judge variance before attributing
  anything to architecture.

Whichever fires must be written into `decision-log.md` **before** any product
change that depends on it.

---

## E1 — retrieval depth only (after BF-2, no new ranking)

- **Held fixed:** current memory state, current ranking, current fusion.
- **Changed:** the recall depth budget only — small / medium / larger-safe.
- **Measures:** reference evidence availability, judge accuracy, latency, context
  size, crowding, duplicate rate.
- **Question it answers:** how much of the current retrieval shortfall is *just
  budget*? Bounded above by the 20.0% Stage-B share of misses.
- **Harness:** `harness/e1-retrieval-depth.mjs` (armed).
- **Result:** _NOT RUN — cost gate closed._

---

## E2 — extraction mechanical reliability

- **Changed:** deterministic pre-split coverage + schema-constrained output +
  explicit truncation/partial-JSON handling.
- **Measures:** parse-failure rate, truncation rate, zero-write fires,
  atoms/packet, source-span coverage, variance across repeated seeds.
- **Result:** _NOT RUN — cost gate closed._

---

## E3 — episode layer with OLD retrieval

- **Measures:** source recovery rate, extraction misses now recoverable, FTS
  evidence availability, erasure convergence, latency, storage delta.
- **Constraint:** episodes are not fed wholesale to the reader.
- **Result:** _NOT RUN — cost gate closed._

---

## E4 — zero-to-many atomic extraction (separated from E2)

- **Measures:** atoms/packet, important-fact capture, precision, false
  contradiction rate, duplicate rate, holdout capture.
- **Result:** _NOT RUN — cost gate closed._

---

## E5 — temporal only

- **Measures:** correct temporal evidence availability, temporal token-F1,
  temporal judge accuracy, normalization accuracy, false-precision rate, latency.
- **Must not** be combined with ranking changes during attribution.
- **Result: KEEP (2026-08-11).** Direct frozen normalization 16/16; captured
  E4 temporal targets 24/24 across three sealed seeds; zero false precision.
  Repaired production path: 7/7 temporal candidates resolved from authoritative
  source time, replay stable, receipt-conserved, scope-bound, and erased to
  zero. No recall/reader participation and therefore no LoCoMo score claim.
  E4 still captured only 8/13 exact temporal phrases per seed. Evidence:
  `e5/score.json`, `e5/live-proof.json`, and `e5/E5-REPORT.md`.

---

## E6 — combined V3 write path + OLD read path

- Isolates the write-path contribution before any read-path change.
- **Result (2026-08-11): MODIFY.** Three paired non-LoCoMo seeds improved mean
  capture recall 55.76% → 90.30%, judge 55.56% → 84.92%, token-F1 37.96% →
  58.66%, and evidence availability 51.59% → 79.37%. Conditional accuracy was
  95.07% (-1.90pp). Projection/provenance was 264/264 and cleanup passed.
- The semantic-redundancy gate failed: 41.33% control versus 49.09% treatment.
  Exact physical duplicates were near zero; same-source legacy/atomic
  paraphrases caused a real +7.76pp increase. E6M must repair and remeasure this
  construct before E7. Full evidence: `e6/E6-ABLATION-REPORT.md`.

---

## E6M — conservative same-source coalescing

- **Result (2026-08-11): MODIFY; disabled.** Three paired non-LoCoMo seeds
  changed only same-source legacy/atomic coalescing. Judge moved 82.54% →
  84.13%, token-F1 60.05% → 60.09%, evidence availability 77.78% → 83.33%,
  and conditional accuracy 95.95% → 95.37%.
- Same-source paraphrases fell 55.87% (8.10% → 3.58%) with zero registered false
  merges, but precision fell 6.73pp and rendered-context duplication remained
  9.74%. The preregistered precision and ≤5% context-duplication gates failed.
- Do not adopt write-time coalescing. The nested cohort is OFF/0, all synthetic
  state is erased, and E7/E10 must test non-destructive source/assertion grouping.
  Full evidence: `e6m/E6M-REPORT.md`; machine result:
  `e6m/results/summary.json`.

---

## E7 — assertion-level hybrid retrieval/fusion (KEEP, 2026-08-11)

- Frozen 399 subset, same d04 memory, depth 200, GPT-OSS-120B, no reranker and
  no re-ingest. Judge improved **46.87% → 54.64% (+7.77pp)**; token-F1
  **27.61% → 28.95%**; evidence availability **67.67% → 68.67%**;
  conditional accuracy **58.52% → 64.60%**. Temporal improved
  **33.73% → 57.83% (+24.10pp)** with no category regression.
- E7M repaired invalid latency observability and reran both arms recall-only
  with exact historical context/item hashes. Current server p95 was
  **414 → 416 ms (+0.48%)**, client p95 **885 → 948 ms (+7.12%)**; every
  integrity/safety gate passed. E7M cost 58 neurons.
- **Decision: KEEP.** Evidence: `e7/E7-CONFIRMATION-399-REPORT.md`,
  `e7/E7M-LATENCY-REPORT.md`, and both machine summaries.

## E8 — reranking

- **Result: ALL REJECT.** The complete immutable arm table appears below;
  no reranker is part of V3.

## E9 — source expansion / episode fallback

- **E9A exact provenance expansion: KEEP.** On one frozen 42-question holdout
  state, judge improved **95.24% -> 97.62%**, token-F1 **65.38% -> 72.83%**,
  availability stayed **95.24%**, and conditional accuracy improved
  **95% -> 100%**. Recall p95 was **40 -> 50 ms** (exactly +25%); failures 0;
  state identical; cleanup zero. Settled E9A burn: 6,647 neurons.
- **E9B bounded episode FTS fallback: REJECT.** Judge and availability were
  unchanged at 41/42 and 40/42. Fallback triggered 18 times but rendered zero
  episodes: 23/24 FTS candidates were exact E9A duplicates and the one novel
  candidate failed the frozen overlap gate. All 42 contexts/items were byte-
  identical while recall p95 rose 68 -> 109 ms (+60.29%), failing the +40% gate.
- Evidence: `e9/E9A-SOURCE-EXPANSION-RESULT.md`,
  `e9b/E9B-EPISODE-FALLBACK-RESULT.md`, and both machine summaries.

## E10 — adaptive context

- **NEXT.** Use accepted E7+E9A only; E9B remains OFF. Test deterministic query-
  complexity budgeting over already selected evidence with hard maximums and
  explicit dilution/assembly-loss protection. Do not add another retrieval lane
  or reranker.

---

## FINAL V3 — full frozen LoCoMo + non-LoCoMo holdout

- Report **both** official token-F1 and LLM-judge accuracy, never mixed.
- Plus: evidence availability, conditional reader accuracy, per-category,
  adversarial separately, latency, context size, ingestion latency, cost,
  variance over repeated seeds.
- **Acceptance rule (§56):** if LoCoMo rises while the non-LoCoMo holdout
  degrades, **V3 is not accepted** and the campaign diagnoses overfitting.
- **Result:** _NOT RUN — cost gate closed._

---

## Per-row schema (to be filled only by real runs)

`code commit · deployment id · flags · dataset · seed · memory state · reader
model · judge model · token-F1 · judge accuracy · evidence availability ·
conditional accuracy · latency p50/p95 · neurons`

---

## E8 — reranking (completed 2026-08-10)

Frozen 399-question subset, SHA-256
`500959da6c7e030248d85669ce49cf85ed62551fba0d0690d7a70bca0337ea6d`;
d04 memory; depth 200; GPT-OSS-120B reader; BGE reranker; no re-ingest. Every
arm reconciled at 399 answers + 399 judge verdicts with zero errors/retries.

| Arm | Judge | Token-F1 | Availability | Conditional | Decision |
|---|---:|---:|---:|---:|---|
| A0 paired control | 46.87% | 27.61% | 67.67% | 58.52% | control |
| A1 keep-8 | 44.36% | 25.91% | 42.36% | 70.41% | REJECT |
| A2 keep-20 | 44.86% | 27.03% | 52.13% | 64.90% | REJECT |
| A3 keep-40 | 47.37% | 28.89% | 59.65% | 60.92% | REJECT |
| A4 reorder-only | 47.87% | 29.18% | 67.67% | 57.04% | REJECT |

**Verdict: ALL REJECT.** Details, categories, latency, context, burn, lock proof,
and interruption accounting are in `RERANK-ABLATION-RESULTS.md`.

---

## E2 - extraction mechanical reliability (completed 2026-08-10)

Frozen non-LoCoMo holdout, three paired independent ingestion seeds, 10
scenarios / 55 must-capture atoms / 42 questions per arm and seed. Fixed read
path: depth 200, no reranker, GPT-OSS-120B reader and judge.

| Metric | B0 control | B1 treatment | Delta |
|---|---:|---:|---:|
| capture recall | 45.45% | 48.48% | +3.03pp |
| precision | 76.13% | 74.78% | **-1.35pp** |
| macro F1 | 56.80% | 58.58% | +1.77pp |
| holdout judge | 52.38% | 60.32% | +7.94pp |
| availability | 50.00% | 57.14% | +7.14pp |
| conditional | 85.05% | 88.70% | +3.65pp |

**Decision:** KEEP B0; REJECT B1 as implemented. The recall branch's precision
safeguard allowed at most -1.0pp and B1 lost -1.35pp. The preregistered 96Q and
399 LoCoMo screens were therefore not run. Incremental burn 31,233 neurons.
Full evidence: `e2/E2-RESULT.md` and `e2/results/holdout-summary.json`.


---

## E3 — acceptance-atomic scrubbed source episodes (completed 2026-08-10)

Frozen non-LoCoMo holdout, three independent semantic-extraction seeds, 84
permitted messages and 55 must-capture atoms per seed. Semantic extraction,
recall, context, and reader were unchanged; episodes were not sent to the
reader.

| Metric | Mean |
|---|---:|
| exact permitted-message coverage | **100%** |
| source-time-aware episode atom recall | **98.79%** |
| recovery of original semantic misses | **97.78%** |
| unchanged semantic capture recall | 43.03% |
| unchanged semantic precision | 75.77% |
| unchanged semantic evidence availability | 49.21% |
| diagnostic episode FTS top-8/top-20 availability | 73.81% |

**Decision: KEEP.** Every mandatory security, provenance, conservation,
erasure, replay, and cleanup gate passed. The final causal aggregate pairs the
original semantic-control judgments with source-time-aware episode judgments;
the raw v2 aggregate's re-sampled semantic control is not used for attribution.
Burn: 20,807 neurons. Evidence: `e3/E3-REPORT.md` and
`e3/E3-SCORER-V2-ATTRIBUTION.md`.

---

## E4 — atomic capture model bakeoff and product confirmation (KEEP)

Frozen non-LoCoMo holdout: 10 scenarios / 55 must-capture atoms. References
were scorer-only after all product artifacts were sealed. No LoCoMo data was
used for prompt or model selection.

| Confirmed arm | Recall | Precision | F1 | Schema | Duplicate | Accepted safety failures | Decision |
|---|---:|---:|---:|---:|---:|---:|---|
| A3 Llama 4 Scout | **54.55%** | **97.90%** | **69.85%** | **100%** | 4.76% | **0** | WINNER |
| A1 incumbent Qwen atomic control | 25.45% | 100.00% | 39.79% | 56.67% | 2.08% | 0 | REJECT |

A3 passed every registered bakeoff gate; A1 failed recall, F1, and schema
validity. The real production path then ran three independent frozen holdout
seeds after reference-blind product artifacts were sealed:

| Product seed | Recall | Precision | F1 | Schema | Duplicate | Contradictions | Gate |
|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | 80.00% | 98.88% | 88.44% | 100% | 2.25% | 2 | PASS |
| 2 | 70.91% | 98.86% | 82.58% | 100% | 2.27% | 2 | PASS |
| 3 | 72.73% | 100.00% | 84.21% | 100% | 2.22% | 2 | PASS |
| **Mean** | **74.55%** | **99.25%** | **85.08%** | **100%** | **2.25%** | **2.0** | **KEEP** |

Zero grounding/scope/secret/accounting failures; provenance, receipt, replay,
erasure, routing, and cleanup gates all passed. Candidate rows remained absent
from recall. Confirmation burn was 14,758 neurons including four preserved,
unscored invalid harness attempts. **Decision: KEEP the source-grounded write
lane, default OFF; E6 must separately earn projection/read participation.**
Evidence: `e4/E4-REPORT.md` and `e4/product-confirmation/summary.json`.

## E10 - deterministic adaptive assertion context (REJECT, 2026-08-11)

- Frozen general holdout, one sealed 42-question state, E7+E9A control versus
  E10-only treatment; selected item ids/order were identical for every pair.
- E10 compressed mean context **242.90 -> 168.95 tokens (-30.45%)**, but evidence
  availability fell **97.62% -> 83.33%**, judge fell **92.86% -> 88.10%** and
  token-F1 fell **68.59% -> 63.13%**. Conditional rate rose 1.60pp only because
  six evidence-present questions became evidence-absent; conditional correct
  count fell 38 -> 33.
- All assertion/source accounting, state, scope, bound and cleanup gates passed.
  The quality gates failed, so Stage C frozen-399 was not run.
- **Decision: REJECT.** Do not use fixed per-object assertion caps. Preserve E7
  breadth and exact E9A source bundles in the accepted architecture. Settled
  E10 burn: 7,924 neurons; final state and flags clean/off. Full evidence:
  `e10/E10-ADAPTIVE-CONTEXT-RESULT.md`.

## Final V3 holdout — three fresh seeds (PASS, 2026-08-11)

| Metric | Seed 1 | Seed 2 | Seed 3 | Mean |
|---|---:|---:|---:|---:|
| judge | 100.00% | 92.86% | 92.86% | **95.24%** |
| token-F1 | 71.15% | 69.42% | 68.21% | **69.60%** |
| availability | 97.62% | 97.62% | 95.24% | **96.83%** |
| conditional | 100.00% | 95.12% | 95.00% | **96.71%** |
| capture recall | 78.18% | 74.55% | 81.82% | **78.18%** |
| capture precision | 96.63% | 96.59% | 96.55% | **96.59%** |

All preregistered generalization, security, provenance, boundedness and cleanup
gates passed. Burn was 18,995 neurons. **Decision: PASS_TO_STAGE_E.**
