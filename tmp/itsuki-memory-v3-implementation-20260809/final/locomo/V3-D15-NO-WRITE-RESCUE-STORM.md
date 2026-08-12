# V3-D15 — Bounded no-write rescue lineage

Status: **HIGH CLOSED** at commit/origin
`fb1c7bc322a5fc26c04765b22d6fdb344317b2a3`, production Worker
`24a9f822-e325-4ee6-91c1-1794e64ae857`, deployment
`2b0c9086-36bf-4f30-a367-94b71cbc443c`.

This incident and all investigation were reference-blind. Product reference
files opened: **0**. Stage E still has **0 answers, 0 judge rows, and 0 scores**.

## Detection and containment

- A reference-blind state audit reached frozen sample `conv-43` and found an
  extraction-run count increasing between read-only observations even though no
  local benchmark, judge, repair, or Wrangler process was active.
- The affected synthetic Stage E account was bound to source packet
  `src_509e971f-6087-417b-a543-0abf8c590553`. Its parent memory job was already
  terminal `enriched`; the continuing work was an orphan semantic rescue
  lineage, not accepted job backlog.
- The stable pre-delete snapshot contained **1,740 extraction runs**, 100 nodes,
  129 slices, 38 events, 8 edges, and 20 atomic candidates, with zero pending
  jobs. Repeated observations proved the run count had been growing.
- The first confirmed product delete timed out after 91 seconds, so its remote
  outcome was treated as unknown and was not blindly replaced by a different
  operation. Read-only checks showed the deletion barrier had stopped growth.
- Repeating the same idempotent confirmed deletion with a 300-second client
  timeout completed in 138.8 seconds. The product reported deletion of all
  1,740 runs, 100 nodes, 129 slices, 38 events, 8 edges, and 20 candidates, and
  minimized 56 source-packet fences.
- Final dry-run deletion, export, D1 residue, pending-job and nonterminal-job
  checks were all zero. The affected frozen tenant is intentionally erased and
  invalid until rebuilt after the fix; the other nine frozen tenants were not
  mutated.

## Cost impact

- Settled campaign burn before the storm was 2,157,792 neurons.
- The runaway lineage added 9,671 Qwen neurons and approximately 916 Qwen
  calls. Cleanup verification added 2 embedding neurons.
- The stable post-containment boundary is **2,167,465 / 3,000,000 neurons
  (72.2%)**, approximately $23.84 campaign usage. This incident used 9,673
  neurons including cleanup and remained below both the global ceiling and the
  Stage E cap.
- Inference remains paused until deployment and safety proof complete.

## Root cause

`meaningful_no_write` correctly settled its owning job and restored the source
messages as a `_settled` rescue buffer. When another extraction context was
held, finalization unconditionally fired that buffer. The fired entry reset the
ordinary `attempts` counter to zero. Two settled rescue buffers in different
projects could therefore exchange places indefinitely: each no-write restored
one buffer and re-enqueued the other, despite both owning jobs already being
terminal.

The per-entry poison ceiling was real but did not bound this lineage because
every held-to-queue transition created a fresh entry with fresh attempts.

## Repair

- A separate persisted `noWriteRescueCount` now survives held/queue transitions.
- An initial meaningful no-write may be restored once, preserving the existing
  deliberate second-chance behavior.
- A second meaningful no-write ends that semantic retry lineage. It cannot
  restore or re-enqueue itself again.
- Pre-fix stored rescues that have `rescuedFromNoWrite=true` but no counter are
  conservatively interpreted as having consumed their one rescue generation.
- Ordinary transient `llm_failed` retries remain independently bounded by
  `MAX_ATTEMPTS`; successful writes, deletion cancellation, repair generations,
  project attribution, immutable context traces, and source provenance are
  unchanged.
- Governed V3 source episodes remain the recoverability layer after semantic
  promotion declines an allowed source.

## Failing-first and gates

- Before repair, `project_scope_do.spec.js` produced seven consecutive
  `meaningful_no_write` calls, retained one extract entry, and failed 3/4.
- After repair, the exact test performs three total runs (initial A, one bounded
  A reconsideration, initial B), leaves zero queued extract entries, and passes
  4/4, including an explicit pre-fix-state upgrade simulation.
- Adjacent extraction/context/queue/interruption suites: **50/50 pass**.
- Complete Worker gate: **112 files, 1,324/1,324 pass**.
- Unit/cross-door gate: **33 files, 539 pass + one intentional skip**.
- `npm audit`: zero vulnerabilities; `git diff --check`: pass; Wrangler 4.120.0
  dry deployment: pass. No schema or migration change exists.

## Required closure

1. Commit/push and deploy with existing V3 flags/allowlists unchanged.
2. Prove propagation, V3-off legacy behavior, allowlisted behavior, and no flag
   bleed.
3. Reattack the bounded lineage on a disposable synthetic account and erase it.
4. Rebuild only erased `conv-43` from the frozen product inputs using a new,
   documented post-erasure idempotency namespace; do not re-ingest the other
   nine samples.
5. Run the complete reference-blind state audit before any answer, reference,
   judge, or score phase.

## Closure proof

- The valid production reattack (`ATTEMPT-002`) proved exactly three terminal
  runs: initial project alpha, one bounded alpha reconsideration after project
  switch, and initial project beta. No further run appeared during the stable
  observation window; zero semantic objects were written; all disposable state
  was erased. The other nine frozen tenant counts remained byte-for-byte equal.
- H20 corrected a harness-only false positive: confirmed deletion preserves
  extraction-run tombstones as `status='deleted'`. The corrected containment
  audit separates 1,756 retired rows from active work and proves zero active
  runs, zero live memory, and 60/60 content-free minimized packet fences.
- Only `conv-43` was rebuilt under a post-erasure idempotency namespace. The
  rebuild passed 29/29 sessions, 680/680 messages and 35/35 packets while the
  historical ledger hash remained unchanged.
- The final reference-blind audit passed all 272 sessions, 5,882 episodes, 301
  packets, and exact 5,572 candidate/projection conservation. It opened zero
  reference files and generated zero answers, judge rows or scores.
