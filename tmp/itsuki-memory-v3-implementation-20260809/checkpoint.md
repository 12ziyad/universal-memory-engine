# ITSUKI MEMORY V3 — CAMPAIGN CHECKPOINT

## 2026-08-11 Stage D safely closed / Stage E harness next

- Stage D commit/origin `2484f772a79889dba0297f83b575d2c6fb2e99d9`
  is live as Worker `c85c7844-9e2e-426e-8f87-ee468296b572`, deployment
  `cef8320d-afd0-4c9f-a4a5-690a2d149f68`, 100% traffic.
- Propagation is 20/20 exact: parent 30, write/source/rejected lanes OFF/0, E7
  historical d04 ten only, normal users outside V3. Focused 4 files / 66 tests
  and Wrangler dry deploy passed; no migration/binding/code change occurred.
- Stage E cohort preflight found 217 pre-D10 plaintext packet rows in the
  otherwise live-empty middle/control ten. The current product erasure API
  minimized all 217; no direct D1 mutation occurred. Combined control+treatment
  closure is now 1,098/1,098 minimized packet fences, zero content rows, zero
  live V3/graph/staging/job state and no global lock.
- Durable proof: `final/holdout/STAGE-D-CLOSURE.md` and
  `final/holdout/evidence/stage-d-closure.json`. Burn remains
  **1,933,582 / 3,000,000**; cleanup/health used no inference.
- Exact next action: implement and freeze the one-shot Stage E harness against
  the clean middle/control ten and project `v3-final-locomo`, prove its lock and
  reference isolation, then activate only that cohort.

## 2026-08-11 Stage D PASS / safe closure deployment next

- The preregistered three-seed final non-LoCoMo holdout is complete and
  **PASS_TO_STAGE_E**. Products were reference-blind and SHA-sealed before
  scoring; all three seeds cleaned to zero before reuse.
- Mean judge accuracy **95.24%**, token-F1 **69.60%**, evidence availability
  **96.83%**, conditional accuracy **96.71%**, capture recall **78.18%**,
  capture precision **96.59%** and capture F1 **86.39%**. Per-seed judge was
  100.00% / 92.86% / 92.86%; no category lost 15pp.
- Safety/provenance/accounting/bounds passed with zero failures; 126/126
  answers/verdicts reconciled and all three cleanup proofs are zero. Mean source
  expansion recovered 33 evidence-bearing questions per seed; assembly loss was
  zero.
- Valid Stage D burn was **18,995 neurons** (5,901 / 6,632 / 6,462), ending at
  1,933,244 at the harness boundary; the immediately settled meter is
  **1,933,582 / 3,000,000**. Billing guard remains first-party/non-partner and
  direct Workers AI only.
- Global benchmark lock is released and campaign process count is zero.
  Authoritative evidence: `final/holdout/STAGE-D-FINAL.md` and
  `final/holdout/results/summary.json`.
- The local config is restored to the safe between-stage posture: parent V3
  allowlist 30; capture/projection/source/rejected lanes OFF; E7 historical d04
  ten only. Exact next action is commit/deploy/prove that closure, then build and
  freeze the one-shot Stage E harness for the clean middle ten and project
  `v3-final-locomo`.

## 2026-08-11 Stage D harness frozen / no inference yet

- Repo/origin are `3565b01bad482a06633bb03ce1b91c4920e51ada`; only the
  owner-owned `AGENTS.md` is dirty. Production remains Worker
  `052d9b68-b131-45cb-b792-1804c86a50d6` with parent V3 allowlist 30,
  historical E7 ten, and every write/source/rejected lane OFF.
- No benchmark, judge or evaluator process was running and the global lock was
  absent. The Stage D contender proof exits 73 before writes, leaves the
  artifact inventory unchanged and releases the lock.
- Stage D is frozen as three sequential fresh treatment seeds on the ten-scenario,
  42-question non-LoCoMo holdout. Products are reference-blind and SHA-sealed
  before capture/answer scoring loads references. Cleanup zero is mandatory
  between seeds.
- The exact accepted candidate is E4 capture + E5 temporal + E6 projection +
  BF-2/E7/D13 depth-200 retrieval + E9A source expansion + GPT-OSS-120B.
  E2-B1, E6M, reranking, E9B and E10 remain OFF.
- Frozen mechanical gates: mean capture precision >=95%, mean judge >=80%, no
  seed below 75%, mean evidence availability >=75%, no accepted category loses
  >15pp, and zero security/durability/accounting/cleanup failure.
- Billing guard is PASS for all 11 permitted first-party `partner=false` models;
  current burn is exactly 1,914,249 / 3,000,000. Stage D cap is 90,000 and the
  500,000-neuron final LoCoMo reserve remains protected.
- Durable files: `final/holdout/STAGE-D-HOLDOUT-PREREGISTRATION.md`,
  `final/holdout/harness-manifest.json`, `final/holdout/LOCK-PROOF.json` and
  `final/holdout/harness/`.
- Activation is now live from commit/origin `efdc222eb8e6a8b0769b9d1f85a3124907937781`:
  Worker `0dc9164e-cf44-4cf2-a61c-58ab598882e2`, deployment
  `821ade3f-dbc5-40f3-b60c-857907530687`, 100% traffic. Propagation is 20/20;
  treatment/control/normal routing matches the frozen nested contract. No
  migration, binding, inference or product-code change occurred.
- Exact next action: rerun billing preflight/burn, prove clean slots/lock/process
  state, then run the three Stage D seeds under the global lock.

## 2026-08-11 V3-D13 CLOSED / exact Stage C PASS / Stage D next

- The failing-first production-schema cells proved that E7 copied 800/8,000/
  80,000 scoped rows per lane into the Worker before applying its nominal
  candidate bounds; 100k broad recall took 510,978 ms and about 898 MB locally.
- The repair performs tenant/project filtering and candidate limits in D1,
  fairly fuses bounded lane identities, walks a bounded graph, and hydrates only
  a bounded evidence closure. It is active only under the nested E7 flag; the
  legacy path remains unchanged. No migration or binding changed.
- The exact repaired 1k/10k/100k run is **PASS** with zero inference and zero
  production fixture. At 100k, target/broad recall was 1,356/2,596 ms, common
  FTS was 130 ms, delete was 4,910 ms, and maximum node/slice/edge load remained
  600. Scope, context bounds, source expansion, delete and both FTS erasure
  gates passed; final fixture state was zero.
- Full implementation gates pass: Worker **111 files / 1,313 tests**, unit/
  cross-door **33 files / 539 pass + 1 skip**, zero audit vulnerabilities, and
  Wrangler dry deploy PASS.
- Commit/origin `5f11d750386c6f276ed0188c8eb7cdb102a988a6` is live as
  Worker `052d9b68-b131-45cb-b792-1804c86a50d6`, deployment
  `29d876c2-fdd1-45b4-a784-314ae6feac7e`, 100% traffic. No migration or
  binding changed; propagation is 20/20 with normal users still outside V3.
- Exact live E7 recall passed every bound with zero lane failures: 66 items,
  9,301 context characters, 1,459 ms server latency. Production-primary state
  remains zero, all 809 packet fences are content-free, the benchmark lock is
  absent, and no temporary credential file or campaign process remains.
- Durable proof: `final/scale/evidence/stage-c-scale-repaired.json`,
  `final/scale/STAGE-C-SCALE-REPORT.md`, and
  `final/scale/evidence/v3-d13-production-reattack.json`.
- **V3-D13 HIGH is CLOSED.** Exact next action is Stage D: three independent
  frozen non-LoCoMo holdout seeds on the accepted final architecture, then the
  single decisive full LoCoMo validation if holdout does not regress.

## 2026-08-11 Final Stage B safely closed / Stage C next

- Closure commit/origin is `d2da0fc813a19cad8d2b662d26831b2fe3f98a6b`;
  Worker version `2cb1f213-0f3f-4cbc-87e1-e5d04ddabb17`, deployment
  `33986e9a-65c4-48ef-9f5b-cc595675bd12`, 100% traffic.
- 20/20 uncached production checks prove parent allowlist 30, historical d04
  hybrid 10, every write/source/rejected lane OFF/0, and equal state on both
  domains. No schema/binding/migration changed.
- Production-primary closure: every live Stage B treatment count is zero;
  packet fences 809/minimized 809/content rows 0; global benchmark lock absent.
- Durable proof is `final/STAGE-B-CLOSURE.md` and
  `final/live/evidence/stage-b-closure-state.json`.
- Exact next action: Stage C isolated local 1k/10k/100k scale. Do not place the
  100k fixture in production and do not invoke inference.

## 2026-08-11 Final Stage B PASS / closure deployment next

- The unchanged preregistered final Stage B run is valid and **PASS**. Durable
  evidence is `final/live/evidence/stage-b-live-reattack.json`; summary is
  `final/STAGE-B-FINAL.md`. Earlier invalid runs remain invalid and unscored.
- Ten parallel subtenant writes and six same-tenant/project burst writes had
  zero accepted loss; the identical-write race converged to one packet,
  episode, extraction job, pass-2 job and capture run. Tenant/subtenant/project
  isolation and exact source expansion passed.
- Eleven secret/rules storage checks plus three exports passed. Delete during
  extraction drained in 40,713 ms; erased replay returned 409; late residue,
  ten post-erasure recalls, 34-marker FTS/content audit and final live state
  were all zero. A new post-delete write succeeded.
- The bounded soak completed 10 writes and 200 recalls, drained backlog and
  survived a 30-second grace. Recall mean/p95 was 399.41/1,285 ms during soak;
  ordinary ingest/recall means were 1,625.5/231.71 ms, recall p95 410 ms.
- Valid run burn was 2,227 neurons, 1,912,019 -> 1,914,246 / 3,000,000.
  First-party Workers AI and the 500,000-neuron final reserve remain enforced.
- V3-D10/D11/D12 HIGH and H11/H12/H13 harness defects are CLOSED. Current
  product version is `e34b92bc-0577-4a16-b63d-7a1bc8b9a1f2`, deployment
  `297b55ff-9668-4c11-8886-ba3d08bcbdfb`; no migration/binding changed.
- Local closure config is prepared and verified: parent allowlist 30; write,
  source and rejected lanes OFF/0; E7 hybrid restricted to the historical d04
  ten; normal users remain outside V3. Exact next action is commit/deploy and
  prove this closure state, then Stage C isolated local 1k/10k/100k scale.

## 2026-08-11 V3-D10 HIGH CLOSED / Stage B replacement ready

- V3-D10 is **CLOSED** through the full HIGH lifecycle. Code commit/origin is
  `3148a9c1dc3fb5f147a5234eb5119156f06d5b80`; production version is
  `b0dfbaca-3807-4e18-8e66-b2d01ff5d468`, deployment
  `26d82115-74df-47a0-89fa-cb8c32b6ed0d`, 100% traffic.
- Propagation is 20/20 exact across both production domains. Parent allowlist
  remains 30; accepted capture/projection/source-expansion treatment lanes are
  10, hybrid historical+treatment is 20, rejected lanes are OFF, and no normal
  user enters V3.
- Exact production reattack: one permitted message and one request-rule-excluded
  message produced one packet message, one episode and one rule-filter count;
  forbidden hits were zero in packet, episode, atom, staging, recall and export.
  Generic export secret audit passed and request-scoped rules did not mutate the
  account configuration.
- Confirmed erasure minimized the packet to its fixed non-content sentinel with
  null preview, `{}` provenance and zero message count. Exact replay returned
  **409 `source_write_erased`, retryable=false**.
- Production-primary final audit at `2026-08-11T16:02:05.634Z`: all **622/622**
  retained campaign packet fences are minimized; plaintext content rows 0;
  episodes 0; atoms 0; projections 0; non-terminal jobs 0.
- Billing guard remained first-party/non-partner Workers AI only. GraphQL's
  settled snapshot is 1,906,099 / 3,000,000 neurons, 85,417 calls; the targeted
  reattack observed zero additional settled neurons because usage was still
  within reporting delay. The Stage B hard cap and 500,000 final reserve remain.
- No migration or binding change occurred. Next exact action: rerun the same
  preregistered Stage B security/isolation/concurrency/soak campaign from clean
  state under the hard global lock. No gates or workload may change.

## 2026-08-11 V3-D10 HIGH repaired locally / production lifecycle next

- The replacement Stage B run is **INVALID / UNSCORED** and stopped fail-closed
  at the first rules/secret persistence audit: synthetic rules-exclusion marker
  index 9 survived only in `source_packets`; the searchable episode, atom,
  graph, staging, recall and export boundaries were clean.
- Root cause: the legacy packet preview/provenance row was written after secret
  scrubbing but before rules admission. Unscoped erasure removed live memory
  but intentionally retained that packet unchanged as the D06 anti-resurrection
  replay fence. This is V3-D10 HIGH, not a harness mismatch.
- Failing-first: `source_episodes.spec.js` passed 29/31 and failed the exact
  pre-erasure rules-leak and post-erasure plaintext assertions.
- Fix: V3 resolves/fails closed on admission rules before packet durability;
  packet preview/provenance contains only admitted messages. Confirmed erasure
  strips all packet plaintext and replaces its request digest with a non-content
  sentinel while retaining only the minimal idempotency/context fence needed
  to return named `409 source_write_erased` and drain canceled DO work safely.
- Exact and regression gates: source episode suite 31/31; focused rules,
  replay, delete, race, crash and ingest set 15 files / 201 tests; full Worker
  110 files / 1,310 tests; unit/cross-door 33 files / 539 pass + one intentional
  skip; npm audit zero; Wrangler 4.120.0 dry deploy pass.
- Pre-fix production cleanup erased all live episode/semantic/graph/staging
  state and left no non-terminal jobs, but cannot close D10 because the old
  deployed erasure path still retains packet plaintext. Deploy, re-run erasure,
  prove packet content zero, and reattack the exact rules/replay contract before
  resuming Stage B.
- No migration or binding change is required. Owner `AGENTS.md` remains
  untouched. Production normal users remain outside every active V3 lane.

## 2026-08-11 Final Stage B invalid run closed / replacement ready

- Final Stage B production activation is deployed at commit/origin
  `969bb161457a4e85d2c9f3fc25bfedc24f4d81bc`, Worker version
  `c9c133a6-4353-4c2a-8c50-ba3abbe209a1`, deployment
  `45b2d68a-85ea-42fb-8f62-be8bfdbcd814`, 100% traffic. Propagation proof was
  20/20 exact across both production domains; only the ten treatment accounts
  enter accepted write/read lanes and rejected lanes remain OFF.
- Lock proof is valid: the holder exited 0, a concurrent contender exited 73
  before writing any artifact, and the lock released. No benchmark/judge or
  reattack process is running.
- The first live reattack is **INVALID / UNSCORED** due to V3-H11. Both
  concurrent same-key accepts converged onto one packet and one extract job.
  The harness incorrectly counted the legitimate downstream `pass2_rollup`
  as duplicate work and stopped before the remaining attacks.
- The audit now separates extract, pass-2 and total jobs while rejecting any
  unrecognized extra job. Syntax validation passes. Original stdout/stderr and
  the invalid-run classification are retained.
- Failed-run synthetic state was erased only through the product deletion API.
  After the 30-second grace, direct counts are zero for episodes, candidates,
  runs, projections, nodes, slices, events, edges, pages, staged rows and
  non-terminal jobs. No result artifact exists.
- Next exact action: rerun the unchanged preregistered Stage B security,
  isolation, concurrency, replay, erasure and bounded-soak campaign under the
  hard single-instance lock. Do not alter acceptance gates or inputs.

## 2026-08-11 E9B complete REJECT / E10 next — AUTHORITATIVE COLD RESUME

## 2026-08-11 E10 complete REJECT / FINAL validation next - AUTHORITATIVE COLD RESUME

- E10 deterministic adaptive context is **REJECT**. On one sealed 42-question
  non-LoCoMo state, selected item ids/order were identical in both arms. E10
  compressed mean context **242.90 -> 168.95 tokens (-30.45%)**, but evidence
  availability fell **41/42 (97.62%) -> 35/42 (83.33%)**, judge fell **39/42
  (92.86%) -> 37/42 (88.10%)**, and token-F1 fell **68.59% -> 63.13%**.
- Conditional rate rose 92.68% -> 94.29% only because needed evidence was
  removed; conditional correct count fell 38 -> 33. Single-hop lost three,
  multi-hop gained one, and temporal was unchanged. The registered gate failed,
  so frozen-399 Stage C was not run.
- State fingerprint remained
  `9fbb9ec4df9f901d06ee09764b50091a9a8d956ff7dc08b9dc96167d1c1b8baf`.
  All 42 treatment calls passed assertion/source conservation, hard bounds and
  exact item-pairing; no hard-cap source/assertion loss was hidden.
- Cleanup is zero across episodes, candidates, projections, graph state, pages
  and non-terminal jobs. The benchmark lock is released; no benchmark, judge,
  evaluator or Wrangler dev process remains.
- Settled burn is **1,904,127 / 3,000,000** (E10 +7,924; calls 85,255), only
  direct first-party `partner=false` Workers AI. Remaining is 1,095,873 and the
  protected 500,000-neuron final reserve remains intact.
- HEAD/origin is `aa16f8a1eded327aaa2af95a933dcc88032b6433`; only owner
  `AGENTS.md` is dirty. Production Worker is
  `7bb3ac6b-8c50-48e7-aa33-b3250deef657`, deployment
  `eaae0273-d09d-4e97-af95-f336315d040e`, 100% traffic. Parent V3 is
  allowlist/30; writes, E9A, E9B and E10 are OFF/0; E7 is restored to d04 ten.
- Accepted final-validation candidate: scrubbed episodes + E4 atomic capture +
  E5 temporal metadata + governed E6 projection + E7 assertion-level fusion +
  exact E9A source expansion + GPT-OSS-120B. Excluded: E2-B1, E6M, E8, E9B,
  E10.
- Next exact phase: preregister and execute FINAL security/erasure/replay/
  cross-door/concurrency/soak/scale validation, then repeated frozen holdout,
  complete frozen 1,540-question LoCoMo, cleanup and final verdict. Preserve at
  least 500,000 neurons; no exploratory full-data run.
- Full evidence: `e10/E10-ADAPTIVE-CONTEXT-RESULT.md` and
  `e10/results/summary.json`.

- E9B bounded semantic-thin episode FTS fallback is **REJECT**. On one sealed
  42-question non-LoCoMO state, control and treatment both scored **41/42 judge
  (97.62%)**, **40/42 evidence availability (95.24%)**, and **40/40 conditional
  accuracy (100%)**. Every category was unchanged.
- E9B triggered 18 times and retrieved 24 bounded FTS candidates, but rendered
  zero episodes: 23 were exact E9A duplicates and the one novel candidate
  failed the frozen overlap gate. All 42 contexts and ordered item arrays were
  byte-identical. Temperature-zero reader outputs differed on 12 questions but
  did not alter judge totals; the token-F1 +0.30pp is reader variance, not E9B.
- Recall p95 rose **68 -> 109 ms (+60.29%)**, failing the registered +40% gate.
  Every flag/scope/privacy/bound/fingerprint gate passed and lookup failures
  were zero. No episode vector or broader fallback was introduced.
- Both valid arms used fingerprint
  `f6dfc50251ac9165b4913b940df1fa4a4db37a4b5989ef0b8aaf02b6eb138be4`:
  84 episodes, 91 candidates, 91 exact projections, zero non-terminal jobs.
  References loaded only after both product artifacts were sealed.
- Two propagation-only preflights failed closed before recall, evaluator,
  inference, artifact writes, or reference access. They are durably invalid and
  no partial output was reused. Final restoration passed 20/20 uncached health
  checks across both domains.
- Cleanup is zero across episodes, candidates, projections, graph state, pages
  and non-terminal jobs. The global lock is released and no campaign benchmark/
  judge/evaluator process remains.
- Settled burn is **1,896,203 / 3,000,000** (E9B +6,825; calls 84,960), only
  permitted first-party Workers AI. Remaining is 1,103,797 and the protected
  500,000-neuron final reserve remains intact.
- HEAD/origin is `6282988c92dba786d3b988fdb851861acb0a7319`; only owner
  `AGENTS.md` is dirty. Production Worker is
  `b7fffb0e-357a-4f90-9f0e-31a644c6814c`, deployment
  `9daefc1d-a017-4d1d-9ac1-003b60f6c49e`, 100% traffic. Parent V3 remains
  allowlist/30; writes/source/E9B are OFF/0; E7 is restored to the d04 ten.
- Next exact phase: preregister **E10 deterministic adaptive context** using
  accepted E7+E9A only. E9B and reranking stay OFF. Test whether query-complexity
  budgeting of already-selected evidence improves quality without dilution,
  unbounded context, another retrieval lane, or re-ingest.
- Full evidence: `e9b/E9B-EPISODE-FALLBACK-RESULT.md` and
  `e9b/results/summary.json`.
- Hash closure is deterministic across two independent regenerations: selected
  manifest 105 files / SHA-256
  `332D2E63183D2DAA77D8046574B1DB77DE303A565A3E9D3196778CAA327619A1`;
  full campaign manifest 921 files / SHA-256
  `C65214144AD3676E93515BD34A8795BDE97D4B1D371F088D47890CCDE3F4B801`.

## 2026-08-11 E9A complete KEEP / E9B next — AUTHORITATIVE COLD RESUME

- E9A exact source-evidence expansion is **KEEP** on the frozen non-LoCoMo
  holdout. Against the same sealed E7 state, judge moved **40/42 (95.24%) ->
  41/42 (97.62%)**, token-F1 **65.38% -> 72.83%**, evidence availability stayed
  **40/42 (95.24%)**, and conditional correctness moved **38/40 (95%) -> 40/40
  (100%)**. Single-hop gained one; multi-hop and temporal remained perfect.
- Context stayed bounded: mean 554 -> 990 chars / about 139 -> 248 tokens.
  Recall p95 was **40 -> 50 ms**, exactly the registered +25% ceiling; source
  lookup itself averaged 10.5 ms. Zero expansion failures occurred.
- Both read arms used the identical production fingerprint
  `9eb697f072ba55034e75e06392cceb6499d78adc049b94264f8ac3211d773628`:
  84 episodes, 89 candidates, 89 projections and zero non-terminal jobs.
  References loaded only after both 42-answer product artifacts were sealed.
- V3-H10 MEDIUM harness defect is closed before read/score. A valid ten-scenario
  ingest stopped at its post-write verifier because synchronous Wrangler child
  capture failed and the fingerprint selected `memory_pages.state` instead of
  `health_state`. No re-ingest occurred. A resume-only, direct D1 HTTPS,
  production-primary seal proved all terminal jobs/provenance before reads.
- Cleanup is zero across episodes, candidates, projections, graph state, pages
  and non-terminal jobs. E9A artifacts and report are retained intentionally.
- Settled burn is **1,889,378 / 3,000,000** (E9A +6,647, about $0.07), all
  permitted first-party Workers AI. Remaining is 1,110,622; protected final
  reserve 500,000 remains intact.
- HEAD/origin is `c34a345160b92bfc1c2272841b7b63e9ff337f63`; only owner
  `AGENTS.md` is dirty. Production Worker is
  `eec4b955-ac88-4627-b834-a424c98069bb`, deployment
  `0268dfa2-7a03-4648-8818-e9cf7ea00983`, 100% traffic. Both domains report
  parent V3 allowlist/30; capture/projection/coalescing/source expansion OFF/0;
  E7 restored to only its prior ten d04 tenants. Normal users remain outside V3.
- Next exact phase: preregister and build **E9B bounded episode FTS fallback**
  as a separate nested flag. Its control is accepted E7+E9A; treatment adds
  fallback only when semantic evidence is thin. No vectors, no full-conversation
  dump, no E10, and no LoCoMo run before E9B earns KEEP.
- Full evidence: `e9/E9A-SOURCE-EXPANSION-RESULT.md` and
  `e9/results/summary.json`.

## 2026-08-11 E7 complete KEEP / E9 next — AUTHORITATIVE COLD RESUME

- E7's immutable frozen-399 quality result is **KEEP**: judge
  **46.87% → 54.64% (+7.77pp)**, evidence availability
  **67.67% → 68.67% (+1.00pp)**, conditional accuracy
  **58.52% → 64.60% (+6.08pp)**, and temporal
  **33.73% → 57.83% (+24.10pp)**. No category regressed.
- The preregistered E7M recall-only cell reproduced all 399 control and 399
  treatment context hashes and ordered item identities exactly. Current server
  mean/p95 was **352.7/414 ms control** versus **366.0/416 ms treatment**;
  p95 increased only **0.48%** against the registered +25% limit. Client p95
  increased 7.12%. Every lock, route, context, semantic-fingerprint, stored-
  memory, spend and safety gate passed.
- One treatment client-wall-clock maximum included a long host/network pause;
  it did not affect current server telemetry, paired p95, context identity, or
  the preregistered decision. It remains visible in the machine summary rather
  than being removed.
- E7M used **58 / 5,000** neurons; settled campaign burn is
  **1,882,731 / 3,000,000** (about $20.71), with only permitted first-party
  Workers AI and the protected 500,000-neuron final reserve intact.
- Final E7 production state is Worker
  `966cf9ac-9e4c-4906-9431-da375ad6b35b`, deployment
  `4d67253d-a011-422b-9185-08c0eeb64661`, 100% traffic. Parent V3 remains
  allowlist/30; all write flags are OFF/0; E7 hybrid retrieval is allowlist/10
  for only the retained d04 benchmark tenants. Normal users remain outside V3.
- HEAD/origin is `cc98dcffdd832c721d1f67797f02eeeeeedfeffc`; only owner
  `AGENTS.md` is dirty. No benchmark/judge process or benchmark lock remains.
- V3-D09 MEDIUM is closed. E8 remains ALL REJECT and must not be resurrected.
- Next exact phase: preregister E9 bounded source-evidence expansion on the
  frozen non-LoCoMo holdout with E7 as the read baseline. Build/test/deploy it
  behind a new nested scope flag, ablate it, and decide before separately
  testing episode fallback. Do not combine the two mechanisms.

## 2026-08-11 E7 frozen-399 quality confirmed / E7M latency cell preregistered — AUTHORITATIVE COLD RESUME

- E7 trial 9 completed all 399 frozen questions and judges with zero errors or
  retries. Against the immutable paired combined E1+E0 control, judge accuracy
  improved **46.87% → 54.64% (+7.77pp)**, evidence availability
  **67.67% → 68.67% (+1.00pp)**, conditional accuracy
  **58.52% → 64.60% (+6.08pp)**, and temporal accuracy
  **33.73% → 57.83% (+24.10pp)**. Every quality, scope, stored-state and
  safety gate passed.
- E7 remains mechanically **MODIFY** only because its client-wall-time p95 was
  28.22% above the old paired artifact's client p95, narrowly missing the
  registered 25% gate. The old server arrays were byte-identical because the
  benchmark adapter had read immutable first-call receipt telemetry.
- **V3-D09 MEDIUM is CLOSED** at `02ab877`: recall now exposes a backward-
  compatible top-level current-invocation `recall_latency_ms` while retaining
  the immutable durable receipt. Failing-first was 17/18; focused closure was
  18/18; full Worker was 1,288/1,288; unit/cross-door was 539/539 plus one
  intentional skip; audit and dry deploy passed. Two production recalls kept
  one receipt id/771 ms but exposed distinct current latencies 771/351 ms.
- Production is Worker `5f6508ef-5d2f-44d9-af0a-a4fbb6b13864`, deployment
  `c45a6621-d77e-4521-929e-9400381cd17c`, 100% traffic. Parent V3 is
  allowlist/30; all V3 write flags are off/0; E7 is allowlist/10 for the ten
  retained d04 benchmark accounts. Normal users remain outside V3.
- HEAD/origin is `02ab877d45542461727f998ee875b3903bd8e2c7`; only owner
  `AGENTS.md` is dirty and must never be altered or staged.
- Settled metering immediately before E7M is **1,882,673 / 3,000,000**
  neurons (62.8%, about $20.71); every billed model is permitted first-party
  Workers AI and the 500,000-neuron final reserve is intact.
- E7M is frozen in `e7/E7M-LATENCY-PREREGISTRATION.md`: same 399 queries,
  paired control/treatment recall only, exact historical context/item hashes,
  no reader/judge/re-ingest/reranker, current server p95 gate <= +25%, and a
  5,000-neuron cap. Its lock proof passed: owner 0, competitor 73, zero writes,
  clean release.
- Next exact action: deploy only the E7 nested read flag OFF, run and seal the
  control recalls, restore the exact ten-account allowlist, run and seal the
  treatment recalls, then apply the preregistered E7M gate. If KEEP, continue
  directly to E9 source-evidence expansion; E8 remains rejected.

## 2026-08-11 E7 holdout passed / frozen-399 confirmation next — AUTHORITATIVE COLD RESUME

- Valid E7 trial 2 used one sealed semantic state for both arms. Treatment
  reached **42/42 judge (100.00%)**, **95.24% evidence availability**, and
  **100.00% conditional accuracy**, versus control 90.48%, 83.33%, and
  100.00%. Stored-but-not-retrieved fell 4 → 0 and assembly loss 5 → 0.
- Every pre-registered holdout expansion gate passed. Verdict is
  **EXPAND_TO_FROZEN_399**, not final KEEP. Full evidence is
  `e7/E7-HOLDOUT-REPORT.md` and `e7/results-trial2/summary.json`.
- The invalid first trial remains explicitly unscored. Trial 2 fixed only the
  harness fingerprint classification of expected recall audit packets; all
  durable source/semantic rows retained exact pre/post hash
  `e882d0cf944aa347aeab5fa54c5738f7064746a31b7d4b5ad778134a155f08b7`.
- Cleanup is zero. Final E7 holdout burn is **1,820,295 / 3,000,000**;
  E7 consumed 8,870 neurons including invalid/meter overhead. Before any 399
  inference, `e7/E7-COST-AMENDMENT-BEFORE-399.md` prospectively raised only the
  E7 stage cap to 100,000 because the measured analogous wide-context E8 cell
  cost 68,949 neurons. Quality gates remain frozen; the 500,000 final reserve
  is intact.
- Repo HEAD/origin is `2bde4687eccfc593ed914c28245d9bc8b3d17223`.
  Only owner `AGENTS.md` is dirty; never alter or stage it. Confirmation Worker
  is `d75c0609-6b74-499e-8236-3963c379caf7`, deployment
  `2c4ab923-5c5c-45bc-84c6-8f9fc74bcd28`; parent V3 is allowlist/30, every
  write flag is off/0, and E7 read treatment selects only the ten existing d04
  benchmark accounts. Normal users remain outside V3.
- No benchmark, judge, evaluator, or Wrangler process is running. Next exact
  action: switch only the nested E7 read allowlist from the cleaned holdout
  cohort to the ten existing d04 benchmark accounts, prove health/lock/input
  hashes, and run the treatment-only frozen 399 confirmation with depth 200,
  GPT-OSS-120B, no reranker, and no re-ingest. Compare against the immutable
  46.8672% / 67.6692% / 58.5185% paired control under the registered gates.

## 2026-08-11 E6M complete / MODIFY — AUTHORITATIVE COLD RESUME

- E6M completed three paired frozen non-LoCoMo seeds under the hard benchmark
  lock. Treatment versus control: judge **84.13% vs 82.54%** (+1.59pp),
  token-F1 **60.09% vs 60.05%**, evidence availability **83.33% vs 77.78%**
  (+5.56pp), and conditional accuracy **95.37% vs 95.95%** (-0.58pp).
- Same-source paraphrases fell **55.87%** (8.10% → 3.58%) with zero registered
  false merges and complete projection/provenance accounting. The mechanical
  verdict is **MODIFY**: precision fell 6.73pp and final rendered-context
  duplication remained 9.74%, failing the registered 1pp/5% gates.
- The write-time coalescer is not adopted. Preserve it nested-off; carry the
  redundancy problem into non-destructive fusion/context compilation rather
  than deleting semantic views at write time.
- Every seed cleaned to zero live synthetic state. Final E6M burn is
  **1,811,425 / 3,000,000**; E6M consumed 45,398 neurons and the 500,000 final
  reserve remains protected.
- Repo HEAD/origin is `9c9a17f6643026180141a0f0efd4137de962fd26`.
  Only the owner's `AGENTS.md` is dirty; never stage or alter it.
- Production closure is deployment `56821ad0-8f39-47ae-8f3d-8b77ab156879`,
  Worker `9b049028-90ba-4e04-bec8-2e0f9c79e610`, 100% traffic. Both domains
  report parent V3 allowlist 30 and atomic capture/projection/coalescing OFF/0.
- Full evidence: `e6m/E6M-REPORT.md`, machine summary
  `e6m/results/summary.json`, and closure `e6m/DEPLOYMENT-CLOSURE.md`.
- Next exact phase: preregister **E7 hybrid retrieval/fusion** using accepted
  episode/atomic/temporal primitives. Keep E8 rejected; do not re-ingest or run
  full LoCoMo. Start with reference-blind lane diagnostics and the frozen
  non-LoCoMo holdout, protecting the final inference reserve.

## 2026-08-11 E6 complete / MODIFY — AUTHORITATIVE COLD RESUME

### 2026-08-11 E6M paired cell ready — latest authoritative state

- Repo HEAD/origin is `613490361e0209e100cf256a1987206f13758513`.
  The only unrelated dirty file is the owner's `AGENTS.md`; never stage or
  alter it.
- Exact coalesced candidates now receive the content-free projection-ledger
  reason `same_source_coalesced`, allowing the harness to audit each real merge.
  Failing-first was 16/18 and focused closure is 18/18. Full Worker regression
  exited 0; unit/cross-door is 539/539 plus one intentional skip; audit is zero.
- Hard global-lock proof: first driver 0, competing driver 73, zero competing
  artifact writes, owner released the lock. Pure construct-metric tests are 4/4.
- Production cohort Worker is `27bf54c5-570d-465d-b878-41065a16e1c5`,
  deployment `9235dcb9-9e27-4eb6-ae1f-3db2b16e5a30`, 100% traffic. Both health
  domains report parent V3 allowlist 30, atomic capture 20, projection 20 and
  coalescing treatment-only 10. Normal users remain outside every nested path.
- Frozen/hash, direct first-party Workers AI, burn and D1 residue preflight is
  PASS at `e6m/E6M-PREFLIGHT.json`: burn **1,766,027 / 3,000,000**, E6M delta
  zero, 500,000 final reserve protected, and all episode/atom/projection/graph
  counts are zero across both ten-account arms.
- Next exact action: run the three paired E6M seeds sequentially under the
  45,000-neuron stage cap; cleanup each seed; aggregate the preregistered gates;
  then immediately restore every nested cohort flag to OFF.

E6M is now preregistered at `e6m/E6M-PREREGISTRATION.md` before source change
or inference. Its paired three-seed cell changes only conservative same-source
legacy/atomic coalescing, uses the same frozen holdout and fixed E1+E0 read
path, and has a 45,000-neuron incremental cap. The corrected duplicate gates
separate physical/source-identity duplication, representation overlap and
rendered-context duplication; original E6 evidence remains immutable.

E6M implementation is committed/pushed at
`1cf8226dfc190b1b91969d0f27e11c28c802e5cf` and deployed default-off as Worker
`de41f362-7e4a-4de1-8e8d-57201a92b2f3`, deployment
`6363856a-483f-44ab-864c-62974f448eec`, 100% traffic. Both health domains
converged to B1/atomic capture/projection/coalescing OFF/0. No migration or
inference occurred.

Failing-first was
49 pass / 9 expected fail; focused is now 60/60, full Worker exited 0,
unit/cross-door is 539 pass + 1 intentional skip, and the 15-file security/
scope/erasure/replay reattack is 143/143. Audit is zero and dry deploy passes
with every nested E6M write switch OFF. Next: build and collision-test the
paired E6M harness, then commit/deploy only the frozen cohort configuration.

- E6 governed atomic projection completed three paired frozen non-LoCoMo seeds.
  Treatment versus control: capture recall **90.30% vs 55.76%**, judge
  **84.92% vs 55.56%**, token-F1 **58.66% vs 37.96%**, and evidence
  availability **79.37% vs 51.59%**. Conditional accuracy remained high at
  **95.07%** (-1.90pp). All three seeds improved and projection/provenance was
  264/264 with zero failure.
- Mechanical verdict is **MODIFY**, not KEEP: the preregistered semantic
  duplicate gate failed (49.09% treatment, 41.33% control, +7.76pp). Exact row
  duplication was near zero; diagnosis isolated same-source legacy/atomic
  paraphrases plus intentional multi-view graph representation.
- Full report: `e6/E6-ABLATION-REPORT.md`; machine result:
  `e6/results/summary.json`. Preserve all invalid scorer attempts as invalid.
- Repo HEAD/origin: `c874ddb35d8ba9edfa6a8b8c96281c47ce7519ae`.
  Only the owner's unrelated `AGENTS.md` is dirty; never stage or alter it.
- Production closure Worker `17f01ba0-cddd-42d5-b41f-0040f3a4fbd2`,
  deployment `98a25928-58ae-4b07-85d5-4d221c4bfdf5`, 100% traffic. Both health
  domains report parent allowlist 30 and B1/atomic capture/projection OFF/0.
- E6 closed at 1,766,026 neurons; the latest live meter is **1,766,027 /
  3,000,000 (58.87%)**, approximately $19.43 at the published rate. E6
  consumed 49,485 neurons, including all
  invalid harness overhead; the 500,000-neuron final reserve remains intact.
- Next exact phase: preregister and implement **E6M conservative same-source
  legacy/atomic paraphrase coalescing**, then rerun the smallest valid frozen
  holdout confirmation. Do not start E7 until E6M earns adoption.

## 2026-08-11 E6 treatment ready — AUTHORITATIVE COLD RESUME

- Cohort config is committed/pushed at
  `9f50955f94ae1c3054730aa204e17f7028105098` and deployed as Worker
  `dd045daf-c8f9-49ed-a1fc-d23be4b1b9b4`, 100% traffic.
- Both health domains converged to parent V3 allowlist 30, atomic capture
  allowlist 20, and atomic projection allowlist 10. The 10 controls have no
  projection membership; all 20 slots are parent-selected and residue-free.
- The E6 reference-blind driver preserves the frozen hashes, depth 200,
  GPT-OSS-120B reader, and no reranker/E7/E9/E10. Its second-driver proof exits
  73 before any artifact write. Product/export artifacts seal before scoring.
- Live billing gate PASS immediately before inference: all 11 models
  `partner=false`, no AI Gateway, burn exactly
  **1,716,541 / 3,000,000 (57.22%)**, E6 incremental zero.
- Next: run the preregistered three seeds sequentially under the global lock and
  40,000-neuron E6 cap; cleanup each seed; apply mechanical KEEP/MODIFY/REJECT.

## 2026-08-11 E6 production-safe base deployed — AUTHORITATIVE COLD RESUME

- Commit/origin: `bccda71e47addcf50fd53d8937ab23e8e81e8572`.
- Additive migration 0037 **SUCCEEDED**: 16 commands in 274.95 ms under Time
  Travel bookmark
  `00000ac0-00000000-000050c3-81c57d3d736a8e69d3dfd41ac826db88`.
  Mandatory readback passed; migration 0037 is now immutable.
- Production Worker: `d099d531-a67c-45f7-825a-878a103bcf5f`, 100% traffic.
  Both health domains report parent allowlist 30, B1 off, atomic capture off,
  and atomic projection off. No normal user can enter the E6 path.
- E6 inference remains zero; burn remains
  **1,716,541 / 3,000,000 (57.22%)**.
- Next: build/verify the preregistered paired three-seed holdout driver, enable
  capture+projection only for explicit treatment accounts, and run C0/T1 under
  the 40,000-neuron E6 cap. No E7/E9/E10 read-path component is permitted.

## 2026-08-11 E6 committed/pushed — AUTHORITATIVE COLD RESUME

- E6 governed atomic projection is committed and pushed at
  `bccda71e47addcf50fd53d8937ab23e8e81e8572`; HEAD and `origin/master` match.
- Migration 0037 SHA-256 is
  `a291e36ae4f18c086fb4256a6047a294fb85a2417c611d28747576a49852a9e5`.
  The final append-only checksum gate is 3/3 and the staged diff check was
  clean. Production migration 0037 has **not** yet been attempted.
- Only the owner's unrelated `AGENTS.md` is dirty; never stage or alter it.
- E6 inference remains zero; campaign burn remains
  **1,716,541 / 3,000,000 (57.22%)**.
- Next safe boundary: verify the remote migration chain and exact schema-before,
  capture a current D1 Time Travel bookmark, durably record all preflight
  evidence, then apply additive migration 0037. Any production migration
  failure is a hard stop with no unattended repair.

## 2026-08-11 E6 implementation/local rehearsal complete — AUTHORITATIVE COLD RESUME

Resume from this section, `e6/E6-PREREGISTRATION.md`, and
`e6/IMPLEMENTATION-EVIDENCE.md`. Do not rerun E0–E5 or recreate migration 0037.

- E6 governed projection is implemented but not yet committed, production-
  migrated, deployed, or ablated. It routes exact episode-backed atomic
  assertions through the existing rules/entity/conflict gates and atomic graph
  commit; it does not add E7 retrieval, reranking, episode fallback, or E10.
- Additive migration `0037_governed_atomic_projection.sql` is checksum-registered
  at `a291e36a…2a9e5`. Its local D1 rehearsal succeeded (16 commands); local
  readback confirmed the ledger, indexes, four slice fields, and five event
  fields. **Production migration has NOT been attempted.**
- Focused post-migration gates pass: projection/date/episodes 53/53; SRV-08
  13/13; source/atomic 41/41; scope/write 22/22; append-only 3/3. Unit/cross-door
  is 539 pass + 1 intentional skip; audit is zero; dry deploy passes.
- Full Worker harness evidence is honest: complete runs reached 1265/1272 and
  1271/1272 with only unrelated five-second pool timeouts. The exact specimens
  passed 107/107 and 1/1 on immediate isolated reruns; no assertion mismatch.
- Repo base remains HEAD/origin `525d4abe3a53771c6ab4ba59abf9af8661f514ea`.
  E6 changes are uncommitted. The owner's unrelated `AGENTS.md` remains dirty
  and must never be staged or altered.
- Production remains unchanged at Worker `46990d10-410e-4e17-b36d-a50583323d5d`;
  parent V3 allowlist 30, atomic capture off, and no projection rollout exists.
- E6 inference: zero. Burn remains **1,716,541 / 3,000,000 (57.22%)**.
- Next: final diff review → commit E6 only → push/origin verify → remote chain,
  schema-before and PITR proof → apply 0037. Migration failure is a hard stop.

## 2026-08-11 E5 complete / KEEP — AUTHORITATIVE COLD RESUME

Resume from this section and `e5/E5-REPORT.md`; older current-state sections
are historical and must not be rerun.

- **E5 KEEP.** Deterministic temporal representation scored 16/16 direct frozen
  cases and 24/24 captured temporal targets across three sealed E4 seeds, with
  zero false precision. The repaired production proof resolved 7/7 candidate
  phrases, preserved exact replay, and erased to zero live state.
- E5 does not claim reader/LoCoMo improvement: candidates still have no recall
  participation. E4 captured only 8/13 exact temporal phrases per seed, so
  capture remains an upstream limitation.
- V3-D08 HIGH is CLOSED. Production and a failing-first regression proved that
  the Durable Object omitted authoritative `source_time` before extraction.
  Commit `bd06e80793d0fedcca822bfcffb67d43a84617bb` preserves the canonical
  field through held and queued state. Full Worker gate: **105 files / 1,257
  pass**; unit: **539 pass / 1 intentional skip**; focused suite 170/170;
  audit 0 and dry deploy pass.
- Additive migration 0036 succeeded under PITR bookmark
  `00000aac-00000000-000050c3-5238a1e1beef603ac35b0c56fd23ca4e`.
  Its hash and exact schema/apply evidence are in `e5/` and the migration
  ledgers. Never edit this applied migration.
- Repo HEAD/origin: `525d4abe3a53771c6ab4ba59abf9af8661f514ea`.
  Only the owner's unrelated `AGENTS.md` is dirty; never stage or alter it.
- Production closure Worker version:
  `46990d10-410e-4e17-b36d-a50583323d5d`, 100% traffic. Both domains report
  parent V3 allowlist/count 30, B1 OFF/count 0, atomic capture OFF/count 0.
  Production-primary atomic candidate/run counts and E5 residue are zero.
- Current burn: **1,716,541 / 3,000,000 neurons (57.2%)**, direct first-party
  Workers AI only. E5 live attempts consumed 1,329 neurons from the frozen
  1,715,212 boundary; the repaired proof itself added 205 observed neurons.
- Next exact phase: **E6 governed candidate projection + fixed E1+E0 read
  path**, preregistered before inference. It must isolate write-path value and
  may not revive the rejected item reranker or add episode fallback yet.

## 2026-08-10 E4 complete / KEEP — AUTHORITATIVE COLD RESUME

Resume from this section and `e4/E4-REPORT.md`. Older E4 live sections are
historical evidence and must not be rerun.

- **E4 KEEP.** Three valid production-path non-LoCoMo holdout seeds measured
  mean capture recall **74.55% ± 3.93pp**, precision **99.25% ± 0.53pp**, F1
  **85.08% ± 2.47pp**, schema validity 100%, duplicate rate 2.25%, and two
  false contradictions per seed. All registered gates passed.
- Zero accepted grounding, scope, secret, or accounting failures. Provenance
  and receipt conservation were 100%; replay and erasure converged in all three
  seeds; nested control routing passed. No LoCoMo or read-path participation.
- Four reference-blind, unsealed, unscored invalid attempts are preserved as
  V3-H06 through V3-H09; V3-I03 records one post-score D1 read transient. All
  are closed. Invalid inference burn remains charged and every attempt was
  erased before replacement.
- Confirmation burn: 1,700,453 -> **1,715,211** = 14,758 neurons. Campaign is
  57.17% of the 3,000,000 ceiling; direct first-party `partner=false` Workers
  AI only, no AI Gateway. The 500,000 final reserve remains intact.
- Final E4 production-primary residue is zero. Temporary treatment routing was
  removed. Both domains report parent V3 allowlist/count 30, B1 OFF/count 0,
  and atomic capture **OFF/count 0**.
- Repo HEAD/origin: `f4a6beb7b38a18fabfca4056e396b5eb5ab4d0a0`.
  Only the owner's unrelated `AGENTS.md` remains dirty. Never stage or alter it.
- Closure deployment `39160155-fdb5-4b9b-b247-2070e2b236ad`, Worker version
  `443c6e65-0066-42a3-8dca-2ccaa0bd0908`, 100% traffic.
- Architecture decision: keep A3 candidates as durable write-only evidence.
  Do not expose them to recall or semantic authority yet. **Next: E5 temporal
  representation**, then E6 separately earns candidate projection with the
  fixed E1+E0 read path.

## 2026-08-10 E4 product confirmation running — AUTHORITATIVE LIVE RESUME

- Repo HEAD/origin are `cda8cf6d7bfdb12a1696494a2f264f5c29d7dfc0`;
  only the owner's unrelated `AGENTS.md` is dirty. Atomic capture is allowlisted
  to exactly ten frozen treatment accounts; normal users remain off.
- Worker version `b0089719-41ec-483a-a3fd-c31aa1f73cff`, deployment
  `d07c6e8f-1b32-44ad-9c40-7037b1efb641`, 100% traffic. Both domains proved
  parent V3 allowlist/count 30, B1 off/count 0, atomic allowlist/count 10.
- E4 product confirmation is executing the preregistered three valid seeds
  under the hard single-instance benchmark lock. Frozen holdout/cohort hashes,
  A3 model, gates, and 30,000-neuron confirmation cap are unchanged.
- Invalid attempt 001 is a closed MEDIUM harness defect: a blanket structured
  export scan false-positive classified opaque IDs as secrets after ten
  reference-blind calls, before seal/score. Burn 2,277 neurons; all live state
  erased. Evidence: `e4/product-confirmation/INVALID-ATTEMPT-001.md`.
- Invalid attempt 002 is expected V3-D06 safety behavior: exact reuse of the
  erased idempotency key returned 409 `source_write_erased` before inference or
  write. The clean replacement uses only a distinct transport namespace;
  evaluated content is unchanged. Evidence:
  `e4/product-confirmation/INVALID-ATTEMPT-002.md`.
- Export-audit repair passes a normal structured fixture and rejects a secret
  in content. Before the clean run: direct production-primary residue was zero,
  no benchmark process/lock existed, and 11/11 models were direct first-party
  `partner=false` Workers AI with no AI Gateway.
- Invalid attempt 003 exposed and closed V3-H08: HO-06 correctly recovered
  from one transient extraction failure, but the harness rejected its two-row
  retry history. Retry-aware identity/conservation tests now pass; the invalid
  attempt consumed 1,255 neurons, was never sealed/scored, and was hard-erased
  to independently verified zero live residue.
- Latest measured burn before further progress: **1,703,985 / 3,000,000**
  neurons. The exact clean seed-1 replacement uses only transport namespace
  `replacement-002`; all frozen evaluated inputs and gates are unchanged.
- Invalid attempt 004 then closed V3-H09: `extraction_runs.job_id` points to the
  same-packet pass-2 job by design, not the ingest job. The scope-aware link
  regression passes, the one-call attempt was never sealed/scored, burn is now
  **1,704,387 / 3,000,000**, and cleanup independently converged to zero. The
  next exact replacement namespace is `replacement-003`.
- Valid seeds 1 and 2 are sealed and pass their individual gates. Seed 1:
  recall 80.00%, precision 98.88%, F1 88.44%. Seed 2: recall 70.91%, precision
  98.86%, F1 82.58%. Seed-2 API cleanup erased all state; its final read-only
  D1 verification command failed transiently before artifact write. Independent
  production-primary proof is zero across every live surface. V3-I03 is closed
  with bounded read-only retries; resume only the idempotent seed-2 cleanup,
  then seed 3. Latest burn: **1,711,544 / 3,000,000**.
- Cold resume rule: first inspect the lock/process and `run.log`. If the driver
  is still alive, let it finish. If it stopped, preserve the exact stop,
  classify it, verify zero/known state, and resume only if protocol integrity
  permits. Never launch a second driver.

## 2026-08-10 E4 product deployed OFF / confirmation pending — AUTHORITATIVE COLD RESUME

Resume from this section, `e4/E4-PREREGISTRATION.md`,
`e4/model-bakeoff/stage-b-summary.json`, and
`e4/IMPLEMENTATION-EVIDENCE.md`. Older current-state sections are historical.

- E4 Stage B confirmed **A3 `@cf/meta/llama-4-scout-17b-16e-instruct`**.
  Across three independent holdout runs: capture recall 54.55%, precision
  97.90%, F1 69.85%, schema validity 100%, duplicate rate 4.76%, and zero
  accepted grounding/scope/secret failures. Incumbent A1 failed the registered
  recall/F1/schema gates.
- The smallest source-grounded product slice is committed, migrated, and
  deployed but not yet invoked: nested default-OFF
  `ITSUKI_MEMORY_V3_ATOMIC_CAPTURE`, append-only migration 0035, exact episode
  provenance, deterministic replay/dedup, erasure fencing, typed terminal
  outcomes, and privacy-safe receipt counters. It has **no recall
  participation**.
- Failing-first product evidence is preserved. After the final accounting
  repair, the complete Worker gate is **105 files / 1,244 pass** and the unit
  gate is **33 files / 539 pass / 1 intentional skip**. `npm audit` reports
  zero vulnerabilities, Wrangler 4.120 dry-run passes, syntax checks pass, and
  `git diff --check` is clean.
- Review found and closed a LOW pre-deployment accounting defect: a correctly
  deduplicated cross-rechunk atom was reported as newly stored. The failing test
  observed stored=1/duplicates=0; durable batch accounting now reports
  stored=0/duplicates=1 and focused 9/9 persistence tests pass.
- Additive migration `0035_semantic_atom_candidates.sql` SHA-256 is
  `3710442146add152af84203fef725ca5aa4c6b05404c4420cbd5b9698a4c2346`.
  The complete local chain applied successfully; local ledger reports no
  pending migrations and the real schema contains both tables, 35 candidate
  columns, and the registered dedup/entity/packet indexes. The production chain
  is now complete through 0035; the migration is immutable.
- Repo HEAD/origin/remote master are
  `8111456387390ec332b0f09d8bc77a82aff83807`; only the owner's unrelated dirty
  `AGENTS.md` remains. Never stage or alter `AGENTS.md`.
- Production migration 0035 succeeded: 12 commands / 4.13 ms. The remote chain
  has no pending migration, both new tables are readable and empty, critical
  dedup index use succeeds, and storage increased 65,536 bytes. Recovery
  bookmark and exact before/after evidence are in
  `e4/0035-PRODUCTION-SCHEMA-BEFORE.md` and
  `e4/0035-PRODUCTION-APPLY.md`.
- Exact commit 8111456 is Worker version
  `6c08fad9-1204-489b-95a4-03fd4b2b07fa`, deployment
  `bf3a4be0-9cf8-445b-83c9-450dc3ca0bc3`, 100% traffic. Both domains converge
  on parent V3 allowlist/count 30, B1 OFF/count 0, and atomic capture OFF/count
  0. The new tables still contain zero rows.
- Latest live burn remains **1,700,453 / 3,000,000 neurons (56.68%)**. No model
  call was made by this product-integration work. Direct first-party
  `partner=false` Workers AI only; no AI Gateway.
- Exact next action: freeze the three-seed E4 product-confirmation manifest and
  budget, recheck live burn/model path/process/lock state, select only synthetic
  holdout tenants in the nested allowlist, deploy, prove selected-vs-control
  routing, then run the product confirmation and cleanup sequentially.

## 2026-08-10 E3 complete / KEEP — AUTHORITATIVE COLD RESUME

Resume from this section, `e3/E3-REPORT.md`, and
`e3/E3-SCORER-V2-ATTRIBUTION.md`. Older current-state sections remain
historical.

- E3 acceptance-atomic scrubbed source episodes: **KEEP**.
- Three seeds preserved 252/252 exact episode rows. Source-time-aware episode
  atom recall was 98.79%; paired recovery of the original semantic misses was
  97.78%, above the frozen 90% gate.
- The unchanged semantic control remained inside prior seed variance. Episodes
  were not sent to the reader; FTS top-8/top-20 availability of 73.81% remains
  diagnostic for E9, not an answer-quality claim.
- Raw scorer-v2 re-sampled the unchanged semantic evaluator. Its episode
  judgments are valid; its new semantic sample is non-causal. The final paired
  result used original semantic judgments plus v2 episode judgments and made
  zero new inference calls.
- V3-D06 HIGH is closed. Exact replay of an erased terminal write now returns
  409 `source_write_erased`; production reattack left zero live episode/job
  residue.
- Repo HEAD/origin/master:
  `72a9b1a519009e7debb3dadb3efc4d2d0caa81ee`. Preserve the owner's dirty
  `AGENTS.md`.
- Production Worker:
  `ff9fbeb0-377b-4c3d-949e-d603202c3bd6`. Parent V3 allowlist remains 30;
  nested E2-B1 remains OFF. No E3 migration; chain remains through 0034.
- Gates: Worker 103 files / 1,218 pass; unit 539 pass / 1 intentional skip;
  npm audit 0; Wrangler 4.120 dry run pass.
- Live GraphQL burn after OAuth refresh:
  **1,682,147 / 3,000,000 neurons (56.07%)**. E3 increment 20,807 / 90,000.
  Direct first-party `partner=false` Workers AI only; no AI Gateway.
- Every E3 seed cleaned zero live semantic/episode residue and zero non-terminal
  jobs. No benchmark/evaluator process or global lock remains.
- Next exact phase: **E4 atomic capture, provenance, and extraction-model
  bakeoff**. Freeze its causal arms and budget before inference; keep the E1+E0
  read path fixed and do not revive rejected E2-B1 or E8 reranking.


## 2026-08-10 E2 deployed / ablation boundary — AUTHORITATIVE

Resume from this section and `e2/E2-PREREGISTRATION.md`; older sections remain
historical evidence.

## 2026-08-10 E2 complete / B1 rejected - AUTHORITATIVE

Resume from this section and `e2/E2-RESULT.md`; older current-state sections are
historical.

- E2-B0 mandatory correctness/security mechanics: **KEEP**.
- E2-B1 behavioral treatment: **REJECT AS IMPLEMENTED**. Three-seed holdout
  capture 45.45% to 48.48% (+3.03pp) but precision 76.13% to 74.78% (-1.35pp),
  violating the frozen -1.0pp safeguard. The 96Q/399 LoCoMo screens were not run.
- Holdout judge 52.38% to 60.32%, availability 50.00% to 57.14%, conditional
  85.05% to 88.70%; promising but too variable to override the capture gate.
- E2 inference 31,233 neurons; campaign burn **1,661,340 / 3,000,000 (55.38%)**.
  All billed models remained first-party `partner=false`; no AI Gateway.
- Every seed cleaned zero live semantic/episode residue and zero non-terminal
  jobs. Audit receipts remain for final complete-reset cleanup.
- Global benchmark lock released; no E2/evaluator process remains.
- Repo HEAD/origin/remote `a4179beedf7c1dec975a1515eaa91d8a2b2598cd`.
- Production `2f7a31b8-3e1a-4c12-acd7-3db0b26bbefc` at 100%; both domains
  report parent allowlist 30 / nested B1 OFF count 0. No migration.
- Next action: begin E3 episode recoverability under B0 + old semantic
  extraction; do not revive B1 or run its skipped LoCoMo screen.

This section supersedes every older current-state paragraph without deleting it.

- E2-B0 mandatory mechanics and E2-B1 nested treatment are implemented locally.
  B1 requires the parent V3 flag and an independent exact allowlist; default OFF.
- Frozen E2 screen: 96 questions, SHA-256
  `b7e108c76213ed9d548d80cba47a852aaf6709a6058253bac68e0bdc67f66a58`;
  parent frozen399 SHA-256
  `500959da6c7e030248d85669ce49cf85ed62551fba0d0690d7a70bca0337ea6d`.
- E2 protocol is frozen before inference. Three holdout seeds are mandatory; 399
  expansion requires both the general-holdout and 96-question gates.
- Authoritative local gates after the final patch: Worker **103 files,
  1,212/1,212 pass**; unit **33 files, 539 pass, 1 intentional skip**; npm audit
  **0 vulnerabilities**; Wrangler 4.120.0 dry-run pass.
- No E2 inference has been invoked. Burn remains **1,630,107 / 3,000,000
  neurons (54.3%)**; E2 incremental cap 190,000; direct first-party
  `partner=false` Workers AI only.
- Repo `HEAD`, `origin/master`, and remote master are
  `c78f5589aa9cbb7f1f199036e456c635dea6979d`. Owner-modified `AGENTS.md`
  remains preserved and excluded.
- Production version `3976b916-5efc-431e-b6ce-8d4b8c317131` is at 100%
  (deployment `764aad0b-179e-4b4e-b151-6aae57c7b37f`). Health on both domains
  reports parent V3 allowlist count 10 and nested B1 OFF/count 0. Selected-vs-
  legacy no-write routing proof passed. Migrations remain complete through 0034;
  E2 required no migration.
- Next exact actions: recheck billing/lock/process state, freeze treatment/control
  account manifest and worst-case burn, enable B1 only for the isolated treatment
  cohort, then execute the pre-registered holdout and 96-question E2 cells
  sequentially.

This section supersedes every older current-state paragraph without deleting it.

## 2026-08-10 E8 RERANK RERUN — AUTHORITATIVE COLD-RESUME OVERRIDE

The older phase summary below is retained as history but is stale. Resume from
this section and `RERANK-RERUN-INTEGRITY.md`.

### 2026-08-10 E2 autonomous execution resume - authoritative

- Authorization: implement the accepted Evidence-Led Architecture plan from E2
  through final validation; preserve build/test/ablate/decide phase boundaries.
- Repo: local `HEAD` `188a771f6deb3b2338af704efaa53369d1c10d47` on
  `master`; `origin/master` `b851de25318d086415214bbb1354c50f987ed7e1`.
  Local HEAD is authoritative and must not be reset. Owner-modified `AGENTS.md`
  is preserved and excluded from campaign commits.
- Production: deployment `35919f2b-b356-4cf4-8beb-6595dec6bc51` at 100%; V3
  `allowlist`, count 10; no pending D1 migrations through `0034`.
- Benchmark integrity: no active `.benchmark-driver.lock`; existing collision
  proof remains valid.
- Billing guard at `2026-08-10T09:16:14Z`: PASS for all nine permitted models,
  every model `partner=false`, direct Workers AI binding, no AI Gateway. Live
  burn unchanged at **1,630,107 / 3,000,000 neurons (54.3%)**; E2 cap 190,000.
- D1 Time Travel pre-E2 bookmark:
  `00000a17-00000000-000050c3-5b37c4cbdf704bc2ee88bee6563a22fc`.
  E2 requires no production migration; capture a fresh bookmark before every
  later migration.
- Tooling: Wrangler `4.104.0`; latest Workers types checked as
  `5.20260810.1`. Focused gate last passed 209 tests in 30.5s; rerun the full
  gate with a non-artificial timeout before deployment.
- Current phase: **E2-B0 failing-first implementation**. E2-A and E2-B1 remain
  inference-blocked until manifests, hashes, seeds, controls and worst-case burn
  are frozen.

This entry supersedes older summaries below without rewriting their history.

- Repo `HEAD`: `188a771f6deb3b2338af704efaa53369d1c10d47`; reranker commit. `origin/master`
  remains `b851de25318d086415214bbb1354c50f987ed7e1`. The only reported worktree
  change at preflight was the owner's `AGENTS.md`; do not overwrite it.
- Production Worker: `35919f2b-b356-4cf4-8beb-6595dec6bc51` at 100%.
  `/health`: V3 `allowlist`, count 10. Deployed allowlist matches the ten d04
  benchmark tenants. Direct AI binding; no AI Gateway.
- Latest valid full result: combined E1+E0 = **46.75% judge**, **65.97% evidence
  availability**, **58.27% conditional**, GPT-OSS-120B reader, recall depth 200.
- Frozen rerank subset: 399 unique questions, SHA-256
  `500959da6c7e030248d85669ce49cf85ed62551fba0d0690d7a70bca0337ea6d`.
  Paired A0 on the subset: 46.87% judge / 67.67% availability / 58.52%
  conditional. No new inference was used for A0.
- The prior reranking results are invalid: concurrent drivers corrupted trials
  5-8. Ten invalid files were hash-recorded and removed; valid E0/E1/combined
  evidence was untouched.
- Hard lock installed. Collision proof PASS: first driver 0, second driver 73,
  zero artifact mutations, owner released the lock. Evidence:
  `phase3-d04/evidence/benchmark-lock-proof.json`.
- Neuron ceiling: **3,000,000**. E8 boundary snapshot: 1,625,527. Latest
  post-run live burn: **1,630,107 (54.3%)**, approximately $17.93; remaining
  1,369,893. Billing preflight remained PASS
  for all nine permitted models (`partner=false`); no AI Gateway or external
  provider was used.
- E8 reranking is **COMPLETE — ALL REJECT**. Every arm has exactly 399 answers
  and 399 zero-error judge verdicts. A1 44.36% / 42.36% availability; A2 44.86%
  / 52.13%; A3 47.37% / 59.65%; A4 reorder-only 47.87% / 67.67% but conditional
  fell to 57.04%. No arm passed all pre-registered gates. Do not lock reranking
  into V3. Durable report: `RERANK-ABLATION-RESULTS.md`.
- No benchmark/judge process or lock remains. Per owner instruction, **STOP**
  after this report. Recommended next experiment when resumed: **E2 extraction
  mechanical-reliability/capture ablation**, with E1+E0 read path fixed; do not
  start E3/E4 before E2 earns the capture branch.

**This file is the cold-resume document.** A new session must be able to continue
from here with zero conversation memory. Update it at every phase boundary.

Campaign root: `tmp/itsuki-memory-v3-implementation-20260809/`
Started: 2026-08-09
Repo: `C:\Users\ziyad\uml` · branch `master`

---

## 0. STATE AT LAST CHECKPOINT

| | |
|---|---|
| Phase | **PHASE 2 RUNNING — D03 LoCoMo rebase.** Root: phase2-d03/. conv-30 pilot INGESTED (32 nodes/22 events, 0 fail). D03 CONFIRMED in production: 17/22 events carry real 2023 dates. Remaining 9 conversations ingesting. Next: ask -> score -> judge. |
| HEAD at campaign start | `42bf6d5aea0e9ea6bd8565e4689b266e60e0b045` |
| origin/master at start | `42bf6d5aea0e9ea6bd8565e4689b266e60e0b045` (in sync) |
| Working tree at start | clean |
| **INFERENCE GATE** | **OPEN.** Owner authorized 2026-08-09: Cloudflare Startup Program credits cover first-party Workers AI. V3_NEURON_CEILING = 1,500,000. Guard: harness/billing-guard.mjs (preflight PASS, 9 models all partner=false, no AI Gateway). |
| Commits (pushed, origin verified) | `03c9084` BF-1 · `dd2aa6d` BF-2 · `23556ca` P0-C · `efe37db` P0-D+V3-D01 · `b851de2` P1+V3-D03 |
| Gates | Workers pool **99 files / 1173 tests PASS** · unit **33 / 539 PASS (+1 skipped)** |
| Production | migrations 0032+0033 applied · worker version `8323f8c7-abeb-4fb2-b437-7dd82d32f41d` · `/health` reports `memory_v3.mode = off` |

### Landed so far

| id | what | flag state | tests |
|---|---|---|---|
| V3-02 | `ITSUKI_MEMORY_V3` flag: off / allowlist / on, fails closed, env-only, whole-string case-sensitive match, surfaced on `GET /health` without account ids | **OFF** | `test/memory_v3_flag.spec.js` 15 |
| V3-03 | BF-1 source-time contract: `sourceTime` at batch and message level, offset retained, day-precision preserved, hash-participating only when present, refused by name when V3 is off. Migration `0032_source_time.sql` (additive). | gated | `test/source_time_contract.spec.js` 37 |
| V3-04 | BF-2 real recall limit: validated or refused by name; narrow-only for legacy accounts, real depth for V3; internal candidate budget separated from final evidence budget, both hard-capped | gated (depth) | `test/recall_limit.spec.js` 17 |
| V3-05 | P0-C: deterministic pre-splitting with coverage/chronology/replay properties, 9–10 message hole closed, truncation salvage, truncation detection, JSON mode wired default-OFF | ungated (pure reliability) | `test/extraction_chunking.spec.js` 24 |

---

## 1. BASELINES — FROZEN, NEVER TO BE MODIFIED

Digests in `frozen-baselines.sha256` (20 artifacts). Sources:

- `tmp/locomo-benchmark-20260808/` — official token-F1 baseline
- `tmp/locomo-llm-judge-20260809/` — Mem0-style LLM-judge baseline

| metric | V1 value | source |
|---|---|---|
| LoCoMo official token-F1 | **15.40%** | token-F1 baseline report |
| LoCoMo LLM-judge accuracy | **25.65%** (395/1540) | judge report §Headline |
| — multi-hop | 40.78% (282) | judge report §Category |
| — single-hop | 28.42% (841) | " |
| — open-domain | 21.88% (96) | " |
| — temporal | **6.23%** (321) | " |
| Reference evidence availability | **28.83%** (444/1540) | judge report §5 |
| Judge accuracy when evidence present | **61.04%** | " |
| Judge accuracy when evidence absent | **11.31%** | " |
| Stage A (never stored / extraction) share of misses | **64.6%** (738) | judge report §5 |
| Stage B (stored, retrieval missed) | 20.0% (228) | " |
| Stage C (retrieved, reader failed) | 14.4% (164) | " |
| Adversarial (excluded, abstention artefact) | 86.77% token-F1 | token-F1 baseline |

Judge model used by the baseline: `@cf/openai/gpt-oss-120b`, temp 0, `json_object`,
max_tokens 4096, 5 retries. Judge validated: 95% agreement with Mem0's rubric,
**0.0% false-accept**, 0% label flip over 3 repeats, 2.0% flip rate on real data.

**LoCoMo reference answers are evaluation-only.** They must never reach ingestion,
extraction, temporal normalization, entity resolution, retrieval, reranking,
context assembly, model selection, or production logic.

---

## 2. SECTION 8 PRECONDITION — RESOLVED: **FROZEN CONTEXT IS AVAILABLE**

Verified by `harness/verify-frozen-context.mjs` → `results/frozen-context-check.json`.

```
judged questions                 1540
matched to frozen context        1540   (100%)
missing from baseline               0
with non-empty retrieval.context 1540   (100%)
answer text mismatch                0   (byte-identical to the judged answers)
mean context chars               1224
categories        temporal 321 · open-domain 96 · multi-hop 282 · single-hop 841
```

Each baseline record in `b1.conv-*.t1.questions.jsonl` carries `question`,
`reference`, `evidence`, `category`, `questionId`, the **exact** `retrieval.context`
string handed to the reader, the retrieved `items[]` with scores, and the reader's
`answer.text`. The judged answers reproduce those `answer.text` values exactly.

**Therefore Experiment 0 is a TRUE frozen-context reader ablation**, not a re-recall.
No re-recall is needed and none may be substituted without reclassifying the
experiment.

---

## 3. COST / CREDIT GATE — **UNVERIFIED. INFERENCE IS BLOCKED.**

Per campaign §4, owner out-of-pocket inference spend is not authorized, and a
numeric `V3_NEURON_CEILING` must be written before the first new inference call.

**A safe numeric ceiling could not be established.** Evidence (all read-only):

| probe | result |
|---|---|
| `wrangler whoami` | OAuth token, `ejziyad@gmail.com`, account `b6009ce8df89884b79e4f6fa49e52942`; scopes include `account (read)`, `ai (write)`, `d1 (write)`; **no billing scope** |
| `GET /client/v4/accounts` with that token | **200 OK** — token is live, account type `standard` |
| `GET /client/v4/accounts/{acct}/subscriptions` | **401 Authentication error** — billing not readable |
| GraphQL `aiInferenceAdaptiveGroups` (neuron usage) | **401 Authentication error** — analytics not readable |
| `GET /client/v4/accounts/{acct}/ai/models/search` | **401** |
| `wrangler` billing/credit command | does not exist |
| `CLOUDFLARE_API_TOKEN` in environment | absent |

The prior LLM-judge campaign reached the same conclusion independently
(judge report §9: "Credit coverage: NOT VERIFIED").

**VERDICT: `CREDIT COVERAGE / COST CEILING UNVERIFIED`.**

Consequence, applied literally:

- `V3_NEURON_CEILING` = **null** in `cost-ledger.json`; no inference budget exists.
- **Zero** new inference calls are permitted: no extraction, no embedding, no
  reader, no judge, no bakeoff, no live recall (recall calls `embed()`).
- Non-inference engineering **continues** — that is explicitly allowed, and the
  vast majority of V3 is deterministic and unit-testable: the whole test suite
  runs with `USE_VECTORS=false` and no AI binding, and every extraction test
  injects canned model output through `overrides.llmResponse`.
- Every ablation harness is **built and left armed**, not run.

**To unblock:** the owner confirms Workers AI credit coverage and a neuron budget.
Then write `V3_NEURON_CEILING` into `cost-ledger.json` and run the armed harnesses
in the order given by `ablations.md`.

---

## 4. CURRENT IMPLEMENTATION — TRACED FROM LOCAL SOURCE (authoritative)

Verified by reading the files, not from research summaries.

### Ingest path
`POST /v1/ingest` → `readBody`/`validateBody` (`src/lib/params.js:45`, allowlist has
**no timestamp field**) → `validateIngestBody` (`src/lib/ingest_contract.mjs:265`,
30 msgs / 4k chars per msg / 120k total / 512 KiB) → `ingestMessages`
(`src/pipeline/ingest.js:133`) → `scrubMessages` **before anything durable** →
opt-out check → `normalizeSourcePacket` (`src/pipeline/source.js:335`) →
idempotency state → `storeSourcePacket` → `claimIngestMemoryJob` (job row before
the 200) → `stageMemoryText` (read-your-writes) → DO `acceptMessagesOnce` →
`drain()` → `runExtraction`.

Message objects accept only `content`, `role`, `id` (`ingest_contract.mjs:299-345`).
`ts` is accepted by `normalizeMessageBatch` (`source.js:270`) but **is not part of
the wire contract** and defaults to `Date.now()` via `numberOrNow` — so it is an
*ingested_at*, not a *source_time*. This is BF-1.

### Extraction path
`runExtraction` (`src/pipeline/extract.js:405`) → meter → `runExtractionInner`:
deletion-barrier pre-flight → `buildPacket` (`src/pipeline/packet.js:18`;
new_slice + bridge_context(5 user) + assistant_context(5)) → `shortlistNodes` →
`proposePrimary` (`extract.js:285`).

**Pre-splitting already exists**: `PRIMARY_SUBCHUNK = 8`,
`PRIMARY_SUBCHUNK_THRESHOLD = 10` (`extract.js:282`). Chunks >10 messages are
split into 8-message sub-chunks before the model sees them. Split *rescue*
(per-message re-extraction on parse failure) is separate, bounded by
`splitRescue.maxCalls = 8` / `failFast = 3`.

Model: `@cf/qwen/qwen3-30b-a3b-fp8`, `LLM_MAX_TOKENS = 4096`, temperature 0
(`wrangler.jsonc:82`). Output is **free-form JSON asked for in the prompt**, parsed
tolerantly (`src/pipeline/llm.js:147` `extractJson`: strips `<think>`, harmony
markers, code fences, then balanced-brace extraction with trailing-comma repair).
**No `response_format`/JSON-schema constraint is used, and there is no explicit
truncation detector** — a cut-off response simply fails to parse and becomes
`{_ok:false}`.

Then engine v2 (`config.engineV2` default ON): `proposeEdges` + `proposeReflexion`
concurrently, optional delta pass (default OFF) → `applyGates` → `writeApproved`
→ `runPass2`.

### Recall path
`POST /v1/recall` (`src/index.js:1619`) → `runRecallCommand`
(`src/pipeline/commands.js:437`) → `recall` (`src/pipeline/recall.js:599`).

`recallGate` returns a fixed plan: `topN 8`, `maxContextNodes 6`,
`maxContextPages 4`, `maxLineItems 4`, `maxContextChars 1800`
(`recall.js:16-22`); `update_mode` 10/7/5/…/2400; `deep_recall` 14/8/6/…/2800.

Four ranked signals fused with **RRF (k=60)** already exist: exact/alias, BM25
(D1 FTS5 over `manual_search_fts`) + keyword tail, vector (Vectorize), and 2-hop
graph expansion with validity windows. Then profile-cluster tie nudge, MMR
de-dup, `buildContext` char budget.

**BF-2 confirmed by source**: `/v1/recall` allowlists `limit`
(`src/lib/params.js:47`) but the handler passes only
`sourceId, idempotencyKey, threadId, conversationId, topic, memoryScope,
recallScope, recallMode` to `runRecallCommand` (`src/index.js:1631-1640`), which
in turn passes only `memoryScope, recallScope, recallMode` to `recall`
(`commands.js:527-531`). **`limit` is silently dropped at the door.**

### What V3 must add (not already present)
1. authoritative source/session time (BF-1) — **absent**
2. caller-controllable bounded recall depth (BF-2) — **absent**
3. schema-constrained extraction + explicit truncation handling — **absent**
4. searchable scrubbed source episodes — **absent** (`source_packets.raw_meta_json`
   holds 240-char snippets, is not FTS-indexed, and is not a retrieval surface)
5. first-class bi-temporal fields — **partial** (`events.happened_at`,
   `edges.valid_at/invalid_at` exist; no `source_time`/`observed_at`, no relative
   phrase normalization)
6. V3 feature flag — **absent**

### What V3 must NOT rebuild (already good)
- multi-channel candidate generation + RRF fusion + MMR (§27/§28 largely done)
- graph expansion / multi-hop (Itsuki's strongest judged category, 40.78%)
- scrub-before-durable, rules enforcement, deletion barriers, idempotency,
  job-row-before-200, replay repair

---

## 5. MIGRATION STATE

Applied migrations: `0001` … `0031_named_fence_constraint.sql` (+ `CHECKSUMS.json`).
D1: `uml-memory` / `3202df08-e568-4e53-a8cd-a85630db50f8`.
V3 migrations start at `0032` and are **additive only**. See `migration-ledger.md`.

---

## 6. NEXT ACTIONS (in order)

1. ~~A0 scaffolding + baseline freeze + frozen-context check + cost gate~~ **DONE**
2. Freeze the non-LoCoMo holdout (`holdout/`), references stored separately
3. V3 feature flag, default OFF, scope-bound
4. BF-1 source-time contract → tests → ablation harness armed
5. BF-2 real recall limit → tests → depth-ablation harness armed
6. Extraction mechanical reliability (schema + truncation) → tests
7. Episode layer (migration 0032+) → tests → erasure/isolation batteries
8. Temporal architecture → tests
9. Security / failure / property / concurrency batteries
10. Deploy with flag OFF; production proof limited to non-inference surfaces
11. **BLOCKED**: every ablation and benchmark run, pending the cost gate
