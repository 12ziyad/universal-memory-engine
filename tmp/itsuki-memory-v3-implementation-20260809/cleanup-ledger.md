# V3 CLEANUP LEDGER

## 2026-08-12 terminal Stage E cleanup — PASS ZERO

All ten final benchmark tenants were erased through the product contract.
Episodes, atomic candidates/runs, projections, graph state, staging,
nonterminal jobs, profiles and both FTS surfaces are zero. Ten recall proofs and
ten export proofs are empty. Their governed query packets were then erased, so
all 2,096 retained packet fences are minimized and content-free. The benchmark
lock and campaign processes are absent; no temporary credential material
exists. Closure commit/origin `2816395` is live as Worker `a38142b9` /
deployment `dc96a1df` and passed 20/20 terminal-safe propagation checks.
Authoritative evidence is `final/locomo/evidence/cleanup.json` and
`final/locomo/evidence/terminal-production-closure.json`.

## 2026-08-11 Stage D closure

All three holdout seeds cleaned to zero. A final cohort preflight then found 217
legacy pre-D10 plaintext packet rows in the otherwise empty control ten; current
product erasure minimized all 217. Control+treatment now has zero live state or
jobs and 1,098/1,098 content-free packet fences. The lock is absent and no
inference was used.

## 2026-08-11 E9B cleanup boundary — authoritative

- The exact ten-account E9B holdout cohort was erased after both sealed arms
  and scoring completed.
- Production-primary fingerprint proves zero live source episodes, candidates,
  projections, nodes, slices, events, edges, pages and non-terminal jobs.
- The benchmark lock is released; no E9B driver, judge, evaluator or campaign
  Wrangler-dev process remains.
- Final Worker `b7fffb0e-357a-4f90-9f0e-31a644c6814c` / deployment
  `9daefc1d-a017-4d1d-9ac1-003b60f6c49e` has capture, projection, source
  expansion and episode fallback OFF/0; E7 is restored to its prior d04 ten.
  Final propagation proof passed 20/20 uncached checks across both domains.
- Repo/origin is `6282988c92dba786d3b988fdb851861acb0a7319`; only the owner's
  unrelated `AGENTS.md` is dirty. No credential material was persisted or
  printed. E9B evidence, including invalid preflight classifications, is
  retained intentionally.

## 2026-08-11 E9A cleanup boundary — authoritative

- The exact ten-account E9A holdout cohort was erased after scoring.
- Production-primary fingerprint proves zero live source episodes, candidates,
  projections, nodes, slices, events, edges, pages and non-terminal jobs.
- Episode FTS deletion is covered by the established source-episode erasure
  triggers and the zero episode count; no episode vector index exists.
- The benchmark lock is released; no E9 driver, judge, evaluator or Wrangler
  dev process remains.
- Final Worker `eec4b955-ac88-4627-b834-a424c98069bb` has atomic capture,
  projection, coalescing and source expansion OFF/0; E7 is restored to only its
  prior ten d04 accounts. Normal users remain outside V3.
- Repo/origin is `c34a345160b92bfc1c2272841b7b63e9ff337f63`; only the owner's
  unrelated `AGENTS.md` is dirty. No credential material was written or
  printed. E9A evidence is retained intentionally.
- Campaign-wide complete reset remains pending FINAL because historical audit
  receipts/jobs from earlier isolated phases are intentionally retained until
  the established complete-reset boundary.

## State at the end of the campaign

| target | state | how it was checked |
|---|---|---|
| V3 benchmark residue | **none** — no benchmark was run | cost gate closed; `benchmark-ledger.json` has zero runs |
| Synthetic episodes in production | **none** | `source_episodes` was created empty by migration 0033 and no account is selected for V3, so nothing can write to it |
| Semantic test rows in production | **none** | no live ingest was performed |
| Campaign non-terminal jobs | **none created** | no live ingest was performed |
| Rules | **pristine** | rules were only written inside the test isolate, never in production |
| Orphan campaign processes | none | all work was synchronous tool calls |
| Temporary secrets | none created | `ITSUKI_API_KEY` was read from the environment for three production probes and never written to disk or printed |
| Releasable tree | **clean** | `git status` clean at `b851de2`; `origin/master` verified byte-equal |

## Test-isolate data

Every test writes into the Workers-pool isolate's own D1, which is created and
torn down per run. Nothing there reaches production.

## 2026-08-10 E2 holdout boundary

- Seeds 1, 2, and 3 each ended with zero live semantic/source-episode residue
  and zero non-terminal jobs across all 20 paired campaign slots.
- Cleanup artifacts: `e2/evidence/holdout.seed{1,2,3}.cleanup.json`; every
  `dirty` count is zero.
- The bulk erasure API intentionally retains audit receipts and terminal job
  history. Those records are excluded from cross-seed scoring by exact
  idempotency prefix, but are still synthetic campaign residue. Before the final
  verdict, use and verify the complete `DELETE ALL` reset contract on these
  scoped tenants; do not claim final zero residue from the bulk erasure proof.
- The local evaluator exited and the global benchmark lock was released.

## Deliberately retained

The campaign root `tmp/itsuki-memory-v3-implementation-20260809/` is retained in
full, including the frozen holdout. It is gitignored — the repository is public,
and the holdout is an evaluation asset that carries its own answers.


## 2026-08-10 E3 cleanup boundary — authoritative

This section supersedes the historical campaign-start table above.

- Each of the three E3 holdout seeds ended with zero live semantic rows, zero
  live source episodes, and zero non-terminal jobs across the isolated cohort.
- Episode FTS row counts converged to zero with episode deletion.
- D06 production reattack left zero episodes and zero non-terminal jobs; the
  retained audit row's seen count remained stable.
- No benchmark driver, judge, evaluator, Wrangler dev server, or global
  benchmark lock remains.
- Removed orphaned D04 log-watch processes 34780/18300 and child 20144 after
  verifying their command lines targeted only the completed campaign judge log.
- The frozen E3 evidence and invalid scorer-attribution artifacts are retained
  intentionally. No benchmark references reached product inputs.
- No temporary credential material was written. The existing Wrangler OAuth
  credential was refreshed in place after a transient GraphQL authentication
  failure.
- Repository status is releasable at
  `72a9b1a519009e7debb3dadb3efc4d2d0caa81ee`; the only tracked worktree
  modification is the owner's pre-existing `AGENTS.md`.
- Campaign-wide complete-reset cleanup remains pending until FINAL because
  audit receipts from isolated benchmark tenants are retained by the ordinary
  erasure contract and must be removed through the established complete-reset
  path, not ad-hoc SQL.

## 2026-08-11 E5 cleanup boundary — authoritative

- All three invalid E5 live attempts were unscored and erased. The repaired
  proof also completed API erasure and an independent D1-primary residue check.
- Production currently has zero `semantic_atom_candidates` and zero
  `semantic_atom_capture_runs`; the E5 tenant has zero source episodes, graph
  rows, and nonterminal jobs.
- No benchmark lock or campaign inference process remains.
- Both domains report atomic capture OFF/count 0; parent V3 remains restricted
  to the 30 campaign tenants and B1 remains OFF/count 0.
- Repo/origin are `525d4abe3a53771c6ab4ba59abf9af8661f514ea`.
  The only worktree modification is the owner's unrelated `AGENTS.md`.
- E5 product and invalid-attempt artifacts are intentionally retained as
  evidence; no temporary credential material was written or printed.

## 2026-08-11 E10 cleanup boundary - authoritative

- The E10 synthetic cohort is zero across source episodes, candidates,
  projections, nodes, slices, events, edges, pages and non-terminal jobs.
- The hard benchmark lock is released; no benchmark, judge, evaluator or
  Wrangler dev process remains.
- Production deployment `eaae0273-d09d-4e97-af95-f336315d040e` / version
  `7bb3ac6b-8c50-48e7-aa33-b3250deef657` is 100% and passed 20/20 uncached
  health probes across both domains.
- Atomic capture/projection/coalescing, E9A source expansion, E9B fallback and
  E10 adaptive context are OFF/count 0. E7 is restored to the d04 ten only;
  normal users remain outside the parent V3 allowlist.
- Repo/origin are `aa16f8a1eded327aaa2af95a933dcc88032b6433`.
  The only tracked worktree modification is the owner's `AGENTS.md`.
- Frozen E10 products, references, results, lock proof and invalid PowerShell
  wrapper observations are retained intentionally. No credential material was
  written or printed.
- Campaign-wide final cleanup remains pending after final validation.
