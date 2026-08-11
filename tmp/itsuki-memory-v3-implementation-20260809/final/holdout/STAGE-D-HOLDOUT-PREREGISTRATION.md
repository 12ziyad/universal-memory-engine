# Itsuki Memory V3 Stage D final holdout preregistration

Frozen before Stage D inference or production cohort activation.

## Cell

Three independent fresh ingestion seeds, sequentially, using the frozen ten-scenario
non-LoCoMo holdout and the ten treatment slots. Each seed is erased to verified zero
before ingest, uses project `v3-final-holdout`, answers all 42 frozen questions, seals
the reference-blind product and export, and only then loads references for capture and
answer judging. Cleanup to zero is mandatory before the next seed.

The architecture is the already accepted final candidate only:

- BF-1 source time, deterministic pre-splitting and salvage;
- scrubbed acceptance-atomic episodes;
- Llama 4 Scout zero-to-many atomic candidates;
- deterministic temporal normalization;
- governed E6 projection through the existing entity/conflict/graph authority;
- BF-2 depth 200 and E7 bounded assertion lanes/fusion/MMR, including V3-D13;
- E9A exact bounded source-provenance expansion;
- GPT-OSS-120B reader, temperature 0, 1,024 output tokens.

E2-B1, E6M coalescing, BGE reranking, E9B episode fallback and E10 adaptive
context remain OFF. There is no LoCoMo input, re-ingest, prompt tuning or reference
access in this cell.

## Frozen comparisons and metrics

Candidate-level capture quality uses the already accepted E4 methodology: target-fact
recall plus unsupported candidate claims for precision. The answer path reports judge,
token-F1, evidence availability, conditional and absent accuracy, source-store and
candidate-store availability, retrieval loss, assembly loss, source recovery, context,
latencies, storage rows/bytes and neuron use. Atom, node, slice, event and edge counts
are retained per seed for variance.

The category non-collapse comparator is the immutable accepted E9A treatment summary
(`110d3416...f9ab`): single-hop 95.83%, multi-hop 100%, temporal 100%. A Stage D
category mean may not fall by more than 15 percentage points. The holdout contains no
open-domain questions, so no open-domain claim is made from Stage D.

## Mechanical gates

- zero scope, secret, provenance, durability, replay, bounded-recall, source-expansion,
  receipt, projection or cleanup failure;
- mean candidate capture precision >=95%;
- mean answer judge >=80%;
- no seed answer judge below 75%;
- mean evidence availability >=75%;
- no accepted-path category collapse over 15 percentage points;
- exactly three products, 126 answers, 126 verdicts and three zero cleanups.

All gates are evaluated mechanically. Failure blocks Stage E acceptance; no post-result
threshold or prompt change is allowed.

## Spend and locking

Start: 1,914,249 campaign neurons. Stage cap: 90,000; maximum Stage D boundary:
2,004,249. The separate 500,000-neuron final LoCoMo reserve remains protected.
Only direct first-party `partner=false` Workers AI is permitted. The global benchmark
lock is acquired before any artifact directory/write; a contender exits 73. The frozen
lock proof records exit 73 and an unchanged artifact inventory.

## Frozen hashes

- final validation preregistration: `ecf58be85195c0c0d89bd88b46246dd22c0a424f1589de7d0a895b3d82d4d142`;
- holdout manifest: `598ba1bb35bbcee1784dce506ee743d1965398c5fca453ac82008b5f649654a6`;
- holdout digest ledger: `259f22f29659b2ad46761483a6ac20162b24dc1441b8eaedb00e3f80fe17a97f`;
- reference-free questions: `588fc4b5f3e6a74a7d7f8dc1f8b3bbcb795f79362930c67fefc6c075f5f7d73c`;
- cohort: `555b01b4f5204a4cf3638801a1b0a3b1ca6e6cb1d1d71bbddb4e47fd44c04930`;
- accepted E9A summary: `110d3416a61ca155db706381e16397387e9be87a5bd05fb1179b3514a1abf9ab`.

Harness hashes are pinned in `harness-manifest.json`.
