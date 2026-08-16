# hermes-itsuki — implementation record

Built from the frozen architecture report (v2.3 plus the nine overriding
corrections applied before implementation), against hermes-agent **0.19.0**
(PyPI, the declared floor) and the repository at tag `v2026.8.13`.

## Divergences from the report, each forced by evidence

### D-1 — recall sends no `conversation_id` at all *(material)*

The report had recall bound to the session. Measurement killed that: the host
passes `session_id=""` into `prefetch` and delivers `on_session_switch`
asynchronously on its boundary worker, so any session-keyed recall state is
stale exactly at a boundary. Recall is therefore user-scoped and carries no
conversation binding, which makes stale-session recall structurally impossible
rather than a race we mitigate. `on_session_switch` rebinds capture scope only
and is forbidden from touching recall state.

### D-2 — no `ThreadPoolExecutor` anywhere *(material)*

`concurrent.futures` workers are non-daemon and are joined at interpreter exit,
so one forever-hung transport call would keep the whole agent from exiting.
Recall and delivery each run on a package-owned daemon thread; recall has
capacity one and skips rather than queueing. `test_reliability.py::
test_the_process_exits_while_the_transport_hangs_forever` is the gate.

### D-3 — retries are ours, both clients use `max_retries=0` *(material)*

The SDK's `timeout` is a whole-operation deadline (`deadline = monotonic() +
timeout`, each attempt clamped to `min(timeout, remaining)`), not a per-attempt
one, so `max_retries=2` would have split one budget three ways. The delivery
worker performs at most three attempts, each with a full 12 s client budget,
always under the same idempotency key. `base_url` is keyword-only — the
positional form the report showed would have been a `TypeError`.

### D-4 — the spool is partitioned by credential authority *(material)*

A single spool survives a key change, which would deliver one project's
conversations under another project's credential. Envelopes live under a
one-way hash of `(base_url, sha256(api_key))`; a re-keyed install starts empty
and the old partition is quarantined, counted and aged out, never drained.

### D-5 — `queue_prefetch` is a no-op *(as overridden)*

The host passes the turn that just completed, so warming with it would either
answer the next question with the previous one's memories or spend a second
lookup for nothing.

## Defects found and fixed

| ID | Severity | Defect |
|---|---|---|
| SEC-H01 | HIGH | The role-delimiter guard required the token to be alone on the line, so `<\|im_start\|>system` — the most common real chat-template shape — passed through unquoted and could read as a turn boundary to the model. Found by its own adversarial test on the first run; regression pinned by parametrised vectors |
| REL-H01 | HIGH | Recall identity hashed the query with the kernel's echo canonicaliser, which returns `""` for short lines. Two different short questions compared equal, so a second question inside one turn would have been answered with the first one's memories. Now a plain sha256 of the query |

## Files

`hermes_itsuki/{__init__,provider,recall,capture,spool,sanitize,errors,identity,config,installer,cli}.py`
plus the vendored `_kernel.py` and `py.typed`. Tests in
`tests/test_{sanitize,identity,recall,spool,provider,reliability,install,host_contract}.py`.

## Gates

123 tests against real hermes-agent 0.19.0 (114 without a host installed;
9 host-contract tests skip themselves) · `mypy --strict` clean · one runtime
dependency · no postinstall · wheel contents reviewed by name · clean-room
wheel-only install and import proven. Full evidence in `PROBES.md`.


## Independent audit (Fable, 2026-08-16) — findings and repairs

Audited from `1685dce`; every finding fixed with a regression that fails
against the defective code.

| ID | Severity | Finding | Fix |
|---|---|---|---|
| AUDIT-01 | HIGH | The SDK reports every transport failure as `MemoryAPIError(status=0, code="timeout"\|"transport_error")`; `classify()` knew neither the codes nor that status=0 is not an HTTP status, so real outages classified UNKNOWN and **the breaker never opened against a dead service** (reproduced: 5 real SDK timeouts, breaker still closed) | codes mapped, `status<=0` excluded from the HTTP ladder; regression built from real `MemoryAPIError` shapes |
| AUDIT-03 | MEDIUM (test integrity) | The superseded-RXID test ended in `or True` — it asserted nothing | rewritten to drive the actual race: a stale in-flight result landing after supersession must never be delivered to the new turn |
| AUDIT-06 | MEDIUM | **Windows `MoveFileEx` under simultaneous contention reports success to every racer holding an open handle** (measured: 32 threads, 32 "successful" renames of one file) — claim-by-rename alone is not mutual exclusion there, and `claim()` could return a path whose file another racer now owned | claim names are unique per claimant (`pid-seq`), ownership decided by read-back (the file exists under exactly one claimant's name); worst case before the fix was a duplicate wire delivery collapsed by the idempotency key — never a wrong-tenant or lost write |
| AUDIT-07 | MEDIUM | The spool bound check-then-write raced under concurrent staging (measured 116 > 64), and dropping one-per-stage could never bring an over-bound backlog back under | staging serialised in-process (`threading.Lock`) with trim-to-bound; cross-process enforcement is per-process-approximate and documented as such |

Also executed this audit: **P-H0 as a permanent test** — the deployed directory
plugin is discovered and loaded by the real 0.19.0 host loader
(`plugins.memory.load_memory_provider`) alongside the 8 bundled providers, with
its synthetic-package relative imports intact.

Post-audit gates: **128 passed on real hermes-agent 0.19.0** (118 on the
stub leg), `mypy --strict` clean, wheel rebuilt and clean-room reinstalled.
