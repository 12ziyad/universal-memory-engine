"""Network work that an event loop can always walk away from.

ADK's synchronous ``Runner.run()`` creates a private event loop per call and
closes it when the call returns. ``asyncio.run`` cancels *and awaits* whatever
tasks are still pending at that point -- so a coroutine that swallows
cancellation does not merely leak, it hangs the whole synchronous run forever.

The fix is to keep uncooperative work off the loop entirely. Every wire call
runs on a package-owned **daemon** thread using the SDK's synchronous client,
and the caller awaits a wrapped future. When our deadline expires we stop
waiting and abandon the job: a daemon thread cannot hold the interpreter open,
and the loop has nothing left to await.

That choice also dissolves the client-lifecycle problem. There is no
``AsyncMemoryClient`` here, so no client is bound to a loop that may already be
closed, and there is no "primary loop" to designate or re-designate.
"""

from __future__ import annotations

import asyncio
import queue
import threading
from concurrent.futures import Future
from typing import Any, Callable, Dict, List, Optional, Tuple

MAX_WORKERS = 4
MAX_QUEUED = 64
MAX_ABANDONED = 32
CLOSE_DEADLINE_SECONDS = 2.0

OPEN = "open"
CLOSING = "closing"
CLOSED = "closed"


class TransportClosed(RuntimeError):
    """Raised into a caller whose job can no longer be accepted or finished."""


class _Job:
    __slots__ = ("fn", "future")

    def __init__(self, fn: Callable[[], Any], future: "Future[Any]") -> None:
        self.fn = fn
        self.future = future


class DaemonTransport:
    """A tiny bounded thread pool whose threads are all abandonable."""

    def __init__(self, workers: int = MAX_WORKERS) -> None:
        self._queue: "queue.Queue[Optional[_Job]]" = queue.Queue(maxsize=MAX_QUEUED)
        self._threads: List[threading.Thread] = []
        self._lock = threading.Lock()
        self._state = OPEN
        self._active = 0
        self._abandoned: List["Future[Any]"] = []
        self.counters: Dict[str, int] = {
            "abandoned": 0,
            "abandoned_overflow": 0,
            "rejected_closing": 0,
            "queue_full": 0,
            "leaked_client": 0,
        }
        for index in range(workers):
            thread = threading.Thread(target=self._loop, name=f"itsuki-adk-{index}", daemon=True)
            thread.start()
            self._threads.append(thread)

    # ----------------------------------------------------------- submission
    def submit(self, fn: Callable[[], Any]) -> "Future[Any]":
        """Hand work to a daemon worker, or fail terminally if we are closing."""
        future: "Future[Any]" = Future()
        with self._lock:
            # Admission stops atomically the moment close() begins, so nothing
            # new can be queued behind the shutdown.
            if self._state != OPEN:
                self.counters["rejected_closing"] += 1
                future.set_exception(TransportClosed("itsuki transport is closing"))
                return future
        try:
            self._queue.put_nowait(_Job(fn, future))
        except queue.Full:
            self.counters["queue_full"] += 1
            future.set_exception(TransportClosed("itsuki transport queue is full"))
        return future

    async def run(self, fn: Callable[[], Any], deadline: float) -> Any:
        """Await ``fn`` under a hard deadline, abandoning it if it overruns.

        The abandoned job keeps running on its daemon thread; we simply stop
        caring about its result. Nothing is left pending on the caller's loop.
        """
        future = self.submit(fn)
        wrapped = asyncio.wrap_future(future)
        done, _pending = await asyncio.wait({wrapped}, timeout=max(0.0, deadline))
        if not done:
            self._abandon(future, wrapped)
            raise TimeoutError("itsuki call exceeded its deadline")
        return wrapped.result()

    def _abandon(self, future: "Future[Any]", wrapped: "asyncio.Future[Any]") -> None:
        wrapped.cancel()
        self.counters["abandoned"] += 1
        with self._lock:
            self._abandoned.append(future)
            while len(self._abandoned) > MAX_ABANDONED:
                self._abandoned.pop(0)
                self.counters["abandoned_overflow"] += 1
        # Swallow whatever it eventually produces so a late failure cannot
        # surface as an unretrieved-exception warning.
        future.add_done_callback(self._discard)

    def _discard(self, future: "Future[Any]") -> None:
        try:
            future.exception()
        except BaseException:  # noqa: BLE001 - the point is to discard it
            pass
        with self._lock:
            if future in self._abandoned:
                self._abandoned.remove(future)

    # ----------------------------------------------------------------- inner
    def _loop(self) -> None:
        while True:
            job = self._queue.get()
            if job is None:
                return
            with self._lock:
                self._active += 1
            try:
                if not job.future.set_running_or_notify_cancel():
                    continue
                job.future.set_result(job.fn())
            except BaseException as exc:  # noqa: BLE001 - carried to the caller
                if not job.future.done():
                    job.future.set_exception(exc)
            finally:
                with self._lock:
                    self._active -= 1

    # -------------------------------------------------------------- shutdown
    def close(self, closer: Optional[Callable[[], None]] = None) -> Dict[str, int]:
        """Stop admission, resolve what is queued, and never wait on a hang.

        ``closer`` (typically the SDK client's own ``close``) is only called
        once no worker can still be using it. If a worker is wedged past the
        deadline the client is deliberately leaked and counted -- closing a
        transport out from under an in-flight request is the worse failure.
        """
        with self._lock:
            if self._state == CLOSED:
                return dict(self.counters)
            self._state = CLOSING

        # Terminally resolve anything queued but not started: a caller waiting
        # on one of these must get an answer, not a silent hang.
        while True:
            try:
                job = self._queue.get_nowait()
            except queue.Empty:
                break
            if job is not None and not job.future.done():
                job.future.set_exception(TransportClosed("itsuki transport closed"))

        for _ in self._threads:
            try:
                self._queue.put_nowait(None)
            except queue.Full:
                pass

        deadline = threading.Event()
        deadline.wait(0)  # no-op; kept explicit for readability
        waited = 0.0
        step = 0.05
        while waited < CLOSE_DEADLINE_SECONDS:
            with self._lock:
                if self._active == 0:
                    break
            threading.Event().wait(step)
            waited += step

        with self._lock:
            active = self._active
            self._state = CLOSED

        if closer is not None:
            if active:
                # Someone is still mid-request on a daemon thread. Leaking a
                # client object is bounded and counted; yanking it is not.
                self.counters["leaked_client"] += 1
            else:
                threading.Thread(target=_safe, args=(closer,), daemon=True).start()
        return dict(self.counters)

    @property
    def state(self) -> str:
        with self._lock:
            return self._state


def _safe(fn: Callable[[], None]) -> None:
    try:
        fn()
    except Exception:  # noqa: BLE001 - closing is best effort by definition
        pass
