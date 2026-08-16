"""Failure handling, and the one thing a memory plugin must never do: hang.

The server distinguishes three outcomes that all arrive as HTTP 409, and they
mean opposite things -- an exact replay is a success, a same-key-different-body
is a defect worth a human's attention, and a post-deletion replay is a fence
that must never be retried. Conflating them is how a memory system either loses
writes or resurrects deleted ones.
"""

from __future__ import annotations

import subprocess
import sys
import textwrap
import time

import pytest

from hermes_itsuki.errors import (
    Breaker,
    ERASED,
    IDEMPOTENCY_CONFLICT,
    NETWORK,
    RATE_LIMITED,
    SERVICE_ERROR,
    TIMEOUT,
    UNAUTHORIZED,
    classify,
    counts_toward_breaker,
)


class ApiError(Exception):
    def __init__(self, status=None, code=None, retry_after=None):
        super().__init__(code or str(status))
        self.status = status
        self.code = code
        self.retry_after = retry_after


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


@pytest.mark.parametrize(
    "error,expected",
    [
        (ApiError(status=401), UNAUTHORIZED),
        (ApiError(status=403), "forbidden"),
        (ApiError(status=404), "not_found"),
        (ApiError(status=409), IDEMPOTENCY_CONFLICT),
        (ApiError(status=409, code="idempotency_conflict"), IDEMPOTENCY_CONFLICT),
        (ApiError(status=409, code="erased"), ERASED),
        (ApiError(status=413), "payload_too_large"),
        (ApiError(status=429), RATE_LIMITED),
        (ApiError(status=503), SERVICE_ERROR),
        (ApiError(status=400), "bad_request"),
    ],
)
def test_server_conditions_are_classified_by_code_then_status(error, expected):
    assert classify(error)[0] == expected


def test_the_deletion_fence_is_never_confused_with_a_conflict():
    """Both are 409s; only the code says whether a replay could ever work."""
    assert classify(ApiError(status=409, code="erased"))[0] == ERASED
    assert classify(ApiError(status=409))[0] == IDEMPOTENCY_CONFLICT


def test_only_transport_failures_count_toward_the_breaker():
    assert counts_toward_breaker(TIMEOUT)
    assert counts_toward_breaker(NETWORK)
    assert counts_toward_breaker(SERVICE_ERROR)
    # The service answering "slow down" is not the service being broken.
    assert not counts_toward_breaker(RATE_LIMITED)
    assert not counts_toward_breaker(IDEMPOTENCY_CONFLICT)


def test_breaker_opens_after_five_transport_failures_and_recovers():
    clock = Clock()
    breaker = Breaker(clock=clock)
    for _ in range(4):
        breaker.record_failure(TIMEOUT)
    assert breaker.allows(), "four failures is not yet a pattern"
    breaker.record_failure(TIMEOUT)
    assert not breaker.allows()
    clock.advance(121)
    assert breaker.allows(), "the breaker must probe again after its cooldown"


def test_a_revoked_key_opens_the_breaker_immediately():
    """Retrying a revoked credential is a storm with no possible payoff."""
    breaker = Breaker(clock=Clock())
    breaker.record_failure(UNAUTHORIZED)
    assert not breaker.allows()


def test_rate_limiting_defers_without_opening_the_breaker():
    clock = Clock()
    breaker = Breaker(clock=clock)
    breaker.record_failure(RATE_LIMITED, retry_after=7)
    assert not breaker.allows()
    assert breaker.state == "deferred"
    clock.advance(8)
    assert breaker.allows()


def test_success_clears_the_failure_streak():
    breaker = Breaker(clock=Clock())
    for _ in range(4):
        breaker.record_failure(TIMEOUT)
    breaker.record_success()
    for _ in range(4):
        breaker.record_failure(TIMEOUT)
    assert breaker.allows()


def test_the_process_exits_while_the_transport_hangs_forever():
    """H-EXIT.

    concurrent.futures workers are non-daemon and are joined at interpreter
    exit, so a lookup that never returns would keep the whole agent alive.
    This is the test that makes that regression impossible to merge.
    """
    script = textwrap.dedent(
        """
        import sys, time
        sys.path.insert(0, %r)
        from hermes_itsuki.recall import EchoIndex, RecallEngine

        def never_returns(_query):
            time.sleep(3600)

        engine = RecallEngine(never_returns, budget=0.2)
        engine.allocate()
        engine.result_for("a question that never gets answered", "scope", EchoIndex())
        print("turn-completed")
        sys.exit(0)
        """
    ) % str(__import__("pathlib").Path(__file__).resolve().parents[1])

    started = time.monotonic()
    result = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, text=True, timeout=20
    )
    elapsed = time.monotonic() - started

    assert "turn-completed" in result.stdout
    assert result.returncode == 0
    assert elapsed < 10, f"interpreter took {elapsed:.1f}s to exit with a hung transport"
