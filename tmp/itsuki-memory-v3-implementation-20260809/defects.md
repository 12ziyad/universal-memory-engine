# V3 DEFECT LEDGER

## Terminal Stage E findings (2026-08-12)

- **V3-H24 HIGH is CLOSED:** the local evaluator crashed after internal
  Wrangler/Workers AI loopback errors. Forty `fetch failed` rows were
  quarantined because no model verdict existed; every actual verdict remained.
  The scorer now aborts before recording transport failure, applies a 90-second
  no-verdict watchdog and runs one request at a time. The exact frozen ledger
  then completed 1,540/1,540 unique verdicts with zero judge errors counted
  wrong.
- **V3-D04 HIGH, V3-D14 MEDIUM and V3-D15 HIGH are CLOSED** in production;
  the final reference-blind state audit reconciled 5,882 episodes and exact
  5,572/5,572 candidate/projection state.
- **V3-H21 MEDIUM is CLOSED:** deterministic official-scoring recovery uses the
  preserved accepted Python environment and revalidates the immutable scorer
  input before running; no judge/input/protocol changed.
- **V3-H22 MEDIUM is CLOSED:** Stage E confirmed deletion now uses a 300-second
  client window for full tenants and verifies residue/jobs after each idempotent
  product-fenced erase.
- **V3-H23 MEDIUM is CLOSED:** cleanup's own governed zero-recall query packets
  are erased after the proof and before the terminal packet audit.
- Open product **CRITICAL: 0; HIGH: 0**. Final cleanup is zero across all stores,
  FTS, recall, export and packet content.

## Final Stage E harness/infrastructure findings (2026-08-11)

| id | sev | classification | finding | status |
|---|---|---|---|---|
| **V3-H16** | **MEDIUM** | **HARNESS DEFECT / TERMINAL REPLAY ACCOUNTING** | A valid enriched exact replay omitted current-call episode counters and the harness coerced missing to zero. | **CLOSED BEFORE ANSWER/SCORE.** Only absent counters on an exact duplicate defer to the existing exact state audit; all fresh/partial/explicit-zero cases remain fail-closed. 5/5 contract proof; zero references opened. |
| **V3-I04** | **LOW** | **WORKERS AI / EXTRACTION TRANSIENT** | Two jobs stopped before a durable model result and were failed at the bounded 15-minute orphan margin. | **CONTAINED.** Same packet/job identities repair through the existing bounded SRV-02 replay path; no answer or score existed. |

## 2026-08-11 — V3-D10 residual cleanup extension CLOSED

The otherwise empty middle/control synthetic cohort retained 217 plaintext
packet rows written before the V3-D10 erasure repair. Current product erasure
minimized all 217 without direct D1 mutation. Combined control+treatment now has
1,098/1,098 content-free fences, zero live state and zero jobs. This closes old
cleanup debt; it is not a new current-code defect.

## Final Stage C product finding (2026-08-11)

| id | sev | classification | finding | status |
|---|---|---|---|---|
| **V3-D13** | **HIGH** | **PRODUCT AVAILABILITY / BOUNDEDNESS DEFECT** | V3 recall fetched every scoped node, slice and edge before bounded fusion. Production-schema local cells loaded 800/8,000/80,000 rows per lane and broad recall grew 3.154s/36.632s/510.978s at 1k/10k/100k. Final context, scope and erasure stayed correct. | **CLOSED.** Exact repaired scale/full gates, deployment and live reattack pass. 100k broad recall is 2.596s, max node/slice/edge load 600; production returned bounded telemetry/zero failures and cleanup stayed zero. Commit `5f11d75`, Worker `052d9b68-b131-45cb-b792-1804c86a50d6`. |

## Final Stage C harness finding (2026-08-11)

| id | sev | classification | finding | status |
|---|---|---|---|---|
| **V3-H14** | **MEDIUM** | **HARNESS DEFECT / STDOUT CAPTURE** | Passing scale-cell stdout was intercepted, leaving a result-less aggregate. | **CLOSED BEFORE SCORE.** The empty aggregate remains INVALID; the corrected exact rerun is authoritative PASS. |
| **V3-H15** | **MEDIUM** | **HARNESS DEFECT / WINDOWS HTTP TRANSPORT** | Local Node/pipe transports hung and one inline JSON request was malformed. | **CLOSED BEFORE PRODUCT VERDICT.** Corrected ephemeral-file curl harness produced the valid HTTP 200 proof and left zero temporary files/processes. |

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



Severity: CRITICAL / HIGH / MEDIUM / LOW. Lifecycle for CRITICAL+HIGH:
failing-first test → classify → root cause → safe fix → exact rerun →
regressions → deploy → production re-attack → cleanup.

## Carried in from the LLM-judge baseline (this campaign actions them)

| id | sev | title | status |
|---|---|---|---|
| BF-1 | HIGH | `/v1/ingest` has no authoritative source/session timestamp field. `ts` is accepted by `normalizeMessageBatch` but is not on the wire contract and defaults to `Date.now()` (`src/pipeline/source.js:201,270`), so it records *ingested_at*, not *source_time*. Relative phrases ("yesterday", "last week") have no anchor. Leading explanation for temporal at 6.23%. | **CLOSED / HISTORICAL V1 FINDING.** Source-time persistence and deterministic temporal normalization shipped; final temporal token-F1 is 33.63%. |
| BF-2 | HIGH | `/v1/recall` allowlists `limit` (`src/lib/params.js:47`) but the handler never forwards it (`src/index.js:1631-1640`), and `runRecallCommand` never forwards it to `recall` (`src/pipeline/commands.js:527-531`). A documented parameter silently does nothing. | **CLOSED / HISTORICAL V1 FINDING.** Bounded candidate/final limits shipped; final depth 200 remained bounded to 200 items and 24,000 characters, and V3-D13 closed unbounded pre-fusion loading. |
| BF-3 | HIGH | Extraction coverage is the binding constraint: 64.6% of judge-misses are Stage A (never stored). ~1 memory per 7.5 turns; whole-conversation graphs average 78 nodes. | **ADDRESSED / NOT AN OPEN PRODUCT DEFECT.** Atomic capture plus episodes produced 94.61% source storage and 85.32% semantic candidate availability; residual misses are reported as quality weakness. |
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
