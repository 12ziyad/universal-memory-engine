"""Make the host importable.

The provider subclasses ``agent.memory_provider.MemoryProvider``, which only
exists inside a Hermes environment. CI installs the real host on both the
0.19.0 floor leg and the current-tag leg; when neither is present (a developer
machine, a packaging check) we stand in a stub whose signatures are copied
verbatim from the real source, so a drift in the host contract shows up as a
failure here rather than as a surprise at runtime.
"""

from __future__ import annotations

import sys
import types
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import pytest


def _install_stub_host() -> None:
    agent = types.ModuleType("agent")
    module = types.ModuleType("agent.memory_provider")

    @dataclass(frozen=True)
    class RecallStatus:
        provider_label: str
        count: int
        glyph: str = "\U0001f9e0"

    class MemoryProvider(ABC):
        @property
        @abstractmethod
        def name(self) -> str: ...

        @abstractmethod
        def is_available(self) -> bool: ...

        @abstractmethod
        def initialize(self, session_id: str, **kwargs) -> None: ...

        @abstractmethod
        def get_tool_schemas(self) -> List[Dict[str, Any]]: ...

        def unavailable_reason(self) -> str:
            return ""

        def system_prompt_block(self) -> str:
            return ""

        def prefetch(self, query: str, *, session_id: str = "") -> str:
            return ""

        def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
            return None

        def recall_status(self) -> Optional[RecallStatus]:
            return None

        def sync_turn(
            self,
            user_content: str,
            assistant_content: str,
            *,
            session_id: str = "",
            messages: Optional[List[Dict[str, Any]]] = None,
        ) -> None:
            return None

        def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
            return "{}"

        def shutdown(self) -> None:
            return None

        def on_turn_start(self, turn_number: int, message: str, **kwargs) -> None:
            return None

        def on_session_end(self, messages: List[Dict[str, Any]]) -> None:
            return None

        def on_session_switch(
            self,
            new_session_id: str,
            *,
            parent_session_id: str = "",
            reset: bool = False,
            rewound: bool = False,
            **kwargs,
        ) -> None:
            return None

        def on_pre_compress(self, messages: List[Dict[str, Any]]) -> str:
            return ""

        def on_delegation(self, task: str, result: str, *, child_session_id: str = "", **kwargs) -> None:
            return None

        def get_config_schema(self) -> List[Dict[str, Any]]:
            return []

        def save_config(self, values: Dict[str, Any], hermes_home: str) -> None:
            return None

        def on_memory_write(
            self, action: str, target: str, content: str, metadata: Optional[Dict[str, Any]] = None
        ) -> None:
            return None

        def backup_paths(self) -> List[str]:
            return []

    module.MemoryProvider = MemoryProvider
    module.RecallStatus = RecallStatus
    agent.memory_provider = module
    sys.modules.setdefault("agent", agent)
    sys.modules["agent.memory_provider"] = module


try:  # pragma: no cover - depends on which CI leg is running
    import agent.memory_provider  # noqa: F401

    HOST_IS_REAL = True
except ImportError:  # pragma: no cover
    _install_stub_host()
    HOST_IS_REAL = False


@pytest.fixture
def host_is_real() -> bool:
    return HOST_IS_REAL


class RecordingClient:
    """A stand-in for MemoryClient that remembers exactly what went on the wire."""

    def __init__(self, context: str = "", count: int = 0, fail: Optional[BaseException] = None) -> None:
        self.searches: List[Dict[str, Any]] = []
        self.writes: List[Dict[str, Any]] = []
        self._context = context
        self._count = count
        self._fail = fail

    def search(self, query: str, **options: Any) -> Dict[str, Any]:
        self.searches.append({"query": query, **options})
        if self._fail is not None:
            raise self._fail
        return {"context": self._context, "count": self._count}

    def add_conversation(self, messages: Any, **options: Any) -> Dict[str, Any]:
        self.writes.append({"messages": messages, **options})
        if self._fail is not None:
            raise self._fail
        return {"ok": True}


@pytest.fixture
def recording_client() -> RecordingClient:
    return RecordingClient()
