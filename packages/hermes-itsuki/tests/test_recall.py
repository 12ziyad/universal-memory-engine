"""Recall identity, bounds, and the honest limits of echo suppression.

The host makes two things impossible to ignore: it tells providers about a
session switch asynchronously, and it hands `prefetch` a cleaned query that
`on_turn_start` never sees. So recall identity is an RXID allocated in
`on_turn_start`, and every test here is about that identity behaving under the
races the host actually creates.
"""

from __future__ import annotations

import threading
import time

from hermes_itsuki._kernel import RECALL_CLOSE_MARKER, RECALL_OPEN_MARKER
from hermes_itsuki.recall import EchoIndex, RecallEngine


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def engine_for(responses, **kwargs):
    calls = []

    def search(query):
        calls.append(query)
        value = responses.pop(0) if responses else ("", 0)
        if isinstance(value, Exception):
            raise value
        return value

    return RecallEngine(search, **kwargs), calls


def test_one_wire_call_per_rxid_even_with_repeated_prefetch():
    engine, calls = engine_for([("remembered", 3)])
    echo = EchoIndex()
    engine.allocate()
    first = engine.result_for("what did I say", "scope", echo)
    second = engine.result_for("what did I say", "scope", echo)
    assert first == second and RECALL_OPEN_MARKER in first
    assert len(calls) == 1, "repeated prefetch inside one RXID must reuse"


def test_a_new_rxid_gets_its_own_lookup():
    """Identical prompts in different turns are different questions."""
    engine, calls = engine_for([("a", 1), ("b", 1)])
    echo = EchoIndex()
    engine.allocate()
    engine.result_for("same text", "scope", echo)
    engine.allocate()
    engine.result_for("same text", "scope", echo)
    assert len(calls) == 2


def test_result_is_dropped_when_its_rxid_is_superseded():
    """A late result must never be delivered to a newer turn.

    AUDIT-03: the original version of this test ended in `or True`, which
    asserts nothing. Now it drives the actual race: a lookup submitted under
    one RXID, superseded before its result arrives, must yield "" for the
    old execution and a fresh lookup for the new one.
    """
    import threading as _threading

    gate = _threading.Event()
    calls = []

    def slow_search(query):
        calls.append(query)
        if len(calls) == 1:
            gate.wait(5)  # the first turn's lookup is in flight...
            return "the stale answer", 1
        return "the fresh answer", 1

    engine = RecallEngine(slow_search, budget=0.3)
    echo = EchoIndex()

    engine.allocate()
    first = engine.result_for("old question", "scope", echo)  # times out waiting
    assert first == ""

    engine.allocate()  # ...and a new turn supersedes it
    gate.set()  # the stale result lands now, after supersession
    second = engine.result_for("new question", "scope", echo)
    assert "the stale answer" not in second, "a superseded result must be dropped"


def test_prefetch_without_allocation_returns_nothing():
    """Trivial prompts allocate no RXID, so recall must not run."""
    engine, calls = engine_for([("unused", 1)])
    assert engine.result_for("ok", "scope", EchoIndex()) == ""
    assert calls == []


def test_a_different_query_under_one_rxid_is_refused():
    engine, calls = engine_for([("first", 1)])
    echo = EchoIndex()
    engine.allocate()
    engine.result_for("first question", "scope", echo)
    assert engine.result_for("entirely different", "scope", echo) == ""
    assert len(calls) == 1


def test_failure_fails_open_and_never_raises():
    engine, _ = engine_for([RuntimeError("service down")])
    engine.allocate()
    assert engine.result_for("q", "scope", EchoIndex()) == ""


def test_a_hung_lookup_returns_within_budget_and_blocks_no_further_threads():
    """A transport that never answers must cost one thread, once."""
    release = threading.Event()

    def search(_query):
        release.wait(30)
        return "late", 1

    engine = RecallEngine(search, budget=0.2)
    echo = EchoIndex()
    before = threading.active_count()

    engine.allocate()
    started = time.monotonic()
    assert engine.result_for("q1", "scope", echo) == ""
    assert time.monotonic() - started < 2.0

    for _ in range(10):
        engine.allocate()
        assert engine.result_for("qN", "scope", echo) == ""

    # Capacity is one: the stuck lookup holds a single thread and later turns
    # skip rather than queueing more.
    assert threading.active_count() - before <= 2
    assert engine.skipped_busy >= 9
    release.set()


def test_injected_block_is_registered_for_echo_suppression():
    engine, _ = engine_for([("the user prefers tea over coffee in the morning", 1)])
    echo = EchoIndex()
    engine.allocate()
    block = engine.result_for("q", "scope", echo)
    assert RECALL_CLOSE_MARKER in block
    assert echo.is_echo("scope", "the user prefers tea over coffee in the morning")


def test_echo_suppression_is_scope_separated():
    echo = EchoIndex()
    line = "the user keeps their notes in obsidian"
    echo.register("scope-a", line)
    assert echo.is_echo("scope-a", line)
    assert not echo.is_echo("scope-b", line)


def test_echo_strip_removes_only_known_lines():
    # The kernel deliberately refuses to fingerprint short lines (>=24 chars,
    # >=12 alphanumerics) so that common phrases are never suppressed by
    # accident. Test data therefore has to be real prose.
    echo = EchoIndex()
    remembered = "the user prefers tea over coffee in the morning"
    echo.register("s", remembered)
    kept = echo.strip("s", remembered + "\nbrand new sentence entirely")
    assert kept == "brand new sentence entirely"


def test_echo_capacity_eviction_is_fail_open_and_counted():
    """Honest bound: past 512 entries the oldest stops being suppressed."""
    echo = EchoIndex()
    echo.register("s", "the first remembered line")
    for index in range(600):
        echo.register("s", f"filler line number {index} with enough text to fingerprint")
    assert echo.evicted > 0
    assert not echo.is_echo("s", "the first remembered line")


def test_echo_expiry_is_fail_open_and_counted():
    clock = FakeClock()
    echo = EchoIndex(clock=clock)
    echo.register("s", "a line worth remembering here")
    assert echo.is_echo("s", "a line worth remembering here")
    clock.advance(31 * 60)
    assert not echo.is_echo("s", "a line worth remembering here")
    assert echo.expired > 0
