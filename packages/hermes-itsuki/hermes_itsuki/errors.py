"""What a failure means, and what to do about it.

Two decisions live here and nowhere else: which class a failure belongs to, and
whether that class should count against the circuit breaker. Getting the second
one wrong is expensive in opposite directions -- counting 429s would open the
breaker exactly when the service is telling us to slow down and try again, and
not counting timeouts would let a dead endpoint absorb every turn forever.
"""

from __future__ import annotations

import time
from typing import Any, Callable, Optional, Tuple

# Classes mirror the TypeScript kernel's taxonomy so the two halves of the
# product describe the same failure with the same word.
UNAUTHORIZED = "unauthorized"
FORBIDDEN = "forbidden"
NOT_FOUND = "not_found"
IDEMPOTENCY_CONFLICT = "idempotency_conflict"
ERASED = "erased"
PAYLOAD_TOO_LARGE = "payload_too_large"
RATE_LIMITED = "rate_limited"
QUOTA_EXHAUSTED = "ai_quota_exhausted"
CAPACITY_PAUSED = "ai_capacity_paused"
QUEUE_FULL = "queue_full"
SERVICE_ERROR = "service_error"
NETWORK = "network"
TIMEOUT = "timeout"
BAD_REQUEST = "bad_request"
UNKNOWN = "unknown"

#: Transport-shaped failures. These are the only ones that count toward the
#: breaker: they mean "we cannot reach a working service", which is the state
#: the breaker exists to stop hammering.
_BREAKER_CLASSES = frozenset({TIMEOUT, NETWORK, SERVICE_ERROR})

#: Failures that will never succeed on replay. Retrying them is pure noise.
TERMINAL_CLASSES = frozenset(
    {UNAUTHORIZED, FORBIDDEN, NOT_FOUND, IDEMPOTENCY_CONFLICT, ERASED, BAD_REQUEST, PAYLOAD_TOO_LARGE}
)


def classify(error: BaseException) -> Tuple[str, Optional[float]]:
    """Map an SDK exception to ``(error_class, retry_after_seconds)``.

    Server ``code`` wins over HTTP status: the service names its own condition
    (``idempotency_conflict`` and the post-deletion ``erased`` fence are both
    409s that mean completely different things), and only the code can tell
    them apart.
    """
    status = _int(getattr(error, "status", None))
    code = getattr(error, "code", None)
    code = code.strip().lower() if isinstance(code, str) else ""
    retry_after = _float(getattr(error, "retry_after", None))

    if code in (
        IDEMPOTENCY_CONFLICT,
        QUOTA_EXHAUSTED,
        CAPACITY_PAUSED,
        QUEUE_FULL,
    ):
        return code, retry_after
    if code in ("erased", "source_erased", "write_erased"):
        return ERASED, None
    if code == "insufficient_scope":
        return FORBIDDEN, None

    if status is not None:
        if status == 401:
            return UNAUTHORIZED, None
        if status == 403:
            return FORBIDDEN, None
        if status == 404:
            return NOT_FOUND, None
        if status == 409:
            # A 409 with no recognised code is still a conflict, and a
            # conflict is a failure to investigate -- never a silent success.
            return IDEMPOTENCY_CONFLICT, None
        if status == 413:
            return PAYLOAD_TOO_LARGE, None
        if status == 429:
            return RATE_LIMITED, retry_after
        if 500 <= status < 600:
            return SERVICE_ERROR, retry_after
        if 400 <= status < 500:
            return BAD_REQUEST, None

    name = type(error).__name__.lower()
    if "timeout" in name:
        return TIMEOUT, None
    if "connect" in name or "network" in name or "transport" in name:
        return NETWORK, None
    return UNKNOWN, None


class Breaker:
    """Stop calling a service that is not answering.

    Deliberately simple: consecutive transport failures open it, one success
    closes it, and an authentication failure opens it immediately because
    retrying a revoked key is a storm with no possible payoff.
    """

    __slots__ = ("threshold", "cooldown", "_failures", "_open_until", "_defer_until", "_clock")

    def __init__(
        self, threshold: int = 5, cooldown: float = 120.0, clock: Callable[[], float] = time.monotonic
    ) -> None:
        self.threshold = threshold
        self.cooldown = cooldown
        self._failures = 0
        self._open_until = 0.0
        self._defer_until = 0.0
        self._clock = clock

    def allows(self) -> bool:
        """True when a wire call may be attempted right now."""
        now: float = self._clock()
        return bool(now >= self._open_until and now >= self._defer_until)

    def record_success(self) -> None:
        self._failures = 0
        self._open_until = 0.0

    def record_failure(self, error_class: str, retry_after: Optional[float] = None) -> None:
        if error_class in (UNAUTHORIZED, FORBIDDEN):
            # No amount of waiting fixes a revoked or unscoped key, but
            # hammering it does produce a retry storm. Open at once and let
            # the doctor tell the operator what to fix.
            self._failures = self.threshold
            self._open_until = self._clock() + self.cooldown
            return
        if error_class in (RATE_LIMITED, CAPACITY_PAUSED, QUEUE_FULL):
            # The service is up and telling us when to come back. That is not
            # a fault, so it must not count toward the breaker -- it only
            # defers the next attempt.
            self._defer_until = self._clock() + (retry_after if retry_after and retry_after > 0 else 60.0)
            return
        if error_class not in _BREAKER_CLASSES:
            return
        self._failures += 1
        if self._failures >= self.threshold:
            self._open_until = self._clock() + self.cooldown

    @property
    def state(self) -> str:
        now: float = self._clock()
        if now < self._open_until:
            return "open"
        if now < self._defer_until:
            return "deferred"
        return "closed"


def counts_toward_breaker(error_class: str) -> bool:
    return error_class in _BREAKER_CLASSES


def _int(value: Any) -> Optional[int]:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _float(value: Any) -> Optional[float]:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None
