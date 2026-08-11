# V3-D13 HIGH — unbounded pre-fusion recall corpus

**Status: OPEN — failing-first complete**

The preregistered local Stage C run used the production schema, deterministic
synthetic text and isolated 1k/10k/100k fixtures. No inference or production
data was used. Scope, source expansion, final result/context bounds, product
deletion and both FTS indexes behaved correctly at every size.

The V3 read path nevertheless fetched every in-scope node, slice and edge
before applying its documented 200-candidate lane bounds. Observed rows per
lane grew **800 -> 8,000 -> 80,000**. The target query grew 483 -> 648 ->
3,044 ms, while a broad query grew **3,154 -> 36,632 -> 510,978 ms**. At 100k
the local Worker held about 898 MB during the broad read. Final output remained
bounded at <=200 items and <=24,000 characters, demonstrating that the defect
is specifically before fusion/context selection.

Root cause is architectural: `recall()` first selects all live scoped nodes,
slices and edges into the Worker and only then runs exact/lexical/vector/graph/
E7 ranking and MMR. Internal lane ceilings therefore bound only the tail of the
pipeline, not database-to-Worker transfer or ranking work.

This is HIGH because a legitimate long-history tenant can consume extreme
Worker CPU/memory on an ordinary broad recall. It is not a scope or erasure
failure. Required repair: preserve the accepted E7 retrieval semantics behind
the V3 flag, but generate bounded exact/FTS/assertion/vector/temporal/graph
candidates in D1 first, hydrate only their bounded object/evidence closure,
retain explicit lane/load telemetry, then rerun this exact scale harness and
the complete regression/deploy/production lifecycle.

Evidence: `evidence/stage-c-scale-failing-first.json`.
