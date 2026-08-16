"""Itsuki as an ADK memory service.

Two ADK facts shape everything here. First, the framework puts **no timeout** on
a memory call, and a `load_memory` tool call that raises **aborts the whole
invocation** -- so `search_memory` must never raise and never hang. Second,
nothing in ADK ever calls `add_session_to_memory` on its own; capture is an
application's job, which is why this package also ships a plugin.

State that must outlive a single event loop -- the pending queue, the breaker,
the recall cache -- lives on the service under a lock, because synchronous
`Runner.run()` creates and destroys a loop per call.
"""

from __future__ import annotations

import threading
import time
from typing import Any, Dict, List, Optional, Sequence, Tuple

from google.adk.memory.base_memory_service import BaseMemoryService, SearchMemoryResponse
from google.adk.memory.memory_entry import MemoryEntry
from google.genai import types

from ._kernel import DEFAULT_MAX_CONTEXT_CHARS, DEFAULT_MAX_ITEMS, RECALL_PREAMBLE
from .capture import (
    SOURCE,
    chunk,
    chunk_key,
    group_by_invocation,
    is_settled,
    project_invocation,
    read_marker,
)
from .config import Settings, resolve
from .context import Invocation, TokenRegistry, current
from .errors import Breaker, ERASED, IDEMPOTENCY_CONFLICT, TERMINAL_CLASSES, classify
from .identity import derive_user_id, scope_metadata
from .sanitize import sanitize_recalled_text
from .transport import DaemonTransport, TransportClosed

RECALL_DEADLINE_SECONDS = 3.0
CAPTURE_DEADLINE_SECONDS = 10.0
MAX_PENDING_CHUNKS = 256
MAX_RECALL_CACHE = 512


class _Pending:
    __slots__ = ("messages", "options", "key")

    def __init__(self, messages: List[Dict[str, str]], options: Dict[str, Any], key: str) -> None:
        self.messages = messages
        self.options = options
        self.key = key


class ItsukiMemoryService(BaseMemoryService):
    """A BaseMemoryService backed by Itsuki."""

    def __init__(
        self,
        uri: Optional[str] = None,
        *,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        user_namespace: Optional[str] = None,
        recall_limit: int = DEFAULT_MAX_ITEMS,
        recall_deadline: float = RECALL_DEADLINE_SECONDS,
        capture_deadline: float = CAPTURE_DEADLINE_SECONDS,
        client: Any = None,
        **kwargs: Any,
    ) -> None:
        # `uri` and the stray `agents_dir` come from ADK's services.yaml
        # factory, which calls every service as cls(uri=..., agents_dir=...).
        self.settings: Settings = resolve(uri=uri, api_key=api_key, base_url=base_url)
        self.user_namespace = user_namespace
        self.recall_limit = recall_limit
        self.recall_deadline = recall_deadline
        self.capture_deadline = capture_deadline

        self._lock = threading.Lock()
        self._transport = DaemonTransport()
        self._client = client if client is not None else self._build_client()
        self._breaker = Breaker()
        self._pending: List[_Pending] = []
        self._recall_cache: Dict[str, SearchMemoryResponse] = {}
        self._recall_order: List[str] = []
        self.tokens = TokenRegistry()
        self.counters: Dict[str, int] = {
            "recall_wire": 0,
            "recall_cached": 0,
            "recall_failed": 0,
            "captured": 0,
            "capture_failed": 0,
            "capture_quarantined": 0,
            "skipped": 0,
        }
        self.skips: Dict[str, int] = {}

    def _build_client(self) -> Any:
        from itsuki import MemoryClient

        # base_url is keyword-only, and `timeout` bounds the whole operation
        # rather than one attempt -- so retries are ours, not the SDK's.
        return MemoryClient(
            self.settings.api_key,
            base_url=self.settings.base_url,
            timeout=self.capture_deadline,
            max_retries=0,
        )

    # -------------------------------------------------------------- retrieval
    async def search_memory(self, *, app_name: str, user_id: str, query: str) -> SearchMemoryResponse:
        """Never raises, never hangs.

        A raising search aborts the invocation on ADK's `load_memory` path, and
        a hanging one has no framework timeout to save it, so both failure
        modes are handled here rather than hoped about.
        """
        empty = SearchMemoryResponse(memories=[])
        if not query or not query.strip():
            return empty

        invocation = current()
        cache_key = self._cache_key(app_name, user_id, query, invocation)
        with self._lock:
            cached = self._recall_cache.get(cache_key)
            if cached is not None:
                self.counters["recall_cached"] += 1
                return cached
            if not self._breaker.allows():
                return empty

        scoped_user = derive_user_id(app_name, user_id, self.user_namespace)
        try:
            result = await self._transport.run(
                lambda: self._client.search(query.strip(), user_id=scoped_user, limit=self.recall_limit),
                self.recall_deadline,
            )
        except (TimeoutError, TransportClosed):
            self.counters["recall_failed"] += 1
            return empty
        except BaseException as exc:  # noqa: BLE001 - degrade, never abort a run
            error_class, retry_after = classify(exc)
            with self._lock:
                self._breaker.record_failure(error_class, retry_after)
            self.counters["recall_failed"] += 1
            return empty

        with self._lock:
            self._breaker.record_success()
        response = self._to_response(result)
        if invocation is not None:
            self._remember(cache_key, response)
        self.counters["recall_wire"] += 1
        return response

    def _to_response(self, result: Any) -> SearchMemoryResponse:
        """One aggregate entry built from the service's prompt-ready context.

        ADK's preload renders only text, author and timestamp, so anything
        else we attached would be dropped. `timestamp` stays None because we
        have no genuine per-result time to report and inventing one would be a
        lie the model reads as fact.
        """
        context = result.get("context") if isinstance(result, dict) else None
        if not isinstance(context, str) or not context.strip():
            return SearchMemoryResponse(memories=[])
        cleaned = sanitize_recalled_text(context)[:DEFAULT_MAX_CONTEXT_CHARS]
        if not cleaned:
            return SearchMemoryResponse(memories=[])
        body = f"{RECALL_PREAMBLE}\n{cleaned}"
        entry = MemoryEntry(
            content=types.Content(parts=[types.Part.from_text(text=body)]),
            author="itsuki",
            timestamp=None,
        )
        return SearchMemoryResponse(memories=[entry])

    def _cache_key(self, app_name: str, user_id: str, query: str, invocation: Optional[Invocation]) -> str:
        marker = invocation.invocation_id if invocation is not None else "no-invocation"
        return "\x00".join((marker, app_name, user_id, query.strip()))

    def _remember(self, key: str, response: SearchMemoryResponse) -> None:
        with self._lock:
            self._recall_cache[key] = response
            self._recall_order.append(key)
            while len(self._recall_order) > MAX_RECALL_CACHE:
                self._recall_cache.pop(self._recall_order.pop(0), None)

    def forget_invocation(self, invocation_id: str) -> None:
        with self._lock:
            keys = [key for key in self._recall_order if key.startswith(invocation_id + "\x00")]
            for key in keys:
                self._recall_cache.pop(key, None)
                self._recall_order.remove(key)

    # ---------------------------------------------------------------- capture
    async def add_session_to_memory(self, session: Any) -> None:
        """Import a whole session, one settled invocation at a time.

        Decomposing into the same units automatic capture uses is what makes a
        re-import idempotent against captures that already happened.
        """
        for invocation_id, events in group_by_invocation(getattr(session, "events", []) or []).items():
            root_agent, root_branch = read_marker(session, invocation_id)
            await self._capture_events(
                events,
                app_name=getattr(session, "app_name", ""),
                user_id=getattr(session, "user_id", ""),
                session_id=getattr(session, "id", ""),
                invocation_id=invocation_id,
                root_agent=root_agent,
                root_branch=root_branch,
            )

    async def add_events_to_memory(
        self,
        *,
        app_name: str,
        user_id: str,
        events: Sequence[Any],
        session_id: Optional[str] = None,
        custom_metadata: Optional[Any] = None,
    ) -> None:
        """A delta. Without a session id there is no conversation to attach it
        to, and inventing a shared one would merge unrelated conversations."""
        if not session_id:
            self._note_skip("no_identity")
            return
        for invocation_id, group in group_by_invocation(events).items():
            root_agent = ""
            root_branch = ""
            invocation = current()
            if invocation is not None and invocation.invocation_id == invocation_id:
                root_agent, root_branch = invocation.root_agent, invocation.root_branch
            await self._capture_events(
                group,
                app_name=app_name,
                user_id=user_id,
                session_id=session_id,
                invocation_id=invocation_id,
                root_agent=root_agent,
                root_branch=root_branch,
            )

    async def capture_invocation(
        self,
        session: Any,
        invocation: Invocation,
    ) -> bool:
        """The plugin's path: only this invocation's events, only if settled."""
        events = [
            event
            for event in (getattr(session, "events", []) or [])
            if (getattr(event, "invocation_id", "") or "") == invocation.invocation_id
        ]
        return await self._capture_events(
            events,
            app_name=invocation.app_name,
            user_id=invocation.user_id,
            session_id=invocation.session_id,
            invocation_id=invocation.invocation_id,
            root_agent=invocation.root_agent,
            root_branch=invocation.root_branch,
        )

    async def _capture_events(
        self,
        events: Sequence[Any],
        *,
        app_name: str,
        user_id: str,
        session_id: str,
        invocation_id: str,
        root_agent: str,
        root_branch: str,
    ) -> bool:
        settled, reason = is_settled(events, root_agent, root_branch)
        if not settled:
            self._note_skip(reason or "not_settled")
            return False
        messages = project_invocation(events, root_agent, root_branch)
        if not messages:
            self._note_skip("nothing_to_capture")
            return False

        scoped_user = derive_user_id(app_name, user_id, self.user_namespace)
        staged: List[_Pending] = []
        for index, part in enumerate(chunk(messages)):
            key = chunk_key(
                part,
                user_id=scoped_user,
                session_id=session_id,
                invocation_id=invocation_id,
                index=index,
            )
            staged.append(
                _Pending(
                    part,
                    {
                        "user_id": scoped_user,
                        "conversation_id": session_id,
                        "source": SOURCE,
                        "idempotency_key": key,
                        "memory_scope": scope_metadata(app_name),
                    },
                    key,
                )
            )
        with self._lock:
            self._pending.extend(staged)
            while len(self._pending) > MAX_PENDING_CHUNKS:
                self._pending.pop(0)
                self._note_skip("pending_overflow")
        await self.drain()
        return True

    async def drain(self) -> None:
        """Deliver what is pending. Safe to call from any loop, any time."""
        while True:
            with self._lock:
                if not self._pending or not self._breaker.allows():
                    return
                item = self._pending.pop(0)
            try:
                await self._transport.run(
                    lambda: self._client.add_conversation(item.messages, **item.options),
                    self.capture_deadline,
                )
            except (TimeoutError, TransportClosed):
                with self._lock:
                    self._pending.insert(0, item)
                self.counters["capture_failed"] += 1
                return
            except BaseException as exc:  # noqa: BLE001
                error_class, retry_after = classify(exc)
                with self._lock:
                    self._breaker.record_failure(error_class, retry_after)
                if error_class in (IDEMPOTENCY_CONFLICT, ERASED):
                    # Neither can succeed on replay: a conflict means the same
                    # key carries different content, and `erased` is the
                    # service refusing to resurrect deleted memory.
                    self.counters["capture_quarantined"] += 1
                    continue
                if error_class in TERMINAL_CLASSES:
                    self.counters["capture_failed"] += 1
                    continue
                with self._lock:
                    self._pending.insert(0, item)
                self.counters["capture_failed"] += 1
                return
            with self._lock:
                self._breaker.record_success()
            self.counters["captured"] += 1

    # --------------------------------------------------------------- teardown
    async def aclose(self) -> None:
        try:
            await self.drain()
        except Exception:  # noqa: BLE001 - closing is best effort
            pass
        closer = getattr(self._client, "close", None)
        self._transport.close(closer if callable(closer) else None)

    # --------------------------------------------------------------- reporting
    def _note_skip(self, reason: str) -> None:
        self.skips[reason] = self.skips.get(reason, 0) + 1
        self.counters["skipped"] += 1

    def status(self) -> Dict[str, Any]:
        with self._lock:
            pending = len(self._pending)
        return {
            "breaker": self._breaker.state,
            "pending_chunks": pending,
            "transport": self._transport.state,
            "transport_counters": dict(self._transport.counters),
            "counters": dict(self.counters),
            "skips": dict(self.skips),
            "open_invocations": self.tokens.size(),
        }

    @property
    def pending_count(self) -> int:
        with self._lock:
            return len(self._pending)
