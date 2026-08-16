"""Fixtures built from ADK's real types, never from stand-ins for them."""

from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

import pytest
from google.genai import types

from adk_itsuki.capture import STATE_KEY
from adk_itsuki.context import Invocation


class RecordingClient:
    """A stand-in for MemoryClient that records exactly what went on the wire."""

    def __init__(self, context: str = "", count: int = 0, fail: Optional[BaseException] = None) -> None:
        self.searches: List[Dict[str, Any]] = []
        self.writes: List[Dict[str, Any]] = []
        self.closed = False
        self._context = context
        self._count = count
        self.fail = fail

    def search(self, query: str, **options: Any) -> Dict[str, Any]:
        self.searches.append({"query": query, **options})
        if self.fail is not None:
            raise self.fail
        return {"context": self._context, "count": self._count}

    def add_conversation(self, messages: Any, **options: Any) -> Dict[str, Any]:
        self.writes.append({"messages": messages, **options})
        if self.fail is not None:
            raise self.fail
        return {"ok": True}

    def close(self) -> None:
        self.closed = True


def text_event(author: str, text: str, *, invocation_id: str = "inv-1", event_id: str = "", **kwargs: Any):
    """A real ADK Event carrying plain text."""
    from google.adk.events.event import Event

    return Event(
        id=event_id or f"{author}-{abs(hash((author, text))) % 100000}",
        invocation_id=invocation_id,
        author=author,
        content=types.Content(role="user" if author == "user" else "model", parts=[types.Part(text=text)]),
        timestamp=kwargs.pop("timestamp", time.time()),
        **kwargs,
    )


def tool_event(author: str, name: str, *, invocation_id: str = "inv-1", **kwargs: Any):
    """A real ADK Event carrying a function call, which must never be captured."""
    from google.adk.events.event import Event

    return Event(
        id=f"tool-{name}",
        invocation_id=invocation_id,
        author=author,
        content=types.Content(
            role="model",
            parts=[types.Part(function_call=types.FunctionCall(name=name, args={"secret": "TOOL_ARG_SENTINEL"}))],
        ),
        timestamp=time.time(),
        **kwargs,
    )


def make_session(events: List[Any], *, app_name="app", user_id="user-1", session_id="sess-1", root="root_agent"):
    """A real ADK Session, with the attribution marker the plugin would write."""
    from google.adk.sessions.session import Session

    state: Dict[str, Any] = {}
    invocations = {getattr(event, "invocation_id", "") for event in events}
    state[STATE_KEY] = {inv: {"root": root, "branch": ""} for inv in invocations if inv}
    return Session(id=session_id, app_name=app_name, user_id=user_id, state=state, events=events)


def invocation_for(session: Any, invocation_id: str = "inv-1", root: str = "root_agent") -> Invocation:
    return Invocation(
        invocation_id=invocation_id,
        app_name=session.app_name,
        user_id=session.user_id,
        session_id=session.id,
        root_agent=root,
        root_branch="",
    )


@pytest.fixture
def client() -> RecordingClient:
    return RecordingClient(context="the user ships on fridays", count=1)


@pytest.fixture
def service(client, monkeypatch):
    from adk_itsuki.service import ItsukiMemoryService

    monkeypatch.setenv("ITSUKI_API_KEY", "itsuki_live_testkey0123456789")
    instance = ItsukiMemoryService(client=client)
    yield instance
    instance._transport.close()
