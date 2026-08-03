# Fix round 1 — Part 0 trace (before build)

Date: 2026-08-03. Scope: the five Part-0 questions from the Zero Silent Failures build
spec, answered by reading the code as deployed (master @ `9c42384`) and by measurement.
No fixes are included in this commit.

Sources of evidence:

- Code reading with file:line citations (the tree at `9c42384`).
- The Aug 2 load-test artifacts (`C:\Users\ziyad\itsuki-loadtest\results\`): before/after
  graph snapshots, calls.jsonl, polls, drain history.
- A fresh small-scale live repro (5 trials × 3 rapid `ingest(flush=True)` saves against
  isolated `fixround1-trace-*` sub-tenants, prod, 2026-08-03).
- An offline replay of the REAL `recall()` code over the post-drain load-test snapshot
  (fake D1 serving the snapshot rows; BM25 + vector signals absent offline and noted).

---

## 0.1 The stranding

### (a) Where does the busy flag live?

**In DO instance memory, not `ctx.storage`.** `this.busy = false` is set in the
constructor ([src/durable/user-memory.js:27](../src/durable/user-memory.js)) and
checked/toggled in `runExtraction` (lines 149–150, 262) and `drainMcpJobs` (lines
292–293, 308). Isolate eviction, crash, or deploy resets it to `false` with whatever
work was in flight simply gone; nothing persists the fact that an extraction was
running except the 5-minute watchdog alarm set at the start of a fire (line 159, 298).

### (b) What happens to a skipped fire today?

Two doors call `runExtraction`:

1. **RPC from the ingest path** ([src/pipeline/ingest.js:82](../src/pipeline/ingest.js)):
   the returned `{skipped: true}` is **discarded** — `result` feeds the wait-budget race
   and the catch only logs. The caller has already been told `fired: true`, and
   commands.js stores an **"accepted / extraction accepted and processing"** receipt
   ([src/pipeline/commands.js:193–212](../src/pipeline/commands.js)) — a promise nothing
   is left responsible for keeping.
2. **The alarm** ([src/durable/user-memory.js:367–370](../src/durable/user-memory.js)):
   a skip re-arms the alarm +2s. This is the only skip path that re-arms anything.

The skipped fire's messages themselves are safe *at rest*: `addMessages` durably
appended them to the `chunk` key in DO storage (line 125) before returning. What is
NOT guaranteed is that anything comes back for them. They are re-processed only if:

- the in-flight extraction completes normally and its completion block re-reads
  `held > 0` → re-arm +1.5s (lines 233–237), or
- a **future** `addMessages` fires again (line 135–137), or
- the 5-minute watchdog fires into a fresh instance.

### (c) Why does the alarm chain terminate?

A DO has exactly one alarm; `setAlarm` overwrites. The chain dies with a non-empty
chunk through four distinct exits:

1. **The completion-race delete.** `runExtraction`'s completion block reads
   `held = chunk.length` (line 233) and, when it sees 0 (or a non-retryable outcome),
   calls `releaseAlarm()` → `deleteAlarm()` (lines 229–232). `runExtraction` does NOT
   run under `blockConcurrencyWhile`, so a concurrent `addMessages` can interleave at
   any of its `await` points: A reads `chunk` (empty) → B appends messages + `setAlarm(+1s)`
   → A `deleteAlarm()`. Non-empty chunk, **no alarm, busy=false — stranded** until the
   next unrelated write arms a fresh alarm. The tell: `drainMcpJobs` has an explicit
   re-check-after-delete for exactly this race (lines 314–323, "Never strand work");
   `runExtraction`'s completion path has no such re-check.
2. **`meaningful_no_write` with held > 0** deliberately releases the alarm (lines
   246–251) — by design it waits for NEW messages. Defensible in isolation, but it
   converts an "accepted / processing" receipt into silence with no visible state.
3. **The fail cap.** After 6 `llm_failed`/`db_write_failed` retries, `releaseAlarm()`
   (lines 241–245). Chunk kept, alarm gone, no receipt, no report. Silent dead-letter.
4. **Uncaught throw inside `alarm()`.** Anything thrown out of `drainMcpJobs`/
   `runExtraction` propagates; Cloudflare retries the alarm ~6× with backoff and then
   drops it. A deterministic error exhausts the retries and the chain is gone.

Additionally the watchdog itself can *delay* the chain: the RPC fire overwrites an
`addMessages` +1s alarm with its +5min watchdog (line 159), so any kill of the RPC
in-flight work (worker event teardown of the `ctx.waitUntil`, eviction, deploy) turns
into a 5-minute stall per occurrence — under sustained load these stack up.

### Production evidence

- Load test (Aug 2): quiesce snapshot showed **54 nodes / 29 edges**; the true content
  of the run only surfaced after `drain_loop.py` sent repeated nudge messages —
  final **90 nodes / 38 edges / 80 slices / 80 events**. i.e. most of the accepted work
  sat stranded in DO storage while every API call had returned 200 with an
  accepted/processing receipt.
- Small repro (2026-08-03, 5 trials × 3 rapid `ingest(flush=True)` saves, each trial
  on a fresh isolated sub-tenant, 0.25s apart so #2/#3 arrive during #1's fire):
  **2 of 5 trials stranded.** Trial 4 parked at checkpoint `t4m2` (message 3's chunk
  held, no alarm) and trial 5 at `t5m1` (messages 2 and 3 stranded) — both flat for
  120s of polling with zero movement, after every call had returned `fired: true`.
  Trials 1–3 drained fully, two of them after visible multi-poll stalls. Three
  messages is enough to hit the race roughly half the time; the load test's ~40
  concurrent writes made it a certainty.

**Conclusion:** the design principle in the spec is confirmed — alarms are hints and
must never be load-bearing; the queue must live in storage and every accept needs a
job row + an independent sweep. No Part-0 contradiction with the Part-1 spec.

---

## 0.2 One multi-hop recall, traced stage by stage

Method: the five failed questions were replayed through the REAL `recall()` code over
the post-drain load-test snapshot (90 nodes / 38 edges), with a fake D1 serving the
snapshot rows. BM25 and vector signals are empty in this offline replay (the FTS
tables and Vectorize namespace are not in the snapshot); the exact/keyword/graph
stages and RRF/MMR/context are the production code paths.

### Headline finding — the spec's premise needs one correction

**Graph expansion is wired and does fire** ([src/pipeline/recall.js:512–535](../src/pipeline/recall.js)):
seeds = top-6 of exact + lexical + vector ranks; 1 hop over open-validity edges into
RRF. On the load-test graph it contributed candidates on 3 of the 5 questions. The
0/5 result is a **compound failure in front of and behind it**, not a dead code path:

Per-question stage counts (offline replay):

| Q | exact | keyword | seeds contain the right entity? | expansion adds | verdict |
|---|---|---|---|---|---|
| Q1 partner's studio city | 0 | 16 | no ("partner" never resolves to Marta Coelho) | +2 (Atelier Barro via Teodor's `uses`, Japan) | answer needs hop 2 (Atelier Barro → Campo de Ourique); never reached |
| Q2 Yusuf's manager + city | 1 (Yusuf Demir) | 10 | yes | **+0 — Yusuf Demir has zero edges** | REPORTS_TO was never extracted. Extraction gap, not recall |
| Q3 sister lives / married to | 0 | 8 | no | +0 | MARRIED_TO / LIVES_IN never extracted from the sister sentence. Extraction gap |
| Q4 ceramics teacher + Marta | 1 (Ceramics class) | 15 | yes | +4 incl. Atelier Barro (correct hop) | teacher (Teodor) is 2 hops away; `TEACHES` edge absent |
| Q5 manager at new company + city | 0 | 17 | no ("manager", "company" resolve to nothing) | +1 | REPORTS_TO edge absent; right seed absent |

The four breaks, in causal order:

1. **Seed contamination (the biggest one).** The keyword signal scores nodes over
   `label + summary + slice text + event text` ([recall.js:487–494](../src/pipeline/recall.js)).
   Because slices carry the **concatenated batch text** (the Problem-4 blob — "ugh the
   traffic on Avenida…" smeared across 5+ nodes), unrelated nodes (Shellfish Allergy,
   Sanne de Bruin, Joost, Salt and Ash exhibition) match 5–9 query tokens on EVERY
   question and fill the 6-per-list seed cap before the right entities. Part 7.4
   (per-message provenance, never the concatenated chunk) is therefore a *recall* fix
   as much as a hygiene fix.
2. **Missing edges.** Q2/Q3/Q5 fail because REPORTS_TO / MARRIED_TO / LIVES_IN /
   TEACHES were never extracted (Part 6.6/6.7 territory). No recall change can
   surface an edge that does not exist.
3. **1 hop only.** The expansion loop is a single pass over `edgeRows`; Q1 and Q4 need
   two hops (person → org → place). The spec's 1–2 hops with hop-decay is the right
   shape.
4. **Relational-word resolution.** "my partner", "my sister", "my manager" appear in
   queries but exist in the graph only as node labels (Marta Coelho, Amara…). Nothing
   maps the relation word to the entity (no alias, no mention-table lookup). The
   spec's "resolve to entity ids via mentions" addresses part of this; a
   relation-alias step (partner→spouse edges) may be needed for full coverage.

Also noted while tracing (not blocking, for Part 5's design): expansion candidates
enter RRF as one more ranked list, so a single-signal graph hit lands near 1/(60+i) —
under contaminated seeds it never outranks the junk. Hop-decay weighting inside RRF
must account for this or expansion stays cosmetic.

**Spec deviation to flag (per ground rules):** Part 5 alone will not reach ≥4/5 on the
multi-hop fixtures — Q2/Q3/Q5 are extraction gaps (Part 6) and Q1 partly hygiene
(Part 7.4). The ≥4/5 target is reachable only after Parts 5+6+7 land together, which
matches the agreed report-after-Part-4 sequencing.

---

## 0.3 Read-your-writes per lane

Question: a user saves "my name is X" and asks "what's my name" 5 seconds later —
does recall see it before enrichment completes?

| Lane | Staged content visible to recall before enrichment? | Detail |
|---|---|---|
| MCP `save_conversation` (staged) | **Partial** | `insertProvisionalPage` writes the page synchronously ([mcp_engine.js:307–333](../src/pipeline/mcp_engine.js)) with `short_summary` = **first durable line only** (line 321) and full lines in `full_markdown`. Recall's page corpus reads title/short_summary/key_points — **not `full_markdown`** ([recall.js:495–503](../src/pipeline/recall.js)), and staged pages have no FTS row (search profiles are built at enrichment). So: line 1 findable via keyword/title match; lines 2+ invisible until enriched. The staged-job processing note ([commands.js:307–317](../src/pipeline/commands.js)) correctly warns the caller. |
| SDK `add()` → /v1/save (direct) | **No (when async)** | Blocks up to the 9s wait budget; if extraction completes in budget the write is fully visible. Past budget: content exists ONLY in the DO `chunk` key — no D1 row of any kind, invisible to recall, no processing note (the memory_jobs check covers `mcp_enrich` only). |
| SDK `ingest()` → /v1/ingest | **No** | Fire-and-forget; content lives in the DO chunk until extraction. Invisible to recall, no processing note. |
| `/v1/turn` autoCollect, Playground | **No** | Same ingest lane. |

The 8.2 fix (staged scrubbed text findable at stage time, upgraded on enrichment)
is real product work, not paranoia — and once Part 1 gives every lane a job row, the
recall processing-note query should widen from `type='mcp_enrich' AND status='staged'`
to any non-terminal job.

---

## 0.4 Vectorize orphans

Confirmed safe — D1 is already the source of truth at read time:

- Recall filters vector hits through the live-nodes map: `matches.filter((m) => byId.has(m.id))`
  ([recall.js:510](../src/pipeline/recall.js)); `byId` is built from a
  `deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL` query.
  A vector whose D1 row is gone (or not yet written) is dropped silently.
- The extraction shortlist does the same: `if (byId.has(m.id))`
  ([shortlist.js:57](../src/pipeline/shortlist.js)).
- Not-yet-inserted vectors simply produce no match; nothing dereferences a vector id
  against D1 without the live filter.

No read-side fix required; Part 3's cascade can rely on async `deleteByIds` + this
recall-time filter, exactly as the spec assumes.

One write-side gap found while confirming this: **`deleteNodeVectors`
([vectorize.js:41](../src/lib/vectorize.js)) is defined but never called** — no delete
path (deleteObject, deleteAllMemories, cleanup SQL) removes vectors today, so orphans
accumulate forever and only the recall-time filter hides them. Part 3's cascade must
actually start calling it.

---

## 0.5 Job-row coverage map

"Does an accepted write create a `memory_jobs` row **at accept time**?" —
`pass2_rollup` rows created *after* a successful write don't count; they postdate the
danger window.

| Lane | Path | Job row at accept? |
|---|---|---|
| MCP `save_conversation` | `stageMcpConversation` → `createMemoryJob(type=mcp_enrich, status=staged)` before the receipt returns ([mcp_engine.js:471–478](../src/pipeline/mcp_engine.js)) | **YES** — the only covered lane |
| MCP `save_memory` | `runDirectSaveCommand` → `saveMemory` → `ingestMessages` → DO chunk | **NO** — only a `pass2_rollup` row after a successful write ([extract.js:461](../src/pipeline/extract.js)) |
| SDK `add()` / REST `/v1/save` (direct) | same as MCP save_memory | **NO** |
| SDK `add_conversation()` / `/v1/save mode=conversation` | `saveConversation` → manual_collect digest → `saveMemoryPage` | **NO** at accept (`pass2_rollup` post-write, [pages.js:726](../src/pipeline/pages.js)); runs synchronously today, but a thrown error between accept and write leaves nothing |
| SDK `ingest()` / REST `/v1/ingest` | `runObserveMessagesCommand` → `ingestMessages` → DO chunk | **NO** — the load-test lane; nothing exists in D1 until extraction lands |
| `/v1/turn` (autoCollect on) | `runObserveMessagesCommand` | **NO** |
| Playground chat | `playgroundTurn` → `runObserveMessagesCommand` ([playground.js:294](../src/pipeline/playground.js)) | **NO** |

Supporting schema facts for Part 1: `memory_jobs` exists since migration 0005 with a
`(user_id, idempotency_key)` unique index; `createMemoryJob` upserts on that key and
`storeSourcePacket` upserts packets on the same key with `seen_count` — so 1.1/1.10
can build on existing tables; the new work is per-lane row creation, lease/queue
state, and the sweep. Next migration number is **0025**.

---

## Reconciliation of findings vs the build spec

- Part 1: fully confirmed; no deviation. The completion-race delete (0.1c-1) is the
  concrete bug the storage-backed queue + lease + sweep design eliminates.
- Part 2: confirmed; the recall processing-note should widen once all lanes have jobs.
- Part 5: **premise correction** — expansion exists and fires; the work is seed
  hygiene, mention/alias resolution, 2-hop reach, hop-decay in RRF, and fixtures.
  ≥4/5 depends on Parts 6/7 landing too (flagged above).
- Part 7.4: upgraded from "hygiene" to "recall-critical" — batch-blob slices are the
  main seed contaminator (0.2 finding 1).
- Everything else: no contradictions found.
