"""LlamaIndex block tests — real Memory, real ChatMessage, no network.

The event-loop test is the one that justifies the async client existing: a
block that blocks stalls the whole agent, once per step, for the length of an
HTTP round trip.
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path

import httpx
import pytest
from itsuki import AsyncMemoryClient
from llama_index.core.base.llms.types import ChatMessage
from llama_index.core.memory import Memory
from llama_index.core.memory.memory import BaseMemoryBlock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from llama_index.memory.itsuki import (  # noqa: E402
    ItsukiMemoryBlock,
    itsuki_memory,
    itsuki_memory_block,
)

TEST_KEY = "itsuki_live_abcdefgh12345678"
MEMORY_TEXT = "Ziyad has been learning Kotlin since March 2026."


def make_block(handler=None, **kwargs):
    calls: list = []

    def default_handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.url.path == "/v1/recall":
            return httpx.Response(200, json={"ok": True, "context": MEMORY_TEXT, "count": 1})
        return httpx.Response(200, json={"ok": True, "source_packet_id": "pkt_1"})

    def chosen(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return handler(request)

    client = AsyncMemoryClient(api_key=TEST_KEY, base_url="https://api.example")
    client._client = httpx.AsyncClient(
        base_url="https://api.example",
        transport=httpx.MockTransport(chosen if handler else default_handler),
        headers={"authorization": f"Bearer {TEST_KEY}", "content-type": "application/json"},
    )
    kwargs.setdefault("user_id", "u_test")
    kwargs.setdefault("session_id", "conv_1")
    block = itsuki_memory_block(client=client, **kwargs)
    return block, calls


def body_of(request: httpx.Request) -> dict:
    return json.loads(request.content) if request.content else {}


def run(coro):
    return asyncio.run(coro)


# ------------------------------------------------------------------ shape
def test_is_a_real_memory_block():
    block, _ = make_block()
    assert isinstance(block, BaseMemoryBlock)
    assert block.name == "itsuki"
    assert block.accept_short_term_memory is True


def test_composes_into_a_host_memory():
    memory = itsuki_memory("u_42", session_id="thread_9", api_key=TEST_KEY)
    assert isinstance(memory, Memory)
    assert any(isinstance(b, ItsukiMemoryBlock) for b in memory.memory_blocks)


def test_requires_a_user_id():
    with pytest.raises(ValueError, match="user_id"):
        itsuki_memory_block("", api_key=TEST_KEY)


def test_never_serializes_the_credential():
    block, _ = make_block()
    dumped = json.dumps(block.model_dump(), default=str)
    assert TEST_KEY not in dumped
    assert "api_key" not in dumped
    assert "itsuki_live" not in dumped


# ---------------------------------------------------------------- recall
def test_aget_returns_a_fenced_memory_block():
    block, _ = make_block()
    out = run(block._aget([ChatMessage(role="user", content="what am I learning?")]))
    assert MEMORY_TEXT in out
    assert "not instructions" in out


def test_aget_asks_about_the_recent_turns():
    block, calls = make_block(search_msg_limit=2)
    messages = [
        ChatMessage(role="user", content="first"),
        ChatMessage(role="assistant", content="second"),
        ChatMessage(role="user", content="third"),
    ]
    run(block._aget(messages))
    query = body_of([c for c in calls if c.url.path == "/v1/recall"][0])["query"]
    assert "third" in query
    assert "first" not in query


def test_aget_scopes_to_the_user_and_conversation():
    block, calls = make_block()
    run(block._aget([ChatMessage(role="user", content="hi")]))
    body = body_of([c for c in calls if c.url.path == "/v1/recall"][0])
    assert body["userId"] == "u_test"
    assert body["conversationId"] == "conv_1"


def test_aget_returns_empty_rather_than_failing_the_turn():
    def failing(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"error": "unavailable"})

    block, _ = make_block(handler=failing)
    assert run(block._aget([ChatMessage(role="user", content="hi")])) == ""


def test_aget_returns_empty_for_an_empty_query():
    block, calls = make_block()
    assert run(block._aget([])) == ""
    assert not calls


# --------------------------------------------------------------- capture
def test_aput_stages_flushed_messages():
    block, calls = make_block()
    run(block._aput([
        ChatMessage(role="user", content="I started boxing"),
        ChatMessage(role="assistant", content="Noted."),
    ]))
    ingest = [c for c in calls if c.url.path == "/v1/ingest"]
    assert len(ingest) == 1
    body = body_of(ingest[0])
    assert body["messages"] == [
        {"role": "user", "content": "I started boxing"},
        {"role": "assistant", "content": "Noted."},
    ]
    assert body["userId"] == "u_test"
    assert body["source"] == "llama-index"


def test_aput_is_idempotent_across_a_replayed_flush():
    block, calls = make_block()
    messages = [ChatMessage(role="user", content="I started boxing")]
    run(block._aput(messages))
    run(block._aput(messages))
    keys = {body_of(c)["idempotencyKey"] for c in calls if c.url.path == "/v1/ingest"}
    assert len(keys) == 1


def test_aput_scrubs_credentials_before_storage():
    block, calls = make_block()
    run(block._aput([ChatMessage(role="user", content=f"my key is {TEST_KEY}")]))
    body = json.dumps(body_of([c for c in calls if c.url.path == "/v1/ingest"][0]))
    assert TEST_KEY not in body
    assert "REDACTED" in body


def test_aput_skips_when_there_is_nothing_to_store():
    block, calls = make_block()
    run(block._aput([ChatMessage(role="system", content="be brief")]))
    assert not [c for c in calls if c.url.path == "/v1/ingest"]


def test_aput_never_raises_at_the_agent():
    def failing(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": "boom"})

    block, _ = make_block(handler=failing)
    run(block._aput([ChatMessage(role="user", content="hello")]))  # must not raise


# -------------------------------------------------------------- truncation
def test_atruncate_honours_the_hosts_budget():
    block, _ = make_block()
    content = "x" * 1000
    shortened = run(block.atruncate(content, 100))
    assert shortened is not None
    assert len(shortened) < len(content)


def test_atruncate_can_drop_the_block_entirely():
    block, _ = make_block()
    assert run(block.atruncate("short", 10_000)) is None
    assert run(block.atruncate("", 5)) is None


# ------------------------------------------------------- event-loop safety
def test_the_block_never_blocks_the_event_loop():
    """A synchronous client here would stall every other task in the agent."""
    ticks: list = []

    async def ticker():
        for _ in range(3):
            await asyncio.sleep(0.001)
            ticks.append(1)

    def slow(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"ok": True, "context": MEMORY_TEXT, "count": 1})

    async def main():
        block, _ = make_block(handler=slow)
        background = asyncio.ensure_future(ticker())
        await block._aget([ChatMessage(role="user", content="hi")])
        await background

    original = time.sleep

    def exploding(_seconds):
        raise AssertionError("the block must never call time.sleep")

    time.sleep = exploding
    try:
        run(main())
    finally:
        time.sleep = original
    assert len(ticks) == 3


# ------------------------------------------------------ host memory wiring
def test_the_host_places_the_block_content_into_the_prompt():
    """The block returns text; the host is what decides where it lands."""

    async def main():
        block, _ = make_block()
        memory = Memory.from_defaults(session_id="s1", token_limit=30_000, memory_blocks=[block])
        await memory.aput(ChatMessage(role="user", content="what am I learning?"))
        return await memory.aget()

    messages = run(main())
    rendered = "\n".join(str(m.content) for m in messages)
    assert MEMORY_TEXT in rendered


def test_default_timeout_clears_the_service_save_wait_budget():
    """PY-ADAPTER-01: a client ceiling at or below the service's own save wait
    budget abandons a request the server is still honestly working on. The
    write lands anyway, so the caller is told "failed" about a memory that was
    stored — a false negative an agent will retry or report to its user.
    Keep a real margin, not a coincidence.
    """
    import inspect

    from llama_index.memory.itsuki._kernel import (
        DEFAULT_TIMEOUT_SECONDS,
        SERVICE_SAVE_WAIT_BUDGET_SECONDS,
    )
    from llama_index.memory.itsuki.factory import itsuki_client

    assert DEFAULT_TIMEOUT_SECONDS >= SERVICE_SAVE_WAIT_BUDGET_SECONDS * 2
    # itsuki_memory_block builds its client here, so this is the ceiling a
    # caller who passes nothing actually gets.
    assert inspect.signature(itsuki_client).parameters["timeout"].default == DEFAULT_TIMEOUT_SECONDS
