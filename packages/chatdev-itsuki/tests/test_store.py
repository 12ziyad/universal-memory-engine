"""ChatDev store tests.

Two lanes. The ``requires_chatdev`` tests run against the REAL ChatDev host
types loaded by conftest — real ``MemoryStoreConfig``, ``MemoryContentSnapshot``,
``MemoryWritePayload``, ``MemoryItem`` and the real ``register_memory_store`` —
which is the genuine host proof the earlier version lacked. The host-free tests
cover the parts that carry no ChatDev dependency (header stripping).

What is still NOT proven, and why the package is held from publication: a full
multi-agent workflow run driven by a real LLM. That needs an OpenAI-class key
and the entire ChatDev runtime, and it is the outstanding stop-gate.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import httpx
import pytest
from itsuki import MemoryClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from chatdev_itsuki.headers import strip_pipeline_headers  # noqa: E402
from conftest import HOST_AVAILABLE, requires_chatdev  # noqa: E402

TEST_KEY = "itsuki_live_abcdefgh12345678"
MEMORY_TEXT = "Ziyad has been learning Kotlin since March 2026."


def make_client(handler=None):
    calls: list = []

    def default_handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.url.path == "/v1/recall":
            return httpx.Response(200, json={
                "ok": True,
                "context": MEMORY_TEXT,
                "count": 1,
                "items": [{"id": "node_1", "summary": MEMORY_TEXT, "score": 0.9}],
            })
        return httpx.Response(200, json={"ok": True, "source_packet_id": "pkt_1"})

    def chosen(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return handler(request)

    client = MemoryClient(api_key=TEST_KEY, base_url="https://api.example")
    client._client.close()
    client._client = httpx.Client(
        base_url="https://api.example",
        transport=httpx.MockTransport(chosen if handler else default_handler),
        headers={"authorization": f"Bearer {TEST_KEY}", "content-type": "application/json"},
    )
    return client, calls


def body_of(request: httpx.Request) -> dict:
    return json.loads(request.content) if request.content else {}


def saves(calls) -> list:
    return [c for c in calls if c.url.path == "/v1/save"]


def recalls(calls) -> list:
    return [c for c in calls if c.url.path == "/v1/recall"]


# ------------------------------------------------------------ host-free lane
@pytest.mark.parametrize("framed,expected", [
    ("### Task\nI started boxing", "I started boxing"),
    ("[Stage: gen]\nI started boxing", "I started boxing"),
    ("Role: Programmer\nI started boxing", "I started boxing"),
    ("<ChatDev>\nI started boxing", "I started boxing"),
    ("I started boxing", "I started boxing"),
])
def test_pipeline_framing_is_stripped(framed, expected):
    assert strip_pipeline_headers(framed) == expected


def test_importing_the_package_does_not_require_chatdev():
    # `import chatdev_itsuki` must work for inspection even without the host;
    # touching the host-bound symbols is what needs ChatDev.
    import chatdev_itsuki
    assert chatdev_itsuki.strip_pipeline_headers("### x\nhi") == "hi"


# --------------------------------------------------------- real ChatDev lane
def _config_and_store(client, **overrides):
    """Build a real MemoryStoreConfig wrapping a real ItsukiMemoryConfig."""
    from chatdev_itsuki.config import ItsukiMemoryConfig
    from chatdev_itsuki.store import ItsukiMemoryStore
    from entity.configs.node.memory import MemoryStoreConfig

    fields = {"api_key": TEST_KEY, "user_id": "acme_team", "path": "root.memory"}
    fields.update(overrides)
    itsuki_config = ItsukiMemoryConfig(**fields)
    store_config = MemoryStoreConfig(
        name="team_memory", type="itsuki", config=itsuki_config, path="root.memory",
    )
    return ItsukiMemoryStore(store_config, client=client), store_config


def _snapshot(text: str):
    from runtime.node.agent.memory.memory_base import MemoryContentSnapshot
    return MemoryContentSnapshot(text=text)


def _payload(inputs_text: str, agent_role: str = "programmer"):
    from runtime.node.agent.memory.memory_base import MemoryWritePayload
    return MemoryWritePayload(
        agent_role=agent_role,
        inputs_text=inputs_text,
        input_snapshot=_snapshot(inputs_text),
        output_snapshot=_snapshot("some agent output"),
    )


@requires_chatdev
def test_store_is_a_real_memory_base_subclass():
    from runtime.node.agent.memory.memory_base import MemoryBase
    client, _ = make_client()
    store, _ = _config_and_store(client)
    assert isinstance(store, MemoryBase)


@requires_chatdev
def test_config_builds_from_yaml_shaped_dict():
    # Exactly the path ChatDev's loader takes: MemoryStoreConfig.from_dict ->
    # schema.config_cls.from_dict. This is the real host parser.
    from chatdev_itsuki.config import ItsukiMemoryConfig
    config = ItsukiMemoryConfig.from_dict(
        {"api_key": "${ITSUKI_API_KEY}", "user_id": "acme", "top_k": 7},
        path="root.memory.config",
    )
    assert config.user_id == "acme"
    assert config.top_k == 7
    # The credential field holds the ${VAR} reference, never an expanded secret.
    assert config.api_key == "${ITSUKI_API_KEY}"


@requires_chatdev
def test_registers_against_the_real_registry():
    from runtime.node.agent.memory.registry import (
        memory_store_registry,
        register_memory_store,
    )
    from schema_registry import iter_memory_store_schemas
    from chatdev_itsuki.register import STORE_TYPE, register

    if STORE_TYPE in memory_store_registry.names():
        pytest.skip("already registered in this session")

    assert register(register_memory_store) is True
    assert STORE_TYPE in memory_store_registry.names()
    # The schema registry — what drives YAML validation and the UI enum — sees it.
    assert STORE_TYPE in iter_memory_store_schemas()


@requires_chatdev
def test_retrieve_returns_real_memory_items():
    from runtime.node.agent.memory.memory_base import MemoryItem
    client, calls = make_client()
    store, _ = _config_and_store(client)

    items = store.retrieve("programmer", _snapshot("what am I learning"), top_k=5,
                           similarity_threshold=-1.0)

    assert items and all(isinstance(i, MemoryItem) for i in items)
    # The manager reads item.content_summary; the memory text must be there.
    assert any(MEMORY_TEXT in i.content_summary for i in items)
    assert recalls(calls)[0].url.path == "/v1/recall"


@requires_chatdev
def test_retrieve_is_empty_for_framing_with_no_content():
    client, calls = make_client()
    store, _ = _config_and_store(client)
    assert store.retrieve("programmer", _snapshot("### Task"), 5, -1.0) == []
    assert not recalls(calls)


@requires_chatdev
def test_retrieve_degrades_instead_of_failing_a_stage():
    def failing(request):
        return httpx.Response(503, json={"error": "unavailable"})

    client, _ = make_client(failing)
    store, _ = _config_and_store(client)
    assert store.retrieve("programmer", _snapshot("anything"), 5, -1.0) == []


@requires_chatdev
def test_update_memorizes_only_the_user_input():
    client, calls = make_client()
    store, _ = _config_and_store(client)

    store.update(_payload("### Task\nI started boxing"))

    body = body_of(saves(calls)[0])
    assert body["content"] == "I started boxing"
    assert "agent output" not in json.dumps(body)
    assert body["source"] == "chatdev"


@requires_chatdev
def test_update_is_idempotent_across_a_re_executed_stage():
    client, calls = make_client()
    store, _ = _config_and_store(client)
    store.update(_payload("I started boxing"))
    store.update(_payload("I started boxing"))
    keys = {body_of(c)["idempotencyKey"] for c in saves(calls)}
    assert len(keys) == 1


@requires_chatdev
def test_update_scrubs_credentials():
    client, calls = make_client()
    store, _ = _config_and_store(client)
    store.update(_payload(f"my key is {TEST_KEY}"))
    body = json.dumps(body_of(saves(calls)[0]))
    assert TEST_KEY not in body
    assert "REDACTED" in body


@requires_chatdev
def test_the_expanded_key_never_lands_on_the_config():
    # ${ITSUKI_API_KEY} is expanded to build the client, but the config the host
    # would serialize keeps only the reference.
    import os
    os.environ["ITSUKI_API_KEY"] = TEST_KEY
    try:
        _, store_config = _config_and_store(make_client()[0], api_key="${ITSUKI_API_KEY}")
        assert store_config.config.api_key == "${ITSUKI_API_KEY}"
        assert TEST_KEY not in json.dumps(store_config.config.api_key)
    finally:
        os.environ.pop("ITSUKI_API_KEY", None)


@requires_chatdev
def test_two_workflows_write_to_their_own_spaces():
    ca, calls_a = make_client()
    cb, calls_b = make_client()
    a, _ = _config_and_store(ca, user_id="team_a")
    b, _ = _config_and_store(cb, user_id="team_b")
    a.update(_payload("shared sentence"))
    b.update(_payload("shared sentence"))
    assert body_of(saves(calls_a)[0])["userId"] == "team_a"
    assert body_of(saves(calls_b)[0])["userId"] == "team_b"
    assert body_of(saves(calls_a)[0])["idempotencyKey"] != body_of(saves(calls_b)[0])["idempotencyKey"]


@requires_chatdev
def test_agent_role_supplies_a_space_only_when_the_node_named_none():
    # A node with neither user_id nor agent_id must still refuse construction —
    # the role fallback is for retrieve/update, never for silent tenancy.
    from chatdev_itsuki.config import ItsukiMemoryConfig
    from chatdev_itsuki.store import ItsukiMemoryStore
    from entity.configs.node.memory import MemoryStoreConfig

    config = ItsukiMemoryConfig(api_key=TEST_KEY, path="root")
    wrapper = MemoryStoreConfig(name="m", type="itsuki", config=config, path="root")
    with pytest.raises(ValueError, match="user_id or agent_id"):
        ItsukiMemoryStore(wrapper, client=make_client()[0])


@requires_chatdev
def test_clear_is_gated_and_scoped():
    client, calls = make_client()
    store, _ = _config_and_store(client)
    store.clear()
    assert not [c for c in calls if c.method == "DELETE"]

    client2, calls2 = make_client()
    allowed, _ = _config_and_store(client2, allow_clear=True)
    allowed.clear()
    deletes = [c for c in calls2 if c.method == "DELETE"]
    assert len(deletes) == 1
    assert "source=chatdev" in str(deletes[0].url)


@requires_chatdev
def test_the_manager_lifecycle_end_to_end():
    """retrieve on stage entry, update then save on stage exit — real types."""
    from runtime.node.agent.memory.memory_base import MemoryManager
    from entity.configs.node.memory import MemoryAttachmentConfig
    from entity.enums import AgentExecFlowStage

    client, calls = make_client()
    store, _ = _config_and_store(client)

    attachment = MemoryAttachmentConfig(
        name="team_memory", top_k=5, similarity_threshold=-1.0, read=True, write=True,
        path="root",
    )
    manager = MemoryManager(attachments=[attachment], stores={"team_memory": store})

    result = manager.retrieve(
        "programmer", _snapshot("what was I working on?"),
        current_stage=AgentExecFlowStage.FINISHED_STAGE,
    )
    assert result is not None
    assert "Related Memories" in result.formatted_text
    assert MEMORY_TEXT in result.formatted_text

    manager.update(_payload("### Task\nI started boxing"))
    assert saves(calls), "the manager drove a capture through the store"


def test_host_availability_is_reported():
    # A visible signal in the run so a skip is never mistaken for a pass.
    print(f"\n[chatdev-itsuki] real ChatDev host available: {HOST_AVAILABLE}")
