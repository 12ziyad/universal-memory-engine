"""Capture: stage the settled turn, then try to deliver it.

``sync_turn`` runs on the host's single memory worker, and the host has already
done the hard part -- it skips interrupted turns entirely and only calls us with
a finalised response. So the ordering here is the whole design: write the
envelope to disk first, return in microseconds, and let our own daemon worker do
the network. A crash between the two loses nothing, and a slow service delays
memory rather than the person waiting for their answer.

What leaves this process is exactly two strings: what the user said and what the
assistant answered. The ``messages`` list the host offers carries tool calls and
tool results, so it is ignored on purpose rather than filtered.
"""

from __future__ import annotations

import queue
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from ._kernel import capture_idempotency_key, scrub_messages, strip_recall_blocks
from .errors import TERMINAL_CLASSES, Breaker, ERASED, IDEMPOTENCY_CONFLICT, classify
from .recall import EchoIndex
from .spool import Spool

SOURCE = "hermes"
MAX_ATTEMPTS = 3
BACKOFF_BASE_SECONDS = 0.5
DRAIN_DEADLINE_SECONDS = 2.0


class CaptureResult:
    """Why a turn was or was not staged. Content-free."""

    __slots__ = ("staged", "reason", "key")

    def __init__(self, staged: bool, reason: Optional[str] = None, key: Optional[str] = None) -> None:
        self.staged = staged
        self.reason = reason
        self.key = key


def project_turn(
    user_content: str,
    assistant_content: str,
    scope_key: str,
    echo: EchoIndex,
) -> Tuple[List[Dict[str, str]], Optional[str]]:
    """Turn the host's two strings into messages, or explain the refusal.

    Recalled context is stripped twice over: the fenced block itself, and then
    any line we know we injected. Without that, memory feeds on its own output
    and a poisoned memory would be rewritten every turn.
    """
    user_text = strip_recall_blocks(_text(user_content))
    user_text = echo.strip(scope_key, user_text)
    assistant_text = strip_recall_blocks(_text(assistant_content))
    assistant_text = echo.strip(scope_key, assistant_text)

    if not user_text or not assistant_text:
        # The host only calls us for finalised turns, so an empty half here
        # means the content was entirely recall echo or entirely scaffolding.
        return [], "nothing_to_capture"

    messages = [
        {"role": "user", "content": user_text},
        {"role": "assistant", "content": assistant_text},
    ]
    scrubbed, _counts = scrub_messages(messages)
    return scrubbed, None


class CaptureWorker:
    """One daemon thread that owns every write to the service.

    Daemon, because a hung transport must never be able to hold the agent's
    process open. Single, because the server's dedupe is per key and ordering
    two writes for one conversation matters more than parallelism.
    """

    def __init__(
        self,
        spool: Spool,
        deliver: Callable[[Dict[str, Any]], None],
        breaker: Breaker,
        *,
        on_event: Optional[Callable[[str, Dict[str, Any]], None]] = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._spool = spool
        self._deliver = deliver
        self._breaker = breaker
        self._on_event = on_event
        self._sleep = sleep
        self._queue: "queue.Queue[Optional[Path]]" = queue.Queue()
        self._thread: Optional[threading.Thread] = None
        self._closing = threading.Event()
        self._idle = threading.Event()
        self._idle.set()

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._loop, name="itsuki-capture", daemon=True)
        self._thread.start()

    def submit(self, path: Path) -> None:
        if self._closing.is_set():
            return
        self._idle.clear()
        self._queue.put(path)

    def drain_pending(self) -> int:
        """Queue everything already on disk (startup recovery)."""
        self._spool.reclaim_stale()
        count = 0
        for path in self._spool.pending():
            self.submit(path)
            count += 1
        return count

    def wait_idle(self, timeout: float) -> bool:
        return self._idle.wait(timeout)

    def close(self, deadline: float = DRAIN_DEADLINE_SECONDS) -> None:
        """Stop admitting work, give in-flight delivery a moment, then leave.

        We never join the worker: it is a daemon precisely so a wedged socket
        cannot become a wedged exit.
        """
        self._closing.set()
        self._queue.put(None)
        self._idle.wait(deadline)

    # ----------------------------------------------------------------- inner
    def _loop(self) -> None:
        while True:
            item = self._queue.get()
            if item is None:
                self._idle.set()
                return
            try:
                self._attempt(item)
            except Exception:  # noqa: BLE001 - the worker never dies of one envelope
                pass
            finally:
                if self._queue.empty():
                    self._idle.set()

    def _attempt(self, path: Path) -> None:
        for attempt in range(MAX_ATTEMPTS):
            if self._closing.is_set():
                return
            if not self._breaker.allows():
                return  # stays on disk; a later drain picks it up
            claimed = self._spool.claim(path)
            if claimed is None:
                return  # another process owns it
            envelope = self._spool.read(claimed)
            if envelope is None:
                self._spool.release(claimed, path)
                return
            try:
                self._deliver(envelope)
            except BaseException as exc:  # noqa: BLE001 - classify, never propagate
                error_class, retry_after = classify(exc)
                self._breaker.record_failure(error_class, retry_after)
                self._spool.mark_attempt(claimed, error_class)
                if error_class in (IDEMPOTENCY_CONFLICT, ERASED):
                    # Neither can ever succeed on replay, and both deserve a
                    # human's attention rather than a silent delete.
                    self._spool.quarantine(claimed, error_class)
                    self._emit("capture.quarantined", {"errorClass": error_class})
                    return
                self._spool.release(claimed, path)
                if error_class in TERMINAL_CLASSES:
                    self._emit("capture.fail", {"errorClass": error_class})
                    return
                self._emit("capture.retry", {"errorClass": error_class})
                if attempt + 1 < MAX_ATTEMPTS:
                    self._sleep(BACKOFF_BASE_SECONDS * (2**attempt))
                continue
            self._breaker.record_success()
            self._spool.complete(claimed)
            self._emit("capture.delivered", {})
            return

    def _emit(self, name: str, fields: Dict[str, Any]) -> None:
        if self._on_event is None:
            return
        try:
            self._on_event(name, fields)
        except Exception:  # noqa: BLE001
            pass


def idempotency_key(
    messages: List[Dict[str, str]],
    user_id: Optional[str],
    conversation_id: Optional[str],
) -> str:
    """Content-derived, so every replay of one exchange is one memory."""
    return capture_idempotency_key(
        messages=messages,
        source=SOURCE,
        user_id=user_id,
        conversation_id=conversation_id,
    )


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""
