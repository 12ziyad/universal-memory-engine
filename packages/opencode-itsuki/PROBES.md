# opencode-itsuki — Phase 0 probe evidence

Campaign: FROZEN ARCHITECTURE REPORT v2.1 (§21.0), owner-approved isolated Phase 0 (2026-08-16), with §0.1 overrides binding.
Anchor: master `91e7425`. Host pinned: `opencode-ai@1.18.18` / `@opencode-ai/plugin@1.18.18` / `@opencode-ai/sdk@1.18.18`.
Probe root: `C:\Users\ziyad\uml\tmp\probes\` (verified git-ignored: `.gitignore:109 tmp/`).
All writes confined to the probe root plus this file and `test/fixtures/` (§0.1-3).

## Start gate (executed 2026-08-16)

- master clean; HEAD `91e7425` == `git ls-remote origin refs/heads/master`.
- Stale-process classification (read-only inspection): four `wrangler d1 execute uml-memory --remote` process trees created 2026-08-15 19:03/19:12/19:57/21:35, each rooted in a Claude shell-snapshot bash wrapper (`.claude/shell-snapshots/snapshot-bash-1786792168097-*`), all running read-only SELECTs matching the prior campaign's SRV verification queries. **Terminated: 20 PIDs** (each re-verified against the classification at kill time); 4 cmd wrappers already exited with their parents. Post-kill re-inspection: zero `wrangler` processes remain.

## Environment survey

| Fact | Value |
|---|---|
| OS | Windows 11 Home 10.0.26200 (Windows Sandbox unavailable on Home) |
| Node / npm (Windows) | v24.12.0 / bundled npm |
| XDG_* env set globally | none |
| WSL | functional but slow to cold-start (`wsl --status` hung >10 min once; `wsl -l -v` OK). Distros: `docker-desktop` (Stopped) only |
| Docker Desktop | installed; engine did NOT come up within 220 s of a headless start (likely first-run GUI gate). Attempt abandoned; Docker Desktop processes stopped again. **Docker vehicle: unavailable this pass** |
| npm task-scoped vars | `npm_config_cache` honored; `npm_config_tmp` deprecated warning ("Unknown env config 'tmp'... will stop working in next major") — cache confinement worked |

## P0a — isolation verification: **FAILED for Windows-native → Windows-native runtime probes PENDING**

Two runs, both with the pinned binary installed inside the probe root (`npm install opencode-ai@1.18.18 --prefix <probe>/host`, 21 s, postinstall selected `opencode-ai\bin\opencode.exe`).

**Run 1** (npm `.cmd` shim; `OPENCODE_TEST_HOME` + all four `XDG_*` set into probe dirs; probe XDG dirs pre-created): the compound command hung at the `debug config` step (killed at 120 s). Afterward: `~/.config/opencode`, `~/.local/share/opencode`, `~/.local/state/opencode`, `~/.cache/opencode` **existed in the REAL profile**, all with creation timestamps `02:42:36` (= the run), while every probe XDG dir remained **empty**.

**Run 2** (decisive; direct exe `opencode-ai\bin\opencode.exe --version`, env injected via `ProcessStartInfo.EnvironmentVariables` — propagation guaranteed; `OPENCODE_TEST_HOME` set): exit 0 in <20 s, stdout `1.18.18` — and the four real-profile dirs were **created again**; probe `home/` contained **0 entries**.

**Conclusions (evidence-backed):**
1. On win32, opencode 1.18.18 creates its global path scaffold (`~/.config/opencode`, `~/.local/share/opencode`, `~/.local/state/opencode`, `~/.cache/opencode`) anchored on `os.homedir()` **unconditionally at process start**, even for `--version`.
2. `XDG_*` environment variables are **ignored on win32** (consistent with `xdg-basedir` being POSIX-oriented; source `packages/core/src/global.ts` uses `xdgData!`-style non-null assertions with homedir fallbacks).
3. `OPENCODE_TEST_HOME` did **not** redirect the scaffold (it overrides only the `Path.home` getter).
4. Therefore no host-specific override isolates Windows-native opencode; per §0.1-2 the compliant vehicles are a disposable OS user (admin, owner-assisted) or a VM/container.
5. `opencode --version` exits promptly; the Run-1 hang was the `debug config` invocation via the npm shim (not re-probed; noted).

**Violation handling:** both times the four probe-created dirs were inspected (contents: empty scaffold subdirs `log/`, `repos/`, `bin/` only — no user data; no pre-existing opencode profile existed, proven by creation timestamps) and **deleted, restoring the pre-probe baseline** (re-audit: all four absent).

## P2 — #42386 synthetic-part/title fix in 1.18.18: **NOT FIXED for the mixed-part case → BUILD with mitigation decision**

- Issue `anomalyco/opencode#42386` ("Title generation includes synthetic parts injected by plugins, polluting session titles") closed **2026-08-13T18:26:09Z** — *after* the v1.18.18 release (published 2026-08-13T01:15:04Z).
- Tagged source `v1.18.18` `packages/opencode/src/session/prompt.ts` (title path): filter is
  `const real = (m) => m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic)`
  — it excludes a message only when **every** part is synthetic. A recall injection (real user text + one synthetic part) **passes into the title prompt**.
- Design consequence for §10.1: the injected recall block will leak into session titles on 1.18.18. Mitigation options to decide at implementation: minimal block text, title-agent detection (the title generator runs as a hidden internal agent — our `chat.message` guard list may already skip its sessions; VERIFY at runtime), or accept+document. Not a hold; recorded as a mandatory blueprint decision with runtime verification.

## Fixtures pinned (this directory's `test/fixtures/`)

| File | Content | Verified |
|---|---|---|
| `plugin-1.18.18-index.d.ts` | full `Hooks` interface (21 members), `PluginInput`, `Plugin`, `PluginModule` | contains `"chat.message"` |
| `plugin-1.18.18-tool.d.ts` | `tool()` helper, `ToolContext`, `ToolResult` | — |
| `sdk-1.18.18-types.gen.d.ts` | 32-member `Event` union; `TextPart` (id/sessionID/messageID/type/text REQUIRED); `TextPartInput` (server-assigned door) | contains `export type TextPart` ×2 (incl. input variant) |

## Runtime probes P1, P3, P4, P5, P13a, P14, P15 — status

Vehicle: disposable WSL distro `itsuki-probe` (ubuntu-base 24.04.4 rootfs downloaded into the probe root; first download attempt was a 286-byte 404 page from a stale cloud-images URL — detected by size+content inspection before use, replaced by `cdimage.ubuntu.com/ubuntu-base/releases/noble/release/ubuntu-base-24.04.4-base-amd64.tar.gz`, 29,989,394 bytes, verified gzip).
Probe assets prepared in `tmp/probes/wsl/payload/`: instrumentation plugin (`probe-plugin.ts` — logs every hook invocation; injects a fully-formed `TextPart` with generated id per §10.1), deterministic loopback OpenAI-compatible stub (`stub-llm.mjs` — streaming SSE, marker-echo, forced-error and slow modes; zero credentials, zero external model traffic), pinned project config (`opencode.json` — custom `stub` provider at `127.0.0.1:4141`, share disabled, autoupdate off), and `setup.sh`.

**RESULT: ALL PENDING — no compliant isolation vehicle was available on this machine.**

Vehicle elimination evidence (2026-08-16):
1. **Windows-native**: P0a proved isolation impossible without redefining `USERPROFILE` (forbidden by §0.1-2).
2. **Windows Sandbox**: unavailable (Windows 11 Home).
3. **Docker**: Docker Desktop installed but the engine never came up in 220 s of headless start polling (likely first-run GUI gate; not interacted with). Processes stopped afterward.
4. **WSL distro import**: three attempts. (a) First rootfs URL returned a 286-byte 404 HTML page — caught by size/content inspection; import against it hung and was killed. (b) Valid `ubuntu-base-24.04.4` rootfs (29,989,394 bytes, verified gzip): `wsl --import` hung >5 min with the target directory never created. (c) After `wsl --shutdown` reset: clean retry hung again at 150 s, target dir never created. Combined with the initial `wsl --status` hang (>10 min), the WSL VM layer is non-functional for imports on this machine right now. `docker-desktop` distro left `Stopped`, exactly as found.
5. **Disposable OS user / VM**: require admin/owner assistance — outside this pass's authorization.

Probe harness preserved for the next pass at `test/fixtures/probe-harness/` (`probe-plugin.ts`, `stub-llm.mjs`, `opencode.json`, `setup.sh`) — the instrumentation plugin and deterministic stub provider are ready to run the moment a vehicle exists (owner-assisted disposable OS user, repaired WSL, or a POSIX box).

Fixture digests (sha256, first 16 hex): `plugin-1.18.18-index.d.ts` = `f3ec1a150d1354be`; `sdk-1.18.18-types.gen.d.ts` = `1fdbed5b58ed5882`.

## Stop-gate resolution table (this pass)

| Gate | Resolution | Evidence |
|---|---|---|
| P0a isolation (Windows-native) | **HELD** — impossible without forbidden env redefinition | two-run proof above; real profile restored both times |
| P1 hooks under `opencode run` | **PENDING** — no vehicle | vehicle elimination above |
| P2 title-leak fix in 1.18.18 | **RESOLVED: not fixed for mixed parts → BUILD with mandatory mitigation decision** | tagged-source filter quote + issue timeline |
| P3 injected-part contract via real loader | **PENDING** — no vehicle (static half done: `TextPart` required fields pinned in fixtures) | fixtures |
| P4 finish/success discrimination (+ §0.1-1 current-human-message boundary) | **PENDING** — no vehicle → per §0.1-1/§10.1, **capture remains HELD until proven** | — |
| P5 subagent `parentID` timing | **PENDING** | — |
| P13a fork anchors | **PENDING** → first-sight-only semantics stand; no cross-fork claims | — |
| P14 forced-exit durability | **PENDING** → headless capture remains HELD | — |
| P15 dispose invocation | **PENDING** → headless capture remains HELD | — |

## Cleanup record

- Real profile: probe-created `~/.config/opencode`, `~/.local/share/opencode`, `~/.local/state/opencode`, `~/.cache/opencode` deleted after each run; final re-audit all absent.
- Probe root `tmp/probes/` deleted in full (host install, npm cache, rootfs tarballs, payload originals) — see final audit in the session log.
- WSL: no distro registered by this pass (`itsuki-probe` never materialized); `wsl --shutdown` issued; `docker-desktop` left Stopped as found. Docker Desktop processes stopped.
- Stale prior-campaign wrangler trees: terminated at start gate (20 PIDs), zero remaining.

---

# UPDATE 2026-08-16 — probes EXECUTED on ubuntu-latest (GitHub Actions)

Vehicle: disposable workflow `probe-phase0.yml` (owner-approved: `workflow_dispatch` only, `permissions: contents: read`, no secrets, no OIDC, no publish/deploy, no production Itsuki). Run **`31911313462`**, job `opencode` — **success**. Artifact `opencode-probe-evidence`. Host `opencode-ai@1.18.18`; model traffic to a loopback OpenAI-compatible stub; **248 hook invocations captured**.

**Every result below came from `opencode run` (headless).** The SDK driver failed with `spawn opencode ENOENT` (harness bug — the step never put the binary on PATH), so all evidence is from the `run` path, which makes the P1 answer stronger, not weaker.

## P1 — hooks under `opencode run`: **RESOLVED → BUILD**

`chat.message` ×3, `dispose` ×3, and the full `event` stream all fired headless. Issue #41422 is specific to `tool.execute.*`; it does **not** generalise. Event types observed (counts): `plugin.added` 135, `session.status` 22, `message.updated` 14, `message.part.updated` 14, `session.updated` 11, `catalog.updated` 9, `message.part.delta` 8, `reference.updated` 6, `integration.updated` 6, `session.idle` 4, `session.created` 3, `session.diff` 3, `session.error` 1.

**Contract finding:** `plugin.added`, `catalog.updated`, `reference.updated`, `integration.updated`, `message.part.delta`, `session.diff` are **not** in the shipped SDK's 32-member `Event` union. Runtime emits more than the type declares — never exhaustively `switch` on it.

## P3 — injected part contract: **RESOLVED → BUILD (proven end to end)**

A fully-formed `TextPart` (`id`, `sessionID`, `messageID`, `type`, `text`, `synthetic:true`) pushed in place onto `output.parts` was **accepted by the host and delivered to the model**: the loopback stub recorded `sawMarker: true` on **every** completion. The user message reached the model as two text parts — the user's own, then ours.

Host-native ids look like `prt_00777ec73001PnMFTq2BPUylqs`; our arbitrary `prt_probe9savb6hjo1` was accepted unchanged. Ids need only be unique — but ship the host-like `prt_` prefix. Plugin context: `directory=/…/project`, `worktree=/`, `hasBunShell=true`, `serverUrl=http://localhost:4096/`.

## P2 — title leakage: **CONFIRMED EMPIRICALLY (static finding upheld)**

Every main completion (`nMsgs:3`) was paired with a second small-model call (`nMsgs:2`) that **also** reported `sawMarker: true`. The synthetic recall block reaches title generation on 1.18.18, exactly as the tagged-source `real` filter predicted. Mitigation is a mandatory §10.1 implementation decision, not a hold.

## P4 — success discrimination + the §0.1-1 boundary: **RESOLVED → BUILD**

Success (turns 1 and 3) — assistant `message.updated` progresses
`finish=undefined, completed=N` → `finish=stop, completed=N` → `finish=stop, completed=Y`, then `status=idle`, then `session.idle`.

Failure (turn 2) — five `status=retry` cycles, then `session.error`, then `session.idle`, and only *afterwards* the assistant `message.updated` carrying **`finish=undefined`, `completed=Y`, `error={APIError, "stub-forced-error"}`**.

Three consequences, all confirming the frozen design:
1. **`timeCompleted` alone is NOT a success signal** — the errored message also carries it. The `finish === "stop"` allowlist is empirically justified.
2. **The final `message.updated` can arrive AFTER `session.idle`.** Capture must re-read the transcript (`client.session.messages()`) rather than trust the event snapshot — which §10.1 already does.
3. **`session.idle` fired twice** for the error session (7 ms apart) and once for each success. Dedup by session + generation is mandatory, as designed.

**§0.1-1 watermark boundary — PROVEN AVAILABLE.** `chat.message` delivers, before the model runs: `input.sessionID`, `input.messageID`, `output.message.id`, `output.message.time.created`, and `partsBefore` containing exactly the user's own text. That is precisely the anchor the owner's override requires — seed the watermark immediately before this identified human message so the current exchange stays capturable. **Capture is unblocked on this axis.**

## P15 — `dispose`: **RESOLVED → BUILD, with a hard constraint**

`dispose` fired on every `opencode run`, but only **19–21 ms after `session.idle`** (16.052→16.071; 34.310→34.331), and the process then exits.

**This is the durability constraint the owner's override #4 anticipated.** A capture that awaits network I/O inside the non-awaited `event` hook will be cut off mid-flight. It vindicates the design: plan → scrub → **atomic temp+rename spool write (the durability point)** must complete inside that window; the network drain is a separate, resumable step; `dispose` is a best-effort flush with a bounded budget, never the durability mechanism.

## P14 — forced-exit durability: **INCONCLUSIVE → headless capture stays HELD**

The `PROBE_WANT_SLOW` turn completed in ~7 s while the kill was scheduled at 12 s, so `kill -9` landed *after* `finish=stop`/idle and never exercised the staging window. Re-probe needed: raise the stub's per-token delay or kill at 2–3 s, then assert the spool envelope survives and the next run drains it exactly once. Not a defect — a harness timing miss, honestly recorded.

## P5 / P13a — subagents and fork anchors: **PENDING**

Both depended on the SDK driver (`session.get().parentID`, `session.fork()` id/timestamp comparison), which never started. No `task` tool ran, so no child sessions appeared. First-sight-only semantics stand; no cross-fork claims.

## P0a — isolation: Linux reproduces the Windows behavior

A bare invocation created `~/.config/opencode`, `~/.local/share/opencode` (`log/`, `repos/`) and `~/.cache/opencode` (`bin/`) under the runner's HOME. The scaffold-on-start behavior is **host behavior, not a Windows quirk** — which is why an ephemeral runner (or disposable user/VM), not an env override, is the correct isolation vehicle.

---

# REAL-HOST PROOF — PASSED (run `31918424723`, 2026-08-16)

Packed tarball (`npm pack`, not the worktree) installed into a clean project
beside the real pinned `opencode-ai@1.18.18`. Model and memory service are both
loopback stubs inside a disposable runner; no secrets, no OIDC, no production
Itsuki. Every assertion below is on what the host actually did.

| Proof | Result |
|---|---|
| exactly one recall per genuinely new human turn | PASS (got 1) |
| the model received the recalled memory | PASS |
| exactly one provider call received the block | PASS (got 1) |
| **NO title-shaped call saw the block** | PASS |
| the marker is never persisted into the host's own storage | PASS |
| exactly one settled capture delivered | PASS (got 1) |
| capture carries the user turn and the assistant answer | PASS |
| capture contains neither the injected block nor the recalled needle | PASS |
| capture is conversation mode with an idempotency key | PASS |
| **P14** envelope survives an unreachable service, on disk | PASS |
| **P14** drain after restart, no duplicate idempotency keys | PASS (2 saves, 2 unique) |
| fail-open: turn completes with memory unreachable | PASS |
| fail-open: nothing injected when recall fails | PASS |
| poisoned memory: forged closing marker defanged | PASS |

## SEC-04 — found only by the real host, three iterations

The frozen design injected via `experimental.chat.messages.transform`, believing
it transient. The host disagreed, three times:

1. Both completions carried the block. Made injection one-shot -> still both.
2. Suspected shared objects; replaced the array element with a copy -> still both.
3. Added strip-then-inject -> still both, which proved the hook is invoked
   **once** per turn and the same array is reused for the title call. Nothing
   added there can be scoped, and there is no second call in which to undo it.

The fix is a different channel. `experimental.chat.system.transform` has an
OPTIONAL `sessionID` in the shipped types, and the host omits it for the
small-model calls. Guarding on its presence puts memory in front of the real
turn and nothing else — now proven: inference `sawMarker=true`, title call
`sawMarker=false`.

Severity HIGH. Regression tests: `adversarial.spec.ts` -> "injection on the
system channel".

## Still open

- **P5 / P13a** (subagent, fork anchors) — not exercised by this harness; the
  scripted `opencode run` turns spawn no child sessions. First-sight semantics
  stand and no cross-fork claim is made.
- Three harness defects were found and fixed along the way (a bare package name
  in `plugin:[]` silently loads nothing when unpublished; a stale marker string;
  stub failure modes set on the client's env that the running stub cannot see).
  None were product defects.
