"""Itsuki as a ChatDev 2.0 memory store, on the real ``MemoryBase`` contract.

The audit found the earlier version of this store implemented an interface that
did not exist: ``retrieve(query: str)`` and ``update(user_input, agent_output)``
against a plain object, returning dicts. ChatDev's real ``MemoryManager`` calls
``retrieve(agent_role, query: MemoryContentSnapshot, top_k, similarity_threshold)``
and ``update(payload: MemoryWritePayload)``, and expects ``List[MemoryItem]``
back — so the old store would have thrown the first time a real workflow
touched it. This version is written against the host source directly and is
exercised by the real host types in the test suite.

Behaviour is kept parity-compatible with the built-in ``mem0`` store, so
swapping ``type: mem0`` for ``type: itsuki`` does not change what a workflow
captures: only the user's input is memorized, and ChatDev's pipeline framing is
stripped first so the extractor sees the user's sentence, not the scaffolding.

Everything degrades. A memory failure returns empty or logs; it never raises.
Failing a workflow stage because a lookup timed out is strictly worse than the
stage running without memory.
"""

from __future__ import annotations

import logging
import os
import re
import time
import uuid
from typing import Any, Dict, List, Optional

from entity.configs import MemoryStoreConfig
from runtime.node.agent.memory.memory_base import (
    MemoryBase,
    MemoryContentSnapshot,
    MemoryItem,
    MemoryWritePayload,
)

from itsuki import MemoryClient

from .config import ItsukiMemoryConfig
from .headers import strip_pipeline_headers
from ._kernel import (
    bound_items,
    capture_idempotency_key,
    clamp,
    emit,
    scrub_text,
)

logger = logging.getLogger(__name__)

SOURCE = "chatdev"

_ENV_REF = re.compile(r"^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$")


def _resolve_key(raw: str) -> str:
    """Expand a ${VAR} reference or fall back to ITSUKI_API_KEY.

    Expansion happens here, at client construction, and the result is never
    written back onto the config — so a serialized workflow keeps only the
    ${VAR} reference, never the secret.
    """
    value = str(raw or "").strip()
    match = _ENV_REF.match(value)
    if match:
        value = (os.environ.get(match.group(1)) or "").strip()
    if not value:
        value = (os.environ.get("ITSUKI_API_KEY") or "").strip()
    return value


class ItsukiMemoryStore(MemoryBase):
    """A ChatDev memory store backed by Itsuki.

    Registered under ``type: itsuki``. Construction takes the host's
    ``MemoryStoreConfig`` wrapper and extracts the typed Itsuki config from it,
    exactly as the built-in stores do.
    """

    def __init__(self, store: MemoryStoreConfig, *, client: Optional[MemoryClient] = None) -> None:
        config = store.as_config(ItsukiMemoryConfig)
        if not config:
            raise ValueError("ItsukiMemoryStore requires an Itsuki memory store configuration")
        super().__init__(store)
        self.config = config

        self.user_id = (config.user_id or "").strip() or None
        self.agent_id = (config.agent_id or "").strip() or None
        if not self.user_id and not self.agent_id:
            raise ValueError(
                "Set user_id or agent_id on the itsuki memory node: without one there "
                "is no memory space to read from or write to."
            )
        self.project_id = (config.project_id or "").strip() or None
        self.top_k = clamp(int(config.top_k or 5), 1, 20)
        self.max_context_chars = clamp(int(config.max_context_chars or 4_000), 1, 100_000)
        self.allow_clear = bool(config.allow_clear)

        if client is not None:
            self.client = client
        else:
            key = _resolve_key(config.api_key)
            if not key:
                raise ValueError(
                    "The Itsuki API key is not configured. Set api_key in the memory node "
                    "config (${ITSUKI_API_KEY} is expanded from the environment)."
                )
            self.client = MemoryClient(
                api_key=key,
                base_url=(config.base_url or os.environ.get("ITSUKI_BASE_URL") or "https://itsuki.app"),
                timeout=float(config.timeout_s or 8.0),
            )

    # ------------------------------------------------------------- scoping
    def _space(self, agent_role: str = "") -> str:
        """The memory space.

        user_id first, then agent_id, then — matching the built-in store — the
        agent's role. Attribution either way: the server binds ownership to the
        authenticated key, so a YAML file cannot reach another account's memory
        whatever it names. The role fallback never crosses a configured tenant;
        it only supplies a space when the node named none.
        """
        return self.user_id or self.agent_id or (agent_role or "").strip()

    def _scope(self) -> Dict[str, Any]:
        scope: Dict[str, Any] = {}
        if self.project_id:
            scope["projectId"] = self.project_id
        if self.agent_id:
            scope["agentId"] = self.agent_id
        return scope

    # ---------------------------------------------------------- persistence
    def load(self) -> None:
        """No-op: the service holds the memory, not this process."""
        return None

    def save(self) -> None:
        """No-op: update() already staged everything server-side."""
        return None

    # ------------------------------------------------------------ retrieval
    def retrieve(
        self,
        agent_role: str,
        query: "MemoryContentSnapshot",
        top_k: int,
        similarity_threshold: float,
    ) -> List["MemoryItem"]:
        """Memories relevant to this stage, as host MemoryItems. Empty on failure.

        The manager frames these under its own "Related Memories" heading and
        scores them, so each item carries the memory text as its
        content_summary — parity with the built-in mem0 store.
        """
        text = strip_pipeline_headers(getattr(query, "text", "") or "")
        if not text:
            return []
        space = self._space(agent_role)
        if not space:
            return []
        limit = clamp(int(top_k or self.top_k), 1, 20)
        try:
            options: Dict[str, Any] = {"user_id": space, "limit": limit}
            if self.project_id:
                options["recall_scope"] = "project_then_global"
                options["memory_scope"] = {"projectId": self.project_id}
            result = self.client.search(text, **options)
            raw_items = result.get("items") or result.get("nodes") or []
            items: List[MemoryItem] = []

            # The prose block the server already assembled, offered first so a
            # model reading top-down sees the coherent summary before fragments.
            context = str(result.get("context") or "").strip()
            if context:
                items.append(MemoryItem(
                    id="itsuki-context",
                    content_summary=context[: self.max_context_chars],
                    metadata={"source": SOURCE, "kind": "context"},
                    timestamp=time.time(),
                ))

            for entry in bound_items(raw_items if isinstance(raw_items, list) else [], limit):
                if not isinstance(entry, dict):
                    continue
                summary = str(entry.get("summary") or entry.get("label") or "").strip()
                if not summary:
                    continue
                items.append(MemoryItem(
                    id=str(entry.get("id") or f"itsuki_{uuid.uuid4().hex}"),
                    content_summary=summary,
                    metadata={"source": SOURCE},
                    timestamp=time.time(),
                ))
            return items
        except Exception as error:  # noqa: BLE001 — a stage must not fail on memory
            logger.error("itsuki: retrieve failed: %s", error)
            return []

    # -------------------------------------------------------------- capture
    def update(self, payload: "MemoryWritePayload") -> None:
        """Memorize the USER's input for this stage. Never raises.

        The output is available on the payload and deliberately not stored:
        stage outputs are workflow chatter, and extracting facts from them is
        how a memory system starts believing its own drafts.
        """
        raw = getattr(payload, "inputs_text", "") or ""
        if not raw:
            snapshot = getattr(payload, "input_snapshot", None)
            raw = getattr(snapshot, "text", "") or ""
        text = strip_pipeline_headers(raw)
        if not text:
            return
        space = self._space(getattr(payload, "agent_role", "") or "")
        if not space:
            return
        safe, _ = scrub_text(text)
        try:
            options: Dict[str, Any] = {
                "user_id": space,
                "source": SOURCE,
                "idempotency_key": capture_idempotency_key(
                    messages=[{"role": "user", "content": safe}],
                    source=SOURCE,
                    user_id=space,
                    conversation_id=self.agent_id,
                    project_id=self.project_id,
                ),
            }
            scope = self._scope()
            if scope:
                options["memory_scope"] = scope
            self.client.add(safe, **options)
            emit(None, "capture.staged")
        except Exception as error:  # noqa: BLE001
            logger.error("itsuki: update failed: %s", error)

    # ------------------------------------------------------------ deletion
    def clear(self) -> None:
        """Erase this workflow's own memories — only when explicitly allowed.

        A workflow finishing is not a user asking to be forgotten, so the
        default does nothing, and even when enabled the deletion is scoped to
        this adapter's own source lane.
        """
        if not self.allow_clear:
            logger.info("itsuki: clear() ignored (allow_clear is false)")
            return
        try:
            self.client.delete_by_source(source=SOURCE, confirm=True, user_id=self._space())
        except Exception as error:  # noqa: BLE001
            logger.error("itsuki: clear failed: %s", error)
