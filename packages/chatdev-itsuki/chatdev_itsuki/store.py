"""Itsuki as a ChatDev 2.0 memory store.

ChatDev's memory manager drives this: on entering a configured
``retrieve_stage`` it calls ``retrieve()`` and injects the results into the
agent's context under a "Related Memories" heading; after the stage completes
it calls ``update()`` and ``save()``. That is a genuine automatic lifecycle —
the agent never chooses to remember — and it is why this adapter can claim more
than a toolkit can.

Two behaviours are deliberately copied from the built-in ``mem0`` store, because
they are right and because swapping `type:` should not change what an existing
workflow captures:

- Only USER input is memorized. Stage outputs are pipeline chatter, and
  extracting "memories" from them teaches the system its own noise.
- ChatDev's pipeline headers are stripped first, so the extractor sees the
  user's sentence rather than the framing around it.

Everything degrades. A memory failure returns empty or logs; it never raises.
Failing a workflow stage because a lookup timed out is strictly worse than the
stage running without memory.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Dict, List, Optional

from itsuki import MemoryClient

from ._kernel import (
    DEFAULT_MAX_CONTEXT_CHARS,
    bound_items,
    capture_idempotency_key,
    clamp,
    emit,
    format_recall_block,
    scrub_text,
)

logger = logging.getLogger(__name__)

SOURCE = "chatdev"

# ChatDev frames stage input with headers. They are structure, not something
# the user said.
_HEADER_PATTERNS = [
    re.compile(r"^\s*#{1,6}\s+.*$", re.MULTILINE),
    re.compile(r"^\s*\[[A-Za-z][^\]\n]{0,80}\]\s*$", re.MULTILINE),
    re.compile(r"^\s*<[A-Za-z_][A-Za-z0-9_\- ]{0,60}>\s*$", re.MULTILINE),
    re.compile(r"^\s*(?:Task|Stage|Role|Phase|Instruction|Context)\s*:\s*.*$", re.MULTILINE),
]


def strip_pipeline_headers(text: str) -> str:
    """Remove ChatDev's own framing so the extractor sees the user's words."""
    out = str(text or "")
    for pattern in _HEADER_PATTERNS:
        out = pattern.sub("", out)
    return re.sub(r"\n{3,}", "\n\n", out).strip()


class ItsukiMemoryStore:
    """A ChatDev memory store backed by Itsuki.

    Registered under ``type: itsuki`` so a workflow declares it in YAML::

        memory:
          - name: team_memory
            type: itsuki
            config:
              api_key: ${ITSUKI_API_KEY}
              user_id: acme_team
    """

    def __init__(self, config: Any) -> None:
        api_key = str(getattr(config, "api_key", "") or "").strip()
        if not api_key:
            raise ValueError(
                "The Itsuki API key is not configured. Set api_key in the memory "
                "node config (${ITSUKI_API_KEY} is expanded from the environment)."
            )
        self.user_id = (getattr(config, "user_id", None) or "").strip() or None
        self.agent_id = (getattr(config, "agent_id", None) or "").strip() or None
        if not self.user_id and not self.agent_id:
            raise ValueError(
                "Set user_id or agent_id on the memory node: without one there is "
                "no memory space to read from or write to."
            )
        self.project_id = (getattr(config, "project_id", None) or "").strip() or None
        self.top_k = clamp(int(getattr(config, "top_k", 5) or 5), 1, 20)
        self.max_context_chars = clamp(
            int(getattr(config, "max_context_chars", DEFAULT_MAX_CONTEXT_CHARS)
                or DEFAULT_MAX_CONTEXT_CHARS),
            1,
            100_000,
        )
        self.allow_clear = bool(getattr(config, "allow_clear", False))
        self.event_hook = getattr(config, "event_hook", None)

        injected = getattr(config, "client", None)
        self.client = injected or MemoryClient(
            api_key=api_key,
            base_url=str(getattr(config, "base_url", None) or "https://itsuki.app"),
            timeout=float(getattr(config, "timeout_s", 8.0) or 8.0),
        )

    # ------------------------------------------------------------- scoping
    @property
    def _space(self) -> str:
        """The memory space. agent_id stands in when no user is configured.

        This mirrors the built-in store's fallback, and it is attribution
        either way: the server binds ownership to the authenticated key, so a
        YAML file cannot reach another account's memory whatever it names.
        """
        return self.user_id or self.agent_id or ""

    def _scope(self) -> Dict[str, Any]:
        scope: Dict[str, Any] = {}
        if self.project_id:
            scope["projectId"] = self.project_id
        if self.agent_id:
            scope["agentId"] = self.agent_id
        return scope

    # ------------------------------------------------------------ retrieval
    def retrieve(
        self, query: str = "", top_k: Optional[int] = None, **_: Any
    ) -> List[Dict[str, Any]]:
        """Memories relevant to this stage. Empty on any failure."""
        text = strip_pipeline_headers(query)
        if not text:
            return []
        limit = clamp(int(top_k or self.top_k), 1, 20)
        try:
            options: Dict[str, Any] = {"user_id": self._space, "limit": limit}
            if self.project_id:
                options["recall_scope"] = "project_then_global"
                options["memory_scope"] = {"projectId": self.project_id}
            result = self.client.search(text, **options)
            items = result.get("items") or result.get("nodes") or []
            block = format_recall_block(result.get("context"), self.max_context_chars)
            emit(self.event_hook, "recall.ok",
                 count=len(items) if isinstance(items, list) else 0)

            out: List[Dict[str, Any]] = []
            if block:
                out.append({
                    "id": "itsuki-context",
                    "content": block,
                    "score": 1.0,
                    "metadata": {"source": SOURCE},
                })
            for item in bound_items(items if isinstance(items, list) else [], limit):
                if isinstance(item, dict) and item.get("id"):
                    out.append({
                        "id": str(item.get("id")),
                        "content": str(item.get("summary") or item.get("label") or ""),
                        "score": float(item.get("score") or 0.0),
                        "metadata": {"source": SOURCE},
                    })
            return out
        except Exception as error:  # noqa: BLE001 — a stage must not fail on memory
            logger.error("itsuki: retrieve failed: %s", error)
            emit(self.event_hook, "recall.fail")
            return []

    def format_context(self, memories: List[Dict[str, Any]]) -> str:
        """The block ChatDev injects under its Related Memories heading."""
        for memory in memories or []:
            if memory.get("id") == "itsuki-context" and memory.get("content"):
                return str(memory["content"])
        return ""

    # -------------------------------------------------------------- capture
    def update(self, user_input: str = "", agent_output: str = "", **_: Any) -> None:
        """Memorize the USER's input for this stage. Never raises.

        agent_output is accepted for interface compatibility and deliberately
        not stored: stage outputs are workflow chatter, and extracting facts
        from them is how a memory system starts believing its own drafts.
        """
        text = strip_pipeline_headers(user_input)
        if not text:
            return
        safe, _ = scrub_text(text)
        try:
            options: Dict[str, Any] = {
                "user_id": self._space,
                "source": SOURCE,
                "idempotency_key": capture_idempotency_key(
                    messages=[{"role": "user", "content": safe}],
                    source=SOURCE,
                    user_id=self._space,
                    conversation_id=self.agent_id,
                    project_id=self.project_id,
                ),
            }
            scope = self._scope()
            if scope:
                options["memory_scope"] = scope
            self.client.add(safe, **options)
            emit(self.event_hook, "capture.staged", messages=1)
        except Exception as error:  # noqa: BLE001
            logger.error("itsuki: update failed: %s", error)
            emit(self.event_hook, "capture.fail")

    # ------------------------------------------------------------ lifecycle
    def load(self) -> None:
        """No-op: the service holds the memory, not this process."""
        return None

    def save(self) -> None:
        """No-op: update() already staged everything server-side."""
        return None

    def clear(self) -> None:
        """Erase this workflow's own memories — only when explicitly allowed.

        A workflow finishing is not a user asking to be forgotten, so the
        default does nothing at all, and even when enabled the deletion is
        scoped to this adapter's own source lane.
        """
        if not self.allow_clear:
            logger.info("itsuki: clear() ignored (allow_clear is false)")
            return
        try:
            self.client.delete_by_source(source=SOURCE, confirm=True, user_id=self._space)
            emit(self.event_hook, "remote.cleared")
        except Exception as error:  # noqa: BLE001
            logger.error("itsuki: clear failed: %s", error)
