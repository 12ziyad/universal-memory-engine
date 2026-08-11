# Stage E — decisive complete LoCoMo preregistration

Status: frozen before activation or inference.

This is the single complete LoCoMo measurement authorized by decision D-023.
It measures the accepted general-purpose V3 candidate; it is not a tuning run.
If the result is weak, it is reported without changing the prompt, thresholds,
candidate, denominator or seed and without a benchmark-specific repeat.

## Frozen data boundary

- Official source: `snap-research/locomo` commit
  `3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376`.
- Vendored dataset SHA-256:
  `553cd5a15e25f2ceccc6ed185221eba645080c93e5b91087560a91aa5961f365`.
- Canonical dataset SHA-256:
  `93808652e5318eaf79a966a7aa3fe50f14eaee22fd0991f7212596600351dc05`.
- Reference-blind product input SHA-256:
  `e9818f2070e6b5a4860e3a7e0cbd706433a0c95c00049980f405fe34cccf10dd`.
- Denominator: exactly 1,540 non-adversarial questions: 282 multi-hop,
  321 temporal, 96 open-domain and 841 single-hop. The 446 adversarial
  questions remain excluded and are not sent to the product or reader.
- The product input contains source turns, source timestamps, speaker names,
  question text and category only. It contains no reference answer, declared
  evidence, score, verdict or prior correctness.
- The scorer may open the official dataset only after the complete product
  artifact is written and SHA-256 sealed.

## Frozen product path

- Cohort: the ten clean `control`/middle campaign slots, one slot per LoCoMo
  conversation. Historical d04 tenants are never read, written or erased.
- Scope: project-only, `v3-final-locomo` / `V3 Final LoCoMo`.
- One fresh ingestion identity per deterministic session batch. Exact
  idempotent transport recovery is allowed; another seed or changed write is
  not.
- Both human speakers are imported as transcript user events with the original
  speaker name retained verbatim in the text, matching the established LoCoMo
  import contract. The original local session time remains in the text.
- Because LoCoMo supplies no timezone, BF-1 receives the exact calendar day
  (`YYYY-MM-DD`) rather than a fabricated offset. Session order remains exact.
- Wire batches are deterministic: at most 30 messages and 120,000 characters;
  only the last batch of a session sets `flush=true`. Samples may run in five
  parallel lanes, but sessions within one sample are strictly chronological
  and terminal before the next session.
- Accepted architecture: scrubbed acceptance-atomic episodes; Llama 4 Scout
  source-grounded zero-to-many capture; deterministic temporal metadata;
  governed typed projection; bounded E7 hybrid fusion/MMR; exact E9A source
  expansion; existing 24,000-character hard context ceiling; GPT-OSS-120B.
- Fixed exclusions: E2-B1, E6M coalescing, reranking, E9B fallback and E10
  adaptive context are OFF.
- Recall is `project_only`, requested depth 200. Every response must prove D13
  bounded corpus active, E7 active, E9A active, no reranker/fallback/adaptive
  path, at most 200 final items and at most 24,000 context characters.
- Reader: `@cf/openai/gpt-oss-120b`, temperature 0, max tokens 1,024, and the
  already accepted LoCoMo answer prompt. No prompt edit is authorized.

## Scoring and reporting

- Official token-F1 is computed by the unchanged vendored LoCoMo scorer bridge.
- Semantic judge is the already frozen Mem0-style prompt with
  `@cf/openai/gpt-oss-120b`, temperature 0, structured JSON and its existing
  bounded retry rule. Judge errors remain wrong in the denominator.
- Report: overall token-F1 and judge; category metrics; reference-token evidence
  availability at the historical 0.5 threshold; conditional and absent-evidence
  accuracy; source-stored, candidate-stored, selected-before-render and final
  context availability; assembly loss; source recovery; context item/line/
  character/token counts; ingest/extraction/recall/reader/judge latency;
  candidates/projections/storage; retries/calls/neurons.
- Product and judge accounting must both reconcile exactly 1,540/1,540.
- The historical comparisons remain V1 15.40% token-F1 / 25.65% judge and the
  valid E1+E0 read baseline 27.45% token-F1 / 46.75% judge / 65.97% evidence
  availability. These are comparisons, not tuning gates.

## Safety, lock and spend

- One global atomic benchmark lock. A contender must exit 73 before creating or
  changing any artifact.
- Direct first-party `partner=false` Workers AI binding only. No AI Gateway,
  partner model or external-provider fallback.
- Campaign ceiling: 3,000,000 neurons. Stage E hard cap: 500,000 neurons from
  the exact settled launch snapshot recorded in the run manifest. Fail closed
  before bounded inference blocks and at either cap.
- At 2,250,000 campaign neurons only this decisive cell may continue. At
  2,700,000 only completion-critical Stage E scoring/cleanup may continue. At
  3,000,000 all inference stops.
- Activation must prove exact control membership, historical d04 preservation,
  normal-user exclusion and identical state on both production domains.
- Completion requires product-API erasure, zero episodes/FTS/candidates/
  projections/graph/staging/nonterminal jobs, minimized source-packet fences,
  safe flag restoration and no process or lock residue.

## Stop conditions

Stop rather than salvage on inconsistent artifact counts, product/reference
boundary violation, lock inconsistency, unpermitted billed model, spend guard,
scope leak, failed extraction, production migration/deployment safety failure or
cleanup non-convergence. No production migration is planned for this stage.
