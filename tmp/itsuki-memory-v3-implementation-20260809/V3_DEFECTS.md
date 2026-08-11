# V3 DEFECT LEDGER

## Final Stage B product finding (2026-08-11)

| id | sev | classification | finding | status |
|---|---|---|---|---|
| **V3-D12** | **HIGH** | **PRODUCT ERASURE-CONVERGENCE DEFECT** | In the clean Stage B delete-during-extraction race, the account deletion barrier won 1.6s after acceptance, but the E4 atomic lane claimed a new `semantic_atom_capture_runs` row about 17s after that barrier. Its commit fence correctly produced `cancelled_by_delete` with zero atoms/content, yet the late audit row survived confirmed erasure because the deletion convergence passes had already completed. | **CLOSED** - failing-first 11/12 reproduced one model call and one surviving run after a pre-existing barrier. The fix makes run claim a single conditional D1 write against `deletion_barriers`, returns cancellation without model spend/row when deletion wins, and retains the commit fence for deletion racing after a claim. Exact 12/12, focused 110/110, Worker 1,312/1,312, unit/cross-door 539/539 + one skip, audit/dry deploy pass; commit `cef9581`, production version `e34b92bc-0577-4a16-b63d-7a1bc8b9a1f2`, deployment `297b55ff-9668-4c11-8886-ba3d08bcbdfb`, 20/20 propagation. Live reattack accepted 20 episodes, deletion reported one pending job, bounded drain reached zero in 34.5s, capture runs/candidates remained zero, replay stayed non-retryable `409 source_write_erased`, erased recall was zero, and final state was zero with 701/701 packet fences content-free. |
| **V3-D11** | **HIGH** | **PRODUCT ERASURE / READ-DURABILITY REGRESSION** | D10's content-free erased-packet sentinel correctly fenced accepted writes, but it also made the deterministic packet key for an identical future `/v1/recall` collide forever. A genuine post-erasure read therefore returned `409 idempotency_conflict`; the clean Stage B replacement stopped at its immediate-read assertion. | **CLOSED** - production and failing-first test reproduced 409; the narrow fix permits only an erased `source_type=query, source_mode=recall` row to be renewed, while write/ingest replay fences remain immutable. Exact 32/32, focused 195/195, Worker 1,311/1,311, unit/cross-door 539/539 + one intentional skip, audit/dry deploy pass; commit `183d540`, production version `345cd4d7-c680-4e16-9a99-2fe59baa33bc`, deployment `1b13b0e9-68ae-4520-8353-33a27b1a343d`, 20/20 propagation. Live reattack returned 200 for the same recall across two erasure cycles while the erased write replay remained non-retryable `409 source_write_erased`; final production-primary state was zero live rows/jobs and 643/643 packet fences content-free. |
| **V3-D10** | **HIGH** | **PRODUCT PRIVACY / ERASURE DEFECT** | Request-scoped rules correctly blocked a synthetic forbidden marker from episodes, FTS, semantic candidates, graph state, staging, recall and export, but `normalizeSourcePacket` had already copied every scrubbed message into `source_packets.content_preview` and `raw_meta_json` before rules admission. Confirmed erasure intentionally retained that packet as an idempotency/replay fence without minimizing its plaintext, so the audit row was a non-searchable but durable shadow copy. | **CLOSED** - failing-first 29/31; exact 31/31, focused 201/201, Worker 1,310/1,310, unit/cross-door 539/539 + one skip, audit/dry deploy pass; commit `3148a9c`, production version `b0dfbaca-3807-4e18-8e66-b2d01ff5d468`, deployment `26d82115-74df-47a0-89fa-cb8c32b6ed0d`; live rules test retained one permitted packet/episode and zero forbidden packet/episode/atom/staging/recall/export hits; erasure left one content-free sentinel packet and exact replay returned non-retryable `409 source_write_erased`; final production-primary audit found 622/622 retained campaign packets minimized, zero content rows, zero live episodes/atoms/projections/jobs. |

## Final Stage B harness finding (2026-08-11)

| id | sev | classification | finding | status |
|---|---|---|---|---|
| **V3-H12** | **MEDIUM** | **HARNESS DEFECT** | The delete-race assertion slept a fixed 15 seconds, then described any nonterminal job as a late commit. The production job was still safely in flight and reached terminal `failed/cancelled_by_delete` after about 37 seconds; no episode, atom, projection or graph row appeared. | **CLOSED BEFORE REPLACEMENT** - the driver now polls the complete residue vector for at most 180 seconds and still requires absolute zero. This separates bounded backlog drain from resurrection while preserving a hard failure if work never converges. The independent V3-D12 late atomic-run row remains a product HIGH and is not excused by this harness correction. |
| **V3-H11** | **MEDIUM** | **HARNESS DEFECT** | The same-key concurrency audit counted every `memory_jobs` row for a packet and required one total row. Production correctly converged both accepts onto one packet, one scrubbed episode, one extract job and one capture run, then created one distinct downstream `pass2_rollup` job; the harness misclassified that valid rollup as duplicate work. | **CLOSED BEFORE CONTINUING THE REATTACK** - invalid run emitted no result and is unscored; exact logs retained; product rows were independently classified by job type; the audit now requires exactly one extract job, at most one pass-2 job and no other jobs; all failed-run synthetic state was erased through the public deletion contract and remained zero after the stability grace. |

## E9A harness finding (2026-08-11)

| id | sev | classification | finding | status |
|---|---|---|---|---|
| **V3-H10** | **MEDIUM** | **HARNESS DEFECT / LOCAL TRANSPORT** | The post-ingest E9A state fingerprint used Wrangler through synchronous Node child capture on Windows/Node 24 and selected nonexistent `memory_pages.state` instead of the production `health_state` column. Ten valid, reference-blind writes and exports completed, then the fail-closed verifier stopped before sealing. | **CLOSED BEFORE READ/SCORE** — no re-ingest; frozen export retained; current production schema independently proved the column contract; E9 now uses Cloudflare's documented read-only D1 HTTPS query endpoint with bounded retries and production-primary enforcement, and selects `health_state`; a resume-only state seal must prove all ten terminal jobs, exact provenance, frozen hashes, export integrity, and an unchanged production fingerprint before any read inference |

## E7 observability finding (2026-08-11)

| id | sev | classification | finding | status |
|---|---|---|---|---|
| **V3-D09** | **MEDIUM** | **PRODUCT OBSERVABILITY DEFECT** | Recall recomputed current context on an exact query, but the response exposed latency only through an idempotent durable receipt. Because the receipt id is deterministic, repeated current calls inherited the first call's `latency_ms`; paired server-latency evidence could therefore be stale even while the returned context changed under a feature flag. | **CLOSED** — failing-first 17/18; `02ab877` adds top-level current-invocation `recall_latency_ms` without mutating the receipt; focused 18/18, Worker 1,288/1,288, unit/cross-door 539/539 + one intentional skip, audit/dry deploy pass; production reattack returned the same receipt/771 ms and distinct current 771/351 ms |

The valid E7 quality result is unaffected. Its old latency decision remains
`MODIFY` pending the preregistered paired recall-only E7M measurement using the
new current-invocation field.

## E5 temporal representation finding (2026-08-11)

| id | sev | classification | finding | status |
|---|---|---|---|---|
| **V3-D08** | **HIGH** | **PRODUCT DEFECT** | BF-1 `source_time` survived the source packet and scrubbed episode, but `UserMemory.addMessages()` omitted it while rebuilding held/queued messages. Atomic temporal normalization therefore silently fell back to `observed_at`. | **CLOSED** — failing-first test reproduced `undefined`; commit `bd06e807` canonicalizes and preserves `source_time`; 1,257 Worker + 539 unit tests pass; repaired production proof resolved 7/7 from `source_time`, replayed stably, erased to zero; closure Worker `46990d10…` has atomic OFF/count 0 |

Full evidence: `e5/HIGH-SOURCE-TIME-HANDOFF-DEFECT.md`,
`e5/INVALID-LIVE-ATTEMPT-003.product.json`, and `e5/live-proof.json`.

## E4 product-integration findings (2026-08-10)

| id | sev | classification | finding | status |
|---|---|---|---|---|
| V3-H09 | MEDIUM | HARNESS DEFECT | Retry-history repair incorrectly required `extraction_runs.job_id` to equal the ingest job. Product source and a production-primary join proved this field is intentionally reassigned to the same-packet `pass2_rollup` job after a write; tenant and packet matched. | CLOSED — invalid attempt 004 stopped after one reference-blind call and is erased; integrity now permits null or requires the linked pass-2 job to match tenant+packet, while cross-scope/cross-packet links fail |
| V3-I03 | LOW | INFRASTRUCTURE TRANSIENT | Seed-2 API erasure completed, but the final read-only Wrangler D1 verification process failed once before writing the cleanup artifact. Immediate independent production-primary verification proved every live count was zero; sealed product/score evidence was unaffected and seed 3 never started. | CLOSED — D1 verification now performs three bounded read-only retries with sanitized errors; exact idempotent cleanup boundary resumes without inference |
| V3-H08 | MEDIUM | HARNESS DEFECT | Product confirmation required exactly one historical extraction-run row. HO-06 correctly recovered from one transient failure with one failed predecessor, one successful run, durable job `attempts=1`, one completed atomic capture, and a final receipt, but the harness rejected that valid retry history before seal/score. | CLOSED — retry-aware integrity now requires exactly one successful terminal run, only bounded failed predecessors with matching packet/job/scope identity, and failures no greater than durable retry count; invalid attempt 003 preserved/erased and uses no quality result |
| V3-H07 | MEDIUM | HARNESS DEFECT / EXPECTED SAFETY REJECTION | The first seed-1 replacement reused invalid attempt 001's erased idempotency key. The product correctly returned `409 source_write_erased` before inference, proving V3-D06 anti-resurrection behavior. | CLOSED — invalid attempt 002 preserved with zero neuron burn and no writes; replacement transport identity is mechanically namespaced while frozen content/model/seed/gates remain unchanged |
| V3-H06 | MEDIUM | HARNESS DEFECT | E4 product confirmation applied the production prose scrubber to a complete structured export serialized as one string. Opaque database IDs and receipt metadata therefore produced 118 high-entropy redactions / 65 affected paths on a previously validated export, stopping seed 1 after ten reference-blind product calls but before any artifact was sealed or scored. | CLOSED / INVALID ATTEMPT PRESERVED — replaced by a path-aware audit that masks structural identities before scanning content; prior clean export passes (364 strings, 94 identities masked), a synthetic API key in memory content fails, all invalid-attempt state was erased, and the exact preregistered seed is eligible for one replacement under the unchanged neuron cap |
| V3-D07 | LOW | PRODUCT DEFECT | Durable cross-rechunk dedup prevented a second candidate row, but `persistChunk` reported every locally accepted atom as stored and omitted the database conflict from duplicate count. This would overstate E4 capture and corrupt conservation metrics without leaking or losing evidence. | CLOSED PRE-DEPLOYMENT — failing assertion reproduced stored=1/duplicates=0; D1-batch run accounting and result metadata now report stored=0/duplicates=1; immediate and replay summaries pass |
| V3-I02 | LOW | LOCAL VALIDATION TOOLING | `wrangler d1 execute --local` completed no captured output and left idle npm/cmd wrappers after a read-only query; the Android SDK `sqlite3.exe` also stalled on a long candidate-insert shell command. | CONTAINED — no production call or mutation; exact wrappers were verified/stopped, local migration ledger/schema were read independently, and actual Worker/D1 persistence tests are authoritative |


## E3 harness/infrastructure findings (2026-08-10)

| id | sev | classification | finding | status |
|---|---|---|---|---|
| V3-H04 | MEDIUM | HARNESS DEFECT | Scorer v1 omitted persisted `source_time` from episode evidence, invalidating its relative-date episode judgments. | CLOSED — scorer v2 renders source time; v1 episode quality metrics labeled invalid |
| V3-H05 | MEDIUM | HARNESS DEFECT | Scorer v2 unnecessarily re-invoked the stochastic semantic-support evaluator for the byte-identical semantic control, making its new semantic precision non-causal. | CLOSED — final paired decision reuses original semantic judgments and substitutes only v2 episode judgments; zero new inference |
| V3-I01 | LOW | INFRASTRUCTURE FAILURE | ReasonLabs' filesystem filter indefinitely blocked long-name content opens of sealed `*-v2*` artifacts while NTFS 8.3 aliases remained readable. | CLOSED FOR CAMPAIGN — same file records read through 8.3 aliases; hashes retained; no artifact mutation |



## E3 erasure/replay finding (2026-08-10)

| id | sev | title | status |
|---|---|---|---|
| **V3-D06** | **HIGH (product)** | **An exact replay of an erased terminal V3 write returned the old HTTP 200 acceptance even though its semantic rows and source episodes were gone.** Terminal `enriched`/`completed` jobs went directly to `recordReplay`; only `failed` jobs carrying `cancelled_by_delete` were fenced. A durable sender could therefore discard its local copy after a false durability acknowledgement. | **FIXED** - `72a9b1a`; production `ff9fbeb0-377b-4c3d-949e-d603202c3bd6` |

### V3-D06 - full lifecycle record

| step | evidence |
|---|---|
| Found | E3 attempt 002 reused attempt 001's exact idempotency key after confirmed cleanup. The response was HTTP 200 with no fresh episode counters. D1 showed the terminal job and packet retained for audit/idempotency, `seen_count=2`, a later deletion barrier, and zero live episodes. |
| Failing-first | Added `source_episodes.spec.js` test "refuses an acceptance-shaped exact replay after a terminal V3 write was erased". Before the fix: **29 pass / 1 fail**, expected 409 but received 200. |
| Root cause | `ingestMessages` fenced only a `failed` job whose error started `cancelled_by_delete`; the earlier generic terminal branch returned `recordReplay` for `enriched`/`completed` without comparing packet acceptance time to `deletion_barriers`. Cleanup correctly retained audit state, but replay incorrectly treated that state as live durability. |
| Fix | For V3 exact replays, compare retained packet `received_at`/`created_at` to the account's latest barrier before any repair or terminal replay. A pre-barrier (or unprovable) packet returns 409 `source_write_erased`; a packet accepted after the barrier remains normally idempotent. |
| Exact rerun | Source episode suite: **30/30 pass**. |
| Regressions | Replay/cleanup/ingest focused set: **4 files / 76 tests pass**. Full serialized Worker gate: **103 files / 1,218 tests pass**. `npm audit`: zero vulnerabilities. Wrangler 4.120 dry-run: pass. |
| Deployment | Commit/origin `72a9b1a519009e7debb3dadb3efc4d2d0caa81ee`; Worker version `ff9fbeb0-377b-4c3d-949e-d603202c3bd6`; no migration or binding change. |
| Production re-attack | Exact previously erased packet: **409**, code `source_write_erased`, `retryable=false` on the allowlisted V3 tenant. Both domains report allowlist 30 / B1 off. Post-attack D1: `seen_count=2` unchanged, zero episodes, zero non-terminal jobs. Artifact: `e3/D06-PRODUCTION-REATTACK.json`. |
| Cleanup | Attempt 002 made no new extraction call or product artifact; emergency cleanup was clean. The old erased packet remained erased. |

## E2 harness findings (2026-08-10)

| id | sev | title | status |
|---|---|---|---|
| V3-H02 | MEDIUM (harness) | Reusing erased holdout slots retained historical audit receipts by design, so seed-2 exports contained both seed-1 and seed-2 extraction receipts. Unfiltered conservation counters would have mixed seeds. Detected before seed-2 scoring; scorer now requires the exact current idempotency prefix. Seed 1 had no prior receipts. | FIXED BEFORE AFFECTED SCORE |
| V3-H03 | LOW (harness/external) | The post-seed-2 GraphQL burn snapshot returned transient authentication errors for all bounded attempts. The fail-closed guard stopped inference, released the lock, and shut down the evaluator. `wrangler whoami` refreshed the existing OAuth session; live usage then read 1,650,136 and the driver resumed completed artifacts without rerun. Resume accounting preserves the original pre-seed burn. | CLOSED / FAIL-CLOSED PROVEN |

Severity: CRITICAL / HIGH / MEDIUM / LOW. Lifecycle for CRITICAL+HIGH:
failing-first test → classify → root cause → safe fix → exact rerun →
regressions → deploy → production re-attack → cleanup.

## Carried in from the LLM-judge baseline (this campaign actions them)

| id | sev | title | status |
|---|---|---|---|
| BF-1 | HIGH | `/v1/ingest` has no authoritative source/session timestamp field. `ts` is accepted by `normalizeMessageBatch` but is not on the wire contract and defaults to `Date.now()` (`src/pipeline/source.js:201,270`), so it records *ingested_at*, not *source_time*. Relative phrases ("yesterday", "last week") have no anchor. Leading explanation for temporal at 6.23%. | OPEN |
| BF-2 | HIGH | `/v1/recall` allowlists `limit` (`src/lib/params.js:47`) but the handler never forwards it (`src/index.js:1631-1640`), and `runRecallCommand` never forwards it to `recall` (`src/pipeline/commands.js:527-531`). A documented parameter silently does nothing. | OPEN |
| BF-3 | HIGH | Extraction coverage is the binding constraint: 64.6% of judge-misses are Stage A (never stored). ~1 memory per 7.5 turns; whole-conversation graphs average 78 nodes. | OPEN |
| BF-4 | INFO | When retrieval succeeds the pipeline works (61.04% with reference in context vs 11.31% without). Effort belongs upstream of retrieval. | ACCEPTED AS DIRECTION |

## New defects found by this campaign

| id | sev | title | status |
|---|---|---|---|
| **V3-D01** | **HIGH (product)** | **An unreadable rules store meant "no rules."** `getMemoryRules` caught every read error and returned `DEFAULT_MEMORY_RULES`; `resolveAdmissionRules` passed those on. Both `stageMemoryText` and the new episode writer are written to fail closed and neither could — their try/catch was unreachable because nothing ever threw. A transient D1 failure on one SELECT therefore converted an account's `excludes: ["salary"]` into "keep everything", durably in `staged_memories` (recallable) and, with V3 on, in `source_episodes` (searchable). Pre-existing; found while building P0-D. | **FIXED** — `efe37db` |
| V3-D02 | LOW (product) | `deleteSourceEpisodes` reported `meta.changes` as the deleted count. With FTS5 triggers that number includes index churn, so erasing 2 episodes reported 6. Counts before/after instead. | FIXED — `efe37db` |
| V3-H01 | LOW (harness) | `test/hook_outbox.spec.js` failed once inside a full `vitest.unit.config.js` run (`ensureOutbox` → `prepareProtectedOutbox`, `hooks/outbox.mjs:517/571`), then passed on an isolated re-run (56/56) and on a full re-run (522/522). Windows ACL/filesystem timing flake in the test harness, not a product path. | OBSERVED — classified harness, not product |

### Baseline gates (before any V3 change)

| suite | result |
|---|---|
| `vitest run --no-file-parallelism` (Workers pool) | **91 files / 987 tests PASS** |
| `vitest run --config vitest.unit.config.js --no-file-parallelism` | **32 files / 522 tests PASS** (after the V3-H01 flake) |

### V3-D01 — full lifecycle record

| step | evidence |
|---|---|
| Found | While writing `test/source_episodes.spec.js` → "writes NOTHING when the rules cannot be loaded". The assertion `result.rulesUnavailable === true` returned `undefined`: the writer's fail-closed branch had never executed. |
| Failing-first | `test/rules_unavailable.spec.js` (7 assertions) written to fail against the old code. |
| Root cause | `src/pipeline/rules.js` `getMemoryRules` — one `catch` covering every failure, returning `{...DEFAULT_MEMORY_RULES}`. The comment said "Rules must never break a save. Missing table (pre-migration) → defaults." The missing-table case was correct; the blanket catch was not. |
| Blast radius (pre-existing) | `staged_text.js` (recall read-your-writes bridge) and every `resolveAdmissionRules` caller: `gates.js`, `extract.js`, `mcp_engine.js` ×2, `/v1/turn`. |
| Fix | Distinguish "no rules row" (a real answer) from "could not read" (not an answer). `getMemoryRules(env, userId, { failClosed })`; a missing TABLE stays defaults in both modes; anything else throws `MemoryRulesUnavailableError` when fail-closed. `resolveAdmissionRules` — the admission boundary — now always fails closed. |
| Caller behaviour after the fix | `staged_text` / `episodes`: write nothing, report `rulesUnavailable`. `gates`/`extract`: the run fails, the chunk is retained, the queue retries — the safe direction. `/v1/turn`: explicit **503 `memory_rules_unavailable`** with `retry-after`. MCP staging: propagates to the worker's generic 500; no write occurs and the caller retries. |
| Residual (message quality only) | MCP's refusal is a generic 500 rather than a named error. Correctness is unaffected — nothing is written — so this is recorded rather than fixed under a V3 flag campaign. |
| Regression | Workers pool **97 files / 1110 tests PASS**; unit **32 / 522 PASS**. |
| Production re-attack | **BLOCKED** — reproducing this live requires an ingest, which requires inference. See the cost gate. |

---

| id | sev | title | status |
|---|---|---|---|
| **V3-D03** | **HIGH (product)** | **The extractor's proposed event date never reached storage.** `parseProposedDate` in `src/pipeline/gates.js` used `/^s*(d{4})-(d{2})-(d{2})s*$/` — no backslashes — so it matched the literal string `"sssd{4}-d{2}-d{2}"` and never a real date. Both `happened_at` assignment sites used it. Every event therefore fell back to the message timestamp: when Itsuki was TOLD, not when the thing happened. | **FIXED** — `b851de2` |

### V3-D03 — full lifecycle record

| step | evidence |
|---|---|
| Found | Reading `gates.js` while wiring the temporal anchor. The pattern is visibly missing its escapes; `cat -A` on line 346 confirmed the bytes rather than a display artefact. |
| Failing-first | `test/event_dates.spec.js`, 8 assertions. Before the fix, 4 failed with every event dated `2026-08-09` (ingest day) regardless of the proposed date. |
| Why it matters | The extraction system prompt instructs the model: *"Events MAY carry \"date\" (YYYY-MM-DD): COPY it from an explicit date in the text or the message timestamp."* The model has been doing that; the gate discarded it. This is a mechanical cause of temporal recall at **6.23%**, the only category that gets *worse* under semantic judging — which had already ruled out wording as the explanation. |
| Blast radius | Every event ever written by every lane. `happened_at` feeds recall context, `manual_search_profiles` ranking, `write.js` validity windows (`valid_at ?? happened_at`), and the `cleanup.js` event history read. |
| Second site | `gates.js:1000`, the anti-orphan auto-created event path, carried the same line and was missed on the first pass — caught because the failing test still failed after the first fix. |
| Fix | Correct pattern, explicit month/day range check, and a round-trip check so `2023-02-30` (which `Date.UTC` rolls into March) is rejected rather than stored as a different day. Both sites now call one `factHappenedAt` helper. |
| Regression | Workers pool **99 files / 1173 tests PASS**; unit **33 / 539 PASS + 1 skipped**. |
| Production re-attack | **BLOCKED** — needs a live ingest, which needs inference. See the cost gate. |
