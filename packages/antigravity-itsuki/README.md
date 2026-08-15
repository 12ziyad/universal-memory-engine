# antigravity-itsuki

Long-term memory for [Google Antigravity](https://antigravity.google), backed by
[Itsuki](https://itsuki.app).

> **Status: unpublished, and automatic capture is deliberately HELD.**
> This package has not been released to npm. Read "What is held" below before
> expecting it to remember anything on its own.

## Supported

| Surface | Status |
|---|---|
| Antigravity CLI (`agy`) | Supported from **1.1.13** |
| Antigravity 2.0 desktop | **HELD** — see below |
| Antigravity IDE | **HELD** — hook execution is unverified at any version |

The CLI floor is not a preference. Per Google's own changelog, `Stop` hooks were
unreachable before 1.1.10, Windows transcript paths crashed before 1.1.12, and
compaction could corrupt the transcript before 1.1.13.

## Install

```bash
export ITSUKI_API_KEY=itsuki_live_...
npx antigravity-itsuki install
npx antigravity-itsuki doctor
```

`install` writes the plugin to `~/.gemini/config/plugins/itsuki/` — the shared
config root, which is where `agy plugin install` was observed to resolve
(Phase-0 probe P6; the docs' `~/.gemini/antigravity-cli/plugins/` path is stale).

The credential comes from `ITSUKI_API_KEY` when present. Otherwise `install`
offers a masked prompt and stores it at `~/.itsuki/credentials.json` with
owner-only permissions — POSIX `0600`, or a verified current-user-only DACL on
Windows. **If that protection cannot be verified, nothing is written to disk**
and you are told to use the environment instead.

## Commands

| Command | What it does |
|---|---|
| `install` | Install for the current user. Refuses to overwrite a directory it does not own. |
| `update` | Reinstall in place. Preserves queued memories and your credential. |
| `doctor` | Report configuration, queue depth and everything currently held. Never prints the key. |
| `uninstall` | Remove the plugin. Add `--purge` to also remove state (refused while memories are still queued, unless `--force`). |

## What is held, and why

- **Automatic capture** — the transcript format is the only route to the
  conversation text, and Google does not publish its entry schema. Probe P7,
  which would record a real fixture, needs a signed-in host. Until a fixture is
  captured and registered, an unrecognised transcript produces no capture.
- **`terminationReason` allowlist** — the documented list is explicitly
  non-exhaustive ("e.g."), so no value is treated as success until probe P8
  observes the real ones on a live host.
- **Desktop (2.0)** — no documented third-party way to read the version, and no
  verified evidence that the desktop app passes environment variables to hook
  subprocesses.

None of this is simulated or worked around. The doctor states each hold plainly.

## What runs today

- The plugin bundle is structurally valid: a top-level named-block `hooks.json`
  registering only `PreInvocation` and `Stop`, with explicit 10s timeouts.
- `Stop` always answers `{"decision":"stop"}` — it never returns `"continue"`,
  because a memory plugin must never re-enter the host's execution loop.
- Transcript paths are canonicalised and required to sit under the documented
  app-data root; symlinks, junctions and traversal are refused; reads are
  bounded to a tail.
- Recall, when a schema is verified, is bounded, delimited and labelled as data.

## Deliberately absent

Update Memory, memory history, entity operations, and any destructive tool. The
service has no safe caller-addressable update, and faking one would destroy
history. Use the MCP door or the dashboard for deletion, where a confirmation
UX exists.

## License

Apache-2.0
