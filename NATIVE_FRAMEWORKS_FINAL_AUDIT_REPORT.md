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
| `itsuki-0.2.1.tgz` (JS SDK) | `61761c9a1864cc0c20fd5ae6bdbfdb3e26f3842aac4f357597297e18c7d38736` |
| `itsuki-0.3.0-py3-none-any.whl` | `137cdb3fbe09f4fa7836c267ad50a71899978788e1945a4cabad9ea8bd810706` |
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

