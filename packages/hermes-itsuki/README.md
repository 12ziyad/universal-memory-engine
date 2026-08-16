# hermes-itsuki

Itsuki memory for [Hermes Agent](https://github.com/NousResearch/hermes-agent):
bounded recall before every real turn, exactly-once capture after every settled
one.

> **Status: unpublished.** This package has not been released to PyPI. The
> install commands below will not work yet.

## What it does

- **Recalls before the turn.** One bounded lookup per genuinely new human turn,
  injected as clearly-marked untrusted data. Trivial prompts ("ok", "thanks")
  cost nothing at all.
- **Captures after the turn.** The user's message and the assistant's answer,
  written to a durable spool *before* any network call, then delivered under a
  content-derived idempotency key so retries and replays collapse into one
  memory.
- **Fails open.** A memory outage costs context, never the answer. The turn
  proceeds untouched.

## Requirements

| | |
|---|---|
| Hermes Agent | **0.19.0 or newer** |
| Python | 3.11 – 3.13 (the host's own range) |
| Runtime dependencies | `itsuki` only |

## Install

```bash
pip install hermes-itsuki
hermes-itsuki install
hermes memory setup      # choose itsuki, paste your key
```

`hermes-itsuki install` copies the provider into `$HERMES_HOME/plugins/itsuki/`
and makes sure the `itsuki` SDK is importable by Hermes. That location is not an
implementation detail: hermes-agent 0.19.0 has no entry-point discovery at all,
and the official installer's update path (`git pull` + `uv sync --locked`)
prunes anything not in the host's own lockfile. Deploying outside the venv is
what makes the provider survive `hermes update`.

## Commands

| Command | What it does |
|---|---|
| `hermes-itsuki install` | Deploy (or refresh) the provider and the SDK |
| `hermes-itsuki doctor` | Check every piece; `--fix` reinstalls a pruned SDK |
| `hermes-itsuki uninstall` | Remove the provider, keep your pending memories |
| `hermes-itsuki uninstall --purge` | Also delete `itsuki.json` and the spool |

The agent can also call two read-only tools: `itsuki_recall` and
`itsuki_status`.

## Configuration

`hermes memory setup` prompts for everything. The key is a secret field, so
Hermes stores it in `~/.hermes/.env` as `ITSUKI_API_KEY`; this package only ever
reads it from the environment. Everything else lands in
`$HERMES_HOME/itsuki.json`:

| Key | Default | Meaning |
|---|---|---|
| `base_url` | `https://itsuki.app` | Service address |
| `user_id` | — | Optional sub-space, or a namespace on a gateway |
| `capture` | `auto` | `off` disables automatic capture entirely |
| `recall` | `auto` | `off` disables automatic recall entirely |

## What is deliberately not done

- **No memory-writing tool.** The agent can read, never write, update, or
  delete. Automatic capture already stores what the person actually saw; a
  model-callable write would put model-authored text into durable memory with
  no human attribution.
- **Nothing is contributed to context compression.** `on_pre_compress` returns
  nothing on purpose: its return value goes into a model prompt, and feeding
  stored content there would bypass the very fence that makes recalled memory
  safe.
- **Subagent work is not captured.** Hermes runs delegations with
  `skip_memory=True` and gives them no provider session; the parent's own
  settled turns are captured normally.
- **`queue_prefetch` is a no-op.** The host passes it the turn that just
  *finished*, so warming a cache with it would either answer the next question
  with the previous one's memories or spend a second lookup for nothing.

## Honest limits

- **Echo suppression is bounded.** Text we injected is not written back while
  its fingerprint is live — up to 512 entries, up to 30 minutes. After eviction
  or expiry the same text can be captured again, and paraphrases were never
  covered.
- **The spool is bounded.** 64 envelopes, 8 MiB, 14 days. Past that the oldest
  is dropped and the loss is counted and reported by `doctor` — durable within
  documented bounds, not lossless.
- **Key rotation orphans pending work.** Envelopes are partitioned by a one-way
  hash of the credential, so a re-keyed install never drains yesterday's
  conversations into a different project. Those envelopes are quarantined and
  counted rather than delivered.
- **Uninstall leaves the SDK.** Package metadata cannot prove nothing else in
  that environment imports `itsuki`, so removing it would be a guess.

## Licence

Apache-2.0.
