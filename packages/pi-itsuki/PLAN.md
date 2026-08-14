# pi-itsuki — implementation record and gate table

Built from Fable's frozen architecture handoff (`proceed-with-the-architecture-eager-anchor.md`, section F1).
Baseline commit: **4fe04f87c86ec4d02e8dcea9991709429e258bf5** (clean tree).
Implementation date: 2026-08-14. Host validated against: `@earendil-works/pi-coding-agent@0.84.2`.

## File ownership

This campaign owns **`packages/pi-itsuki/**`** plus three files the handoff explicitly assigned to the Pi build:
`.github/workflows/publish-pi-extension.yml`, `test/fixtures/agent_lifecycle_corpus.json`, `test/agent_lifecycle_corpus.spec.js`.

Untouched, as required: `packages/n8n-nodes-itsuki/**`, `hooks/**`, `plugins/**`, `src/**`, `sdk/**`, `migrations/**`, `wrangler*.jsonc`, `public/**` (dashboard/docs), root manifests. The existing generic Pi REST door is unchanged and still the documented fallback.

## Contract revalidation (step 3 of the build order)

Every [DOC] fact the handoff relied on was re-fetched from official sources on 2026-08-14 and, where possible, proven empirically rather than read.

| Contract | Source | Result |
|---|---|---|
| Package + runtime | registry.npmjs.org/@earendil-works/pi-coding-agent | 0.84.2, `engines.node >= 22.19.0`, MIT. Adopted as our floor. |
| Extension format | `docs/extensions.md` | Default-export factory `(pi: ExtensionAPI) => void`; package manifest key `pi.extensions`. Confirmed. |
| `before_agent_start` return shape | `docs/extensions.md` | `{ message: { customType, content, display }, systemPrompt? }`. **Proven by typecheck** against the real types and by a real run. |
| `agent_settled` semantics | `docs/extensions.md` | "`agent_end` fires… but pi may still auto-retry, auto-compact and retry, or continue with queued follow-up messages. Use `agent_settled`…" Confirmed — this is why capture keys off it. |
| `session_before_compact` | `docs/extensions.md` | `{ preparation, branchEntries, customInstructions, reason, willRetry, signal }`, `reason: manual\|threshold\|overflow`. Confirmed. |
| `session_start` / resume / fork | `docs/extensions.md` | Reasons `startup\|reload\|new\|resume\|fork`. Critically: on switch/fork pi emits `session_shutdown`, **reloads and rebinds extensions**, then `session_start`. In-memory state cannot survive; this is why the watermark lives in the session tree. |
| `appendEntry` persistence | `docs/extensions.md` + `docs/session-format.md` | Custom entries `{type:"custom", id, parentId, timestamp, customType, data}`, do NOT enter LLM context, readable via `sessionManager.getEntries()`. Confirmed. |
| Tool + command registration | `docs/extensions.md` | `registerTool` / `registerCommand` signatures confirmed by typecheck. |
| `pi install npm:` flow | `docs/packages.md` | `pi install npm:<pkg>` / `pi remove` / `pi list` / `pi update`. Confirmed, and exercised locally. |
| Itsuki API | repo `src/index.js`, `src/lib/ingest_contract.mjs`, live production | `POST /v1/save` conversation mode, `POST /v1/recall` → `{count, context, items}`, `GET /v1/packets/:id/status` (+ `userId` query), terminal statuses `enriched\|failed\|completed`, ingest limits 30/4,000/120,000/512KiB. Confirmed on production (see canary). |

## Divergences from the frozen handoff

Every divergence below is forced by evidence, not preference, per the standing rule "follow the frozen architecture exactly unless current official documentation disproves a detail".

### D-1 — Transport: self-contained, NOT the published `itsuki` SDK *(material)*

The handoff specified `dependencies: { "itsuki": "^0.2.1" }`. **That version does not exist.** The published package is `itsuki@0.2.0` (versions: 0.1.0, 0.1.1, 0.2.0); the repo's `sdk/js` is 0.2.1 but unpublished. `npm install` of the handoff's spec fails outright.

Inspecting the published 0.2.0 tarball (144 lines, files `index.js`, `package.json`, `README.md`) showed it cannot satisfy this adapter's mandatory contract:

| Requirement | `itsuki@0.2.0` |
|---|---|
| Packet status / `waitFor` — honest receipt state | **absent entirely** |
| Base-URL safety (HTTPS-except-loopback, no credentials/query/fragment) | **absent** — accepts any string |
| Redirect hardening | **absent** — no `redirect: "error"`, so a redirect can replay the `Authorization` header cross-origin |
| TypeScript types | **not shipped** (`index.d.ts` absent from the tarball) |
| Retry-After | partial: numeric-seconds only, no HTTP-date form, no cap |

**Decision:** `pi-itsuki` ships its own transport with **zero runtime dependencies**, porting the semantics of the *published and proven* n8n node (`packages/n8n-nodes-itsuki/nodes/Itsuki/GenericFunctions.ts`). This also removes the version-coupling liability the handoff itself flagged, matches the n8n precedent exactly, and minimises supply chain in an ecosystem whose own docs warn "extensions run with full system access". Revisit only if `itsuki@>=0.2.1` is published with packet status and URL validation.

### D-2 — `typebox` version *(minor)*
Handoff implied an older range; pi 0.84.2 pins `typebox@1.3.7`. Declared `peerDependencies: { "typebox": "*", "@earendil-works/pi-coding-agent": "*" }` per pi's documented rule ("if you import any of these, list them in `peerDependencies` with a `"*"` range and do not bundle them"), with matching devDependencies for local typecheck/test.

### D-3 — Ship built JS, and the source beside it *(minor)*
`pi.extensions` points at `dist/index.js` rather than TypeScript. jiti would load `.ts` fine, but compiled JS removes a runtime transform step from every session start. `src/` is shipped too, deliberately: pi's docs tell users to review source before installing third-party packages, so the reviewable source travels with the artifact.

### D-4 — Capture split into `stage()` then `drain()` *(material, strengthens the contract)*
The handoff described a single `capture()`. Implemented as two phases with the watermark written between them, because a single phase has a real duplication window: crash after delivery but before the watermark advances, and the next settle collects a *larger* span with a *different* key — the same content delivered twice under two keys, which idempotency cannot collapse. Ordering is now stage → append watermark → drain, and `test/hooks.spec.ts` asserts the watermark is written before the network call.

### D-5 — Scrubber pinned by differential parity, not just corpus vectors *(minor, strengthens)*
The handoff called for corpus pinning. In addition, `test/scrub.spec.ts` asserts this copy and `src/pipeline/scrub.js` produce **byte-identical output** on all 18 canonical corpus entries plus 11 further samples. A drift in either direction fails, including a limitation "fixed" on one side only. (One shared limitation was found and deliberately preserved: a trailing comma after a secret label, e.g. `the token is expired,`, redacts the word. Faithful to the server; not a Pi-side defect to fix unilaterally.)

### D-6 — Local `.tgz` install is not a valid pi package source *(documentation-affecting)*
`pi install <path-to.tgz>` succeeds and writes settings, but pi then treats a local *file* path as a single extension module and fails with `Unknown file extension ".tgz"`. Local paths are added "without copying"; archives are not unpacked. Real installs use `pi install npm:pi-itsuki`; the faithful pre-publication rehearsal is installing the **extracted package directory**, which is what the runtime proof did. The README documents only `npm:`.

## Enterprise requirement coverage

| Requirement | Where it lives | Proof |
|---|---|---|
| Bounded pre-turn recall | `coordinator.recall`, `before_agent_start` | limit/chars/timeout clamped in `config.ts`; query truncated to 2,000 cp; `test/coordinator.spec.ts`, `test/hooks.spec.ts` |
| Exactly-once post-`agent_settled` capture | `coordinator.stage` + `session.collectCaptureSpan` | `test/hooks.spec.ts` (no capture mid-turn; per-turn spans disjoint); real-runtime two-process proof |
| Stable content-derived idempotency | `identity.captureIdentity` | corpus digests pinned; `pi:v1:<sha256>`; real runtime shows the same key before and after an outage |
| Retry / compaction / fork / resume dedup | watermark in pi session tree | `test/session.spec.ts`, `test/hooks.spec.ts`, real `--continue` across processes |
| Crash-safe spool, honest receipt state | `spool.ts`, `coordinator.drain` | `test/spool.spec.ts`; crash-simulation test; `itsuki_save` says "Queued", never "Saved", without a receipt |
| Account/project/session isolation | scope in identity + wire body | corpus vectors `subtenant-differs`, `other-session-same-content`; `test/transport.spec.ts` |
| No scope widening | `userId` narrows only; tenancy from credential | `test/transport.spec.ts`; no adapter parameter can widen |
| Secret redaction | `scrub.ts`, `transport.redact` | 27 scrub tests incl. server parity; log/error/doctor leak tests |
| Prompt-injection boundary | `inject.ts` markers + preamble | corpus `injectedDirectiveMustNotEscape`; real prompt inspected in runtime proof |
| Timeout / cancellation / Retry-After / breaker | `transport.ts`, `coordinator.ts` | `test/transport.spec.ts`, `test/coordinator.spec.ts` |
| No automatic destructive operations | no DELETE exists in the package | tarball scan gate; `test/hooks.spec.ts` forbids destructive tool names |
| No unsupported claims | README "Deliberately absent" | no update/multimodal/consolidation/marketplace claim anywhere |

## Gate table

Legend: **PASS** evidenced here · **PENDING** requires an action outside this phase.

| # | Gate | Status | Evidence |
|---|---|---|---|
| 1 | Baseline clean + recorded | PASS | `4fe04f8`, clean tree |
| 2 | Repo suite green (serial) | PASS | Baseline 139 files / 1,735 tests → final **140 files / 1,757 tests, 0 failures**. The delta is exactly this campaign's corpus spec (+1 file, +22 tests). Note: a mid-build run reported 1–9 failures purely because two full suites executed concurrently against the same miniflare/D1 state; run alone it is clean. Do not run this suite in parallel with itself. |
| 3 | n8n package suite green (untouched) | PASS | 3 files / 40 tests |
| 4 | Pi contracts revalidated | PASS | table above; typecheck against real 0.84.2 types |
| 5 | Itsuki contracts revalidated | PASS | repo source + live production canary |
| 6 | Typecheck clean | PASS | `tsc --noEmit` exit 0 |
| 7 | Package suite green | PASS | 9 files / 148 tests |
| 8 | Corpus spec green (repo side) | PASS | 22 tests, incl. cross-check against `src/lib/ingest_contract.mjs` |
| 9 | Scrubber parity with server | PASS | 18 corpus entries + 11 samples byte-identical |
| 10 | Zero runtime dependencies | PASS | `npm ls --omit=dev` → empty |
| 11 | Dependency vulnerabilities | PASS | `npm audit --omit=dev` → 0 |
| 12 | Licenses / SBOM | PASS | 56 dev packages: 51 MIT, 2 Apache-2.0, 2 ISC, 1 BSD-3-Clause; **0 copyleft, 0 unknown**; runtime tree empty |
| 13 | Package content inspection | PASS | 26 files (11 `dist/`, 11 `src/`, README/LICENSE/CHANGELOG/package.json); no secrets, no postinstall, no DELETE |
| 14 | Real Pi runtime lifecycle | PASS | pi 0.84.2, published artifact: recall→inject→settle→save observed on the wire |
| 15 | Injection reached the model | PASS | model request contains markers + data-not-instructions label |
| 16 | Exactly-once across process restart | PASS | two `pi -p` processes, `--continue`: turn 2 did not resend turn 1; distinct keys |
| 17 | Offline degradation | PASS | Itsuki unreachable: turn completed normally, span spooled (`attempts:1, transport`) |
| 18 | Recovery delivery | PASS | spool drained to 0; offline span delivered under its original key |
| 19 | Clean install / uninstall | PASS | `pi install` → `pi list` → `pi remove`; settings emptied; zero Itsuki traffic after removal; no residue |
| 20 | Production canary | PASS | real save → receipt (`src_97ef…`, `receipt_door_…`) → recall round-trip |
| 21 | Canary cleanup verified zero | PASS | **two** nodes removed (extraction created a second under a different label); counts returned exactly to baseline 109/97/12/102/55/5 |
| 22 | Windows evidence | PASS | entire build and runtime proof ran on Windows 11 |
| 23 | **Linux evidence** | **PENDING** | Not obtainable locally: the only Linux here is Docker Desktop's minimal musl VM (no glibc/libstdc++, official and unofficial Node builds both fail to relocate). Satisfied by the `ubuntu-latest` leg of `publish-pi-extension.yml`, which has **not run yet**. Must be green before publication. |
| 24 | Publication | **NOT DONE — out of scope** | Nothing published. `dry_run` defaults to true; first publish needs `NPM_TOKEN`, then Trusted Publisher setup and owner approval. |
| 25 | Site / docs surfaces | **NOT DONE — out of scope** | Dashboard and docs untouched; the no-dead-commands test still forbids a `pi install npm:` verb until the package is live. Correct: it is not live. |

**Open findings: 0 Critical, 0 High, 0 release-blocking Medium.**

Two non-blocking observations recorded above: the shared scrubber comma limitation (D-5, faithful to server, fix belongs upstream and to both lanes at once) and the `.tgz` install behaviour (D-6, documentation handled).

## Independent audit (Fable, 2026-08-15)

Read-only verification first: branch/diff scope confirmed exact (31 files, only the four permitted paths); host contracts re-verified (pi still 0.84.2, Node ≥22.19.0, `pi-itsuki` still 404 on the registry); all deterministic suites re-run serially and green. The D-1 transport divergence was **accepted**: `itsuki@0.2.1` genuinely does not exist, 0.2.0 demonstrably lacks packet-status, base-URL validation and redirect hardening, and the replacement transport is corpus-pinned, parity-tested against the published n8n behaviour, and adds no dependency surface.

Adversarial review findings (all fixed in the follow-up commit, each with a regression test proven to fail without its fix):

| # | Severity | Finding | Repair |
|---|---|---|---|
| A | nonblocking Medium | `coordinator.recall` truncated the query with UTF-16 `.slice(0, 2000)` — could split a surrogate pair (lone surrogate on the wire) and miscounted the contract's 2,000 code points | `truncateToCodePoints(trimmed, 2000)`; astral-plane regression test |
| B | nonblocking Medium | Echo fingerprints lived only in process memory. After `/resume`, a model echo of a line injected by the PREVIOUS process was captured as new — the structural block-strip held, line-level suppression did not | `session_start` reseeds fingerprints from the branch's own `itsuki-recall` messages via `coordinator.seedEchoContext`; resume-echo regression test (verified red without the fix) |
| C | Low (open, documented) | A crash in the window between `stage()` resolving and the watermark append can yield an overlapping subset+superset span under two keys at the next settle. Milliseconds wide; the reverse ordering converts the same window into data LOSS, which is worse. Same accepted property as the Claude outbox. | None safe; documented here |
| D | Low (open, by design) | `validateBaseUrl` permits HTTPS to any host (only plain HTTP is loopback-restricted) — an operator can point the adapter at an internal HTTPS host. Identical policy to the published n8n node; config is local and operator-owned | None; parity with shipped behaviour |

Post-fix state: typecheck 0, package suite **150** tests green, packaging gates re-run green (no secrets, no DELETE, zero deps, 0 vulnerabilities).

## What is deliberately NOT claimed

- Not published, not advertised, not installable by name yet.
- Linux is not proven; gate 23 is open.
- The production canary exercised the **backend contracts** via authorized MCP tools, not this adapter's own HTTP client against production TLS. No credential was requested or handled at any point. An owner-run canary with a real project key, driving `pi-itsuki` itself against `https://itsuki.app`, remains the final pre-publication check.
- "Native" is claimed only in the sense proven at gate 14: recall and capture participate in pi's lifecycle without the agent choosing to invoke a tool.
