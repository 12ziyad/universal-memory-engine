"""Recall: one bounded lookup per genuinely new human turn.

Three decisions here are load-bearing, and each exists because of something the
host actually does rather than something it documents.

**The identity is an RXID, not a session or a turn number.** Hermes tells a
provider about a session switch *asynchronously*, on a background worker, and it
passes ``session_id=""`` into ``prefetch``. Any recall state keyed by session is
therefore stale exactly at a boundary -- the moment it matters. A monotonic
counter allocated synchronously in ``on_turn_start`` has no such problem: it is
assigned by the same thread that is about to ask, and nothing later can change
what it identified.

**The query arrives in ``prefetch``, not in ``on_turn_start``.** The host expands
``/skill`` invocations into a model-facing message that embeds the whole skill
body, and strips that scaffolding *once*, in ``prefetch_all``, before handing the
text to providers. So ``on_turn_start``'s message is the raw expansion and must
never be sent anywhere; ``prefetch``'s argument is the user's actual instruction.

**One outstanding lookup, on a daemon thread.** ``ThreadPoolExecutor`` workers
are non-daemon and are joined at interpreter exit, so a transport that never
returns would keep the whole agent from exiting. A daemon thread can simply be
abandoned. Capacity is one: if the previous lookup is still running we skip
rather than queue, because a queue of stale lookups helps nobody.
"""

from __future__ import annotations

import itertools
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

import hashlib

from ._kernel import (
    DEFAULT_MAX_CONTEXT_CHARS,
    DEFAULT_MAX_ITEMS,
    fingerprint_echo_line,
    format_recall_block,
)
from .sanitize import sanitize_recalled_text


def _query_hash(query: str) -> str:
    """Identify a question exactly.

    Deliberately not the kernel's echo canonicaliser: that one is built for
    suppression and returns nothing for short or low-content lines, so two
    different short questions would compare equal and the second would be
    answered with the first one's memories (REL-H01).
    """
    return hashlib.sha256(query.strip().encode("utf-8")).hexdigest()

RECALL_BUDGET_SECONDS = 3.0
MAX_FINGERPRINTS = 512
FINGERPRINT_TTL_SECONDS = 30 * 60


class Execution:
    """One recall attempt, named by its RXID."""

    __slots__ = ("rxid", "query_hash", "done", "block", "count", "submitted")

    def __init__(self, rxid: int) -> None:
        self.rxid = rxid
        self.query_hash: Optional[str] = None
        self.done = threading.Event()
        self.block: Optional[str] = None
        self.count = 0
        self.submitted = False


class EchoIndex:
    """Fingerprints of lines we injected, so we never store them back.

    Bounded on purpose, and honest about it: an entry survives 512 newer
    entries or thirty minutes, whichever comes first. After that the same text
    is capturable again. This suppresses *byte-exact* echoes only -- a model
    that paraphrases a memory is writing something new, and no fingerprint can
    or should catch that.

    Keyed by user scope rather than session, because recall happens before the
    provider is told which session it is in.
    """

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._entries: Dict[Tuple[str, str], float] = {}
        self._lock = threading.Lock()
        self._clock = clock
        self.evicted = 0
        self.expired = 0

    def register(self, scope_key: str, text: str) -> int:
        added = 0
        now = self._clock()
        with self._lock:
            self._expire(now)
            for line in text.splitlines():
                fingerprint = fingerprint_echo_line(line, scope_key)
                if not fingerprint:
                    continue
                self._entries[(scope_key, fingerprint)] = now
                added += 1
            while len(self._entries) > MAX_FINGERPRINTS:
                oldest = min(self._entries, key=lambda key: self._entries[key])
                del self._entries[oldest]
                self.evicted += 1
        return added

    def is_echo(self, scope_key: str, line: str) -> bool:
        fingerprint = fingerprint_echo_line(line, scope_key)
        if not fingerprint:
            return False
        now = self._clock()
        with self._lock:
            self._expire(now)
            return (scope_key, fingerprint) in self._entries

    def strip(self, scope_key: str, text: str) -> str:
        kept = [line for line in text.splitlines() if not self.is_echo(scope_key, line)]
        return "\n".join(kept).strip()

    def _expire(self, now: float) -> None:
        stale = [key for key, stamp in self._entries.items() if now - stamp > FINGERPRINT_TTL_SECONDS]
        for key in stale:
            del self._entries[key]
            self.expired += 1

    def size(self) -> int:
        with self._lock:
            return len(self._entries)


class RecallEngine:
    """Allocates RXIDs and runs at most one lookup at a time."""

    def __init__(
        self,
        search: Callable[[str], Tuple[Optional[str], int]],
        *,
        budget: float = RECALL_BUDGET_SECONDS,
        max_items: int = DEFAULT_MAX_ITEMS,
        max_chars: int = DEFAULT_MAX_CONTEXT_CHARS,
        on_event: Optional[Callable[[str, Dict[str, Any]], None]] = None,
    ) -> None:
        self._search = search
        self._budget = budget
        self._max_items = max_items
        self._max_chars = max_chars
        self._on_event = on_event
        self._counter = itertools.count(1)
        self._lock = threading.Lock()
        self._current: Optional[Execution] = None
        self._busy = False
        self._closing = False
        self.skipped_busy = 0
        self.last_count = 0

    # ------------------------------------------------------------ allocation
    def allocate(self) -> Optional[int]:
        """Reserve an RXID for the turn that is starting.

        Called from ``on_turn_start``, which has the raw message: we take an
        identity and nothing else. No query, no network, no thread.
        """
        with self._lock:
            if self._closing:
                return None
            rxid = next(self._counter)
            self._current = Execution(rxid)
            return rxid

    # --------------------------------------------------------------- lookup
    def result_for(self, query: str, scope_key: str, echo: EchoIndex) -> str:
        """Run (or reuse) this RXID's lookup and return prompt-ready text.

        Repeated calls inside one RXID reuse the first answer, which is what
        makes "one wire request per turn" true even though the host may call
        ``prefetch`` more than once.
        """
        with self._lock:
            execution = self._current
            if execution is None or self._closing:
                return ""
            query_hash = _query_hash(query)
            if execution.submitted:
                if execution.query_hash != query_hash:
                    # A different question under the same RXID is a new
                    # question; answering it from the old one would be wrong.
                    return ""
                pending = execution
            else:
                if self._busy:
                    # The previous turn's lookup is still out. Skipping is the
                    # fail-open answer; queueing would grow without bound.
                    self.skipped_busy += 1
                    self._emit("recall.skipped", {"reason": "not_ready"})
                    return ""
                execution.submitted = True
                execution.query_hash = query_hash
                self._busy = True
                pending = execution
                thread = threading.Thread(
                    target=self._run,
                    args=(execution, query),
                    name="itsuki-recall",
                    daemon=True,
                )
                thread.start()

        pending.done.wait(self._budget)
        with self._lock:
            if self._current is not pending or pending.block is None:
                if not pending.done.is_set():
                    self._emit("recall.timeout", {})
                return ""
            block = pending.block
            self.last_count = pending.count

        if block:
            echo.register(scope_key, block)
        return block

    def _run(self, execution: Execution, query: str) -> None:
        block = ""
        count = 0
        try:
            context, count = self._search(query)
            if context:
                cleaned = sanitize_recalled_text(context)
                formatted = format_recall_block(cleaned, self._max_chars)
                block = formatted or ""
        except Exception:  # noqa: BLE001 - a memory outage is never a turn outage
            block = ""
            self._emit("recall.fail", {})
        finally:
            with self._lock:
                self._busy = False
                if self._current is execution:
                    execution.block = block
                    execution.count = count
            execution.done.set()
            if block:
                self._emit("recall.ok", {"count": count})

    def close(self) -> None:
        with self._lock:
            self._closing = True
            current = self._current
        if current is not None:
            current.done.set()

    def _emit(self, name: str, fields: Dict[str, Any]) -> None:
        if self._on_event is None:
            return
        try:
            self._on_event(name, fields)
        except Exception:  # noqa: BLE001 - telemetry is never load-bearing
            pass


def bounded_items(items: List[Any], limit: int = DEFAULT_MAX_ITEMS) -> List[Any]:
    return list(items or [])[:limit]
