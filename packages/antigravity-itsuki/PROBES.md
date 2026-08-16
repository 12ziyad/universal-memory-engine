# antigravity-itsuki — Phase 0 probe evidence

Campaign: FROZEN ARCHITECTURE REPORT v2.1 (§21.0), owner-approved isolated Phase 0 (2026-08-16), §0.1 overrides binding.
Anchor: master `91e7425`. Host pins: Antigravity 2.0 v2.8.1 · CLI `agy` v1.1.13 · IDE v2.5.5 (IDE HELD).
All writes confined to the probe root plus this file and `test/fixtures/` (§0.1-3).

## UPDATE 2026-08-16 — credential-free CLI probes EXECUTED on ubuntu-latest

Vehicle: disposable GitHub Actions workflow `probe-phase0.yml` (owner-approved: `workflow_dispatch` only, `permissions: contents: read`, no secrets, no OIDC, no publish/deploy, no production Itsuki). Run **`31911313462`**, job `antigravity` — **success**. Evidence artifact `antigravity-probe-evidence`.

### P6 — install path: **RESOLVED (BUILD)**

`agy plugin install <local-dir>` on **CLI 1.1.13** resolves to the **shared config root**:

```
/home/runner/.gemini/config/plugins/itsuki-probe/
/home/runner/.gemini/config/plugins/itsuki-probe/plugin.json
/home/runner/.gemini/config/plugins/itsuki-probe/skills
/home/runner/.gemini/config/import_manifest.json
```

This settles the report §7 item-16 contradiction **in favour of the changelog** (1.0.2 "install… directly to the shared configuration directory (`~/.gemini/config/`)"). The docs' `~/.gemini/antigravity-cli/plugins/<plugin_name>/` is **stale**. Installer targets `~/.gemini/config/plugins/itsuki/`, as the frozen architecture assumed — confirmed, not guessed.

### P12 — plugin lifecycle: **RESOLVED (BUILD)**

Every command exited 0: `install` → `list` → `disable` → `enable` → `uninstall`. `agy plugin list` emits **JSON** (`{"imports":[{"name","source","importedAt","components"}]}`) — machine-readable, so the doctor can assert enablement without scraping. Uninstall printed `Uninstalled plugin "itsuki-probe"` and removed the plugin directory; `~/.gemini/config/plugins/` remained (empty) alongside `import_manifest.json` and a `config.json` (where changelog 1.1.11 says enablement state lives).

Full `agy plugin` surface (captured `--help`): `list · import · install <target> (supports plugin@marketplace) · uninstall · enable · disable · **validate [path]** · link <mp> <target> · help`.

### NEW FINDING — the installer natively processes `hooks` (architecture-relevant)

`agy plugin install` enumerated component processing for our minimal bundle:

```
[ok]    itsuki-probe
        ✔ skills      : 1 processed
        - agents      : skipped (not found)
        - commands    : skipped (not found)
        - mcpServers  : skipped (not found)
        - hooks       : skipped (not found)
```

So `hooks` is a first-class component of the host's own installer. Consequences for §10.2: (a) `agy plugin install` is a viable, supported install path for the real bundle — the custom installer need not be the only route on CLI; (b) `agy plugin validate <path>` gives the installer and CI a host-authoritative bundle check; (c) a `plugin.json` carrying only `name` + `description` validated and installed cleanly, confirming the minimal manifest choice.

### Still PENDING (unchanged, and correctly so)

P7 (transcript fixtures), P8 (invocationNum/executionNum + terminationReason allowlist), P9 (subagent hook firing), P11 (shell/argv contract + icacls), P13b (fork anchors) all require a **turn**, which requires a Google sign-in or `GEMINI_API_KEY` — deliberately not granted. P16/P17 (desktop) remain owner-assisted. Antigravity capture, auto-capture scope, desktop support and persistent-Windows-credential mode therefore all remain **HELD**.

---

## Original status summary (superseded in part by the update above)

Two independent blockers, both outside this pass's authorization:

1. **No compliant isolation vehicle materialized on this machine.** Antigravity CLI has no documented host-specific profile override (it anchors on `~/.gemini`), so §0.1-2 requires a container/VM/disposable-user vehicle. The full elimination evidence is recorded in `packages/opencode-itsuki/PROBES.md` (shared vehicle hunt): Windows Sandbox absent (Home edition); Docker engine never started; `wsl --import` of a verified-valid ubuntu-base rootfs hung repeatedly with the WSL VM layer non-functional for imports (initial `wsl --status` hang >10 min corroborates); disposable OS user needs admin (owner-assisted).
2. **Credentials are excluded from this approval.** Turn-dependent probes (P7 live transcript fixtures, P8 termination-reason observation, P9 subagent behavior, P13b fork anchors, parts of P10/P11) additionally require a Google sign-in or `GEMINI_API_KEY`, which §0.1 explicitly does not grant. Desktop probes (P7-desktop, P16, P17) were excluded outright.

**Consequence per the frozen stop-gates:** Antigravity capture, auto-capture scope, desktop support, and persistent-Windows-credential mode all remain **HELD** pending their probes. Nothing was simulated.

## What WAS established this pass (static, evidence-backed)

### Official contract fixtures pinned (`test/fixtures/docs/`, fetched 2026-08-16 from antigravity.google `.md` endpoints)

| File | Bytes | Key content verified |
|---|---|---|
| `hooks.md` | 15,171 | 5 events; `fullyIdle` ×2; `injectSteps` ×5; camelCase stdin/stdout; transcript path template; sha256[:16] `5fd61038d394efcf` |
| `plugins.md` | 2,749 | plugin dir layout; workspace/global paths |
| `cli-plugins.md` | 6,825 | CLI plugin schema (`name` required), `agy plugin` commands, CLI paths |
| `mcp.md` | 4,676 | `mcpServers`/`serverUrl`/`headers`; no env interpolation |
| `skills.md` | 4,951 | SKILL.md folder layout, lazy loading |

These are the golden inputs for the future `hooks_contract.spec.ts` golden tests — the stdin/stdout contract can be built and unit-tested against them without the host, with runtime confirmation deferred to the probe session.

### Probe design ready for the next pass

- Vehicle options for the owner to choose: (a) owner-assisted disposable OS user on this machine (admin), (b) repaired WSL (`wsl --update` / service repair, then the prepared ubuntu-base import — rootfs already validated), (c) any POSIX box, (d) separately-approved disposable GitHub Actions probe workflow.
- Turn-dependent probes additionally need the owner's decision on a credential grant (bounded ≤25 short turns) per §21.0.
- Desktop probes (P16 version detection, P17 env propagation, P7-desktop transcript fixtures) need an owner-assisted desktop session.

## Per-probe status table

| Probe | Status | Note |
|---|---|---|
| P6 install-path reality | **PENDING** (vehicle) | docs-vs-changelog contradiction recorded in report §7 |
| P7 transcript format fixtures (CLI/desktop × Win/POSIX) | **PENDING** (vehicle + credential; desktop excluded) | capture design blocked on this — capture stays HELD |
| P8 invocationNum/executionNum + terminationReason allowlist | **PENDING** (vehicle + credential) | capture allowlist unresolved — capture stays HELD |
| P9 subagent hook firing/distinguishability | **PENDING** (vehicle + credential) | auto-capture scope unresolved |
| P10 malformed-stdout/non-zero-exit behavior | **PENDING** (vehicle) | — |
| P11 shell/argv + quoting contract per OS; icacls DACL verify | **PENDING** (vehicle; icacls part could run Windows-native but is only meaningful alongside the hook-execution contract) | platform holds unresolved |
| P12 `agy plugin` lifecycle round-trip | **PENDING** (vehicle) | — |
| P13b fork anchors | **PENDING** (vehicle + credential) | first-sight-only semantics stand |
| P16 desktop version detection | **PENDING** (owner-assisted desktop; excluded this pass) | desktop HELD |
| P17 desktop env propagation of ITSUKI_API_KEY | **PENDING** (owner-assisted desktop; excluded this pass) | desktop env-credential mode HELD |

## Cleanup record

Shared with `packages/opencode-itsuki/PROBES.md` — probe root fully deleted; no Antigravity software was installed anywhere (neither `agy` nor the desktop app); the real `~/.gemini` was never created or touched.

---

# P7 / P8 CLOSED — real signed-in host, 2026-08-16

Host: **Antigravity CLI 1.1.13** (`C:\Users\ziyad\AppData\Local\agy\bin\agy.exe`), authenticated, Windows 11. Real model turns confirmed (`AGY_AUTH_OK`, `PROBE_P8_TURN`, `AGY_E2E_OK`). Memory traffic went to a loopback stub; production Itsuki was never contacted. No credential was read, printed or moved.

## P7 — transcript schema (CLOSED)

Path matches the docs exactly. **The host passes `transcript_full.jsonl`, not the documented `transcript.jsonl`** — both exist side by side.

Entry shape: `{ step_index: number, source: string, type: string, status: string, created_at: ISO8601, content?: string }`

| source | type | carries content | used |
|---|---|---|---|
| `USER_EXPLICIT` | `USER_INPUT` | yes | **user turn** |
| `MODEL` | `PLANNER_RESPONSE` | yes | **assistant answer** |
| `SYSTEM` | `CONVERSATION_HISTORY` | no | excluded |
| `SYSTEM` | `CHECKPOINT` | **yes** | excluded — host state, never uploaded |

Redacted fixture: `test/fixtures/transcripts/cli-1.1.13-windows.jsonl`.

## P8 — Stop contract (CLOSED)

Real payload from a successful turn:

```
fullyIdle: true
terminationReason: "NO_TOOL_CALL"
error: ""            <- present, but an EMPTY STRING
executionNum: 0
transcriptPath: …/transcript_full.jsonl   (under brain/)
workspacePaths: []
```

**The documented example value `model_stop` never appears.** Hardcoding it — the obvious shortcut — would have meant capture silently never firing. Keeping the allowlist empty until a real host filled it was the correct call.

`PreInvocation` carries `invocationNum`, `initialNumSteps`, `modelName`, `conversationId`, `transcriptPath`, `artifactDirectoryPath`, `workspacePaths`.

**Env propagation into hook subprocesses: CONFIRMED on CLI** (`ITSUKI_API_KEY` visible). Hook cwd is not the workspace.

## Two HIGH defects found only by the real host

**AG-01 — the user's turn was being discarded.** `parseEntries` dropped the first line unconditionally, correct for a truncated tail but wrong when the whole file fits — and on a short conversation that first line *is* the user's message. Every small real transcript was therefore unclassifiable. Now the first line is kept when it parses as a whole object.

**AG-02 — host scaffolding would have been uploaded.** A `USER_INPUT` entry is not the user's message; it wraps it:

```
<USER_REQUEST>…the person's words…</USER_REQUEST>
<ADDITIONAL_METADATA>…host state…</ADDITIONAL_METADATA>
<USER_SETTINGS_CHANGE>…environment/settings…</USER_SETTINGS_CHANGE>
```

Measured: **14 of 435 characters were the person's words.** The rest is environment and settings. Only the `USER_REQUEST` body is now taken, and unrecognised scaffolding fails closed.

## End-to-end proof on real data

Uploaded payload after the fixes: `["Reply: ENVTEST", "ENVTEST"]` — the human's words and the model's answer, nothing else. Four identical `Stop` invocations produced **1 save, 1 idempotency key**.

Install/uninstall exercised through our own installer against the live host; `--purge` removed state; the host's plugin directory is clean.

## P11 — a Windows finding that blocks default installs

The stock Windows Node path is `C:\Program Files\nodejs\node.exe`, which contains a space — and the installer refuses spaces because the host's hook shell and quoting are undocumented. The probes therefore used the 8.3 short path (`C:/PROGRA~1/nodejs/node.exe`), which worked. **Left open:** the installer should resolve a short path itself on Windows rather than refusing, otherwise a default Node install cannot be used. Recorded, not yet implemented.

## Still HELD / open

- **Desktop (Antigravity 2.0)** — P16/P17 untested; no desktop host on this machine.
- **P11 short-path resolution** — see above.
- Antigravity IDE.
