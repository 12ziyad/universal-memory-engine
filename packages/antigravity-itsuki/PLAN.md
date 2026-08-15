# antigravity-itsuki — implementation record

Built from FROZEN ARCHITECTURE REPORT v2.1 §10.2/§12 against the official
contract at `antigravity.google/docs/hooks` (fixture pinned in
`test/fixtures/docs/hooks.md`) and the Phase-0 CLI probes (run `31911313462`).

## What ships active, and what ships HELD

Active: the plugin bundle, installer, updater, uninstaller, doctor, hook runner,
transcript path validation, bounded tail reads, and the recall path.

**HELD — automatic capture.** Two independent gates are empty by construction:

- `VERIFIED_SCHEMAS` in `transcript.ts`. Google documents the transcript's path
  but not its entry schema, and the changelog shows the file being rewritten in
  place during compaction. Probe P7 would record a real fixture; it needs a
  signed-in host, which this campaign was not given.
- `VERIFIED_SUCCESS_TERMINATIONS` in `hook.ts`. The docs give `terminationReason`
  a non-exhaustive "e.g." list. Probe P8 would record the real values.

With both empty, an unrecognised transcript captures nothing and an unrecognised
termination captures nothing. This is the honest state, enforced by tests that
assert the registries are empty and that capture refuses.

**HELD — desktop (Antigravity 2.0).** No documented third-party way to read the
version (P16), and no evidence that the desktop app propagates environment
variables to hook subprocesses (P17).

**HELD — Antigravity IDE.** Hook execution unverified at any version.

## Divergences

### D-1 — install target is the shared config root *(evidence-forced)*

Phase-0 probe P6 observed `agy plugin install` resolving to
`~/.gemini/config/plugins/<name>/`, matching changelog 1.0.2 and contradicting
the CLI docs' `~/.gemini/antigravity-cli/plugins/`. The installer targets the
observed path.

### D-2 — hook commands must need no quoting at all *(hardening)*

The shell Antigravity uses to run hook commands is undocumented (P11), so rather
than guess a quoting scheme the installer refuses any node/script path
containing whitespace, a shell metacharacter, or a control character, and says
why. A refused install is better than a silently mis-tokenised command.

### D-3 — `${extensionPath}` is not used *(hardening)*

The token is undocumented on the hooks and plugins pages. The installer writes
absolute paths instead.

## Defects found and fixed

| ID | Severity | Defect |
|---|---|---|
| INS-01 | HIGH | The `--purge` precondition was checked *after* the plugin files were deleted, so a refused purge still uninstalled and the retry then failed for want of the marker it had just removed. Preconditions now run first. |
| INS-02 | MEDIUM | Uninstall left empty directories behind: `rmSync` without `recursive` throws on a directory and the `catch` swallowed it. `rmdirSync` refuses a non-empty directory by design, which is the guarantee wanted. |
| SEC-03 | MEDIUM | The hook-path guard matched shell metacharacters and `\s`, but `\s` does not cover the control range, so a NUL byte passed — the one character where the string a guard inspects and the bytes an exec layer uses can disagree. Rewritten as explicit code-point checks. |

## Executed evidence

- `dist/hook-entry.js Stop` run for real: answered `{"decision":"stop"}`.
- `dist/cli.js doctor` run for real: reported every hold, and verified Windows
  DACL protection as current-user-only on this machine.
- 72 tests · typecheck clean · zero runtime dependencies · no postinstall ·
  76-file pack containing the bundle, CLI and hook entry.
