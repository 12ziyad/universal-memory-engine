# V3-D14 — Projection accounting after post-commit recovery

Status: **MEDIUM IMPLEMENTED AND FULLY GATED LOCALLY; DEPLOYMENT PENDING**.

The Stage E state audit found one immutable receipt that reported 372 projected
candidates while D1 contained 392 exact candidates and 392 exact projection
ledger rows. No memory or projection was missing. The process had committed the
atomic graph/projection batch and then stopped before publishing its response
receipt. Recovery rebuilt atomic capture counters from the durable capture
ledger but did not rebuild projection counters from the durable projection
ledger.

The append-only `semantic_atom_projections` ledger is now the authority for a
content-free recovery summary keyed by tenant and extraction run. A recovered
response repairs its returned projection counters without mutating historical
receipts. The reference-blind final audit records any old immutable receipt gap
separately from durable candidate/projection conservation.

Failing-first reproduced one durable projection with a missing post-commit
receipt. The focused recovery/context/queue slice passes 50/50; complete Worker
is 1,324/1,324; unit/cross-door is 539 pass plus one intentional skip; audit,
diff check, and dry deployment pass. No migration is required.
