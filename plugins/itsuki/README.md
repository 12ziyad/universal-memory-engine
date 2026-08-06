# Itsuki for Codex

This package contains Itsuki's Codex-native MCP configuration and lifecycle
adapter. The adapter was developed against Codex CLI `0.146.0-alpha.9.2`.
Codex documents `transcript_path` as unstable, so unknown transcript shapes are
omitted rather than passed through as text.

## Runtime requirements

- Codex with plugin lifecycle-hook support;
- a maintained Node.js 22 or 24 LTS executable available as `node` to hook
  subprocesses;
- `ITSUKI_API_KEY` set to an active `itsuki_live_...` API key (legacy
  `uml_live_...` keys remain accepted).

## Install and activate

Add this repository as a marketplace and install the plugin:

```sh
codex plugin marketplace add 12ziyad/universal-memory-engine
codex plugin add itsuki@itsuki-plugins
codex plugin list --json
codex mcp list --json
```

The MCP server reads `ITSUKI_API_KEY` from the Codex host process. A variable
set only in one terminal reaches Codex CLI only when Codex is launched from
that same terminal. Codex Desktop and IDE extensions may not inherit it. For
those surfaces, current Codex documentation recommends putting required values
in `~/.codex/.env`, followed by a full app or extension restart:

```dotenv
# ~/.codex/.env; on Windows: %USERPROFILE%\.codex\.env
ITSUKI_API_KEY=itsuki_live_...
```

The Codex host needs that variable for the remote MCP server and lifecycle
hooks, but ordinary project commands do not. Add this canonical filter to
`~/.codex/config.toml` to prevent ordinary project commands from inheriting the
token by default:

```toml
[shell_environment_policy.filters]
"ITSUKI_API_KEY" = "exclude"
```

If that configuration layer already uses the legacy
`shell_environment_policy.exclude` or `include_only` arrays, add
`ITSUKI_API_KEY` to the existing legacy policy instead; Codex rejects mixing
legacy arrays with `filters` in the same layer. Project `.codex/config.toml`
files have higher precedence than user configuration in trusted projects, so
inspect any project policy that changes `shell_environment_policy` before
trusting it. Restart Codex after changing either file.

This filter governs ordinary command environments only; it is not a security
boundary against trusted hooks, a trusted project's higher-precedence policy,
or same-user code that can read `~/.codex/.env`. Keep hostile repositories
untrusted, and audit their hooks and `.codex/config.toml` before granting trust.

Finally, open `/hooks`, inspect the installed Itsuki `SessionStart` and
`SessionEnd` commands, and explicitly trust them. Codex does not trust plugin
hooks merely because the plugin was installed; unreviewed or changed hooks are
skipped. Do not use `--dangerously-bypass-hook-trust` for normal interactive
use. Start a new session after trusting the hooks.

Once trusted, the bundled default `hooks/hooks.json` runs a network-free
SessionEnd capture and a bounded SessionStart delivery/recall pass. SessionEnd
scrubs eligible durable outcomes before atomically writing them to Codex's
protected `PLUGIN_DATA/codex-outbox/v1` subdirectory. Failed delivery remains
queued for a later start.

The local outbox is deliberately finite: at most 64 envelopes (staged and
quarantined combined), 16 MiB in total, and 512 KiB per envelope. Each
SessionStart attempts at most four envelopes in oldest-first order. Captures do
not expire automatically and the plugin never evicts an existing capture to
make room.

Failure handling is per-envelope. A capture the service permanently rejects
(for example HTTP 413/422, or a response that is not a durable acceptance) is
moved to the outbox's `failed` quarantine directory with a machine-readable
reason in `state/`; it is preserved verbatim, reported by the SessionStart
status, and never blocks later valid captures. Transient failures (offline,
HTTP 5xx/429) stay staged with a persisted attempt count and deterministic
backoff; an envelope whose transient retries exhaust their bound (16 attempts)
is quarantined the same way instead of retrying forever. Delivery receipts
retain the service packet identity, and SessionStart reports accepted packet
ids so a capture can be correlated with its job status.

Rotating the API key or service origin never disables capture. New captures
queue under the active credential; captures bound to a previous credential are
skipped and preserved — they deliver again when that credential returns, or
when you explicitly re-key them. Rebinding is deliberately explicit (a capture
made under one credential must never silently deliver to another account):

```sh
node -e "import(String.raw`PLUGIN_ROOT/hooks/codex-outbox.mjs`.replace(/\\/g,'/')).then(m => m.rebindCodexOutbox({ pluginData: process.env.CODEX_PLUGIN_DATA, apiKey: process.env.ITSUKI_API_KEY }).then(r => console.log(r)))"
```

replacing `PLUGIN_ROOT` with the installed plugin root and `CODEX_PLUGIN_DATA`
with the plugin-data directory Codex assigns the plugin. Review quarantined
envelopes before deciding anything is lost: each `failed/*.json` file is the
complete scrubbed capture. To retire one permanently, remove that single
reviewed `.json` file (and its `state/` sidecar) after making a private backup
of the complete `codex-outbox/v1` directory with the hooks disabled; never
remove the whole plugin-data or outbox directory. Quarantined envelopes count
toward the outbox entry bound, so an unreviewed quarantine eventually applies
visible backpressure rather than growing without limit. Note that upgrading to
this outbox layout is automatic, but an older plugin version will refuse (fail
closed, without data loss) to open an outbox that already contains the newer
`failed`/`state` directories.

Automatic lifecycle capture covers the main Codex thread only. Codex does not
emit `SessionEnd` for subagents, and this plugin does not install a
`SubagentStop` hook. SessionEnd output is advisory; local queue persistence is
the durability mechanism and the host UI is not treated as a proven
notification channel.

`ITSUKI_BASE_URL` is optional and defaults to `https://itsuki.app`. For safety,
the adapter accepts only a bare HTTPS origin; bare loopback HTTP origins are
allowed for local testing.

The hook launchers discard inherited Node preload/module-search variables and
custom TLS, key-log, and proxy variables before starting the credential-bearing
runtime. A custom CA or corporate proxy is therefore not currently supported
by automatic lifecycle delivery; use a directly reachable HTTPS service origin
or leave the lifecycle hooks disabled.

Queued captures carry only a one-way binding to the active API key and service
origin; the credential itself is never written. A different key or origin will
not receive those captures. Restore the matching configuration to resume their
delivery.

## Project identity limitation

Project scope currently uses a one-way hash of the canonical session working
directory (`cwd`), with Windows path casing normalized, plus its basename as a
display name. This isolates same-named projects at different paths and casing
variants of the same Windows path. Starting Codex in different subdirectories
or package roots of one repository therefore creates distinct project IDs. It
also does **not** guarantee continuity after a repository rename, move, or
worktree-path change. Set a stable `ITSUKI_PROJECT_ID` when that continuity is
required. It must match the service contract: a non-empty, control-free string
of at most 160 characters with no surrounding whitespace. An invalid configured
value, including an explicitly empty value, fails closed; the adapter does not
silently switch back to a path-derived identity.

This adapter is implemented and locally tested. The package has also passed
manifest validation and local marketplace discovery/install in an isolated
`CODEX_HOME`. The isolated install also confirmed that hooks remain untrusted
until reviewed. That does not establish clean-machine portability, Desktop
environment propagation, or a live hosted-service end-to-end result.
