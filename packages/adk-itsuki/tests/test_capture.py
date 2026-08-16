"""What becomes a memory, and what deliberately does not.

ADK's after_run callback fires on paths that are not completed turns, and its
event stream carries tool traffic and sub-agent chatter alongside the answer a
person actually saw. Everything here is about telling those apart.
"""

from __future__ import annotations

import json

import pytest

from conftest import invocation_for, make_session, text_event, tool_event


@pytest.mark.asyncio
async def test_a_settled_invocation_is_captured(service, client):
    session = make_session(
        [text_event("user", "what did I ship"), text_event("root_agent", "you shipped the parser")]
    )
    assert await service.capture_invocation(session, invocation_for(session))
    assert len(client.writes) == 1
    assert [m["role"] for m in client.writes[0]["messages"]] == ["user", "assistant"]


@pytest.mark.asyncio
async def test_early_close_before_a_final_response_captures_nothing(service, client):
    """The caller stopped iterating before the agent answered."""
    session = make_session([text_event("user", "a question with no answer yet")])
    assert not await service.capture_invocation(session, invocation_for(session))
    assert client.writes == []
    assert service.skips.get("not_settled")


@pytest.mark.asyncio
async def test_early_close_after_a_final_response_captures_the_settled_prefix(service, client):
    """A persisted answer is durable history, so it is remembered."""
    session = make_session(
        [text_event("user", "a real question"), text_event("root_agent", "a real and complete answer")]
    )
    assert await service.capture_invocation(session, invocation_for(session))
    assert len(client.writes) == 1


@pytest.mark.asyncio
async def test_tool_traffic_never_reaches_memory(service, client):
    session = make_session(
        [
            text_event("user", "run the deploy"),
            tool_event("root_agent", "deploy"),
            text_event("root_agent", "deployed successfully"),
        ]
    )
    await service.capture_invocation(session, invocation_for(session))
    assert "TOOL_ARG_SENTINEL" not in json.dumps(client.writes)


@pytest.mark.asyncio
async def test_an_errored_invocation_is_not_captured(service, client):
    session = make_session(
        [text_event("user", "a question"), text_event("root_agent", "partial", error_code="OOPS")]
    )
    assert not await service.capture_invocation(session, invocation_for(session))
    assert client.writes == []


@pytest.mark.asyncio
async def test_a_partial_event_is_not_a_final_response(service, client):
    session = make_session(
        [text_event("user", "a question"), text_event("root_agent", "streaming...", partial=True)]
    )
    assert not await service.capture_invocation(session, invocation_for(session))


@pytest.mark.asyncio
async def test_an_unresolved_long_running_tool_holds_the_turn_open(service, client):
    session = make_session(
        [
            text_event("user", "ask a human"),
            text_event("root_agent", "waiting for approval", long_running_tool_ids={"tool-1"}),
        ]
    )
    assert not await service.capture_invocation(session, invocation_for(session))
    assert service.skips.get("not_settled")


@pytest.mark.asyncio
async def test_only_root_authored_output_is_captured(service, client):
    """A SequentialAgent child can keep the root branch, so the branch alone
    cannot prove authorship -- the author name has to."""
    session = make_session(
        [
            text_event("user", "do the thing"),
            text_event("child_agent", "INTERMEDIATE-CHILD-OUTPUT"),
            text_event("root_agent", "here is the final answer"),
        ]
    )
    await service.capture_invocation(session, invocation_for(session))
    body = json.dumps(client.writes)
    assert "INTERMEDIATE-CHILD-OUTPUT" not in body
    assert "here is the final answer" in body


@pytest.mark.asyncio
async def test_an_invocation_without_an_attribution_marker_fails_closed(service, client):
    """A legacy session predates the marker. Guessing the author would be
    worse than remembering nothing."""
    session = make_session([text_event("user", "q"), text_event("root_agent", "a")])
    session.state.clear()
    invocation = invocation_for(session)
    await service.add_session_to_memory(session)
    assert client.writes == []
    assert service.skips.get("no_attribution")


@pytest.mark.asyncio
async def test_replaying_the_same_invocation_reuses_its_keys(service, client):
    """Automatic capture, a re-import and a restart must agree byte for byte."""
    session = make_session([text_event("user", "q one"), text_event("root_agent", "a one")])
    await service.capture_invocation(session, invocation_for(session))
    await service.add_session_to_memory(session)
    keys = [write["idempotency_key"] for write in client.writes]
    assert len(keys) == 2 and keys[0] == keys[1]


@pytest.mark.asyncio
async def test_full_session_import_captures_each_invocation_separately(service, client):
    session = make_session(
        [
            text_event("user", "first question", invocation_id="inv-1"),
            text_event("root_agent", "first answer", invocation_id="inv-1"),
            text_event("user", "second question", invocation_id="inv-2"),
            text_event("root_agent", "second answer", invocation_id="inv-2"),
        ]
    )
    await service.add_session_to_memory(session)
    assert len(client.writes) == 2
    assert len({write["idempotency_key"] for write in client.writes}) == 2


@pytest.mark.asyncio
async def test_delta_without_a_session_id_fails_closed(service, client):
    """Unattributed sessions must never be merged into one conversation."""
    await service.add_events_to_memory(
        app_name="app",
        user_id="user-1",
        events=[text_event("user", "q"), text_event("root_agent", "a")],
        session_id=None,
    )
    assert client.writes == []
    assert service.skips.get("no_identity")


@pytest.mark.asyncio
async def test_out_of_order_and_duplicate_events_canonicalise_identically(service, client):
    ordered = [
        text_event("user", "q one", event_id="e1", timestamp=100.0),
        text_event("root_agent", "a one", event_id="e2", timestamp=200.0),
    ]
    shuffled = [ordered[1], ordered[0], ordered[0]]  # reversed, with a duplicate

    session_a = make_session(ordered)
    session_b = make_session(shuffled)
    await service.capture_invocation(session_a, invocation_for(session_a))
    await service.capture_invocation(session_b, invocation_for(session_b))

    keys = [write["idempotency_key"] for write in client.writes]
    assert len(keys) == 2 and keys[0] == keys[1]


@pytest.mark.asyncio
async def test_credentials_in_the_transcript_are_scrubbed(service, client):
    session = make_session(
        [
            text_event("user", "my key is itsuki_live_abcdefghijklmnop0123456789"),
            text_event("root_agent", "noted"),
        ]
    )
    await service.capture_invocation(session, invocation_for(session))
    assert "itsuki_live_abcdefghijklmnop" not in json.dumps(client.writes)
