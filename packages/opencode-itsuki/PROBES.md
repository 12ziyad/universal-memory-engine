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
