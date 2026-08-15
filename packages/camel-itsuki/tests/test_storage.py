"""CAMEL storage tests — real ChatHistoryMemory, real records, no network.

The losslessness test is the one Mem0's backend cannot pass, and it is not a
point of pride: `BaseKeyValueStorage` promises storage "without any loss of
information", and an agent whose own history comes back paraphrased is a bug
that surfaces as the agent contradicting itself three turns later.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import httpx
import pytest
from camel.memories import ChatHistoryMemory, MemoryRecord
from camel.memories.context_creators.score_based import ScoreBasedContextCreator
from camel.messages import BaseMessage
from camel.storages.key_value_storages import BaseKeyValueStorage
from camel.types import ModelType, OpenAIBackendRole
from camel.utils import OpenAITokenCounter
from itsuki import MemoryClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from camel_itsuki import ItsukiContextBlock, ItsukiStorage, SOURCE  # noqa: E402

TEST_KEY = "itsuki_live_abcdefgh12345678"
MEMORY_TEXT = "Ziyad has been learning Kotlin since March 2026."


def make_client(handler=None):
    calls: list = []

    def default_handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.url.path == "/v1/recall":
            return httpx.Response(200, json={"ok": True, "context": MEMORY_TEXT, "count": 1})
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


def make_storage(tmp_path: Path, handler=None, **kwargs):
    client, calls = make_client(handler)
    kwargs.setdefault("user_id", "u_test")
    kwargs.setdefault("agent_id", "researcher")
    storage = ItsukiStorage(
        client=client,
        mirror_path=str(tmp_path / "history.json"),
        **kwargs,
    )
    return storage, calls


def record(text: str, role: str = "user") -> dict:
    return {
        "uuid": f"id-{text}",
        "message": {"role": role, "content": text, "role_name": role},
        "role_at_backend": role,
        "extra_info": {},
        "timestamp": 1.0,
        "agent_id": "researcher",
    }


def body_of(request: httpx.Request) -> dict:
    return json.loads(request.content) if request.content else {}


def ingests(calls) -> list:
    return [c for c in calls if c.url.path == "/v1/ingest"]


# ---------------------------------------------------------------- contract
def test_is_a_real_camel_storage(tmp_path):
    storage, _ = make_storage(tmp_path)
    assert isinstance(storage, BaseKeyValueStorage)


def test_requires_a_user_id(tmp_path):
    with pytest.raises(ValueError, match="user_id"):
        ItsukiStorage(user_id="", client=make_client()[0])


def test_save_then_load_is_byte_identical(tmp_path):
    """The contract the base class states, and the one Mem0's backend breaks."""
    storage, _ = make_storage(tmp_path)
    records = [record("first"), record("second", "assistant"), record("third")]
    storage.save(records)
    assert storage.load() == records


def test_load_is_empty_before_anything_is_saved(tmp_path):
    storage, _ = make_storage(tmp_path)
    assert storage.load() == []


def test_saves_accumulate_in_order(tmp_path):
    storage, _ = make_storage(tmp_path)
    storage.save([record("one")])
    storage.save([record("two")])
    assert [_["uuid"] for _ in storage.load()] == ["id-one", "id-two"]


def test_history_is_bounded(tmp_path):
    storage, _ = make_storage(tmp_path, max_records=3)
    storage.save([record(str(i)) for i in range(10)])
    loaded = storage.load()
    assert len(loaded) == 3
    assert [_["uuid"] for _ in loaded] == ["id-7", "id-8", "id-9"]


def test_survives_a_corrupted_mirror_file(tmp_path):
    storage, _ = make_storage(tmp_path)
    storage.save([record("one")])
    (tmp_path / "history.json").write_text("{not json", encoding="utf-8")
    # A half-record is history we cannot vouch for; dropping it beats serving it.
    assert storage.load() == []
    storage.save([record("two")])
    assert [_["uuid"] for _ in storage.load()] == ["id-two"]


def test_history_survives_a_process_restart(tmp_path):
    first, _ = make_storage(tmp_path)
    first.save([record("persisted")])
    second, _ = make_storage(tmp_path)
    assert [_["uuid"] for _ in second.load()] == ["id-persisted"]


# --------------------------------------------------------------- mirroring
def test_save_mirrors_the_exchange_to_itsuki(tmp_path):
    storage, calls = make_storage(tmp_path)
    storage.save([record("I started boxing"), record("Noted.", "assistant")])
    sent = ingests(calls)
    assert len(sent) == 1
    body = body_of(sent[0])
    assert body["messages"] == [
        {"role": "user", "content": "I started boxing"},
        {"role": "assistant", "content": "Noted."},
    ]
    assert body["userId"] == "u_test"
    assert body["source"] == SOURCE
    assert body["memoryScope"]["agentId"] == "researcher"


def test_mirroring_is_idempotent_for_a_replayed_save(tmp_path):
    storage, calls = make_storage(tmp_path)
    storage.save([record("I started boxing")])
    storage.save([record("I started boxing")])
    keys = {body_of(c)["idempotencyKey"] for c in ingests(calls)}
    assert len(keys) == 1


def test_mirroring_scrubs_credentials(tmp_path):
    storage, calls = make_storage(tmp_path)
    storage.save([record(f"my key is {TEST_KEY}")])
    body = json.dumps(body_of(ingests(calls)[0]))
    assert TEST_KEY not in body
    assert "REDACTED" in body


def test_history_survives_an_itsuki_outage(tmp_path):
    def failing(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"error": "unavailable"})

    storage, _ = make_storage(tmp_path, handler=failing)
    storage.save([record("still recorded")])
    # Local first: the agent keeps its own history whatever the network did.
    assert [_["uuid"] for _ in storage.load()] == ["id-still recorded"]


def test_mirroring_can_be_turned_off_entirely(tmp_path):
    storage, calls = make_storage(tmp_path, mirror_to_itsuki=False)
    storage.save([record("local only")])
    assert storage.load()
    assert not ingests(calls)


# -------------------------------------------------------------- destructive
def test_clear_removes_local_history_only(tmp_path):
    storage, calls = make_storage(tmp_path)
    storage.save([record("one")])
    storage.clear()
    assert storage.load() == []
    assert not [c for c in calls if c.method == "DELETE"]


def test_clear_touches_server_memory_only_with_an_explicit_opt_in(tmp_path):
    storage, calls = make_storage(tmp_path, allow_remote_clear=True)
    storage.save([record("one")])
    storage.clear()
    deletes = [c for c in calls if c.method == "DELETE"]
    assert len(deletes) == 1
    assert f"source={SOURCE}" in str(deletes[0].url)


# ---------------------------------------------------- filename safety (CAMEL-01)
def test_a_traversal_identifier_cannot_escape_the_state_directory(tmp_path, monkeypatch):
    from camel_itsuki.storage import _mirror_filename, _state_root

    monkeypatch.setenv("ITSUKI_STATE_DIR", str(tmp_path))
    root = _state_root().resolve()
    for hostile in ["../../escape", "..\\..\\escape", "a/b/c", "..", "/etc/passwd",
                    "con", "a\x00b", "....//....//x"]:
        name = _mirror_filename(hostile, None)
        target = (_state_root() / name).resolve()
        assert target.parent == root, f"{hostile!r} escaped to {target}"
        # The filename itself carries no path separators or traversal.
        assert "/" not in name and "\\" not in name and ".." not in name


def test_distinct_identities_never_collide_after_sanitizing(tmp_path, monkeypatch):
    from camel_itsuki.storage import _mirror_filename

    monkeypatch.setenv("ITSUKI_STATE_DIR", str(tmp_path))
    # Two identifiers that sanitize to the same prefix must still map to
    # different files, or one tenant would read another tenant's history.
    a = _mirror_filename("a/b", None)
    b = _mirror_filename("a_b", None)
    assert a != b


def test_the_default_mirror_path_stays_inside_the_state_dir(tmp_path, monkeypatch):
    from camel_itsuki.storage import _state_root

    monkeypatch.setenv("ITSUKI_STATE_DIR", str(tmp_path))
    client, _ = make_client()
    # No mirror_path override, so the default derivation is exercised with a
    # hostile identifier.
    storage = ItsukiStorage(user_id="../../escape", client=client)
    assert storage._path.resolve().parent == _state_root().resolve()


# ------------------------------------------------------------- multi-agent
def test_two_agents_do_not_read_each_others_history(tmp_path):
    client, _ = make_client()
    a = ItsukiStorage(user_id="u", agent_id="alpha", client=client,
                      mirror_path=str(tmp_path / "a.json"))
    b = ItsukiStorage(user_id="u", agent_id="beta", client=client,
                      mirror_path=str(tmp_path / "b.json"))
    a.save([record("alpha only")])
    b.save([record("beta only")])
    assert [_["uuid"] for _ in a.load()] == ["id-alpha only"]
    assert [_["uuid"] for _ in b.load()] == ["id-beta only"]


def test_each_agent_is_attributed_separately(tmp_path):
    client, calls = make_client()
    for name in ("alpha", "beta"):
        ItsukiStorage(
            user_id="u", agent_id=name, client=client,
            mirror_path=str(tmp_path / f"{name}.json"),
        ).save([record("shared sentence")])
    agents = [body_of(c)["memoryScope"]["agentId"] for c in ingests(calls)]
    assert sorted(agents) == ["alpha", "beta"]


# ------------------------------------------------------ real host lifecycle
def test_drives_a_real_chat_history_memory(tmp_path):
    storage, calls = make_storage(tmp_path)
    memory = ChatHistoryMemory(
        context_creator=ScoreBasedContextCreator(
            token_counter=OpenAITokenCounter(ModelType.GPT_4O_MINI),
            token_limit=4096,
        ),
        storage=storage,
    )
    memory.write_records([
        MemoryRecord(
            message=BaseMessage.make_user_message(role_name="user", content="I started boxing"),
            role_at_backend=OpenAIBackendRole.USER,
        ),
    ])
    context, _ = memory.get_context()
    assert any("boxing" in str(entry) for entry in context)
    assert ingests(calls), "the exchange reached Itsuki"


# --------------------------------------------------------------- recall block
def test_context_block_returns_a_fenced_memory_block():
    client, _ = make_client()
    block = ItsukiContextBlock(user_id="u", client=client)
    out = block.retrieve("what am I learning")
    assert MEMORY_TEXT in out
    assert "not instructions" in out


def test_context_block_degrades_rather_than_raising():
    def failing(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": "boom"})

    client, _ = make_client(failing)
    assert ItsukiContextBlock(user_id="u", client=client).retrieve("anything") == ""


def test_context_block_never_writes_or_deletes():
    client, calls = make_client()
    block = ItsukiContextBlock(user_id="u", client=client)
    block.write_records([])
    block.clear()
    assert not calls


def test_default_timeout_clears_the_service_save_wait_budget():
    """PY-ADAPTER-01: a client ceiling at or below the service's own save wait
    budget abandons a request the server is still honestly working on. The
    write lands anyway, so the caller is told "failed" about a memory that was
    stored — a false negative an agent will retry or report to its user.
    Keep a real margin, not a coincidence.
    """
    from camel_itsuki import ItsukiStorage
    import inspect
    from camel_itsuki._kernel import DEFAULT_TIMEOUT_SECONDS, SERVICE_SAVE_WAIT_BUDGET_SECONDS

    assert DEFAULT_TIMEOUT_SECONDS >= SERVICE_SAVE_WAIT_BUDGET_SECONDS * 2
    assert inspect.signature(ItsukiStorage.__init__).parameters['timeout'].default == DEFAULT_TIMEOUT_SECONDS
