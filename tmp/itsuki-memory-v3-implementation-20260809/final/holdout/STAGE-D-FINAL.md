# Stage D final non-LoCoMo holdout

**Verdict: PASS_TO_STAGE_E.** Three independent, sequential, fresh ingestion
seeds ran on the frozen 10-scenario / 42-question general-memory holdout. Each
product was reference-blind and SHA-sealed before scoring, and each seed erased
to verified zero before the next began.

| Metric | Seed 1 | Seed 2 | Seed 3 | Mean |
|---|---:|---:|---:|---:|
| judge accuracy | 100.00% | 92.86% | 92.86% | **95.24%** |
| token-F1 | 71.15% | 69.42% | 68.21% | **69.60%** |
| evidence availability | 97.62% | 97.62% | 95.24% | **96.83%** |
| conditional accuracy | 100.00% | 95.12% | 95.00% | **96.71%** |
| capture recall | 78.18% | 74.55% | 81.82% | **78.18%** |
| capture precision | 96.63% | 96.59% | 96.55% | **96.59%** |
| capture F1 | 86.43% | 84.15% | 88.58% | **86.39%** |

Category means: single-hop 93.06%, multi-hop 100.00%, temporal 96.97% judge
accuracy. Mean evidence availability was 98.61%, 100.00%, and 90.91%
respectively. Mean context was about 3.72 items / 1,039 characters / 260 tokens.
No evidence was lost during assembly. Exact source expansion recovered a mean
33 evidence-bearing questions per seed that semantic retrieval alone did not.

All registered gates passed: zero security, durability, scope, provenance,
accounting or bounded-recall failure; 126/126 products and verdicts reconciled;
all three cleanup proofs were zero; no accepted category declined by 15pp; no
seed fell below 75%. Candidate/projection counts were 89/89, 88/88 and 87/87.

Observed inference was 5,901 + 6,632 + 6,462 = **18,995 neurons**, 21.11% of
the 90,000-neuron Stage D cap. The settled campaign meter immediately after the
run was 1,933,582 / 3,000,000 neurons. Direct first-party `partner=false`
Workers AI was the only inference path.

Authoritative machine evidence: `results/summary.json`,
`evidence/run-manifest.json`, the three sealed product/score artifacts and the
three cleanup artifacts. Large scrubbed export snapshots remain local campaign
evidence and are hash-covered; their security assertions are summarized in the
scored artifacts.
