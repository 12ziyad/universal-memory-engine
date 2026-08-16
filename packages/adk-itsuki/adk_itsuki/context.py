"""Carrying invocation identity to a method that is not given one.

``BaseMemoryService.search_memory`` receives ``(app_name, user_id, query)`` and
nothing else -- no invocation id. But ADK's ``preload_memory`` runs before
*every* model call in an invocation with the same user query, so without a
notion of "which invocation is this", a five-step tool loop is five identical
lookups.

A ContextVar solves it because contextvars are copied into every task an
invocation spawns, including the ones ADK creates internally. What it does not
solve is cleanup: a caller task that catches an exception and keeps going still
carries whatever value was set. So identity is reset explicitly on every exit
path, and defensively on entry -- never left to the task tree's lifetime.
"""

from __future__ import annotations

import threading
from contextvars import ContextVar, Token
from typing import Dict, NamedTuple, Optional


class Invocation(NamedTuple):
    """The immutable facts about one run, captured before anything else."""

    invocation_id: str
    app_name: str
    user_id: str
    session_id: str
    root_agent: str
    root_branch: str


CURRENT: ContextVar[Optional[Invocation]] = ContextVar("itsuki_adk_invocation", default=None)


class TokenRegistry:
    """Reset tokens, held per invocation.

    Service-owned rather than loop-owned: a synchronous ``Runner.run()`` gets a
    fresh event loop every call, so anything kept per loop would evaporate
    between runs.
    """

    def __init__(self, limit: int = 512) -> None:
        self._tokens: Dict[str, "Token[Optional[Invocation]]"] = {}
        self._order: list[str] = []
        self._lock = threading.Lock()
        self._limit = limit
        self.cleared_stale = 0
        self.abandoned = 0

    def enter(self, invocation: Invocation) -> None:
        """Install identity, clearing anything the caller task still carried."""
        if CURRENT.get() is not None:
            # A caller that caught an error and continued in the same task
            # still has the previous invocation's value. Clearing here is what
            # makes consecutive invocations independent.
            CURRENT.set(None)
            self.cleared_stale += 1
        token = CURRENT.set(invocation)
        with self._lock:
            self._tokens[invocation.invocation_id] = token
            self._order.append(invocation.invocation_id)
            while len(self._order) > self._limit:
                stale = self._order.pop(0)
                if self._tokens.pop(stale, None) is not None:
                    self.abandoned += 1

    def exit(self, invocation_id: str) -> None:
        """Remove identity on any exit path: success, error, or cancellation."""
        with self._lock:
            token = self._tokens.pop(invocation_id, None)
            if invocation_id in self._order:
                self._order.remove(invocation_id)
        if token is not None:
            try:
                CURRENT.reset(token)
                return
            except ValueError:
                # The token belongs to a different context (the callback ran in
                # another task than this one). Clearing the value directly is
                # the correct fallback.
                pass
        CURRENT.set(None)

    def rollback(self, invocation_id: str) -> None:
        """Undo a half-finished enter()."""
        self.exit(invocation_id)

    def size(self) -> int:
        with self._lock:
            return len(self._tokens)


def current() -> Optional[Invocation]:
    return CURRENT.get()
