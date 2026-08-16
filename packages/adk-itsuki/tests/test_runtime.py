"""Recall dedup, context cleanup, transport shutdown, and the sync-run hazard.

The riskiest thing this package does is run network work near an event loop
that ADK creates and destroys per synchronous call. These tests exist because
`asyncio.run` cancels *and awaits* pending tasks at shutdown: anything
uncooperative left on that loop hangs `Runner.run()` forever.
"""

from __future__ import annotations

import asyncio
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import pytest

from adk_itsuki.context import CURRENT, Invocation, TokenRegistry, current
from adk_itsuki.transport import DaemonTransport, TransportClosed
from conftest import RecordingClient


def invocation(id_: str = "inv-1") -> Invocation:
    return Invocation(id_, "app", "user-1", "sess-1", "root_agent", "")


# --------------------------------------------------------------- recall dedup
@pytest.mark.asyncio
async def test_one_wire_call_per_invocation_across_a_tool_loop(service, client):
    """preload_memory runs before every model call in an invocation."""
    token_registry = service.tokens
    token_registry.enter(invocation())
    try:
        for _ in range(5):
            await service.search_memory(app_name="app", user_id="user-1", query="what do you know")
    finally:
        token_registry.exit("inv-1")
    assert len(client.searches) == 1
    assert service.counters["recall_cached"] == 4


@pytest.mark.asyncio
async def test_two_invocations_with_identical_prompts_each_recall(service, client):
    for index in (1, 2):
        service.tokens.enter(invocation(f"inv-{index}"))
        await service.search_memory(app_name="app", user_id="user-1", query="the same question")
        service.tokens.exit(f"inv-{index}")
    assert len(client.searches) == 2


@pytest.mark.asyncio
async def test_search_never_raises_even_when_the_service_is_down(service, client):
    client.fail = RuntimeError("service unreachable")
    response = await service.search_memory(app_name="app", user_id="user-1", query="anything")
    assert response.memories == []


@pytest.mark.asyncio
async def test_recall_returns_one_aggregate_entry_from_context(service, client):
    response = await service.search_memory(app_name="app", user_id="user-1", query="q")
    assert len(response.memories) == 1
    entry = response.memories[0]
    assert entry.author == "itsuki"
    assert entry.timestamp is None, "we have no genuine per-result timestamp to report"
    assert "ships on fridays" in entry.content.parts[0].text


@pytest.mark.asyncio
async def test_recall_is_scoped_and_never_takes_scope_from_the_caller(service, client):
    await service.search_memory(app_name="app", user_id="user-1", query="q")
    sent = client.searches[0]
    assert sent["user_id"].startswith("adk1_")
    assert "user-1" not in sent["user_id"], "raw ids are hashed, never sent verbatim"


# ------------------------------------------------------------ context cleanup
def test_identity_does_not_leak_between_invocations_in_one_task():
    """A caller that catches an error and continues keeps its context."""
    registry = TokenRegistry()
    registry.enter(invocation("inv-a"))
    assert current().invocation_id == "inv-a"
    registry.exit("inv-a")
    assert current() is None

    registry.enter(invocation("inv-b"))
    registry.exit("inv-b")
    assert current() is None


def test_a_stale_value_is_cleared_on_entry():
    """The case on_run_error cannot cover: cancellation that never reaches us."""
    registry = TokenRegistry()
    CURRENT.set(invocation("orphan"))
    registry.enter(invocation("inv-new"))
    assert current().invocation_id == "inv-new"
    assert registry.cleared_stale == 1
    registry.exit("inv-new")
    assert current() is None


@pytest.mark.asyncio
async def test_identity_is_cleared_after_a_cancelled_invocation():
    registry = TokenRegistry()

    async def cancelled_run():
        registry.enter(invocation("inv-cancel"))
        try:
            await asyncio.sleep(10)
        except asyncio.CancelledError:
            registry.exit("inv-cancel")
            raise

    task = asyncio.create_task(cancelled_run())
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert current() is None


def test_the_token_registry_is_bounded():
    registry = TokenRegistry(limit=8)
    for index in range(50):
        registry.enter(invocation(f"inv-{index}"))
    assert registry.size() <= 8
    assert registry.abandoned > 0


# ------------------------------------------------------------------ transport
@pytest.mark.asyncio
async def test_a_hung_call_returns_at_its_deadline():
    transport = DaemonTransport()
    started = time.monotonic()
    with pytest.raises(TimeoutError):
        await transport.run(lambda: time.sleep(30), 0.2)
    assert time.monotonic() - started < 2.0
    assert transport.counters["abandoned"] == 1
    transport.close()


@pytest.mark.asyncio
async def test_submission_is_refused_once_closing_starts():
    transport = DaemonTransport()
    transport.close()
    with pytest.raises(TransportClosed):
        await transport.run(lambda: "work", 1.0)
    assert transport.state == "closed"


@pytest.mark.asyncio
async def test_close_is_idempotent():
    transport = DaemonTransport()
    first = transport.close()
    second = transport.close()
    assert first["rejected_closing"] <= second["rejected_closing"]


@pytest.mark.asyncio
async def test_the_client_is_not_closed_while_a_worker_may_still_use_it():
    """Yanking a transport out from under an in-flight request is worse than
    leaking one object, so the leak is taken and counted."""
    transport = DaemonTransport()
    client = RecordingClient()
    transport.submit(lambda: time.sleep(5))
    time.sleep(0.1)
    counters = transport.close(client.close)
    assert counters["leaked_client"] == 1
    assert client.closed is False


def test_a_synchronous_run_exits_even_with_a_hung_transport():
    """A-EXIT.

    asyncio.run cancels and awaits pending tasks when it finishes. Work left
    on that loop by an uncooperative coroutine would hang Runner.run forever,
    so the transport keeps it on abandonable daemon threads instead.
    """
    script = textwrap.dedent(
        """
        import asyncio, sys, time
        sys.path.insert(0, %r)
        from adk_itsuki.transport import DaemonTransport

        async def main():
            transport = DaemonTransport()
            try:
                await transport.run(lambda: time.sleep(3600), 0.2)
            except TimeoutError:
                pass
            print("call-returned")

        asyncio.run(main())
        sys.exit(0)
        """
    ) % str(Path(__file__).resolve().parents[1])

    started = time.monotonic()
    result = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, timeout=25)
    elapsed = time.monotonic() - started

    assert "call-returned" in result.stdout
    assert result.returncode == 0
    assert elapsed < 12, f"asyncio.run took {elapsed:.1f}s to unwind with a hung transport"


@pytest.mark.asyncio
async def test_repeated_event_loops_reuse_one_transport(service, client):
    """Runner.run() creates a loop per call; nothing here may be loop-bound."""

    def one_sync_run():
        asyncio.run(service.search_memory(app_name="app", user_id="user-1", query="q"))

    for _ in range(5):
        await asyncio.get_running_loop().run_in_executor(None, one_sync_run)
    assert len(client.searches) == 5
    assert service._transport.state == "open"


# --------------------------------------------------------- cross-run recovery
@pytest.mark.asyncio
async def test_a_failed_capture_drains_on_the_next_run(service, client):
    """Retry state is service-owned, so a fresh loop still finds the backlog."""
    from conftest import invocation_for, make_session, text_event

    session = make_session([text_event("user", "q"), text_event("root_agent", "a")])
    client.fail = TimeoutError("first attempt times out")
    await service.capture_invocation(session, invocation_for(session))
    assert service.pending_count == 1

    client.fail = None
    await service.drain()
    assert service.pending_count == 0
    assert service.counters["captured"] == 1
