# V3 ARCHITECTURE

The authoritative trace of the pre-V3 (V1) implementation is in
`checkpoint.md` §4. This file records what V3 added and where it sits.

## New modules

| module | responsibility |
|---|---|
| `src/lib/memory_v3.js` | The rollout flag. Resolved from `(env, userId)` only. |
| `src/lib/source_time.mjs` | The BF-1 contract: what a valid source time is, in a runtime-neutral form the Worker, SDKs and plugin outboxes can all share. |
| `src/pipeline/chunking.js` | Deterministic pre-splitting with coverage, chronology and replay-identity properties. |
| `src/pipeline/episodes.js` | The recoverability layer: write, search, expand, erase. |
| `src/pipeline/temporal.js` | Deterministic relative-phrase normalization anchored on source time. |
| `src/pipeline/source_expansion.mjs` | E9A: bounded exact provenance expansion from selected semantic assertions back to scrubbed source episodes. |
| `src/pipeline/episode_fallback.mjs` | E9B experimental bounded episode FTS fallback; measured REJECT and default OFF, not part of accepted V3. |
| `src/pipeline/bounded_recall_candidates.mjs` | V3-D13: D1-first, tenant/project-filtered E7 candidate lanes and bounded evidence hydration before fusion. |

## Where each hooks into the existing pipeline

```
POST /v1/ingest
  readBody → validateBody              params.js: sourceTime allowlisted (write doors only)
  validateIngestBody                   ingest_contract.mjs: sourceTime shape, batch + per message
  requireMemoryUser                    (auth; the account id is only known from here on)
  refuseUngatedSourceTime              index.js: named 400 when V3 is off for this account
  ingestMessages
    scrubMessages                      (unchanged, and still before anything durable)
    normalizeSourcePacket              source.js: source_time on messages, packet, hash, provenance
    storeSourcePacket                  + 3 additive columns (migration 0032)
    claimIngestMemoryJob               (unchanged)
    stageMemoryText                    (unchanged; now genuinely fails closed — V3-D01)
    writeSourceEpisodes         [V3]   episodes.js: permitted text, before the model runs
    DO acceptMessagesOnce → drain
      runExtraction
        planExtractionChunks           chunking.js: replaces inline splitting arithmetic
        verifyChunkCoverage            fails loudly rather than extracting a partial view
        proposeMemory                  llm.js: truncation detection + salvage, optional JSON mode
        chunkAnchor                [V3] temporal.js: the authoritative anchor for this chunk
        applyGates
          factHappenedAt               gates.js: proposed date → relative phrase → anchor → lastTs
        writeApproved                  (unchanged)

POST /v1/recall
  runRecallCommand
    validateRecallLimit                recall.js: works or fails by name
    memoryV3Enabled → limitMode        narrow for legacy accounts, depth for V3
    recall
      applyRecallLimit                 final evidence budget
      candidateBudget                  internal per-lane budget, hard-capped
      (4 signals + RRF + MMR unchanged — see decision-log D-004)

DELETE (bulkDeleteBySource / deleteAllMemories)
  deleteSourceEpisodes          [V3]   hard delete; FTS triggers drop tokens with the row
  countSourceEpisodes           [V3]   inside the erasure convergence loop
```

## Deliberate non-changes

Multi-channel candidate generation, RRF fusion, MMR de-duplication and 2-hop
graph expansion already existed and were **not** rebuilt (`decision-log.md`
D-004). Multi-hop is Itsuki's strongest judged category at 40.78% and campaign
§33 says to preserve it.

Episodes are deliberately **not** vector-indexed. Campaign §20 requires an
ablation to justify that first, and that ablation needs inference.

## What each new surface costs

| surface | cost |
|---|---|
| `source_time` columns | 3 nullable columns; NULL for every pre-V3 packet |
| `source_episodes` | one row per permitted message, capped at 40 per accepted write and 4,000 characters per row, only for selected accounts |
| `source_episodes_fts` | FTS5 tokens for the above; removed by trigger when the row is |
| chunk planning | pure function, no I/O |
| temporal normalization | pure function, no model call |


## E3 acceptance boundary

E3 changed source episodes from a best-effort side write into an acceptance
precondition for selected V3 accounts:

```
claim job as awaiting_source
  -> write scrubbed/rules-approved episode rows with deletion-barrier guards
  -> verify exact expected row identities, hashes, order, scope, and timestamps
  -> transition job to queued
  -> Durable Object handoff/replay protocol
  -> semantic extraction
```

The D1 episode statements are atomic only inside their D1 batch. The subsequent
Durable Object handoff is deliberately not called cross-resource atomic; it
retains the existing durable replay/repair protocol. A source write or
verification failure returns non-2xx, invokes no model, and leaves a named
repairable non-runnable job.

Exact replays bind to the retained packet and deletion barrier before returning
a historical success. V3-D06 closed the case where an erased terminal packet
could otherwise return a stale 200. Erasure hard-deletes episode rows and lets
the FTS triggers remove their tokens before convergence is declared.

The episode layer remains internal/admin-only, account-scoped, and absent from
reader context. E3 earned preservation (97.78% paired semantic-miss recovery),
not unrestricted episode recall. E9 must separately earn bounded source
expansion/fallback; episode vectors remain absent.

## E4 source-grounded candidate lane (confirmed, default OFF)

E4 adds a second, append-only extraction lane beside the established graph
proposal only for accounts selected by both the parent V3 flag and the nested
atomic-capture flag:

```
durable scrubbed source episodes
  -> deterministic extraction chunks and complete coverage proof
  -> Llama 4 Scout guided JSON proposal
  -> local compact-schema, exact-message/span, rules, and secret validation
  -> D1 batch: deletion fence + exact tenant/project episode guard
  -> semantic_atom_candidates + terminal semantic_atom_capture_runs
```

The model never supplies authoritative provenance. Candidate rows are inserted
through `SELECT` from the already-permitted source episode, so tenant/project,
source/session time, observed time, and source identity come from durable local
state. A model quote must match an exact Unicode code-point span before the D1
batch is built. Raw responses are neither persisted nor logged.

Candidate identity records the exact extraction chunk; a separate stable dedup
key excludes operational re-chunking so the same source assertion cannot become
multiple rows after rescue/replay. Capture-run rows make timeout/schema/source
loss/erasure/write outcomes terminal and observable without presenting failed
semantic work as success. Erasure deletes candidates, run state, and episodes
atomically per packet/project batch and the global convergence loop counts all
three.

Three production-path holdout seeds confirmed the lane at 74.55% mean recall,
99.25% precision, 85.08% F1, 100% schema validity, and zero accepted
grounding/scope/secret/accounting failures. Replay and erasure converged in all
seeds. This earns durable candidate preservation, not semantic authority.

The lane still does not feed retrieval, graph projection, context, export, or
the reader. E5 must add temporal representation without fabricating precision;
E6 must earn governed promotion into typed current/historical state; E7/E9 must
separately earn read-path participation. Production default remains OFF and the
temporary confirmation cohort was removed after cleanup.

## V3-D13 bounded E7 corpus construction

Under the nested E7 flag, every candidate lane now binds tenant/project scope
and applies its limit in D1 before data crosses into the Worker. Candidate
identities are fused fairly and only a fixed evidence closure is hydrated; lane
failure cannot fall back to a full-corpus scan. The legacy path remains
unchanged outside E7. The repaired 100k cell reduced broad recall from 510.978s
to 2.596s with maximum node/slice/edge load 600 and all scope/erasure gates
preserved.

## E9A exact source-evidence expansion (KEEP, default OFF)

E9A follows only exact provenance from an E7-selected assertion through its
projection and candidate to a permitted scrubbed source episode. It is capped
at 12 selected assertions, 8 unique episodes, 700 Unicode code points per
episode, and the shared 24,000-character final context ceiling. Tenant, project,
packet, episode, message, memory-user, owner-user and external-user identities
are constrained before text is returned, and text is scrubbed again at render.

The frozen holdout improved judge 95.24% -> 97.62% and token-F1 65.38% ->
72.83% with unchanged 95.24% evidence availability, 100% conditional accuracy,
zero failures and recall p95 at the +25% gate. E9A is kept. It does not search
episodes. Episode vectors remain absent.

## E9B episode FTS fallback (REJECT, default OFF)

E9B tested a second, reference-blind source-recovery path only when selected
semantic evidence was sparse or entirely unbacked. It used SQL scope predicates
before FTS `LIMIT`, a candidate maximum of 8, at most 4 rendered episodes, fixed
lexical overlap, duplicate suppression against E9A, re-scrubbing, and a 3,200-
character contribution cap.

The mechanism was safe but redundant on the sealed holdout: 23/24 FTS hits were
already exact E9A episodes, the one novel candidate did not qualify, and all 42
treatment contexts remained byte-identical. Recall p95 still rose 60.29%.
Therefore E9B is excluded from the accepted architecture and stays OFF/0. The
episode store remains the recoverability/provenance layer; its existence does
not imply that every possible read lane should be activated.

## E5 deterministic temporal representation (confirmed, default OFF)

Atomic candidates now retain the raw temporal phrase plus deterministic
`event_time`, optional range end, precision, relation, source, anchor, and
schema metadata. Resolution prefers authoritative source time, falls back to
observed time only when no source time exists, clamps calendar arithmetic, and
keeps unresolved/anchor-missing outcomes explicit instead of fabricating dates.

The production proof caught and closed V3-D08: the source and episode layers
had preserved `source_time`, but the Durable Object reconstructed messages
without it. The corrected handoff canonicalizes the field with
`persistedSourceTime()` before placing it in held/recent/queued state. This is a
load-bearing architecture invariant: authoritative provenance must survive
every transport boundary, not merely exist in the first and last tables.

E5 remains write-only. No temporal candidate enters graph state, retrieval,
context, export, or the reader. E6 must govern projection and measure its value
with the fixed E1+E0 read path before that boundary changes.

## E10 adaptive context compiler (REJECT, default OFF)

E10 preserved every E7-selected object and changed only assertion rendering,
but its deterministic per-object caps intentionally omitted 345/538 available
assertions on the frozen holdout. Context shrank 30.45%, yet evidence
availability fell 14.29pp and judge accuracy fell 4.76pp. All accounting and
safety invariants passed, so this is a clean architectural rejection rather
than an implementation or harness defect.

The accepted final-validation candidate is therefore:

```
scrubbed acceptance-atomic episodes
  -> source-grounded zero-to-many atomic capture
  -> deterministic temporal metadata
  -> governed typed projection through existing graph authority
  -> E7 bounded assertion-level lanes + RRF/MMR
  -> exact E9A provenance source bundles
  -> existing evidence-preserving hard context ceiling
  -> GPT-OSS-120B reader
```

Excluded from the candidate: E2-B1 extraction behavior, E6M destructive
coalescing, BGE reranking, E9B episode fallback and E10 fixed assertion caps.
Episodes remain required for durability, provenance, erasure and repair even
though broad episode retrieval is rejected. Every accepted quality component
remains nested under exact account-scoped flags and default OFF for normal
users pending final validation and explicit owner enablement.
