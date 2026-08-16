"""The provider driven by the host's own MemoryManager.

These run only when a real hermes-agent is installed (both CI legs install
one). They are the tests that would have caught a wrong assumption about the
host, because nothing here is our own stub: the manager, the skill-scaffolding
stripper and the ABC all come from the host package.
"""

from __future__ import annotations

import tempfile
import time

import pytest

from conftest import HOST_IS_REAL, RecordingClient
from hermes_itsuki.provider import ItsukiMemoryProvider

pytestmark = pytest.mark.skipif(not HOST_IS_REAL, reason="requires an installed hermes-agent")


@pytest.fixture
def managed(monkeypatch):
    """A provider registered with the host's real MemoryManager."""
    from agent.memory_manager import MemoryManager

    monkeypatch.setenv("ITSUKI_API_KEY", "itsuki_live_probekey0123456789")
    client = RecordingClient(context="the user ships on fridays", count=1)
    provider = ItsukiMemoryProvider(client_factory=lambda *_: (client, client))

    manager = MemoryManager()
    manager.add_provider(provider)
    manager.initialize_all(
        session_id="20260816_120000_probe",
        platform="cli",
        hermes_home=tempfile.mkdtemp(),
    )
    yield manager, provider, client
    manager.shutdown_all()


def settle(manager, client, user, assistant="an answer the user saw"):
    manager.on_turn_start(1, user)
    injected = manager.prefetch_all(user)
    manager.sync_all(user, assistant, session_id="20260816_120000_probe")
    for _ in range(40):
        if client.writes:
            break
        time.sleep(0.05)
    return injected


def test_the_provider_is_the_hosts_own_abstraction():
    from agent.memory_provider import MemoryProvider

    provider = ItsukiMemoryProvider()
    assert isinstance(provider, MemoryProvider)
    assert not getattr(ItsukiMemoryProvider, "__abstractmethods__", frozenset())


def test_one_external_provider_rule_accepts_us(managed):
    manager, provider, _client = managed
    assert provider.name == "itsuki"


def test_a_real_turn_recalls_then_captures(managed):
    manager, _provider, client = managed
    injected = settle(manager, client, "what did I ship last week")
    assert "<itsuki-recalled-context-v1>" in injected
    assert len(client.searches) == 1
    assert len(client.writes) == 1
    assert [m["role"] for m in client.writes[0]["messages"]] == ["user", "assistant"]


def test_recall_through_the_real_manager_is_user_scoped(managed):
    manager, _provider, client = managed
    manager.on_turn_start(1, "a genuine question about the parser")
    manager.prefetch_all("a genuine question about the parser")
    assert "conversation_id" not in client.searches[0]


def test_trivial_prompts_cost_nothing_through_the_real_manager(managed):
    """The host calls on_turn_start before its own trivial gate."""
    manager, _provider, client = managed
    for noise in ("ok", "thanks", "yes"):
        manager.on_turn_start(2, noise)
        manager.prefetch_all(noise)
    assert client.searches == []


def test_skill_scaffolding_never_reaches_the_wire(managed):
    """H-SKILL, built with the host's own constants rather than a guess.

    Hermes expands `/skill` into a message carrying the entire skill body and
    strips it once, in prefetch_all. This asserts the contract our recall path
    depends on: the body stays local, only the instruction travels.
    """
    import agent.skill_commands as sc

    manager, _provider, client = managed
    body = "ENTIRE-SKILL-BODY-SECRET-PAYLOAD"
    expanded = (
        sc._SKILL_INVOCATION_PREFIX
        + "deploy skill. "
        + sc._SINGLE_SKILL_MARKER
        + "\n"
        + body
        + "\n"
        + sc._SINGLE_SKILL_INSTRUCTION
        + "what is my deploy step"
    )

    manager.on_turn_start(1, expanded)
    manager.prefetch_all(expanded)

    assert client.searches, "a skill turn with an instruction still recalls"
    for search in client.searches:
        assert body not in search["query"]
    assert client.searches[0]["query"] == "what is my deploy step"


def test_a_bare_skill_invocation_recalls_nothing(managed):
    """No user instruction means no question, so there is nothing to look up."""
    import agent.skill_commands as sc

    manager, _provider, client = managed
    bare = sc._SKILL_INVOCATION_PREFIX + "deploy skill. " + sc._SINGLE_SKILL_MARKER + "\nBODY"
    manager.on_turn_start(1, bare)
    manager.prefetch_all(bare)
    assert client.searches == []


def test_capture_through_the_manager_is_idempotent(managed):
    manager, _provider, client = managed
    for _ in range(3):
        manager.sync_all("same question", "same answer", session_id="s-dup")
        time.sleep(0.2)
    assert len({write.get("idempotency_key") for write in client.writes}) == 1


def test_session_switch_through_the_manager_does_not_disturb_recall(managed):
    manager, provider, client = managed
    manager.on_turn_start(1, "the very same question text")
    manager.prefetch_all("the very same question text")
    provider.on_session_switch("20260816_121500_next")
    manager.on_turn_start(1, "the very same question text")
    manager.prefetch_all("the very same question text")
    assert len(client.searches) == 2, "a new turn must recall again, never reuse a memo"


def test_the_deployed_directory_plugin_loads_through_the_hosts_own_loader(tmp_path, monkeypatch):
    """P-H0, permanent.

    The installer's whole reason to exist is that PyPI 0.19.0 has no
    entry-point discovery -- so the deployed directory MUST load through the
    host's own `plugins.memory` loader, synthetic-package machinery, relative
    imports and all. This drives that loader directly, not our code.
    """
    import hermes_itsuki.installer as installer_module

    home = tmp_path / "hermes-home"
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("ITSUKI_API_KEY", "itsuki_live_ph0key0123456789")
    monkeypatch.setattr(installer_module, "ensure_sdk", lambda _home: (True, "sdk present"))

    ok, notes = installer_module.install(str(home))
    assert ok, notes

    from plugins.memory import discover_memory_providers, load_memory_provider

    names = [entry[0] for entry in discover_memory_providers()]
    assert "itsuki" in names, f"host discovery missed the deployed plugin: {names}"

    provider = load_memory_provider("itsuki")
    assert provider is not None
    assert provider.name == "itsuki"
    assert [tool["name"] for tool in provider.get_tool_schemas()] == ["itsuki_recall", "itsuki_status"]
