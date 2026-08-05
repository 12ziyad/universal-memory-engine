"""Python SDK unit tests — httpx.MockTransport, no network.

Run:  pip install -e sdk/python httpx pytest && pytest sdk/python/tests
"""

import httpx
import pytest

from itsuki import MemoryClient, MemoryAPIError


def make_client(handler, **kw):
    client = MemoryClient(api_key="itsuki_live_test", base_url="https://api.example", **kw)
    client._client = httpx.Client(
        base_url="https://api.example",
        transport=httpx.MockTransport(handler),
        headers={"authorization": "Bearer itsuki_live_test", "content-type": "application/json"},
    )
    return client


def test_requires_api_key():
    with pytest.raises(MemoryAPIError):
        MemoryClient("")


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


def test_sub_tenant_user_id_in_query_and_body():
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={"ok": True})

    m = make_client(handler, user_id="end-user-7")
    m.status()
    m.add("fact")
    assert "userId=end-user-7" in str(seen[0].url)
    assert b"end-user-7" in seen[1].content


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


def test_sub_tenant_usage_preserves_range_query():
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={"usage": []})

    m = make_client(handler, user_id="end-user-7")
    m.usage(range="90d")

    assert seen[0].url.path == "/v1/usage"
    assert seen[0].url.params["range"] == "90d"
    assert seen[0].url.params["userId"] == "end-user-7"


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
    assert b'"memoryScope"' in seen[0].content
    assert b'"projectId":"atlas"' in seen[0].content
    assert b'"recallScope":"project_then_global"' in seen[1].content


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


def test_typed_error_on_403():
    def handler(request):
        return httpx.Response(403, json={"error": "forbidden"})

    with pytest.raises(MemoryAPIError) as excinfo:
        make_client(handler).search("q")
    assert excinfo.value.status == 403


def test_new_idempotency_key_unique():
    a = MemoryClient.new_idempotency_key()
    assert a.startswith("idem_")
    assert MemoryClient.new_idempotency_key() != a
