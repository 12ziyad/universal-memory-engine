# adk-itsuki — implementation record

Built against `google-adk` **2.5.0** (the declared floor) and **2.7.0**, both
installed from PyPI and both exercised by the full suite.

## Why the floor is 2.5.0, not 2.0

Bisecting `runners.py` and `plugins/base_plugin.py` across every 2.x tag:
`on_run_error_callback` does not exist before 2.5.0, and the `after_run`
invocation only acquires its `finally:` + `if run_error is None:` structure at
2.5.0. Below that, automatic capture and identity cleanup cannot be built at
all. `base_memory_service.py` and `memory_entry.py` are byte-identical between
2.5.0 and 2.7.0, so the raise costs nothing on the memory contract itself.

## Divergences from the report

### D-1 — the attribution marker goes through the state *delta* channel *(material)*

The report said to persist the root-agent marker in `session.state`. Writing it
there directly does not survive: the session service hands out copies, so the
mutation is invisible to the next read. The marker is now written from
`before_agent_callback` via `callback_context.state`, which records a delta the
session service persists — verified by re-fetching the session after a real run.

### D-2 — canonical event order is timestamp-only *(material, defect-driven)*

The report specified `(timestamp, event.id)`. Events inside one invocation
routinely share a timestamp, and then the id decided the order — which put the
agent's answer before the user's question, and made the idempotency key depend
on how ids happened to sort. Python's sort is stable, so ordering by timestamp
alone preserves the sequence the session persisted.

### D-3 — no `AsyncMemoryClient` anywhere *(as overridden)*

`asyncio.run` cancels *and awaits* pending tasks, so uncooperative work left on
`Runner.run()`'s private loop hangs the synchronous call forever. Every wire
call runs on package-owned daemon threads with the sync client and is awaited
through `wrap_future`; abandoning one is always safe. This also removes the
loop-ownership problem entirely — there is no primary loop and no `bind()`.

## Defects found and fixed

| ID | Severity | Defect |
|---|---|---|
| CAP-A01 | HIGH | Same-timestamp events were ordered by id, so a capture could store the assistant's answer before the user's question, and the same invocation could produce different idempotency keys depending on id ordering. Found by the first real-Runner test |
| ATTR-A02 | HIGH | The root-attribution marker was written to `session.state` directly and did not persist, so any later import would have failed closed and silently captured nothing. Found by re-reading the session after a real run |

## Files

`adk_itsuki/{__init__,service,plugin,registry,capture,context,transport,identity,config,sanitize,errors}.py`
plus the vendored `_kernel.py` and `py.typed`. Tests in
`tests/test_{capture,runtime,host_contract}.py`.

## Gates

37 tests green on google-adk 2.5.0 **and** 2.7.0 · `mypy --strict` clean ·
two runtime dependencies · wheel contents reviewed by name (17 entries, no
credential strings, no destructive call sites) · A-EXIT proves a synchronous
`Runner.run()` still unwinds while a transport hangs forever.


## Independent audit (Fable, 2026-08-16) — findings and repairs

Audited from `1685dce`; every finding fixed with a regression that fails
against the defective code.

| ID | Severity | Finding | Fix |
|---|---|---|---|
| AUDIT-01 | HIGH | (shared with hermes-itsuki — errors.py is duplicated per package) real SDK transport failures (`status=0`, `code="timeout"/"transport_error"`) classified UNKNOWN, so the breaker never opened | same classifier fix; regression with real `MemoryAPIError` shapes |
| AUDIT-02 | HIGH | A call abandoned at OUR deadline surfaces as `TimeoutError` from the daemon pool — and that path skipped the breaker in both `search_memory` and `drain`, so a wedged service was retried at full price on every recall forever | deadline timeouts now count toward the breaker (`TransportClosed` — our own shutdown — deliberately does not); regression: five deadline-hung recalls open the breaker |
| AUDIT-04 | MEDIUM | `before_agent_callback` had no ownership guard: in a foreign run (AgentTool child, other-service runner) it fell back to `agent.name` and would have written an attribution marker into a session we do not own, recording a CHILD as root | marker writes now require the invocation to have passed the before_run guard (`_pending_root`); regression: an unguarded invocation leaves state untouched |
| AUDIT-05 | MEDIUM (CI honesty) | `publish-pypi.yml` never installed the pinned hosts, so the promised floor legs (hermes-agent 0.19.0; google-adk 2.5.0) did not actually run in CI | additive per-package steps install the pinned floor and run the suite against it before the current-version run; existing packages' arms untouched |

Also added this audit: a **100-concurrent-session cross-tenant attack** (10
users x 10 sessions in flight at once; every wire body asserted to carry
exactly its own derived user + session, no other user's text anywhere).

Post-audit gates: **42 passed on google-adk 2.5.0 AND 2.7.0**, `mypy --strict`
clean, wheel rebuilt and clean-room reinstalled.
