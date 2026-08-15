"""Itsuki as a LlamaIndex memory block.

LlamaIndex deprecated the `BaseMemory` generation that Mem0's integration
targets — `ChatMemoryBuffer`, `SimpleComposableMemory` and friends are on the
way out, and the current architecture is the `Memory` class composing
`BaseMemoryBlock` subclasses. So this ships a block, not a `BaseMemory` clone:
Itsuki becomes the long-term half of the host's own memory rather than a
replacement for it, and short-term chat history keeps working exactly as the
host intends.

The interface is async-first, which is why the async SDK client exists. Calling
the synchronous client from `_aget` would block the event loop the agent is
running on — the whole framework would stall for the length of an HTTP round
trip, once per step.
"""

from __future__ import annotations

from typing import Any, List, Optional

from itsuki import AsyncMemoryClient, MemoryAPIError
from llama_index.core.base.llms.types import ChatMessage
from llama_index.core.memory.memory import BaseMemoryBlock
from pydantic import Field, PrivateAttr

from ._kernel import (
    DEFAULT_MAX_CONTEXT_CHARS,
    DEFAULT_MAX_ITEMS,
    capture_idempotency_key,
    clamp,
    emit,
    format_recall_block,
    scrub_messages,
    truncate_to_code_points,
)

SOURCE = "llama-index"

#: How many recent messages inform the recall query. Mem0's integration calls
#: the same knob ``search_msg_limit``; the name is kept recognisable.
DEFAULT_SEARCH_MSG_LIMIT = 5


def _text_of(message: ChatMessage) -> str:
    """The plain text of a chat message, whatever block shape it arrived in."""
    content = message.content
    if isinstance(content, str):
        return content.strip()
    blocks = getattr(message, "blocks", None) or []
    parts = [getattr(block, "text", "") for block in blocks]
    return "\n".join(part for part in parts if isinstance(part, str) and part).strip()


class ItsukiMemoryBlock(BaseMemoryBlock[str]):
    """Long-term memory backed by Itsuki, as a block inside `Memory`.

    ``_aget`` returns the prompt-ready memory for the current turn; the host
    decides where to place it. ``_aput`` receives messages as they flush out of
    short-term memory and stages them for extraction.
    """

    name: str = "itsuki"
    description: str = "Durable memory of this user, recalled from Itsuki."
    priority: int = 1
    accept_short_term_memory: bool = True

    user_id: str = Field(description="Isolated memory space for this end user.")
    session_id: Optional[str] = Field(default=None, description="Conversation id.")
    agent_id: Optional[str] = Field(default=None, description="Agent attribution.")
    run_id: Optional[str] = Field(default=None, description="Run attribution.")
    project_id: Optional[str] = Field(default=None, description="Project attribution.")
    recall_scope: Optional[str] = Field(default=None, description="Recall coverage.")
    max_context_chars: int = Field(default=DEFAULT_MAX_CONTEXT_CHARS)
    max_items: int = Field(default=DEFAULT_MAX_ITEMS)
    search_msg_limit: int = Field(default=DEFAULT_SEARCH_MSG_LIMIT)

    _client: AsyncMemoryClient = PrivateAttr()
    _event_hook: Any = PrivateAttr(default=None)

    def __init__(
        self,
        *,
        client: AsyncMemoryClient,
        event_hook: Any = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        # PrivateAttr keeps the client — and therefore the credential — out of
        # every pydantic dump, export and serialized agent state.
        self._client = client
        self._event_hook = event_hook

    # ------------------------------------------------------------- retrieval
    async def _aget(
        self,
        messages: Optional[List[ChatMessage]] = None,
        **block_kwargs: Any,
    ) -> str:
        """Recall for this turn. Returns "" when there is nothing to add.

        Never raises: a memory outage must cost the agent context, not the
        answer. The host skips empty blocks, so "" is the correct degraded
        result rather than a placeholder.
        """
        query = self._query_from(messages or [])
        if not query:
            emit(self._event_hook, "recall.skipped", reason="empty_query")
            return ""
        try:
            options: dict = {
                "user_id": self.user_id,
                "limit": clamp(int(self.max_items), 1, 50),
            }
            if self.recall_scope:
                options["recall_scope"] = self.recall_scope
            if self.project_id:
                options["memory_scope"] = {"projectId": self.project_id}
            if self.session_id:
                options["conversation_id"] = self.session_id
            result = await self._client.search(query, **options)
            block = format_recall_block(
                result.get("context"), clamp(int(self.max_context_chars), 1, 100_000)
            )
            emit(self._event_hook, "recall.ok", count=int(result.get("count") or 0))
            return block or ""
        except (MemoryAPIError, Exception):  # noqa: BLE001 — degrade, never fail a turn
            emit(self._event_hook, "recall.fail")
            return ""

    def _query_from(self, messages: List[ChatMessage]) -> str:
        """The last few turns, newest last, as one query string."""
        limit = clamp(int(self.search_msg_limit), 1, 50)
        texts = [_text_of(message) for message in messages[-limit:]]
        return "\n".join(text for text in texts if text).strip()

    # --------------------------------------------------------------- capture
    async def _aput(self, messages: List[ChatMessage]) -> None:
        """Stage messages flushing out of short-term memory.

        The host calls this with whole windows, and it may call it again for
        the same window after a retry or a re-run. The idempotency key is
        derived from the content, so a replay stores one memory rather than two.
        """
        payload = [
            {"role": "assistant" if message.role == "assistant" else "user",
             "content": _text_of(message)}
            for message in messages
            if _text_of(message) and message.role in ("user", "assistant")
        ]
        if not payload:
            emit(self._event_hook, "capture.skipped", reason="nothing_to_capture")
            return

        scrubbed, _ = scrub_messages(payload)
        try:
            options: dict = {
                "user_id": self.user_id,
                "source": SOURCE,
                "idempotency_key": capture_idempotency_key(
                    messages=scrubbed,
                    source=SOURCE,
                    user_id=self.user_id,
                    conversation_id=self.session_id,
                    project_id=self.project_id,
                ),
            }
            if self.session_id:
                options["conversation_id"] = self.session_id
            if self.run_id:
                options["source_id"] = self.run_id
            scope = {}
            if self.project_id:
                scope["projectId"] = self.project_id
            if self.agent_id:
                scope["agentId"] = self.agent_id
            if scope:
                options["memory_scope"] = scope
            await self._client.ingest(scrubbed, **options)
            emit(self._event_hook, "capture.staged", messages=len(scrubbed))
        except Exception:  # noqa: BLE001 — capture must never break the agent
            emit(self._event_hook, "capture.fail")

    # -------------------------------------------------------------- trimming
    async def atruncate(self, content: str, tokens_to_truncate: int) -> Optional[str]:
        """Honour the host's token budget honestly.

        Returning the content unchanged would let this block push the rest of
        the prompt out of the window, which is precisely what the host is
        trying to prevent by asking.
        """
        if not content:
            return None
        if tokens_to_truncate <= 0:
            return content
        # ~4 characters per token is the host's own rule of thumb; erring
        # towards cutting more is safe, erring towards less is not.
        remove = max(0, int(tokens_to_truncate) * 4)
        keep = len(content) - remove
        if keep <= 0:
            return None
        return truncate_to_code_points(content, keep)
