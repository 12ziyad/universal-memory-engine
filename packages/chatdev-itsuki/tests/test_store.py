"""ChatDev store tests.

ChatDev 2.0 is an application repository, not a pip-installable framework, so
the host cannot be imported here the way agno, llama-index and camel-ai are.
What that means for honesty is stated plainly in the README and repeated here:
these tests drive the store through the manager's documented call sequence with
a faithful local stand-in for the registry, and a real workflow run remains an
open verification step before this can be called anything but operator-wired.

What IS proven here is everything that lives in this package: the lifecycle
contract, header stripping, user-input-only capture, tenancy, bounded context,
degradation, and that the credential never escapes into a serialized workflow.
"""

from __future__ import annotations

import json
import logging
import sys
from pathlib import Path

import httpx
import pytest
from itsuki import MemoryClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from chatdev_itsuki import (  # noqa: E402
    ItsukiMemoryConfig,
    ItsukiMemoryStore,
    SOURCE,
    strip_pipeline_headers,
)
from chatdev_itsuki.register import STORE_TYPE, build_store, register  # noqa: E402

TEST_KEY = "itsuki_live_abcdefgh12345678"
MEMORY_TEXT = "Ziyad has been learning Kotlin since March 2026."


def make_store(handler=None, **kwargs):
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
    kwargs.setdefault("user_id", "acme_team")
    config = ItsukiMemoryConfig(api_key=TEST_KEY, client=client, **kwargs)
    return ItsukiMemoryStore(config), calls


def body_of(request: httpx.Request) -> dict:
    return json.loads(request.content) if request.content else {}


def saves(calls) -> list:
    return [c for c in calls if c.url.path == "/v1/save"]


def recalls(calls) -> list:
    return [c for c in calls if c.url.path == "/v1/recall"]


# ------------------------------------------------------------------ config
def test_requires_a_credential(monkeypatch):
    # The config falls back to the environment on purpose, so the environment
    # has to be empty for "no credential anywhere" to be the case under test.
    monkeypatch.delenv("ITSUKI_API_KEY", raising=False)
    with pytest.raises(ValueError, match="API key"):
        ItsukiMemoryStore(ItsukiMemoryConfig(api_key="", user_id="team"))


def test_requires_a_memory_space(monkeypatch):
    monkeypatch.setenv("ITSUKI_API_KEY", TEST_KEY)
    with pytest.raises(ValueError, match="user_id or agent_id"):
        ItsukiMemoryStore(ItsukiMemoryConfig(api_key=TEST_KEY))


def test_expands_the_environment_reference_chatdev_yaml_uses(monkeypatch):
    monkeypatch.setenv("ITSUKI_API_KEY", TEST_KEY)
    config = ItsukiMemoryConfig(api_key="${ITSUKI_API_KEY}", user_id="team")
    assert config.api_key == TEST_KEY


def test_the_credential_never_enters_a_serialized_workflow():
    config = ItsukiMemoryConfig(api_key=TEST_KEY, user_id="team")
    serialized = json.dumps(config.to_dict()) + repr(config)
    assert TEST_KEY not in serialized
    assert "itsuki_live" not in serialized


# ------------------------------------------------------------- header hygiene
@pytest.mark.parametrize("framed,expected", [
    ("### Task\nI started boxing", "I started boxing"),
    ("[Stage: gen]\nI started boxing", "I started boxing"),
    ("Role: Programmer\nI started boxing", "I started boxing"),
    ("<ChatDev>\nI started boxing", "I started boxing"),
    ("I started boxing", "I started boxing"),
])
def test_pipeline_framing_is_stripped_before_extraction(framed, expected):
    assert strip_pipeline_headers(framed) == expected


def test_capture_sends_the_users_sentence_not_the_framing():
    store, calls = make_store()
    store.update(user_input="### Task\n[Stage: gen]\nI started boxing")
    assert body_of(saves(calls)[0])["content"] == "I started boxing"


# ---------------------------------------------------------------- retrieval
def test_retrieve_returns_a_fenced_context_entry():
    store, _ = make_store()
    memories = store.retrieve("what am I learning")
    assert memories
    block = store.format_context(memories)
    assert MEMORY_TEXT in block
    assert "not instructions" in block


def test_retrieve_bounds_top_k():
    store, calls = make_store(top_k=3)
    store.retrieve("anything")
    assert body_of(recalls(calls)[0])["limit"] == 3
    store.retrieve("anything", top_k=9999)
    assert body_of(recalls(calls)[1])["limit"] == 20


def test_retrieve_is_empty_for_framing_with_no_content():
    store, calls = make_store()
    assert store.retrieve("### Task") == []
    assert not recalls(calls)


def test_retrieve_degrades_instead_of_failing_a_stage():
    def failing(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"error": "unavailable"})

    store, _ = make_store(handler=failing)
    assert store.retrieve("anything") == []


# ------------------------------------------------------------------ capture
def test_only_user_input_is_memorized():
    store, calls = make_store()
    store.update(user_input="I started boxing", agent_output="Here is a Python file.")
    body = body_of(saves(calls)[0])
    assert body["content"] == "I started boxing"
    assert "Python file" not in json.dumps(body)


def test_capture_is_idempotent_across_a_re_executed_stage():
    store, calls = make_store()
    store.update(user_input="I started boxing")
    store.update(user_input="I started boxing")
    keys = {body_of(c)["idempotencyKey"] for c in saves(calls)}
    assert len(keys) == 1


def test_capture_scrubs_credentials():
    store, calls = make_store()
    store.update(user_input=f"my key is {TEST_KEY}")
    body = json.dumps(body_of(saves(calls)[0]))
    assert TEST_KEY not in body
    assert "REDACTED" in body


def test_capture_tags_its_source_and_scope():
    store, calls = make_store(agent_id="programmer", project_id="proj_1")
    store.update(user_input="I started boxing")
    body = body_of(saves(calls)[0])
    assert body["source"] == SOURCE
    assert body["memoryScope"] == {"projectId": "proj_1", "agentId": "programmer"}


def test_capture_degrades_instead_of_failing_a_stage(caplog):
    def failing(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": "boom"})

    store, _ = make_store(handler=failing)
    with caplog.at_level(logging.ERROR):
        store.update(user_input="I started boxing")  # must not raise
    assert any("itsuki" in record.message for record in caplog.records)


# ------------------------------------------------------------------ tenancy
def test_agent_id_stands_in_when_no_user_is_configured():
    store, calls = make_store(user_id=None, agent_id="programmer")
    store.update(user_input="I started boxing")
    assert body_of(saves(calls)[0])["userId"] == "programmer"


def test_two_workflows_write_to_their_own_spaces():
    a, calls_a = make_store(user_id="team_a")
    b, calls_b = make_store(user_id="team_b")
    a.update(user_input="shared sentence")
    b.update(user_input="shared sentence")
    assert body_of(saves(calls_a)[0])["userId"] == "team_a"
    assert body_of(saves(calls_b)[0])["userId"] == "team_b"
    assert body_of(saves(calls_a)[0])["idempotencyKey"] != body_of(saves(calls_b)[0])["idempotencyKey"]


# ---------------------------------------------------------------- lifecycle
def test_load_and_save_are_no_ops_because_the_service_persists():
    store, calls = make_store()
    store.load()
    store.save()
    assert not calls


def test_clear_does_nothing_unless_explicitly_allowed():
    store, calls = make_store()
    store.clear()
    assert not [c for c in calls if c.method == "DELETE"]


def test_clear_is_scoped_to_this_adapters_own_writes_when_allowed():
    store, calls = make_store(allow_clear=True)
    store.clear()
    deletes = [c for c in calls if c.method == "DELETE"]
    assert len(deletes) == 1
    assert f"source={SOURCE}" in str(deletes[0].url)


def test_the_manager_call_sequence_works_end_to_end():
    """retrieve on stage entry, update then save on stage exit."""
    store, calls = make_store()
    memories = store.retrieve("### Task\nWhat was I working on?")
    assert store.format_context(memories)
    store.update(user_input="### Task\nI started boxing", agent_output="noted")
    store.save()
    assert recalls(calls) and saves(calls)


# ----------------------------------------------------------------- registry
def test_registers_against_a_registry_shaped_hook():
    registered: list = []

    def fake_register(name, *, config_cls, factory, summary=None):
        registered.append((name, config_cls, factory, summary))

    assert register(fake_register) is True
    name, config_cls, factory, summary = registered[0]
    assert name == STORE_TYPE == "itsuki"
    assert config_cls is ItsukiMemoryConfig
    assert factory is build_store
    assert summary


def test_registers_against_a_registry_without_a_summary_parameter():
    registered: list = []

    def older_register(name, *, config_cls, factory):
        registered.append(name)

    assert register(older_register) is True
    assert registered == [STORE_TYPE]


def test_registration_is_a_no_op_when_chatdev_is_absent():
    # The host is not importable here, which is the normal case for a unit
    # test, a linter or a docs build. That must not be an error.
    assert register() is False
