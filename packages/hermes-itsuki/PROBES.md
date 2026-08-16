# hermes-itsuki — measured evidence

Everything here was run, not reasoned about. Where a measurement contradicted
the host's documentation, the measurement won and the design changed.

Baseline: branch `feat/native-hermes-adk` from `7148ca3`. Host under test:
**hermes-agent 0.19.0** installed from PyPI into a throwaway virtualenv, plus
the repository at tag `v2026.8.13` read from source.

---

## What the host actually does (source- and runtime-verified)

| Claim | How it was checked | Result |
|---|---|---|
| `on_turn_start` fires **before** the host's trivial-prompt gate | `agent/turn_context.py` at main: `on_turn_start(...)` is called unconditionally, then `prefetch_all` is guarded by `is_trivial_prompt` | **Confirmed.** A provider that starts work in `on_turn_start` sees "ok" and "thanks", so the gate is repeated in the provider |
| `prefetch` receives scaffolding-stripped text, `on_turn_start` does not | `memory_manager.prefetch_all` calls `_strip_skill_scaffolding(query)` before dispatching | **Confirmed.** The question is taken from `prefetch`; the raw message is used only for the trivial gate |
| The host strips a real `/skill` expansion | Composed a message from the host's own `_SKILL_INVOCATION_PREFIX` / `_SINGLE_SKILL_MARKER` / `_SINGLE_SKILL_INSTRUCTION` constants and passed it through `extract_user_instruction_from_skill_message` | **Confirmed.** Body → dropped, instruction → `"what is my deploy step"`. A bare invocation returns `None`, so providers are never called |
| `queue_prefetch` receives the turn that just completed | `run_agent._sync_external_memory_for_turn` calls `queue_prefetch_all(user_text)` after `sync_all` | **Confirmed.** Implemented as a deliberate no-op |
| Interrupted turns never reach `sync_turn` | `run_agent._sync_external_memory_for_turn` returns early on `interrupted` (#15218) and requires a finalised response | **Confirmed.** Settlement is host-gated; our checks are defence in depth |
| Subagents have no provider session | `memory_provider.on_delegation` docstring, and `run_agent` spawning delegates with `skip_memory=True` | **Confirmed.** `on_delegation` writes nothing |
| PyPI 0.19.0 has no entry-point discovery | Unzipped `hermes_agent-0.19.0-py3-none-any.whl`; `plugins/memory/__init__.py` scans bundled + `$HERMES_HOME/plugins/` only | **Confirmed.** Zero occurrences of `hermes_agent.memory_providers`. This is why the installer deploys a directory plugin |
| 0.19.0 lacks `RecallStatus` / `is_trivial_prompt` | `python -c "import agent.memory_provider"` against the installed floor | **Confirmed** — both absent, both guarded in our code |
| The host venv is uv-managed and its update prunes extras | `scripts/install.sh` (`uv venv`, `uv sync --extra all --locked`) and `install.ps1` (`$env:LOCALAPPDATA\hermes\hermes-agent`, venv recreated on reinstall) | **Confirmed.** Installer is uv-first and never assumes pip |
| Lazy dependency install cannot heal a third-party SDK | `tools/lazy_deps.py`: `LAZY_DEPS` is a hardcoded allowlist and `ensure()` refuses anything absent from it | **Confirmed.** `hermes-itsuki doctor` is the heal path |

---

## Gates run against the real host

Driven through the host's own `MemoryManager` — not a stub of it.

| Gate | Assertion | Result |
|---|---|---|
| H-MAIN | one recall per turn, fenced block injected, capture carries exactly the user/assistant pair | **PASS** (1 search, 1 write, roles `["user","assistant"]`) |
| H-TRIVIAL | `"ok"`, `"thanks"`, `"yes"` through the real manager | **PASS** — 0 wire calls |
| H-SKILL | a genuine skill expansion | **PASS** — body absent from every wire query; only `"what is my deploy step"` travelled |
| H-SKILL (bare) | bare `/skill` with no instruction | **PASS** — 0 wire calls |
| H-MEMO | same query, same turn number, immediately after a session switch | **PASS** — 2 searches; the previous turn's memo is never reused |
| H-SCOPE | recall request contents | **PASS** — no `conversation_id` on any recall |
| H-DUP | three identical settled turns | **PASS** — 1 idempotency key |
| ABC conformance | `isinstance(provider, MemoryProvider)`, no unimplemented abstract methods | **PASS** |

## Gates run deterministically (both host legs)

| Gate | Result |
|---|---|
| H-EXIT — subprocess with a forever-hung transport calls `sys.exit(0)` | **PASS**, exits in well under 5 s. This is what makes the "no `ThreadPoolExecutor`" rule enforceable |
| H-ECHO / H-ECHO-CAP / H-ECHO-TTL — suppression in bounds, then fail-open on eviction and expiry, both counted | **PASS** |
| H-AUTH — a second credential sees an empty spool; the first key's partition is listed as foreign and never drained | **PASS** |
| H-POISON — stored fence markers, ANSI, bidi, zero-width, role delimiters | **PASS** — fence holds, content preserved |
| H-INSTALL — install → doctor → refresh → uninstall (state kept) → purge (state **and** `itsuki.json` gone) | **PASS** |
| Idempotency semantics — exact replay vs `idempotency_conflict` vs `erased` | **PASS** — conflict and erased quarantine, never counted as success |

**Suite: 123 passed / 1 skipped against real hermes-agent 0.19.0; 114 passed /
10 skipped without a host** (the 9 host-contract tests skip themselves, plus a
POSIX-permissions test on Windows). `mypy --strict`: clean.

## Packaging

- Wheel contents reviewed by name: 12 modules, `_kernel.py`, `py.typed`, LICENSE, entry point `itsuki = hermes_itsuki:register`. No credential-shaped strings, no destructive call sites, no postinstall.
- **Clean-room**: fresh venv, wheel only → `import hermes_itsuki` succeeds, the entry point is discoverable, `register()` raises a named `ImportError` without a host, and `itsuki` resolves as the single runtime dependency.

## Defects found and fixed

| ID | Severity | What it was |
|---|---|---|
| SEC-H01 | HIGH | The role-delimiter guard anchored on a bare token, so `<\|im_start\|>system` — the most common real chat-template shape — was not quoted as data. Found by its own adversarial test on the first run |
| REL-H01 | HIGH | Query identity used the kernel's echo canonicaliser, which returns nothing for short lines. Two different short questions therefore compared equal, and the second would have been answered with the first one's memories |

## Held / not claimed

- **Gateway multi-user tenancy is code-proven, not live-proven.** Per-sender partitioning has unit coverage; no Telegram or Discord run happened (no platform credentials in this campaign).
- **No production canary.** Nothing in this campaign touched the live service; every proof used a loopback recording client.
- **macOS**: no runner, no claim.
