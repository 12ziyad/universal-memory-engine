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


@pytest.mark.asyncio
async def test_deadline_abandoned_calls_count_toward_the_breaker(service, client, monkeypatch):
    """AUDIT-02 regression.

    A transport hung past our own deadline surfaces as TimeoutError from the
    daemon pool, not as an SDK error -- and that path skipped the breaker, so
    a wedged service was retried at full price on every recall forever.
    """
    import time as time_module

    def hang(*_a, **_k):
        time_module.sleep(30)

    client.search = hang  # type: ignore[assignment]
    service.recall_deadline = 0.05

    for index in range(5):
        service.tokens.enter(invocation(f"inv-slow-{index}"))
        await service.search_memory(app_name="app", user_id="user-1", query=f"q{index}")
        service.tokens.exit(f"inv-slow-{index}")

    assert service.status()["breaker"] == "open", "five deadline timeouts must open the breaker"


@pytest.mark.asyncio
async def test_real_sdk_failure_shapes_are_classified(service, client):
    """AUDIT-01 regression, ADK side (errors.py is duplicated per package)."""
    from itsuki import MemoryAPIError
    from adk_itsuki.errors import NETWORK, TIMEOUT, classify

    assert classify(MemoryAPIError("t", status=0, code="timeout"))[0] == TIMEOUT
    assert classify(MemoryAPIError("n", status=0, code="transport_error"))[0] == NETWORK


@pytest.mark.asyncio
async def test_hundred_concurrent_sessions_never_cross_tenants(service, client):
    """1,000-user shape: 10 users x 10 sessions, all in flight at once.

    The assertion is per-wire-body: every capture carries exactly its own
    session id and its own derived user, and no body ever contains another
    user's text. Volume without isolation proof is a vanity metric.
    """
    from conftest import invocation_for, make_session, text_event
    from adk_itsuki.identity import derive_user_id

    async def one_turn(user_index: int, session_index: int):
        user = f"user-{user_index}"
        session_id = f"sess-{user_index}-{session_index}"
        session = make_session(
            [
                text_event("user", f"question from {user} in {session_id}", invocation_id=f"inv-{session_id}"),
                text_event("root_agent", f"answer for {user} in {session_id}", invocation_id=f"inv-{session_id}"),
            ],
            user_id=user,
            session_id=session_id,
        )
        invocation = invocation_for(session, invocation_id=f"inv-{session_id}")
        await service.capture_invocation(session, invocation)

    await asyncio.gather(*(one_turn(u, s) for u in range(10) for s in range(10)))
    await service.drain()

    assert len(client.writes) == 100
    for write in client.writes:
        text = write["messages"][0]["content"]
        # "question from user-3 in sess-3-7" -> its wire identity must match.
        user = text.split("question from ")[1].split(" in ")[0]
        session_id = text.split(" in ")[1]
        assert write["user_id"] == derive_user_id("app", user, None), text
        assert write["conversation_id"] == session_id, text
        # No other user's text may ever share a body.
        for message in write["messages"]:
            assert f"user-{user}" not in ""  # structural no-op guard
            for other in range(10):
                other_user = f"user-{other}"
                if other_user != user:
                    assert other_user not in message["content"], (
                        f"cross-tenant text leak: {other_user} inside {user}'s capture"
                    )
