"""Python SDK unit tests — httpx.MockTransport, no network.

Run:  pip install -e sdk/python httpx pytest && pytest sdk/python/tests
"""

import json
import time
from datetime import datetime, timezone
from email.utils import format_datetime

import httpx
import pytest

from itsuki import (
    CommandResult,
    DeleteResult,
    PacketStatusResult,
    ReceiptsResult,
    SourceEvent,
    TERMINAL_JOB_STATUSES,
    TimedOutPacketStatus,
    VERSION,
    MemoryClient,
    MemoryAPIError,
    MemoryMessage,
    MemoryRules,
)


def make_client(handler, **kw):
    client = MemoryClient(api_key="itsuki_live_test", base_url="https://api.example", **kw)
    client._client.close()
    client._client = httpx.Client(
        base_url="https://api.example",
        transport=httpx.MockTransport(handler),
        headers={"authorization": "Bearer itsuki_live_test", "content-type": "application/json"},
    )
    return client


def test_requires_api_key():
    with pytest.raises(MemoryAPIError):
        MemoryClient("")

    with pytest.raises(MemoryAPIError):
        MemoryClient("   ")


def test_prepared_release_version():
    assert VERSION == "0.2.1"
    assert TERMINAL_JOB_STATUSES == {"enriched", "failed", "completed"}
    assert MemoryMessage is not None
    assert MemoryRules is not None
    assert CommandResult is not None
    assert DeleteResult is not None
    assert PacketStatusResult is not None
    assert ReceiptsResult is not None
    assert SourceEvent is not None
    assert TimedOutPacketStatus is not None


@pytest.mark.parametrize(
    "base_url",
    ["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"],
)
def test_cleartext_base_url_is_allowed_only_for_loopback_development(base_url):
    client = MemoryClient("itsuki_live_test", base_url=base_url)
    client.close()


@pytest.mark.parametrize(
    "base_url",
    [
        "http://api.example",
        "http://0.0.0.0:8787",
        "ftp://api.example",
        "https://key@example.com",
        "https://api.example/v1",
        "https://api.example?debug=1",
        "https://api example",
        "https://%",
        "https://api.example\\evil",
    ],
)
def test_base_url_rejects_unsafe_or_non_origin_values(base_url):
    with pytest.raises(MemoryAPIError, match="base_url"):
        MemoryClient("itsuki_live_test", base_url=base_url)


def test_add_and_search_shapes():
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={"ok": True, "context": "Kotlin - learning"})

    m = make_client(handler)
    m.add("I run daily.", idempotencyKey="idem_1")
    result = m.search("running")
    assert seen[0].url.path == "/v1/save"
    assert seen[0].headers["authorization"] == "Bearer itsuki_live_test"
    assert b"idem_1" in seen[0].content
    assert seen[1].url.path == "/v1/recall"
    assert result["context"].startswith("Kotlin")


@pytest.mark.parametrize(
    "invoke",
    [
        lambda client: client.add(""),
        lambda client: client.add("   "),
        lambda client: client.add(messages=[]),
        lambda client: client.add_conversation([]),
        lambda client: client.search(""),
        lambda client: client.search(query="\t"),
    ],
)
def test_primary_write_and_recall_inputs_must_be_non_empty(invoke):
    client = make_client(lambda request: httpx.Response(200, json={"ok": True}))
    with pytest.raises(MemoryAPIError) as excinfo:
        invoke(client)
    assert excinfo.value.code == "invalid_argument"


def test_turn_allows_empty_messages_only_with_query_and_ingest_allows_empty():
    seen = []

    def handler(request):
        seen.append(json.loads(request.content))
        return httpx.Response(200, json={"ok": True})

    client = make_client(handler)
    with pytest.raises(MemoryAPIError) as missing_query:
        client.turn([])
    assert missing_query.value.code == "invalid_argument"

    with pytest.raises(MemoryAPIError) as blank_query:
        client.turn([], query="  ")
    assert blank_query.value.code == "invalid_argument"

    client.turn([], query="what changed?")
    client.ingest([], flush=True)
    assert seen == [
        {"query": "what changed?", "messages": []},
        {"flush": True, "messages": []},
    ]


@pytest.mark.parametrize(
    "invoke",
    [
        lambda client: client.add("original", **{"content": "override"}),
        lambda client: client.add("original", mode="conversation"),
        lambda client: client.add_conversation(
            ["original"], **{"messages": ["override"]}
        ),
        lambda client: client.add_conversation(["original"], content="override"),
        lambda client: client.add_conversation(["original"], mode="single"),
        lambda client: client.turn(["original"], **{"messages": ["override"]}),
        lambda client: client.ingest(["original"], **{"messages": ["override"]}),
        lambda client: client.search("original", **{"query": "override"}),
    ],
)
def test_reserved_options_cannot_override_method_arguments(invoke):
    client = make_client(lambda request: httpx.Response(200, json={"ok": True}))
    with pytest.raises(MemoryAPIError) as excinfo:
        invoke(client)
    assert excinfo.value.code == "invalid_argument"


def test_sub_tenant_user_id_in_query_and_body():
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={"ok": True})

    m = make_client(handler, user_id="end-user-7")
    m.status()
    m.add("fact")
    assert "userId=end-user-7" in str(seen[0].url)
    assert seen[1].url.query == b""
    assert b"end-user-7" in seen[1].content


def test_per_call_user_id_overrides_constructor_and_none_selects_owner():
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={"ok": True})

    m = make_client(handler, user_id="default-user")
    m.add("fact", user_id="call-user")
    m.search("fact", user_id=None)
    m.status(user_id="status-user")
    m.graph(user_id=None)

    assert seen[0].url.query == b""
    assert json.loads(seen[0].content)["userId"] == "call-user"
    assert seen[1].url.query == b""
    assert json.loads(seen[1].content)["userId"] is None
    assert seen[2].url.params["userId"] == "status-user"
    assert "userId" not in seen[3].url.params


def test_sub_tenant_receipts_preserves_limit_query():
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={"receipts": []})

    m = make_client(handler, user_id="end-user-7")
    m.receipts(limit=17)

    assert seen[0].url.path == "/v1/receipts"
    assert seen[0].url.params["limit"] == "17"
    assert seen[0].url.params["userId"] == "end-user-7"


@pytest.mark.parametrize("limit", [0, -1, 1.5, True, float("nan"), float("inf")])
def test_receipts_rejects_invalid_limits(limit):
    with pytest.raises(MemoryAPIError, match="limit") as excinfo:
        make_client(lambda request: httpx.Response(200, json={})).receipts(limit=limit)
    assert excinfo.value.code == "invalid_argument"


def test_sub_tenant_usage_preserves_range_query():
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={"usage": []})

    m = make_client(handler, user_id="end-user-7")
    m.usage(range="all")

    assert seen[0].url.path == "/v1/usage"
    assert seen[0].url.params["range"] == "all"
    assert seen[0].url.params["userId"] == "end-user-7"


def test_usage_rejects_ranges_the_usage_endpoint_does_not_support():
    with pytest.raises(MemoryAPIError, match="1d, 7d, 30d, or all"):
        make_client(lambda request: httpx.Response(200, json={})).usage(
            range="90d"  # type: ignore[arg-type]
        )


def test_project_memory_and_recall_scopes_use_wire_names_without_user_id():
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={"ok": True})

    scope = {"projectId": "atlas", "projectName": "Atlas"}
    m = make_client(handler)
    m.add("Atlas deploys from main.", memory_scope=scope)
    m.search(
        "How does Atlas deploy?",
        memory_scope=scope,
        recall_scope="project_then_global",
    )

    assert seen[0].url.query == b""
    first_body = json.loads(seen[0].content)
    second_body = json.loads(seen[1].content)
    assert first_body["memoryScope"] == scope
    assert second_body["memoryScope"] == scope
    assert second_body["recallScope"] == "project_then_global"


def test_write_and_recall_operation_routes_and_aliases():
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={"ok": True, "context": "ready"})

    m = make_client(handler)
    m.add_conversation(
        [{"role": "user", "content": "one"}],
        conversation_id="conv-1",
        source_scope={"workspace_id": "workspace-1"},
        recent_context="earlier context",
    )
    m.turn([{"role": "user", "content": "two"}], thread_id="thread-1")
    m.ingest([{"role": "user", "content": "three"}], flush=True)
    assert m.recall("what?")["context"] == "ready"

    assert [request.url.path for request in seen] == [
        "/v1/save",
        "/v1/turn",
        "/v1/ingest",
        "/v1/recall",
    ]
    assert json.loads(seen[0].content) == {
        "mode": "conversation",
        "messages": [{"role": "user", "content": "one"}],
        "conversationId": "conv-1",
        "sourceScope": {"workspace_id": "workspace-1"},
        "recentContext": "earlier context",
    }
    assert json.loads(seen[1].content)["threadId"] == "thread-1"
    assert json.loads(seen[2].content)["flush"] is True


def test_read_status_and_delete_helpers_support_per_call_tenant_scope():
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={"ok": True, "jobs": []})

    m = make_client(handler, user_id="default-user")
    m.receipts(limit=17, user_id="receipts-user")
    m.usage(range="all", user_id="usage-user")
    m.get_rules(user_id="rules-user")
    m.set_rules({"autoCollect": True}, user_id="rules-write-user")
    m.export_all(user_id="export-user")
    m.packet_status("packet / 1", user_id="packet-user")
    m.jobs(status="failed", since=123, limit=7, user_id="jobs-user")
    m.delete("node / 1", user_id="delete-user")
    m.delete_by_source(source="ingest", after=456, confirm=True, user_id="bulk-user")

    assert dict(seen[0].url.params) == {"limit": "17", "userId": "receipts-user"}
    assert dict(seen[1].url.params) == {"range": "all", "userId": "usage-user"}
    assert seen[2].url.params["userId"] == "rules-user"
    assert json.loads(seen[3].content)["userId"] == "rules-write-user"
    assert seen[4].url.params["userId"] == "export-user"
    assert "/v1/packets/packet%20%2F%201/status" in str(seen[5].url)
    assert seen[5].url.params["userId"] == "packet-user"
    assert dict(seen[6].url.params) == {
        "status": "failed",
        "since": "123",
        "limit": "7",
        "userId": "jobs-user",
    }
    assert "/v1/memories/node%20%2F%201" in str(seen[7].url)
    assert seen[7].url.params["userId"] == "delete-user"
    assert dict(seen[8].url.params) == {
        "source": "ingest",
        "after": "456",
        "confirm": "true",
        "dry_run": "false",
        "userId": "bulk-user",
    }


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"status": "unknown"}, "status"),
        ({"status": []}, "status"),
        ({"since": 0}, "since"),
        ({"since": float("nan")}, "since"),
        ({"since": float("inf")}, "since"),
        ({"since": 10 ** 10000}, "since"),
        ({"limit": 0}, "limit"),
        ({"limit": 1.5}, "limit"),
        ({"limit": True}, "limit"),
    ],
)
def test_jobs_rejects_invalid_filters(kwargs, message):
    client = make_client(lambda request: httpx.Response(200, json={"jobs": []}))
    with pytest.raises(MemoryAPIError, match=message) as excinfo:
        client.jobs(**kwargs)
    assert excinfo.value.code == "invalid_argument"


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"source": ""}, "source"),
        ({"source": " ingest"}, "source"),
        ({"source": "ingest\x00tail"}, "source"),
        ({"before": 0}, "before"),
        ({"before": float("nan")}, "before"),
        ({"after": float("inf")}, "after"),
        ({"after": 10 ** 10000}, "after"),
        ({"after": True}, "after"),
    ],
)
def test_delete_by_source_rejects_invalid_filters(kwargs, message):
    client = make_client(lambda request: httpx.Response(200, json={"ok": True}))
    with pytest.raises(MemoryAPIError, match=message) as excinfo:
        client.delete_by_source(**kwargs)
    assert excinfo.value.code == "invalid_argument"


def test_jobs_and_deletes_preserve_explicit_owner_scope_override():
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={"ok": True, "jobs": []})

    client = make_client(handler, user_id="constructor-user")
    client.jobs(user_id=None)
    client.delete("node-1", user_id=None)
    client.delete_by_source(source="ingest", user_id=None)

    assert all("userId" not in request.url.params for request in seen)


def test_wait_for_accepts_completed_as_a_terminal_compatibility_status(monkeypatch):
    statuses = iter(["processing", "completed"])
    sleeps = []

    def handler(request):
        return httpx.Response(200, json={"ok": True, "status": next(statuses)})

    monkeypatch.setattr("itsuki.time.sleep", lambda seconds: sleeps.append(seconds))
    result = make_client(handler).wait_for("packet-1", timeout=10, interval=0.01)

    assert result["status"] == "completed"
    assert result.get("timed_out") is not True
    assert sleeps


def test_wait_for_caps_poll_sleep_to_remaining_budget(monkeypatch):
    statuses = iter(["processing", "completed"])
    sleeps = []

    def handler(request):
        return httpx.Response(200, json={"ok": True, "status": next(statuses)})

    monkeypatch.setattr("itsuki.time.sleep", lambda seconds: sleeps.append(seconds))
    result = make_client(handler).wait_for("packet-1", timeout=0.02, interval=60)

    assert result["status"] == "completed"
    assert len(sleeps) == 1
    assert 0 < sleeps[0] <= 0.020001


def test_wait_for_bounds_a_slow_status_request_to_remaining_budget():
    observed_timeouts = []

    def handler(request):
        request_timeout = request.extensions["timeout"]["read"]
        observed_timeouts.append(request_timeout)
        # Exceed one Windows monotonic-clock tick after the requested timeout.
        time.sleep(request_timeout + 0.05)
        raise httpx.ReadTimeout("synthetic slow status", request=request)

    started = time.monotonic()
    result = make_client(handler, timeout=0.5).wait_for("packet-1", timeout=0.02)
    elapsed = time.monotonic() - started

    assert result == {"status": "unknown", "timed_out": True}
    assert len(observed_timeouts) == 1
    assert 0 < observed_timeouts[0] <= 0.020001
    assert elapsed < 1.0


def test_wait_for_zero_timeout_still_checks_once_and_forwards_user_id():
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={"ok": True, "status": "processing"})

    result = make_client(handler, user_id="default-user").wait_for(
        "packet-1", timeout=0, user_id=None
    )

    assert result == {"ok": True, "status": "processing", "timed_out": True}
    assert len(seen) == 1
    assert "userId" not in seen[0].url.params


@pytest.mark.parametrize(
    ("timeout", "interval", "message"),
    [
        (-1, 1, "timeout"),
        (float("nan"), 1, "timeout"),
        (float("inf"), 1, "timeout"),
        (2_147_483.648, 1, "timeout"),
        (1, 0, "interval"),
        (1, -1, "interval"),
        (1, float("nan"), "interval"),
        (1, float("inf"), "interval"),
        (1, 2_147_483.648, "interval"),
    ],
)
def test_wait_for_rejects_invalid_polling_values(timeout, interval, message):
    with pytest.raises(MemoryAPIError, match=message):
        make_client(lambda request: httpx.Response(200, json={})).wait_for(
            "packet-1", timeout=timeout, interval=interval
        )


def test_reads_retry_on_500():
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(500, json={"error": "boom"})
        return httpx.Response(200, json={"ok": True, "nodes": 1})

    assert make_client(handler).status()["nodes"] == 1
    assert calls["n"] == 2


def test_writes_do_not_retry_without_idempotency_key():
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        return httpx.Response(500, json={"error": "boom"})

    with pytest.raises(MemoryAPIError):
        make_client(handler).add("x")
    assert calls["n"] == 1


def test_writes_retry_with_python_spelled_idempotency_key(monkeypatch):
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(503, json={"error": "busy"})
        return httpx.Response(200, json={"ok": True})

    monkeypatch.setattr("itsuki.time.sleep", lambda seconds: None)
    result = make_client(handler).add("x", idempotency_key="idem_python")

    assert result == {"ok": True}
    assert calls["n"] == 2


def test_retry_after_sleep_is_capped_to_the_request_budget(monkeypatch):
    sleeps = []

    def handler(request):
        return httpx.Response(503, headers={"retry-after": "60"}, json={"error": "busy"})

    monkeypatch.setattr("itsuki.time.sleep", lambda seconds: sleeps.append(seconds))
    with pytest.raises(MemoryAPIError):
        make_client(handler, timeout=0.05).status()

    assert sleeps
    assert all(0 <= seconds <= 0.05 for seconds in sleeps)


def test_retry_after_http_date_is_converted_to_seconds(monkeypatch):
    calls = {"count": 0}
    sleeps = []
    now = 1_800_000_000
    retry_at = format_datetime(datetime.fromtimestamp(now + 2, tz=timezone.utc))

    def handler(request):
        calls["count"] += 1
        if calls["count"] == 1:
            return httpx.Response(
                503,
                headers={"retry-after": retry_at},
                json={"error": "busy"},
            )
        return httpx.Response(200, json={"ok": True})

    monkeypatch.setattr("itsuki.time.time", lambda: now)
    monkeypatch.setattr("itsuki.time.sleep", lambda seconds: sleeps.append(seconds))
    assert make_client(handler, timeout=10, max_retries=1).status() == {"ok": True}
    assert calls["count"] == 2
    assert sleeps == pytest.approx([2.0])


@pytest.mark.parametrize("retry_after", ["NaN", "Infinity", "-Infinity", "not-a-date"])
def test_invalid_or_non_finite_retry_after_is_never_exposed(retry_after):
    def handler(request):
        return httpx.Response(
            503,
            headers={"retry-after": retry_after},
            json={"error": "busy"},
        )

    with pytest.raises(MemoryAPIError) as excinfo:
        make_client(handler, max_retries=0).status()
    assert excinfo.value.retry_after is None


def test_typed_error_on_403():
    def handler(request):
        return httpx.Response(403, json={"error": "forbidden"})

    with pytest.raises(MemoryAPIError) as excinfo:
        make_client(handler).search("q")
    assert excinfo.value.status == 403
    assert excinfo.value.code == "forbidden"


def test_non_object_json_error_is_wrapped_in_memory_api_error():
    def handler(request):
        return httpx.Response(502, json=["upstream unavailable"])

    with pytest.raises(MemoryAPIError) as excinfo:
        make_client(handler, max_retries=0).status()

    assert excinfo.value.status == 502
    assert excinfo.value.body == ["upstream unavailable"]
    assert excinfo.value.code is None


def test_non_string_error_fields_do_not_become_misleading_strings():
    def handler(request):
        return httpx.Response(400, json={"error": {"reason": "nested"}, "code": 42})

    with pytest.raises(MemoryAPIError) as excinfo:
        make_client(handler).search("q")
    assert str(excinfo.value) == "POST /v1/recall failed with 400"
    assert excinfo.value.code is None
    assert excinfo.value.body == {"error": {"reason": "nested"}, "code": 42}


def test_constructor_rejects_invalid_retry_and_timeout_settings():
    with pytest.raises(MemoryAPIError, match="max_retries"):
        MemoryClient("itsuki_live_test", max_retries=-1)
    with pytest.raises(MemoryAPIError, match="max_retries"):
        MemoryClient("itsuki_live_test", max_retries=11)
    with pytest.raises(MemoryAPIError, match="timeout"):
        MemoryClient("itsuki_live_test", timeout=0)
    with pytest.raises(MemoryAPIError, match="timeout"):
        MemoryClient("itsuki_live_test", timeout=float("nan"))
    with pytest.raises(MemoryAPIError, match="timeout"):
        MemoryClient("itsuki_live_test", timeout=10 ** 10000)
    with pytest.raises(MemoryAPIError, match="timeout"):
        MemoryClient("itsuki_live_test", timeout=2_147_483.648)


@pytest.mark.parametrize(
    ("method", "value"),
    [("delete", "node_1\x00tail"), ("packet_status", "packet_1\ntail")],
)
def test_identifiers_reject_control_characters(method, value):
    client = make_client(lambda request: httpx.Response(200, json={}))
    with pytest.raises(MemoryAPIError, match="control characters"):
        getattr(client, method)(value)


def test_bulk_delete_requires_a_real_boolean_confirmation():
    with pytest.raises(MemoryAPIError, match="confirm"):
        make_client(lambda request: httpx.Response(200, json={})).delete_by_source(
            source="ingest", confirm="false"  # type: ignore[arg-type]
        )


@pytest.mark.parametrize("key", ["", " idem", "idem\x00tail", 17])
def test_idempotency_key_is_validated_before_network(key):
    with pytest.raises(MemoryAPIError, match="idempotency_key") as excinfo:
        make_client(lambda request: pytest.fail("network must not be called")).add(
            "fact", idempotency_key=key
        )
    assert excinfo.value.code == "invalid_argument"


def test_new_idempotency_key_unique():
    a = MemoryClient.new_idempotency_key()
    assert a.startswith("idem_")
    assert MemoryClient.new_idempotency_key() != a
