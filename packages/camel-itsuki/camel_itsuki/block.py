"""Semantic recall as a CAMEL memory block.

Storage answers "what did we say"; this answers "what do we know". Keeping
them apart is what lets `ItsukiStorage.load()` stay lossless — the moment one
object tries to be both, history starts coming back as a summary of itself.
"""

from __future__ import annotations

from typing import Any, List, Optional

from camel.memories.base import MemoryBlock
from camel.memories.records import MemoryRecord
from itsuki import MemoryClient

from ._kernel import (
    DEFAULT_MAX_CONTEXT_CHARS,
    DEFAULT_MAX_ITEMS,
    bound_items,
    clamp,
    emit,
    format_recall_block,
)

SOURCE = "camel"


class ItsukiContextBlock(MemoryBlock):
    """Recalls durable memory for the current query.

    ``retrieve(query)`` returns the prompt-ready block. Writes go through
    :class:`ItsukiStorage`, so ``write_records`` here is deliberately a no-op:
    two components writing the same exchange would store it twice.
    """

    def __init__(
        self,
        user_id: str,
        client: MemoryClient,
        agent_id: Optional[str] = None,
        project_id: Optional[str] = None,
        recall_scope: Optional[str] = None,
        max_items: int = DEFAULT_MAX_ITEMS,
        max_context_chars: int = DEFAULT_MAX_CONTEXT_CHARS,
        event_hook: Any = None,
    ) -> None:
        if not str(user_id or "").strip():
            raise ValueError("user_id is required to select a memory space.")
        self.user_id = str(user_id).strip()
        self.client = client
        self.agent_id = (agent_id or "").strip() or None
        self.project_id = (project_id or "").strip() or None
        self.recall_scope = recall_scope or ("project_then_global" if self.project_id else None)
        self.max_items = clamp(int(max_items), 1, 50)
        self.max_context_chars = clamp(int(max_context_chars), 1, 100_000)
        self.event_hook = event_hook

    def retrieve(self, query: str = "", **_: Any) -> str:
        """The prompt-ready memory block, or "" when there is nothing.

        Never raises: an agent that cannot reach its memory should answer with
        less context, not stop answering.
        """
        text = str(query or "").strip()
        if not text:
            return ""
        try:
            options: dict = {"user_id": self.user_id, "limit": self.max_items}
            if self.recall_scope:
                options["recall_scope"] = self.recall_scope
            if self.project_id:
                options["memory_scope"] = {"projectId": self.project_id}
            result = self.client.search(text, **options)
            block = format_recall_block(result.get("context"), self.max_context_chars)
            emit(self.event_hook, "recall.ok", count=int(result.get("count") or 0))
            return block or ""
        except Exception:  # noqa: BLE001 — degrade, never fail the agent
            emit(self.event_hook, "recall.fail")
            return ""

    def retrieve_items(self, query: str = "") -> List[Any]:
        """The raw recalled items, for callers doing their own scoring."""
        try:
            result = self.client.search(
                str(query or "").strip() or " ", user_id=self.user_id, limit=self.max_items
            )
            items = result.get("items") or result.get("nodes") or []
            return bound_items(items if isinstance(items, list) else [], self.max_items)
        except Exception:  # noqa: BLE001
            return []

    def write_records(self, records: List[MemoryRecord]) -> None:
        """Deliberately empty — ItsukiStorage owns the write path."""
        return None

    def clear(self) -> None:
        """Deliberately empty — deletion is never a side effect of a reset."""
        return None
