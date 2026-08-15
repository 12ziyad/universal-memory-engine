# Itsuki Six Native Framework Integrations — FINAL AUDIT REPORT

Audit and release campaign, 2026-08-15. Independent adversarial audit of the
six-framework implementation, repairs, merge, and CI — executed to the
publication boundary.

**The final claim this report supports:** zero known Critical, High or
release-blocking Medium findings after independent adversarial audit and
executed release evidence. Publication itself is **not executed**: it stops at
a genuine credential boundary (§10), with the exact owner actions listed.

---

## 1. Commits and branches

| Point | Commit |
|---|---|
| Audit began at (branch `native-frameworks-six`) | `0d33791` |
| Base (`master` before merge) | `ee2fcff` |
| Audit repairs | `37bd1a2`, `9c0ed0f`, `eebc575` |
| Merge to master (no force-push anywhere) | `fd5200d` |
| CI repairs on master | `a0f88d0`, `78b7ebe` |
| Final master | `78b7ebe` + this report |

The reported implementation HEAD (`0d33791`) was verified against origin before
anything else; master equalled `ee2fcff` on both local and origin, and the
working tree was clean. `origin/master` had not moved when the merge was
pushed.

## 2. Findings

Severity scale: CRITICAL / HIGH / RELEASE-BLOCKING MEDIUM / NONBLOCKING MEDIUM / LOW.
Every confirmed finding below was reproduced, given a regression test that
failed against the defective code, fixed, and re-verified. **Open count at
close: CRITICAL 0, HIGH 0, RELEASE-BLOCKING MEDIUM 0.**

### CHATDEV-01 — CRITICAL — the store implemented an interface that does not exist
The ChatDev store shipped `retrieve(query: str)` / `update(user_input,
agent_output)` over a plain config object, returning dicts. The real host
(cloned at `4fb2db0ea90375ce1059f44fe03ffbd191a7a169`) calls
`retrieve(agent_role, query: MemoryContentSnapshot, top_k,
similarity_threshold) -> List[MemoryItem]` and `update(payload:
MemoryWritePayload)`, constructing stores with `MemoryStoreConfig` through
`BaseConfig.from_dict`. The package would have thrown on first contact with a
real workflow — it had been written against a research summary, never validated
against host source. *Fix (`37bd1a2`):* config and store rewritten as real
`BaseConfig`/`MemoryBase` subclasses; a conftest loads ChatDev's genuine leaf
modules; **20 tests now run against real host types**, including the full
`MemoryManager` retrieve/update lifecycle and the real YAML config parser.
Additional hardening beyond parity: the `${ITSUKI_API_KEY}` reference is
expanded only at client construction and never written back, so a serialized
workflow cannot carry the secret (the built-in mem0 config stores whatever the
field held). *Residual:* a live-LLM multi-agent workflow run was not executed
(no LLM credential in this environment) — the package is **HELD** (§8).

### CAMEL-01 — HIGH — mirror path traversal via tenant identifier
`user_id="../../escape"` steered the local mirror file outside the state
directory (proven: `escapes_root=True`); the sanitizer only replaced `os.sep`,
so `/` survived on Windows and `\` on Linux. A hostile or merely unusual
username could write transcripts to arbitrary paths or clobber unrelated
files. *Fix (`37bd1a2`):* the mirror filename is a sanitized human-readable
prefix plus a SHA-256 of the full identity — traversal-proof by construction,
deterministic, and collision-free for identifiers that sanitize identically
(`a/b` vs `a_b` proven distinct). Three regression tests cover hostile
identifiers, collision resistance, and containment of the default path.

### MASTRA-01 — RELEASE-BLOCKING MEDIUM — tools ignored the host-supplied run resource
Mastra's `AgentToolExecutionContext` puts the run's `resourceId`/`threadId` on
the tool-execute options — host-supplied identity, never model input. The tools
ignored it, so a multi-tenant app relying on Mastra's own `resource` (without
custom request-context keys) had every model tool-save land in the configured
default space. Processors already resolved identity correctly; the two tiers
diverged. *Fix (`eebc575`):* one resolution ladder for both — request-context
override → host resource/thread → single-tenant default → readable refusal.
The regression test constructs execute options exactly as the host does and
failed against the old code (`u_test` instead of `u_resource`).

### TEST-01 — NONBLOCKING MEDIUM — pre-existing 1-in-8 flake in the repo suite
`test/mcp_rate_limit.spec.js` asserted the rate key does `not.toContain("proj_a"/"proj_b")`
while the key legitimately contains the server's bound project id `proj_<32 hex>`
— matching by dice one run in eight. It failed the audit's full-suite gate on
exactly those dice and was reproduced from the preserved log. *Fix (`9c0ed0f`):*
caller ids `proj_caller_alpha/beta`, impossible substrings of a hex id; the
strong equality assertion (rotation yields the identical bucket key) unchanged.
Stable across six consecutive runs.

### CI-01 — RELEASE-BLOCKING (gate) — Windows/Ubuntu line-ending asymmetry
All six first dry-run CI runs failed **only** on Windows legs, **only** on the
kernel-parity gate. `.gitattributes` forced `eol=lf` for `.js/.mjs` but not
`.ts/.py`: the Windows runner smudged kernel copies to CRLF while the sync
script (and its banner template) stayed LF — mixed expected vs uniformly-CRLF
actual, "stale" verdict against correct content. Index blobs were verified
already-LF (`git ls-files --eol`). *Fix (`a0f88d0`):* attributes extended to
`.ts/.py/.yml/.toml`, and the guard now compares and writes EOL-normalized
content — it exists to catch content drift, and checkout configuration is not
content.

### CI-02 — LOW (gate) — bulk-delete gate matched a definition, not a call
The Mastra tarball gate grepped the bare word `deleteBySource`; GNU tar
wildcards match slashes, so it hit the vendored kernel transport's method
*definition*. mastra-itsuki has no call site and registers no bulk-delete tool
(proven by its own tests). *Fix (`78b7ebe`):* the gate matches invocation
syntax (`\.deleteBySource\(`), the same form the ai-sdk workflow already used.

### WF-01 — LOW — over-broad workflow permissions
`publish-pypi.yml` granted `id-token: write` workflow-wide. *Fix (`37bd1a2`):*
only the publish job mints an OIDC token; the test matrix runs with read-only
contents.

### SDK-01 — NONBLOCKING MEDIUM (post-report addendum) — waitFor deadline race
Found by the new JS SDK release workflow's Ubuntu leg: waitFor's final poll is
dispatched with exactly the remaining polling budget, and the catch decided
"deadline reached?" by re-reading the wall clock — racing the request's own
abort timer. When the timer fired a hair early, waitFor THREW a timeout instead
of returning the documented timed_out snapshot ("a timeout is not a failure,
never an exception"). Both SDKs shared the flaw; both now decide at dispatch
whether a poll is budget-bounded, making the outcome deterministic. Fixed in
sdk/js/index.js and the shared Python plan; JS contract spec stable across four
consecutive runs, Python 147 + strict mypy green. SDK artifact hashes in §6
reflect the fixed bytes.

### SDK-02 — NONBLOCKING MEDIUM (post-report addendum) — one extra poll at the budget cap
Found by the real npm publish run's Ubuntu leg, in the same family as SDK-01:
after sleeping the FULL remaining polling budget, waitFor re-read the clock,
and a timer waking at 19ms of a 20ms budget squeezed one extra sub-millisecond
poll in before the deadline check. The JS test suite pinned "no late poll"; the
Python suite, via a frozen-clock sleep, accidentally pinned the opposite. Both
SDKs now break deterministically when the sleep is budget-capped — the budget
is spent by construction — and both suites pin the same contract. JS spec
stable across six consecutive runs; Python 147 + strict mypy green.

### Attacked and verified sound (no defect)
- **ai-sdk middleware state under composition:** `wrapLanguageModel` passes each
  layer's own transformed params object to that layer's wrap hooks by identity
  (verified in host source and pinned by a new cloning-middleware test with a
  per-call tenancy override).
- **Detached background captures cannot reject unhandled** (new test registers
  a process-level handler and proves zero rejections under a failing write).
- **Mastra `messageList` accessor:** real shape probed (`get.all` object with
  `.db()`); wrong-shape fallback fails closed to "capture nothing".
- **Secret hygiene:** no credential-shaped strings in any shipped source,
  tarball or wheel; Agno error surfaces redacted (D-3 from the implementation
  phase); LlamaIndex `model_dump` and ChatDev config serialization exclude the
  key; kernel transport refuses redirects and scrubs errors.
- **SHA-256 kernel** pinned against NIST vectors and node:crypto over a
  randomized corpus including block boundaries and multi-byte input.
- **Tenancy:** 1,000-identity isolation test (distinct keys, no crossing); no
  model-reachable tenancy parameter in any tool schema in any package.

## 3. Per-package verdicts

| Package | Verdict | Real-host evidence |
|---|---|---|
| `itsuki` Python SDK 0.3.0 | **RELEASE-READY** | 147 tests; sync/async parity on the wire; strict mypy |
| `itsuki` JS SDK 0.2.1 | **RELEASE-READY** (housekeeping release) | repo `sdk_js` contract tests; packed clean |
| `ai-sdk-itsuki` 0.1.0 | **RELEASE-READY** | 135 tests on real `ai@7.0.66` (generate/stream/tools/abort); CI green both OSes |
| `mastra-itsuki` 0.1.0 | **RELEASE-READY** | 42 tests incl. real `@mastra/core@1.59.0` Agent; CI green both OSes after CI-02 |
| `agno-itsuki` 0.1.0 | **RELEASE-READY** | 25 tests on real `agno 2.9.0` Toolkit; CI green |
| `llama-index-memory-itsuki` 0.1.0 | **RELEASE-READY** | 18 tests incl. real `Memory` block lifecycle on `llama-index-core 0.14.23`; CI green |
| `camel-itsuki` 0.1.0 | **RELEASE-READY** | 24 tests incl. real `ChatHistoryMemory` flow on `camel-ai 0.2.90`; CI green |
| `chatdev-itsuki` 0.1.0 | **HELD** | 20 tests against real ChatDev host types (`4fb2db0`), full manager lifecycle — but no live-LLM workflow run; labelled operator-wired everywhere |

## 4. Test commands and counts (final, all re-run at the audited tree)

| Suite | Count | Command |
|---|---|---|
| Full repo (Workers pool) | **1761 passed / 1761** (140 files) | `npx vitest run --no-file-parallelism` |
| Repo Node config | **572 passed, 1 skipped** (34 files) | `npx vitest run --config vitest.unit.config.mjs` |
| Python SDK | **147** | `cd sdk/python && python -m pytest -q` (+ `mypy --strict`) |
| ai-sdk-itsuki | **135** | `cd packages/ai-sdk-itsuki && npm test` |
| mastra-itsuki | **42** | `cd packages/mastra-itsuki && npm test` |
| agno-itsuki | **25** | `PYTHONPATH=sdk/python pytest packages/agno-itsuki/tests -q` |
| llama-index-memory-itsuki | **18** | same pattern |
| camel-itsuki | **24** | same pattern |
| chatdev-itsuki (real host) | **20 + 1 skip** | `CHATDEV_SRC=<checkout> pytest packages/chatdev-itsuki/tests -q` |
| openclaw / pi / n8n (unregressed) | **151 / 150 / 40** | package `npm test` |
| `git diff --check`, kernel parity | clean / in sync | — |

One full-suite failure observed during the audit was the TEST-01 dice (§2),
fixed; the definitive gate run is the 1761/1761 above.

## 5. CI runs (Windows + Linux, dispatched from the default branch)

Round 1 at `fd5200d` — all six failed on CI-01 (Windows kernel-parity only;
every other gate green on Ubuntu): runs `31882591182` (AI SDK), `31882593193`
(Mastra), `31882594933`/`31882596950`/`31882598731`/`31882600645` (PyPI ×4).

Round 2 at `a0f88d0`:

| Run | Workflow | Conclusion |
|---|---|---|
| `31882823691` | Publish AI SDK provider (ubuntu+windows) | **success** |
| `31882826399` | Publish Python adapter — agno-itsuki (2 OS × 3.10/3.12/3.13) | **success** |
| `31882828212` | Publish Python adapter — llama-index-memory-itsuki | **success** |
| `31882829736` | Publish Python adapter — camel-itsuki | **success** |
| `31882831441` | Publish Python adapter — chatdev-itsuki | **success** |
| `31882824981` | Publish Mastra integration | failure → CI-02 |
| `31882925818` | Publish Mastra integration | cancelled (dispatched before CI-02 landed) |

Round 3 at `78b7ebe`: run `31882949834` — Publish Mastra integration —
**success**. Final state: **all six workflows green on ubuntu-latest and
windows-latest** at the release tree.

All runs were `dry_run=true`: every gate executed (tests, typecheck, build,
zero-dependency and tarball/wheel inspections, audits), only the publish step
gated off. No publication occurred.

## 6. Artifacts (built at the audited tree, SHA-256)

| Artifact | SHA-256 |
|---|---|
| `ai-sdk-itsuki-0.1.0.tgz` | `d56f6d7f840f5ba890058a114063fcb9d424fbe54497f3f2b6126eb42a7153dd` |
| `mastra-itsuki-0.1.0.tgz` | `2d6807fa6ede3c7ff9ef2de0a7b979c763331c7db0163b675be3c344fbe16736` |
| `itsuki-0.2.1.tgz` (JS SDK) | `85e7ea1bb0232e2f4f44e66ec0b87fc745f0559ec693f3850b43b0a2b45dc108` |
| `itsuki-0.3.0-py3-none-any.whl` | `9cc5a02c4b9d05fa2073def6a2e279c1e158f7085941d7ac7264299b2bc83c7d` |
| `agno_itsuki-0.1.0-py3-none-any.whl` | `1f3a66342294771b3d4d97b5352e57ec75637b96cd27a141ba0781aa6d051ce9` |
| `llama_index_memory_itsuki-0.1.0-py3-none-any.whl` | `f4f5a16738dd9bd130c7a2522465fb340477211cdd7d2306a6b6852b62f88b3e` |
| `camel_itsuki-0.1.0-py3-none-any.whl` | `a95dde97e8798fbadfdce7ef1fbc9ebf794af0f427a266afc4398d53c2455edb` |
| `chatdev_itsuki-0.1.0-py3-none-any.whl` | `1b021a032db08128d3078ec2c1d255c0867bcdcdffc740475bcbdf17c6b0c77a` |

Clean-install verification: all wheels + the SDK wheel install and construct in
a fresh venv; both tarballs + `ai@7` install and resolve in a fresh npm
project. Supply-chain sweeps found no credential-shaped strings, no
postinstall hooks, no Node built-ins in the edge-targeted code, no bundled
providers, LICENSE present, kernel vendored. CycloneDX SBOMs generate cleanly
via `npm sbom` (npm 11). `pip-audit` over the installed clean environment
reported no known vulnerabilities in the dependency tree (our own unpublished
packages are unauditable by definition until they exist on PyPI). CI runs the
`npm audit --omit=dev --audit-level=high` gate on every leg.

## 7. What did NOT happen (and must not be claimed)

- **No package or SDK was published.** npm and PyPI are untouched.
- **No production canary ran.** No production API key exists in this
  environment and minting one requires the owner's dashboard login. Nothing
  synthetic was written to production; there is nothing to clean.
- **No site or Worker change was deployed.** `public/` is untouched: showing an
  install command for an unpublished package is exactly what the repo's "no
  dead commands" tests forbid.
- **No ChatDev upstream PR was opened.** The upstream-ready patch is
  `packages/chatdev-itsuki/UPSTREAM_PATCH.md`, verified against ChatDev
  `4fb2db0`.
- **No credentials were read, printed, moved or created.**

## 8. ChatDev — exact truthful status

`chatdev-itsuki` implements ChatDev 2.0's real memory contract and passes 20
tests against the genuine host modules, including the full
`MemoryManager.retrieve`/`update` cycle driven by ChatDev's own manager code
and the real YAML config parser. What has not been executed is a multi-agent
workflow driven by a live LLM (requires an OpenAI-class credential and the full
runtime). Under the campaign's own stop-gate that keeps the package **held
from publication and marketing**; it is labelled "operator-wired" in every
sentence that describes it, and "built-in/native" is reserved for upstream
acceptance. The five other integrations do not share this gate.

## 9. Remaining nonblocking risks

- Host velocity: `ai` v7 and `@mastra/core` 1.x move quickly; the derived-type
  pattern turns spec renames into typecheck failures rather than silent drift,
  and CI pins current versions. LOW.
- CAMEL local mirror is plaintext on disk (bounded, atomic, 0600 on POSIX via
  tempfile; explicit `mirror_path` available). An encrypted-at-rest option is a
  reasonable future hardening. LOW.
- `pypi` GitHub environment was auto-created unprotected by the dry runs; the
  owner may wish to add protection rules before first real publish. LOW.
- Windows local dev smudges `.ts/.py` worktrees to CRLF under
  `core.autocrlf=true`; blobs and CI are LF-forced now, and the parity guard is
  EOL-insensitive, so this is cosmetic. LOW.

## 10. The publication boundary — exact owner actions

Everything up to the publish button is done and green. The campaign stops here
because each remaining step requires your accounts:

1. **PyPI (do this first — Python packages depend on the SDK):** on pypi.org,
   add a **pending Trusted Publisher** for each project name
   (`itsuki` → *manage project*, plus new pending publishers for
   `agno-itsuki`, `llama-index-memory-itsuki`, `camel-itsuki`) with:
   owner `12ziyad`, repository `universal-memory-engine`, workflow
   `publish-pypi.yml`, environment `pypi`. Then dispatch **Publish Python
   adapter** with `dry_run=false` — the SDK first is not needed as a separate
   workflow: publish order inside PyPI is `itsuki` 0.3.0 (needs its own
   pending publisher and a small workflow input addition, or a one-time
   `twine upload sdk/python/dist/*` from your logged-in machine), then the
   three adapters. No token ever needs to exist for PyPI.
2. **npm:** create a granular automation token scoped to publish, add it as the
   `NPM_TOKEN` repository secret, then dispatch **Publish AI SDK provider**
   and **Publish Mastra integration** with `dry_run=false`, and publish
   `itsuki@0.2.1` from `sdk/js` (`npm publish` in that directory from a
   logged-in session, or a workflow clone). After the first publishes:
   configure Trusted Publishers for all three npm packages on npmjs.com,
   **delete the `NPM_TOKEN` secret, and revoke the token**.
3. **Canaries:** mint one production API key per canary run at itsuki.app →
   API Keys and provide it to a canary session; the report's canary protocol
   (save → wait → recall → list/get → delete → zero-residue) is ready to
   execute against the published bytes.
4. **Site:** only after canaries pass — the six door entries plus the two
   contract specs in one commit, then `wrangler deploy`.
5. **ChatDev PR:** say the word and the prepared patch goes upstream.

## 11. GO/NO-GO

**GO** — for publication of the seven release-ready artifacts (two SDKs, five
packages) the moment the credentials in §10 exist, in the order given there.
**NO-GO** — for `chatdev-itsuki` publication and for any claim of a ChatDev
"built-in" integration, until a live-LLM workflow proof exists and upstream
acceptance lands respectively.

Zero known Critical, High or release-blocking Medium findings after independent
adversarial audit and executed release evidence.

---

## 12. Release execution addendum (2026-08-15, same day)

The owner configured `NPM_TOKEN` and approved the release. Executed state:

### Published — npm (all with SLSA provenance v1, verified signatures + attestations)

| Package | Version | Evidence |
|---|---|---|
| `itsuki` | **0.2.1** | run `31884450413` (ubuntu leg published); registry tarball SHA-256 `85e7ea1bb0232e2f4f44e66ec0b87fc745f0559ec693f3850b43b0a2b45dc108` — **byte-identical to the local audited build**; `npm audit signatures`: verified signature + attestation |
| `ai-sdk-itsuki` | **0.1.0** | run `31884609539`; registry tarball `2654ae0ab413…`; all 37 packed `.ts` sources content-identical to the audited tree (modulo EOL); provenance verified |
| `mastra-itsuki` | **0.1.0** | run `31884611088`; registry tarball `5a81ee864506…`; same content verification; provenance verified |

`NPM_TOKEN` was **deleted from the repository** after the three publications
(`gh secret list` is empty). **Owner: revoke the token on npmjs.com** (Access
Tokens), and optionally configure npm Trusted Publishers for the three
packages (workflows `publish-js-sdk.yml`, `publish-ai-sdk-provider.yml`,
`publish-mastra-integration.yml`; user `12ziyad`, repository
`universal-memory-engine`, no environment) so future releases are tokenless.

### Production canaries — npm artifacts, registry bytes, dedicated synthetic spaces

19 checks, all passed:

- **js-sdk lane (6):** save → `enriched` → recall finds it → invalid-key 401
  taxonomy probe → dry-run preview → zero residue.
- **ai-sdk lane (7):** REAL `generateText` through the published middleware
  (model mocked, memory production) → packet staged → `enriched` → recall
  finds it → **cross-tenant negative** → dry-run preview with true counts →
  converged cleanup, recall silent.
- **mastra lane (6):** REAL `@mastra/core` Agent with both processors →
  packet staged → `enriched` → recall → dry-run preview → converged cleanup,
  recall silent.

Rate-limit/circuit-breaker behaviour was NOT force-tested against production
(hammering the live service to provoke 429s is not a canary); it is covered by
the unit/contract gates. Canary identities were synthetic
(`canary_<lane>_<epoch>`), spaces dedicated, all verified erased and silent.

### New findings from the canaries — server-side (production), packages not at fault

- **SRV-01 — HIGH (server): source-scoped bulk deletion misses
  conversation-capture rows and reports zero.** `DELETE /v1/memories?source=X`
  deleted nothing and counted nothing for memories created through
  conversation-mode capture, while an unscoped dry-run on the same space
  showed `{runs:1, nodes:2, slices:2}` and recall still returned the content.
  Direct single-fact saves filter correctly — the conversation lane appears
  not to stamp the caller's `source` onto the resulting rows. Until fixed
  server-side, per-source cleanup of conversation captures silently no-ops;
  the packages' rollback docs reference `deleteBySource(source=…)` and need
  this caveat.
- **SRV-02 — HIGH (server): deletion is not durable against in-flight
  pipeline passes.** An unscoped full-space erase reported zero residue; ~60s
  later the same dry-run showed **5 objects** and recall hit again —
  post-enrichment passes re-materialized the memory from in-flight state.
  `enriched` is not quiescence. Once the pipeline was quiescent, one erase
  pass converged and stayed converged. Enterprise erasure semantics require
  deletion to tombstone in-flight work; recorded with exact repro, not
  patched here — platform deletion surgery deserves its own campaign, not a
  same-day hotfix.

Both reproduce via raw REST with no package involved. The canaries now use a
converge-erase protocol (erase → settle → verify rows AND recall → repeat),
and every canary space was proven empty and silent.

### CI findings during release

- **CI-03 — cosmetic:** the JS SDK version gate ran on both matrix legs; the
  ubuntu leg published while the slower Windows leg was mid-run, and the
  sibling's fresh publish tripped the Windows leg's own overwrite-refusal
  check, marking the successful release run "failed". The registry-existence
  check now runs only on the publishing leg (`df68116`).

### PyPI — blocked at the owner boundary, with definitive evidence

Run `31884452183` (`itsuki` 0.3.0, `dry_run=false`): all 6 test legs and every
gate passed; the publish step failed with **`invalid-publisher: valid token,
but no corresponding publisher`** — no Trusted Publisher is configured on
PyPI. Nothing was published to PyPI. The four Python artifacts (SDK 0.3.0 +
three adapters) remain built, audited, dry-run-green, and ready.

**Exact PyPI configuration (owner, on pypi.org):**

- Existing project `itsuki`: *Manage project → Publishing → Add a new
  publisher (GitHub)*.
- New names, three *pending publishers* under *Your account → Publishing*:
  `agno-itsuki`, `llama-index-memory-itsuki`, `camel-itsuki`.
- Identical values for all four: Owner `12ziyad` · Repository
  `universal-memory-engine` · Workflow `publish-pypi.yml` · Environment
  `pypi`. Do **not** add `chatdev-itsuki` — HELD, and the workflow refuses a
  real publish for it by name.

After configuration: dispatch `publish-pypi.yml` with `dry_run=false` for
`itsuki`, then the three adapters; verify; run the prepared Python canary
lanes; then the single site/docs update, full serial repository gates, and
`wrangler deploy`.

### Site and docs — deliberately not yet updated

The Get Started doors and Connect-a-tool nav present the integrations as a
set; updating them for the npm half alone would ship dead `pip install`
commands or a half-told story, and the repo's contract tests enforce exactly
this. One coherent site update follows the PyPI publications and Python
canaries.

### Updated GO/NO-GO

- npm half: **SHIPPED and canary-proven** (`itsuki@0.2.1`,
  `ai-sdk-itsuki@0.1.0`, `mastra-itsuki@0.1.0`).
- PyPI half: **GO — waiting only on the four Trusted Publisher entries above.**
- `chatdev-itsuki`: **HELD**, mechanically refused by the publish workflow.
- Server findings SRV-01/SRV-02: **open, HIGH, production scope** — deletion
  semantics must be fixed server-side before any marketing claim about
  source-scoped cleanup or instant erasure; nothing in the published packages
  is affected in normal operation.

---

## 13. Server deletion repair campaign (2026-08-15, same day, second session)

The two release-blocking HIGH findings from §12 are **fixed, deployed, and
production-verified**. Master `5d224c3`; deployed Worker version
`0228394f-7d6c-473c-acea-2d072f94455b` on itsuki.app.

### SRV-01 — source-scoped deletion was blind to the caller's label (fixed, `6f02a55`)

Root cause: the write doors (`/v1/save` both modes, `/v1/ingest`) accepted the
published SDKs' `source` body field and dropped it. Runs were stamped only
with engine lanes (`mcp_save`, `conversation_collect`), so
`DELETE /v1/memories?source=ai-sdk` matched nothing and reported zero while
the content stayed live and recallable.

Fix: a canonical `client_source` — validated at every door (1–64 chars, no
control characters; unmatchable labels are a 400 at save, ingest, the REST
DELETE filter, and MCP `delete_all_memories` alike), stamped into the source
packet's `raw_meta_json`, propagated by `sourceMeta()` onto every derived
`scope_json` (jobs, receipts, runs), and matched by a third arm of the scoped
deletion filter (`json_extract(scope_json,'$.client_source')`). Deliberately
excluded from content hashing so every already-issued idempotency key stays
valid; conditional at every stamp site so pre-fix rows keep byte-identical
scope_json. **No schema migration.**

### SRV-02 — deletion was not durable against in-flight extraction (fixed, `5d224c3`)

Reproduced in production before fixing (forensic variant D: conversation
save, unscoped erase ~1.3s later, against pre-fix build `ac93622f`): the
pre-flight barrier check predates the erase and the commit fence guards only
content batches, so the **no-write finalization** stomped the erasure's
`cancelled_by_delete` back to `skipped`, settled the job **`enriched`** with
`cancelled_by_delete:false`, and left a post-barrier run row that read as
residue in every later preview. On the no-write outcome the DO also restored
the raw messages into its **rescue buffer**, where a later flush re-extracts
erased content under a fresh acceptance time — past every fence. That is the
§12 "5 objects came back ~60s later" mechanism.

Fix:

- `extract.js`: the no-write and `llm_failed` finalizations re-check the
  deletion barrier **after** the model call and are `expectStatus`-guarded so
  they can never overwrite a concurrent erasure's cancellation. A superseded
  save finalizes `cancelled_by_delete`, its receipt is non-durable, and its
  messages are never rescued.
- `cleanup.js`: a **confirmed erasure resets the memory coordinator**
  (`resetAll()`, serializing behind any in-flight drain — quiescence, not
  hope) and terminally closes the `queued`/`staged` jobs whose queue entries
  that wipe orphans. Consequence: an erase may take as long as the in-flight
  drain it waits for.
- Digest lane (`manual_collect.js`/`pages.js`): barrier re-check after its
  model call; its `memory_pages` commits carry the deletion fence inside
  their own D1 batch, like every other durable writer.

### Evidence

- **Local**: `test/srv_source_scoped_deletion.spec.js` — 11 adversarial
  tests, including a deterministic mid-model-call erasure via the
  function-form `llmResponse` hook (arms the barrier inside the model call).
  Full serial Workers suite **1772 passed**, Node lane **572 passed**,
  adjacent deletion/fence/MCP suites all green.
- **Production reattack (post-deploy, registry-independent, 14/14 passed)**:
  build fingerprint (new 400s live); SRV-01 — scoped preview now **sees**
  conversation-capture rows (`{runs:1,nodes:3,slices:1,edges:1}`), scoped
  delete removes them all, unscoped preview zero, recall silent, idempotent
  repeat clean; SRV-02 — the exact variant-D interleaving now stays at zero
  residue with silent recall for the full 4-minute watch, and the job ledger
  reads `failed` with `cancelled_by_delete:true` and the cancellation named.
- Pre-fix forensic runs (variants A/B/C clean, D resurrected) and post-fix
  reattack logs are preserved in the session scratchpad.

### PyPI — still blocked at the owner boundary (re-proven on the fixed tree)

Run `31889766483` (dry-run): all 6 test legs green on current master. Run
`31889880458` (`itsuki` 0.3.0, `dry_run=false`): all 6 test legs green, the
publish step failed with **`invalid-publisher`** — the Trusted Publisher is
still not configured. Nothing was published. The OIDC claims PyPI must match
(from that run's own log): repository `12ziyad/universal-memory-engine`,
workflow `publish-pypi.yml`, environment `pypi`, ref `refs/heads/master`.
The §12 owner instructions stand unchanged: one publisher on the existing
`itsuki` project + three pending publishers (`agno-itsuki`,
`llama-index-memory-itsuki`, `camel-itsuki`). `chatdev-itsuki` stays HELD and
the workflow mechanically refuses it.

### Site and docs

Still deliberately untouched: the four Python artifacts are unpublished, and
the Get Started contract tests enforce that no advertised install command can
be dead. One coherent site update follows the PyPI publications and canaries.

### Updated GO/NO-GO

- Server deletion semantics (SRV-01/SRV-02): **FIXED — production-verified.**
  Source-scoped cleanup is exact for every lane the published packages use,
  and a confirmed erasure is durable against in-flight processing.
- npm half: **SHIPPED** (§12), unchanged.
- PyPI half: **GO — waiting only on the four Trusted Publisher entries.**
  After configuring them: dispatch `publish-pypi.yml` `dry_run=false` for
  `itsuki`, then the three adapters; verify; run `scratchpad/canary_py.py`;
  then the single site update, full serial gates, `wrangler deploy`.
- `chatdev-itsuki`: **HELD.**
- Owner actions outstanding: (1) four PyPI Trusted Publisher entries;
  (2) revoke the old npm token on npmjs.com (the GitHub secret is already
  deleted).

---

## 14. PyPI release, canaries, and the final GO/NO-GO (2026-08-15)

The owner configured four Trusted Publishers, each with its own environment.
Everything below was executed after that.

### Per-package publishing environments, and an identity assertion

`publish-pypi.yml` now carries the package -> environment mapping itself,
hardcoded and exhaustive, in its own `plan` job (a job-level `environment:`
may read `needs` but not `steps`):

| Package | GitHub environment | PyPI project |
|---|---|---|
| `itsuki` | `pypi` | itsuki |
| `agno-itsuki` | `pypi-agno-itsuki` | agno-itsuki |
| `llama-index-memory-itsuki` | `pypi-llama-index-memory-itsuki` | llama-index-memory-itsuki |
| `camel-itsuki` | `pypi-camel-itsuki` | camel-itsuki |
| `chatdev-itsuki` | mapped, **HELD** | not published |

This is worth the extra job: the OIDC `sub` claim carries the environment
name, so a publisher configured for one package cannot upload another. The
publish job asserts its own minted identity against the intended publisher
**before** uploading — repository, environment, `sub` and `workflow_ref` must
match or the run fails with a readable diff instead of a bare PyPI
`invalid-publisher`. The token is never printed or exported; only the four
public claims PyPI matches on are logged.

All four environments (including the pre-existing `pypi`) are restricted to
deployments from `master`. Required reviewers were deliberately NOT added:
they would have blocked the authorised autonomous run. Branch restriction
gives the protection without the stall.

Dry runs for all four packages passed every gate, and each printed its own
distinct identity — evidence, not assumption:

```
sub=repo:12ziyad/universal-memory-engine:environment:pypi                            (itsuki)
sub=repo:12ziyad/universal-memory-engine:environment:pypi-agno-itsuki                (agno)
sub=repo:12ziyad/universal-memory-engine:environment:pypi-llama-index-memory-itsuki  (llama)
sub=repo:12ziyad/universal-memory-engine:environment:pypi-camel-itsuki               (camel)
```

### Published

| Package | Version | Wheel sha256 |
|---|---|---|
| `itsuki` | **0.3.0** | `8e3fadb42a1b19803dcc6f783f24d773753d7e1675114aa486912cd3b568a361` |
| `agno-itsuki` | **0.1.1** | `c3e9487d7d1d4071d1d41d98152ab3b17c785c1bc8db365768b2c6e5459c4800` |
| `llama-index-memory-itsuki` | **0.1.1** | `6dc76f874be1b500deaf9fe59f3389d3fd042f927ca7b8a729a5d991d68658e8` |
| `camel-itsuki` | **0.1.1** | `f4b633b42df3c01846db21da719f020ce94874607d641726ebd748854edfcf12` |

`chatdev-itsuki` returns **404** on PyPI — still held, and the workflow
refuses a real publish for it by name.

**32/32 artifact checks passed**: version is latest, wheel and sdist both
present, a PEP 740 attestation bundle exists whose publisher is this
repository's workflow and the package's own environment, the registry bytes
re-hash to the advertised sha256, and each installs into a clean venv from
the registry alone, imports, and self-reports its version.

One honest note on method: the first install pass FAILED for the three
0.1.1 adapters with `No matching distribution found` while the JSON API
already advertised 0.1.1. That was PyPI's simple index trailing its JSON API
by about a minute. It was confirmed by watching the index catch up, not
assumed — and only then re-run to 32/32.

### PY-ADAPTER-01 — found by canary, fixed, republished (HIGH)

The agno toolkit returned `{"ok": false, "error": "timeout"}` after 8.13s
while the server went on to **store the memory** — job `enriched`, content
recallable. A false negative, not a slow call: an agent retries it, or tells
someone their fact was not remembered.

The cause was structural. A blocking save waits for its receipt and the
service's own budget for that is 9s (`SAVE_WAIT_BUDGET_MS`), while all four
Python adapters defaulted to an **8s** client ceiling — the client abandons a
request the server is still honestly working on. Measured direct saves
against production: 2.6s, 6.5s, 6.2s, 7.2s. The old ceiling sat inside the
normal range.

Fixed in the shared Python kernel, which now names both numbers, with every
adapter deriving its default from it: **30s**, matching the Python SDK. Each
package gained a test asserting the default clears twice the service budget
and that the constructor a caller actually reaches uses it. Verified in the
published bytes by importing the installed distributions and reading the real
defaults: agno 30.0, camel 30.0, llama-index client 30.0.

Not affected: both SDKs (30s). The TS adapters clear the budget at 10s but
only by 1s — recorded as a follow-up, not silently republished, because the
npm packages were explicitly out of scope for republication.

### Production canaries — published bytes, 31 checks, all passed

Run from a venv built only from PyPI, against the live service, with every
synthetic identity printed so no id is ever guessed.

- **sdk (17)** — lifecycle (save, terminal receipt, recall, list, get);
  idempotent replay returns the original packet; cross-tenant negative;
  invalid key -> 401; empty content refused *before any request is issued*;
  **SRV-01** scoped preview sees the labelled rows, scoped delete converges
  to zero, deleted source unrecallable, sibling source survives;
  **SRV-02** mid-flight erase never undone across a 3-minute watch; cleanup
  converges with recall silent.
- **agno (6)** — real toolkit save/recall, cross-tenant negative, dry-run
  preview, converged cleanup.
- **llama (5)** — real LlamaIndex memory block capture and recall (511
  chars, needle present), preview, converged cleanup.
- **camel (7)** — lossless local round-trip, mirror staged a packet, server
  recall, preview, converged cleanup, local clear.
- **limits (2)** — a modest read burst is answered or cleanly rate-limited;
  no 429 within the documented allowance. Production was deliberately not
  hammered to force one.

Two canary defects were found and fixed in the harness, and neither was a
product defect — both are recorded because the first draft of each looked
like one:

1. **The empty-content assertion was wrong.** The Python SDK exposes ONE
   error type and marks client-side refusals with `status=0`. Proven against
   an unroutable `base_url`: an argument error, not a connection error, so no
   request is issued. (Cross-SDK asymmetry: the JS client throws a distinct
   type. Not a defect in either; worth knowing.)
2. **The llama lane drove two `asyncio.run()` calls.** That tears down the
   loop the block's async HTTP client is bound to. In one loop — as a real
   host runs an agent — recall returns 511 chars and emits `recall.ok`.

A third scare was **my own error and no defect at all**: a space appeared to
have lost its memories, but the user id had been invented rather than read
from the probe's output, so the query targeted a space that never existed. A
dedicated persistence probe (save, then re-check at +0s, +30s, +90s) showed
memories intact throughout. The canaries now print every synthetic identity.

Observation, not a defect: `ItsukiMemoryBlock._aget` deliberately swallows
every recall exception and returns empty context, so a misconfiguration
degrades silently unless the event hook is attached. That is a documented
design choice (a memory outage should cost context, not the answer), and the
hook does report `recall.fail`.

### Get Started and the docs — updated only after the proof

The Integrations door now offers a native route beside the MCP one for Agno,
LlamaIndex, CAMEL, Mastra and the Vercel AI SDK; the docs gained a **Native
packages** page. Every snippet is taken from the package's own README and
tested API, not invented.

`camel-itsuki`'s prohibition in the Get Started contract was removed because
it graduated — published and canary-proven, so its install command is real.
`chatdev-itsuki` keeps its prohibition in BOTH contracts, and the docs
contract now additionally pins every advertised install command to a package
that actually shipped. The "no dead commands" rule therefore still blocks the
one package that would print a command that cannot work.

### Deployment

Worker version **`2426bec8-1d99-4ed9-8dfa-a568b1f96609`** (itsuki.app),
deployed from master `c061d73` after the complete serial gates: 1773 Workers
tests, 572 Node tests, kernel parity in sync.

Live verification against the deployed build: the docs **Native packages**
page renders all five packages with their real install commands, and the Get
Started Integrations door carries `agno-native`, `llamaindex-native`,
`camel-native`, `mastra-native` and `vercel-ai-native`. `chatdev` appears
nowhere in the shipped page source.

The SRV reattack was then re-run against this deployed version: **14/14
passed** — the build fingerprint (invalid source labels refused at both write
doors and the delete filter), SRV-01 scoped deletion exact end to end, and
SRV-02's variant-D interleaving clean across a 4-minute watch with the job
ledger reading `failed` / `cancelled_by_delete: true`. Deletion behaviour is
therefore verified on the exact bytes now serving traffic, not only on the
build that preceded the site update.

### FINAL GO/NO-GO

**GO**, with the exceptions named below.

- **Server deletion semantics (SRV-01, SRV-02): FIXED, production-verified.**
  Source-scoped cleanup is exact for every lane the published packages use,
  and a confirmed erasure is durable against in-flight processing. Evidence
  in section 13 plus the sdk canary lane above.
- **npm half: SHIPPED** (`itsuki@0.2.1`, `ai-sdk-itsuki@0.1.0`,
  `mastra-itsuki@0.1.0`) — untouched this session, as instructed.
- **PyPI half: SHIPPED** — four artifacts, each attested to its own
  publisher, verified from registry bytes, canary-proven against production.
- **`chatdev-itsuki`: HELD** — unpublished (404), mechanically refused by the
  workflow, absent from every published surface.
- **Not claimed:** native parity with any competitor, and enterprise
  readiness as a whole. Neither was measured here.
- **Follow-ups (not blockers):** the TS adapters' 10s default clears the 9s
  service budget by only 1s and deserves the same treatment as
  PY-ADAPTER-01 at the next npm release; rate limiting was observed, never
  force-tested against production.

**Owner actions outstanding:** revoke the old npm token on npmjs.com (the
GitHub secret was already deleted); optionally configure npm Trusted
Publishers so future npm releases are tokenless too.
