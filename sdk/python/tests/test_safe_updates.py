"""Direct execution tests for update / history / rollback.

The first release shipped these methods with no test that actually called
them: the released 0.4.0 even reported VERSION "0.3.0". These tests run the
real client against a scripted transport and assert the exact wire contract,
for both the sync and async clients.
"""

import asyncio
import json

import httpx
import pytest

from itsuki import VERSION, AsyncMemoryClient, MemoryClient

KEY = "itsuki_live_test"
BASE = "https://api.example"


def _headers():
    return {
        "authorization": f"Bearer {KEY}",
        "content-type": "application/json",
        "user-agent": f"itsuki-python/{VERSION}",
    }


def make_client(handler):
    """Sync client wired to a scripted transport (same pattern as the suite)."""
    client = MemoryClient(api_key=KEY, base_url=BASE)
    client._client.close()
    client._client = httpx.Client(
        base_url=BASE, transport=httpx.MockTransport(handler),
        follow_redirects=False, headers=_headers(),
    )
    return client


def make_async_client(handler):
    client = AsyncMemoryClient(api_key=KEY, base_url=BASE)
    client._client = httpx.AsyncClient(
        base_url=BASE, transport=httpx.MockTransport(handler),
        follow_redirects=False, headers=_headers(),
    )
    return client


def json_response(payload, status=200):
    return httpx.Response(status, json=payload)


def test_version_string_matches_package_metadata():
    # The published artifact must not lie about which release it is.
    import tomllib
    from pathlib import Path

    pyproject = Path(__file__).resolve().parents[1] / "pyproject.toml"
    declared = tomllib.loads(pyproject.read_text(encoding="utf-8"))["project"]["version"]
    assert VERSION == declared


def test_update_sends_precondition_and_idempotency_key():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["method"] = request.method
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        return json_response({"ok": True, "revision": 4, "previous_revision": 3})

    client = make_client(handler)
    result = client.update(
        "node_abc",
        {"summary": "Corrected."},
        expected_revision=3,
        reason="sdk correction",
    )

    assert result["revision"] == 4
    assert seen["method"] == "PATCH"
    assert seen["url"].endswith("/v1/memories/node_abc")
    assert seen["body"]["summary"] == "Corrected."
    assert seen["body"]["expectedRevision"] == 3
    assert seen["body"]["reason"] == "sdk correction"
    assert len(seen["body"]["idempotencyKey"]) >= 8


def test_update_rejects_bad_arguments_before_any_request():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return json_response({"ok": True})

    client = make_client(handler)
    with pytest.raises(Exception):
        client.update("node_abc", {}, expected_revision=1)
    with pytest.raises(Exception):
        client.update("node_abc", {"summary": "x"}, expected_revision=0)
    with pytest.raises(Exception):
        client.update("", {"summary": "x"}, expected_revision=1)
    assert calls == []


def test_history_uses_bounded_query():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        return json_response({"ok": True, "current_revision": 4, "revisions": []})

    client = make_client(handler)
    client.history("node_abc", limit=10, cursor="7")
    assert "/v1/memories/node_abc/history" in seen["url"]
    assert "limit=10" in seen["url"]
    assert "cursor=7" in seen["url"]


def test_rollback_sends_target_and_head():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["method"] = request.method
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        return json_response({"ok": True, "revision": 5, "rolled_back_to": 2})

    client = make_client(handler)
    result = client.rollback("event_abc", 2, expected_revision=4)

    assert result["rolled_back_to"] == 2
    assert seen["method"] == "POST"
    assert seen["url"].endswith("/v1/memories/event_abc/rollback")
    assert seen["body"]["toRevision"] == 2
    assert seen["body"]["expectedRevision"] == 4


def test_stale_revision_surfaces_the_server_code():
    def handler(request: httpx.Request) -> httpx.Response:
        return json_response(
            {"error": "stale_revision", "code": "stale_revision", "current_revision": 9},
            status=412,
        )

    client = make_client(handler)
    with pytest.raises(Exception) as excinfo:
        client.update("node_abc", {"summary": "x"}, expected_revision=3)
    message = str(excinfo.value)
    assert "stale_revision" in message or "412" in message


def test_async_update_history_rollback_round_trip():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append((request.method, str(request.url)))
        if request.method == "PATCH":
            return json_response({"ok": True, "revision": 2})
        if request.url.path.endswith("/history"):
            return json_response({"ok": True, "current_revision": 2, "revisions": [
                {"revision": 1, "action": "baseline"}, {"revision": 2, "action": "update"},
            ]})
        return json_response({"ok": True, "revision": 3, "rolled_back_to": 1})

    async def drive():
        client = make_async_client(handler)
        updated = await client.update("node_abc", {"summary": "async"}, expected_revision=1)
        assert updated["revision"] == 2
        history = await client.history("node_abc")
        assert history["current_revision"] == 2
        rolled = await client.rollback("node_abc", 1, expected_revision=2)
        assert rolled["rolled_back_to"] == 1

    asyncio.run(drive())
    assert [method for method, _ in calls] == ["PATCH", "GET", "POST"]
