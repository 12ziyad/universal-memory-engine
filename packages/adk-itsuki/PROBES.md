# adk-itsuki — measured evidence

Run against `google-adk` **2.5.0** and **2.7.0**, both installed from PyPI into
throwaway virtualenvs. The Runner, App, plugin manager, AgentTool,
SequentialAgent and Event/Session types in these tests are the host's own; only
the model and the memory backend are stand-ins.

## What ADK actually does

| Claim | How it was checked | Result |
|---|---|---|
| Nothing in ADK calls `add_session_to_memory` | Exhaustive scan of the release tree; the only shipped call sites are `Context.add_session_to_memory` (an app-invoked convenience) and the `PATCH /apps/…/memory` endpoint | **Confirmed.** Automatic capture is the gap this package fills |
| `on_run_error_callback` does not exist before 2.5.0 | Downloaded `plugins/base_plugin.py` at v2.0.0…v2.7.0 and grepped | **Confirmed.** Absent at 2.0.0–2.4.0, present from 2.5.0 — this is why the floor is 2.5.0 |
| `after_run` gains its `run_error` guard at 2.5.0 | Same bisect over `runners.py`: 1 call site at 2.0/2.1, 2 from 2.2, the current `finally:` + `if run_error is None:` shape from 2.5 | **Confirmed** |
| The memory contract itself is unchanged across the range | `diff` of `base_memory_service.py` and `memory_entry.py` at 2.5.0 vs 2.7.0 | **Byte-identical.** Raising the floor costs nothing |
| `AgentTool` forwards plugins into a child run **by default** | `inspect.signature(AgentTool.__init__)` on the installed host: `include_plugins: bool = True` | **Confirmed** — the ownership guard is mandatory, not defensive |
| Session state must be written through the delta channel | Wrote a marker to `session.state` directly, re-fetched the session: gone. Wrote via `callback_context.state`: persisted | **Confirmed** (defect ATTR-A02) |

## Gates run against a real Runner

| Gate | Assertion | Result |
|---|---|---|
| A-MAIN | one capture per invocation, roles `["user","assistant"]`, the model's answer present | **PASS** |
| A-AGENTTOOL | `AgentTool(include_plugins=True)` with a sentinel argument | **PASS** — child run refused by the guard, sentinel absent from every wire body |
| A-FOREIGN | plugin bound to service A, Runner wired to service B | **PASS** — neither service receives a write; there is no fallback path |
| A-SEQ | root is a `SequentialAgent` | **PASS** — only root-authored final output captured; `step_one`/`step_two` output absent |
| A-ATTR | attribution marker after a real run | **PASS** — persisted in session state, `root == "root_agent"` |
| A-RECALL | two turns with `preload_memory` attached | **PASS** — 2 recalls, 2 captures |
| A-FAILOPEN | memory backend raising on every call | **PASS** — the turn still produces events |

## Gates run deterministically (both host versions)

| Gate | Result |
|---|---|
| A-EXIT — `asyncio.run` unwinds while a transport hangs forever | **PASS** in a subprocess, well inside the deadline. This is the hazard that makes daemon-thread transport non-negotiable: `asyncio.run` cancels *and awaits* pending tasks |
| A-DEDUP — five preload calls in one invocation | **PASS** — 1 wire call, 4 cache hits |
| A-DEDUP — two invocations, identical prompt | **PASS** — 2 wire calls |
| A-CANCEL — identity after success, after error, after cancellation, and with a stale value already in the caller's context | **PASS** — no leak into the next invocation in the same task |
| A-CANON — reversed and duplicated delta feeds | **PASS** — byte-identical chunks and keys |
| A-REPLAY — automatic capture then full-session re-import | **PASS** — identical idempotency keys |
| A-RETRYRUNS — capture fails, then drains on a later call with a fresh loop | **PASS** — state is service-owned, not loop-owned |
| A-SHUTDOWN — submit-after-close, double close, close under a wedged worker | **PASS** — terminal errors, no hang; the client is deliberately leaked and counted rather than closed under an in-flight request |
| Settled predicate — no answer / error_code / partial-only / unresolved long-running tool / tool-only | **PASS** — none captured |
| Fail-closed — delta without a session id, invocation without an attribution marker | **PASS** — counted skips, no writes |

**Suite: 37 passed on google-adk 2.5.0 and 37 passed on 2.7.0.**
`mypy --strict`: clean.

## Packaging

Wheel reviewed by name: 17 entries, `_kernel.py` and `py.typed` present,
LICENSE present, no credential-shaped strings, no destructive call sites.

## Defects found and fixed

| ID | Severity | What it was |
|---|---|---|
| CAP-A01 | HIGH | Events sharing a timestamp were ordered by id, so a capture stored the assistant's answer before the user's question — and the same invocation could yield different idempotency keys depending on how ids sorted |
| ATTR-A02 | HIGH | The root-attribution marker was written to `session.state` directly, which does not persist. Every later import would have failed closed and captured nothing |

## Held / not claimed

- **No production canary**; every proof used a recording client.
- **Capture is durable to process life, not across restarts** — recovery is an explicit, idempotent re-import.
- **ADK 1.x unsupported**; **`add_memory` not implemented**; the `itsuki://` URI route is a **partial** installation (service only, no preload tool, no plugin).
