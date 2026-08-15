# antigravity-itsuki — Phase 0 probe evidence

Campaign: FROZEN ARCHITECTURE REPORT v2.1 (§21.0), owner-approved isolated Phase 0 (2026-08-16), §0.1 overrides binding.
Anchor: master `91e7425`. Host pins: Antigravity 2.0 v2.8.1 · CLI `agy` v1.1.13 · IDE v2.5.5 (IDE HELD).
All writes confined to the probe root plus this file and `test/fixtures/` (§0.1-3).

## Status summary: every runtime probe is PENDING this pass

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
