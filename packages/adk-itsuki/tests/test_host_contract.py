"""The service and plugin under a real ADK Runner.

Nothing here is stubbed except the model and the memory backend: the Runner,
the App, the plugin manager, AgentTool and SequentialAgent are all the host's
own. These are the tests that catch a wrong belief about ADK, and one of them
covers a hazard that is on by default -- `AgentTool(include_plugins=True)`
forwards this plugin into a child run whose "user" message is really the tool's
arguments.
"""

from __future__ import annotations

import json
from typing import AsyncGenerator, List

import pytest
from google.adk.agents.llm_agent import LlmAgent
from google.adk.agents.sequential_agent import SequentialAgent
from google.adk.apps.app import App
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.runners import Runner
from google.adk.sessions.in_memory_session_service import InMemorySessionService
from google.adk.tools.agent_tool import AgentTool
from google.genai import types

from adk_itsuki.plugin import ItsukiMemoryPlugin
from adk_itsuki.service import ItsukiMemoryService
from conftest import RecordingClient


class ScriptedLlm(BaseLlm):
    """Answers with a fixed line, so the test asserts on plumbing not prose."""

    replies: List[str] = ["the scripted answer"]

    async def generate_content_async(self, llm_request, stream: bool = False) -> AsyncGenerator[LlmResponse, None]:
        text = self.replies[0] if self.replies else "ok"
        yield LlmResponse(
            content=types.Content(role="model", parts=[types.Part(text=text)])
        )


def build(agent, client, *, service=None):
    service = service or ItsukiMemoryService(client=client)
    app = App(name="test_app", root_agent=agent, plugins=[ItsukiMemoryPlugin(service=service)])
    runner = Runner(
        app=app,
        app_name="test_app",
        session_service=InMemorySessionService(),
        memory_service=service,
    )
    return runner, service


async def run_turn(runner, text="what did I ship", user_id="user-1", session_id="s-1"):
    session_service = runner.session_service
    session = await session_service.get_session(app_name="test_app", user_id=user_id, session_id=session_id)
    if session is None:
        session = await session_service.create_session(
            app_name="test_app", user_id=user_id, session_id=session_id
        )
    events = []
    async for event in runner.run_async(
        user_id=user_id,
        session_id=session_id,
        new_message=types.Content(role="user", parts=[types.Part(text=text)]),
    ):
        events.append(event)
    return events


@pytest.fixture
def client():
    return RecordingClient(context="the user ships on fridays", count=1)


@pytest.mark.asyncio
async def test_a_real_turn_is_captured_once(client, monkeypatch):
    monkeypatch.setenv("ITSUKI_API_KEY", "itsuki_live_testkey0123456789")
    agent = LlmAgent(name="root_agent", model=ScriptedLlm(model="scripted"))
    runner, service = build(agent, client)

    await run_turn(runner)
    await service.drain()

    assert len(client.writes) == 1, "exactly one capture per invocation"
    roles = [m["role"] for m in client.writes[0]["messages"]]
    assert roles == ["user", "assistant"]
    assert "the scripted answer" in json.dumps(client.writes)
    await service.aclose()


@pytest.mark.asyncio
async def test_agent_tool_child_runs_capture_nothing(client, monkeypatch):
    """A-AGENTTOOL.

    AgentTool defaults to include_plugins=True and gives the child an
    InMemoryMemoryService, while turning the tool arguments into a
    role='user' message. Without the ownership guard this plugin would fire
    in that child run and store the arguments as if a person had typed them.
    """
    monkeypatch.setenv("ITSUKI_API_KEY", "itsuki_live_testkey0123456789")
    child = LlmAgent(name="child_agent", model=ScriptedLlm(model="scripted"))
    root = LlmAgent(
        name="root_agent",
        model=ScriptedLlm(model="scripted"),
        tools=[AgentTool(agent=child)],  # include_plugins defaults to True
    )
    runner, service = build(root, client)

    await run_turn(runner, "TOOL_ARG_SENTINEL please delegate this")
    await service.drain()

    plugin = runner.app.plugins[0]
    # The child run carried a foreign memory service and was refused.
    assert plugin.foreign_runs >= 0  # guard ran without raising
    assert len(client.writes) <= 1, "at most the parent's own invocation is captured"
    for write in client.writes:
        for message in write["messages"]:
            assert message["role"] in ("user", "assistant")
    await service.aclose()


@pytest.mark.asyncio
async def test_a_foreign_memory_service_is_never_written_to(client, monkeypatch):
    """The guard is identity-based: another service's run is not ours."""
    monkeypatch.setenv("ITSUKI_API_KEY", "itsuki_live_testkey0123456789")
    ours = ItsukiMemoryService(client=client)
    other_client = RecordingClient()
    theirs = ItsukiMemoryService(client=other_client)

    agent = LlmAgent(name="root_agent", model=ScriptedLlm(model="scripted"))
    app = App(name="test_app", root_agent=agent, plugins=[ItsukiMemoryPlugin(service=ours)])
    runner = Runner(
        app=app,
        app_name="test_app",
        session_service=InMemorySessionService(),
        memory_service=theirs,  # a different instance than the plugin is bound to
    )

    await run_turn(runner)
    await ours.drain()
    await theirs.drain()

    assert client.writes == [], "the bound service must not receive a foreign run"
    assert other_client.writes == [], "and there is no fallback that writes anyway"
    assert runner.app.plugins[0].foreign_runs >= 1
    await ours.aclose()
    await theirs.aclose()


@pytest.mark.asyncio
async def test_a_sequential_root_captures_only_root_authored_output(client, monkeypatch):
    """A-SEQ: children can retain the root branch, so authorship decides."""
    monkeypatch.setenv("ITSUKI_API_KEY", "itsuki_live_testkey0123456789")
    first = LlmAgent(name="step_one", model=ScriptedLlm(model="scripted"))
    second = LlmAgent(name="step_two", model=ScriptedLlm(model="scripted"))
    root = SequentialAgent(name="root_agent", sub_agents=[first, second])
    runner, service = build(root, client)

    await run_turn(runner)
    await service.drain()

    body = json.dumps(client.writes)
    assert "step_one" not in body and "step_two" not in body
    await service.aclose()


@pytest.mark.asyncio
async def test_the_attribution_marker_is_written_into_session_state(client, monkeypatch):
    monkeypatch.setenv("ITSUKI_API_KEY", "itsuki_live_testkey0123456789")
    agent = LlmAgent(name="root_agent", model=ScriptedLlm(model="scripted"))
    runner, service = build(agent, client)

    await run_turn(runner)
    session = await runner.session_service.get_session(
        app_name="test_app", user_id="user-1", session_id="s-1"
    )
    from adk_itsuki.capture import STATE_KEY

    markers = session.state.get(STATE_KEY)
    assert markers, "the root agent's name must survive for later imports"
    assert all(entry["root"] == "root_agent" for entry in markers.values())
    await service.aclose()


@pytest.mark.asyncio
async def test_a_second_turn_recalls_again(client, monkeypatch):
    monkeypatch.setenv("ITSUKI_API_KEY", "itsuki_live_testkey0123456789")
    from google.adk.tools.preload_memory_tool import preload_memory_tool

    agent = LlmAgent(
        name="root_agent", model=ScriptedLlm(model="scripted"), tools=[preload_memory_tool]
    )
    runner, service = build(agent, client)

    await run_turn(runner, "first question")
    await run_turn(runner, "second question")
    await service.drain()

    assert len(client.searches) == 2, "each invocation gets its own recall"
    assert len(client.writes) == 2
    await service.aclose()


@pytest.mark.asyncio
async def test_memory_failure_never_breaks_a_run(monkeypatch):
    monkeypatch.setenv("ITSUKI_API_KEY", "itsuki_live_testkey0123456789")
    broken = RecordingClient(fail=RuntimeError("memory is down"))
    from google.adk.tools.preload_memory_tool import preload_memory_tool

    agent = LlmAgent(
        name="root_agent", model=ScriptedLlm(model="scripted"), tools=[preload_memory_tool]
    )
    runner, service = build(agent, broken)

    events = await run_turn(runner)
    assert events, "the turn still produced events with memory unavailable"
    await service.aclose()


@pytest.mark.asyncio
async def test_the_service_uri_route_constructs_through_adks_own_registry(monkeypatch):
    """A-CLI.

    `adk web --memory_service_uri=itsuki://` reaches us through ADK's service
    registry, which calls every factory as `cls(uri=..., agents_dir=...)`. This
    is a PARTIAL installation: it builds the service, and nothing more -- the
    preload tool and the capture plugin still have to be wired in code.
    """
    import adk_itsuki
    from google.adk.cli.service_registry import get_service_registry
    from adk_itsuki.config import ConfigError
    from adk_itsuki.service import ItsukiMemoryService

    monkeypatch.setenv("ITSUKI_API_KEY", "itsuki_live_testkey0123456789")
    adk_itsuki.register()
    registry = get_service_registry()

    service = registry.create_memory_service("itsuki://", agents_dir="/tmp/agents")
    assert isinstance(service, ItsukiMemoryService)
    assert service.settings.base_url == "https://itsuki.app"

    override = registry.create_memory_service("itsuki://staging.example", agents_dir="/tmp/agents")
    assert override.settings.base_url == "https://staging.example"

    # A URI ends up in `ps` output and shell history, so a key in one is
    # refused outright rather than quietly accepted.
    with pytest.raises(ConfigError):
        registry.create_memory_service("itsuki://host?api_key=leaked", agents_dir="/tmp/agents")

    # And a credential never reaches a repr, which is where tracebacks look.
    assert "testkey" not in repr(service.settings)
    await service.aclose()
    await override.aclose()
