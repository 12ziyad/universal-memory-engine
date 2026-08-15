"""Building a host `Memory` with Itsuki as its long-term half."""

from __future__ import annotations

import os
from typing import Any, Optional

from itsuki import AsyncMemoryClient
from llama_index.core.memory import Memory

from .block import DEFAULT_SEARCH_MSG_LIMIT, ItsukiMemoryBlock
from ._kernel import DEFAULT_MAX_CONTEXT_CHARS, DEFAULT_MAX_ITEMS

SETUP_HINT = (
    "Create a key at https://itsuki.app under API Keys, then set ITSUKI_API_KEY "
    "in the environment."
)


def itsuki_client(
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    timeout: float = 8.0,
) -> AsyncMemoryClient:
    """An async client, resolved from the argument then the environment."""
    resolved = (api_key or os.environ.get("ITSUKI_API_KEY") or "").strip()
    if not resolved:
        raise ValueError(f"The Itsuki API key is not configured. {SETUP_HINT}")
    return AsyncMemoryClient(
        api_key=resolved,
        base_url=(base_url or os.environ.get("ITSUKI_BASE_URL") or "https://itsuki.app"),
        timeout=timeout,
    )


def itsuki_memory_block(
    user_id: str,
    *,
    session_id: Optional[str] = None,
    agent_id: Optional[str] = None,
    run_id: Optional[str] = None,
    project_id: Optional[str] = None,
    recall_scope: Optional[str] = None,
    max_context_chars: int = DEFAULT_MAX_CONTEXT_CHARS,
    max_items: int = DEFAULT_MAX_ITEMS,
    search_msg_limit: int = DEFAULT_SEARCH_MSG_LIMIT,
    priority: int = 1,
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    client: Optional[AsyncMemoryClient] = None,
    event_hook: Any = None,
) -> ItsukiMemoryBlock:
    """One configured block, for composing into a `Memory` yourself."""
    if not str(user_id or "").strip():
        raise ValueError(
            "user_id is required — it selects the isolated memory space for this "
            "end user, and there is no safe default for whose memory this is."
        )
    return ItsukiMemoryBlock(
        client=client or itsuki_client(api_key, base_url),
        event_hook=event_hook,
        user_id=str(user_id).strip(),
        session_id=session_id,
        agent_id=agent_id,
        run_id=run_id,
        project_id=project_id,
        recall_scope=recall_scope or ("project_then_global" if project_id else None),
        max_context_chars=max_context_chars,
        max_items=max_items,
        search_msg_limit=search_msg_limit,
        priority=priority,
    )


def itsuki_memory(
    user_id: str,
    *,
    session_id: Optional[str] = None,
    token_limit: int = 30_000,
    **block_kwargs: Any,
) -> Memory:
    """A host `Memory` whose long-term half is Itsuki.

        memory = itsuki_memory(user_id="u_42", session_id="thread_9")
        response = await agent.run("...", memory=memory)

    Short-term chat history keeps working exactly as the host intends; this
    only adds the block that survives the session.
    """
    block = itsuki_memory_block(user_id, session_id=session_id, **block_kwargs)
    return Memory.from_defaults(
        session_id=session_id or f"itsuki-{user_id}",
        token_limit=token_limit,
        memory_blocks=[block],
    )
