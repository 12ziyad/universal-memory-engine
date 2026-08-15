"""AsyncMemoryClient tests — httpx.MockTransport, no network, no pytest-asyncio.

Each test drives its own event loop with asyncio.run, so the suite adds no
plugin dependency to a package whose whole point is a thin dependency list.

The parity tests at the bottom are the ones that matter most: they prove the
async client and the sync client put the SAME bytes on the wire for the same
call, which is the only durable defence against the two drifting apart.
"""

import asyncio
import json
import time

import httpx
import pytest

from itsuki import AsyncMemoryClient, MemoryAPIError, MemoryClient, VERSION


def make_async_client(handler, **kw):
    client = AsyncMemoryClient(api_key="itsuki_live_test", base_url="https://api.example", **kw)
    client._client = httpx.AsyncClient(
        base_url="https://api.example",
        transport=httpx.MockTransport(handler),
        follow_redirects=False,
        headers={
            "authorization": "Bearer itsuki_live_test",
            "content-type": "application/json",
            "user-agent": f"itsuki-python/{VERSION}",
        },
    )
    return client


def make_sync_client(handler, **kw):
    client = MemoryClient(api_key="itsuki_live_test", base_url="https://api.example", **kw)
    client._client.close()
    client._client = httpx.Client(
        base_url="https://api.example",
        transport=httpx.MockTransport(handler),
        follow_redirects=False,
        headers={
            "authorization": "Bearer itsuki_live_test",
            "content-type": "application/json",
            "user-agent": f"itsuki-python/{VERSION}",
        },
    )
    return client


def run(coro):
    return asyncio.run(coro)


def ok(payload=None):
    def handler(request):
        return httpx.Response(200, json=payload if payload is not None else {"ok": True})

    return handler


# ------------------------------------------------------------- construction
def test_rejects_missing_api_key():
    with pytest.raises(MemoryAPIError):
        AsyncMemoryClient("")
    with pytest.raises(MemoryAPIError):
        AsyncMemoryClient("   ")


def test_rejects_plain_http_and_credential_urls():
    with pytest.raises(MemoryAPIError):
        AsyncMemoryClient("itsuki_live_test", base_url="http://api.example")
    with pytest.raises(MemoryAPIError):
        AsyncMemoryClient("itsuki_live_test", base_url="https://user:pw@api.example")


def test_allows_loopback_http():
    client = AsyncMemoryClient("itsuki_live_test", base_url="http://127.0.0.1:8787")
    assert str(client._client.base_url).startswith("http://127.0.0.1:8787")
    run(client.aclose())


def test_refuses_to_follow_redirects():
    # A redirect must never replay the Authorization header at another origin.
    client = AsyncMemoryClient("itsuki_live_test", base_url="https://api.example")
    assert client._client.follow_redirects is False
    run(client.aclose())


# -------------------------------------------------------------------- write
def test_add_posts_content_and_returns_payload():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"ok": True, "source_packet_id": "pkt_1"})

    async def main():
        client = make_async_client(handler)
        async with client:
            return await client.add("Ada prefers email.", user_id="ada")

    result = run(main())
    assert result["source_packet_id"] == "pkt_1"
    assert seen["url"] == "https://api.example/v1/save"
    assert seen["body"]["content"] == "Ada prefers email."
    assert seen["body"]["userId"] == "ada"


def test_snake_case_options_translate_to_wire_names():
    seen = {}

    def handler(request):
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"ok": True})

    async def main():
        client = make_async_client(handler)
        async with client:
            await client.add(
                "fact",
                conversation_id="conv-1",
                thread_id="thread-1",
                idempotency_key="idem_1",
                recall_scope="project_only",
                memory_scope={"projectId": "proj_1"},
            )

    run(main())
    assert seen["body"]["conversationId"] == "conv-1"
    assert seen["body"]["threadId"] == "thread-1"
    assert seen["body"]["idempotencyKey"] == "idem_1"
    assert seen["body"]["recallScope"] == "project_only"
    assert seen["body"]["memoryScope"] == {"projectId": "proj_1"}
    assert "conversation_id" not in seen["body"]


def test_add_conversation_sets_conversation_mode():
    seen = {}

    def handler(request):
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"ok": True})

    async def main():
        client = make_async_client(handler)
        async with client:
            await client.add_conversation([{"role": "user", "content": "hi"}])

    run(main())
    assert seen["body"]["mode"] == "conversation"
    assert seen["body"]["messages"] == [{"role": "user", "content": "hi"}]


def test_add_rejects_content_and_messages_together():
    async def main():
        client = make_async_client(ok())
        async with client:
            await client.add(content="a", messages=[{"role": "user", "content": "b"}])

    with pytest.raises(MemoryAPIError):
        run(main())


def test_turn_requires_messages_or_query():
    async def main():
        client = make_async_client(ok())
        async with client:
            await client.turn([])

    with pytest.raises(MemoryAPIError):
        run(main())


def test_ingest_accepts_empty_messages():
    async def main():
        client = make_async_client(ok({"ok": True, "counts": {}}))
        async with client:
            return await client.ingest([], flush=True)

    assert run(main())["ok"] is True


# --------------------------------------------------------------------- read
def test_search_posts_query_and_returns_context():
    def handler(request):
        assert str(request.url) == "https://api.example/v1/recall"
        return httpx.Response(200, json={"ok": True, "context": "Ada prefers email."})

    async def main():
        client = make_async_client(handler)
        async with client:
            return await client.search("email")

    assert run(main())["context"] == "Ada prefers email."


def test_get_endpoints_carry_user_id_as_query():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        return httpx.Response(200, json={"ok": True})

    async def main():
        client = make_async_client(handler, user_id="ada")
        async with client:
            await client.status()

    run(main())
    assert "userId=ada" in seen["url"]


def test_explicit_null_user_id_overrides_client_default():
    seen = {}

    def handler(request):
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"ok": True})

    async def main():
        client = make_async_client(handler, user_id="ada")
        async with client:
            await client.add("fact", user_id=None)

    run(main())
    assert seen["body"]["userId"] is None


def test_delete_by_source_is_a_dry_run_by_default():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        return httpx.Response(200, json={"ok": True, "dry_run": True, "would_delete": {}})

    async def main():
        client = make_async_client(handler)
        async with client:
            return await client.delete_by_source(source="ingest")

    result = run(main())
    assert result["dry_run"] is True
    assert "confirm" not in seen["url"]
    assert "dry_run=false" not in seen["url"]


def test_delete_by_source_confirm_sends_confirmation():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        return httpx.Response(200, json={"ok": True, "deleted": {}})

    async def main():
        client = make_async_client(handler)
        async with client:
            await client.delete_by_source(source="ingest", confirm=True)

    run(main())
    assert "confirm=true" in seen["url"]
    assert "dry_run=false" in seen["url"]


# ------------------------------------------------------------------ retries
def test_writes_without_idempotency_key_do_not_retry():
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(503, json={"error": "unavailable"})

    async def main():
        client = make_async_client(handler)
        async with client:
            await client.add("fact")

    with pytest.raises(MemoryAPIError):
        run(main())
    assert len(calls) == 1


def test_writes_with_idempotency_key_retry_then_succeed():
    calls = []

    def handler(request):
        calls.append(json.loads(request.content)["idempotencyKey"])
        if len(calls) < 3:
            return httpx.Response(500, json={"error": "boom"})
        return httpx.Response(200, json={"ok": True})

    async def main():
        client = make_async_client(handler, max_retries=2)
        async with client:
            return await client.add("fact", idempotency_key="idem_stable")

    assert run(main())["ok"] is True
    assert calls == ["idem_stable", "idem_stable", "idem_stable"]


def test_gets_retry_without_any_key():
    calls = []

    def handler(request):
        calls.append(1)
        if len(calls) < 2:
            return httpx.Response(500, json={"error": "boom"})
        return httpx.Response(200, json={"ok": True})

    async def main():
        client = make_async_client(handler, max_retries=2)
        async with client:
            return await client.status()

    assert run(main())["ok"] is True
    assert len(calls) == 2


def test_client_errors_raise_immediately_without_retry():
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(403, json={"error": "forbidden", "message": "no scope"})

    async def main():
        client = make_async_client(handler, max_retries=3)
        async with client:
            await client.status()

    with pytest.raises(MemoryAPIError) as excinfo:
        run(main())
    assert excinfo.value.status == 403
    assert excinfo.value.code == "forbidden"
    assert len(calls) == 1


def test_retry_after_header_is_honoured():
    calls = []
    slept = []

    async def fake_sleep(seconds):
        slept.append(seconds)

    def handler(request):
        calls.append(1)
        if len(calls) < 2:
            return httpx.Response(429, headers={"retry-after": "2"}, json={"error": "rate_limited"})
        return httpx.Response(200, json={"ok": True})

    async def main(monkeypatched_sleep):
        client = make_async_client(handler, max_retries=2, timeout=30)
        async with client:
            return await client.status()

    original = asyncio.sleep
    asyncio.sleep = fake_sleep
    try:
        result = run(main(fake_sleep))
    finally:
        asyncio.sleep = original
    assert result["ok"] is True
    assert slept == [2.0]


def test_timeout_maps_to_timeout_code():
    def handler(request):
        raise httpx.ReadTimeout("too slow", request=request)

    async def main():
        client = make_async_client(handler, max_retries=0)
        async with client:
            await client.status()

    with pytest.raises(MemoryAPIError) as excinfo:
        run(main())
    assert excinfo.value.code == "timeout"
    assert excinfo.value.status == 0


def test_transport_failure_maps_to_transport_error_code():
    def handler(request):
        raise httpx.ConnectError("dns is down", request=request)

    async def main():
        client = make_async_client(handler, max_retries=0)
        async with client:
            await client.status()

    with pytest.raises(MemoryAPIError) as excinfo:
        run(main())
    assert excinfo.value.code == "transport_error"


def test_non_serializable_body_raises_argument_error():
    async def main():
        client = make_async_client(ok())
        async with client:
            await client.add("fact", memory_scope={"bad": {1, 2, 3}})

    with pytest.raises(MemoryAPIError) as excinfo:
        run(main())
    assert "JSON-serializable" in str(excinfo.value)


# ---------------------------------------------------------------- lifecycle
def test_wait_for_polls_until_terminal_status():
    statuses = ["staged", "processing", "enriched"]
    calls = []

    def handler(request):
        calls.append(str(request.url))
        return httpx.Response(200, json={"ok": True, "status": statuses[len(calls) - 1]})

    async def main():
        client = make_async_client(handler)
        async with client:
            return await client.wait_for("pkt_1", timeout=30, interval=0.001)

    result = run(main())
    assert result["status"] == "enriched"
    assert result.get("timed_out") is None
    assert len(calls) == 3
    assert calls[0].endswith("/v1/packets/pkt_1/status")


def test_wait_for_returns_timed_out_snapshot_not_an_exception():
    def handler(request):
        return httpx.Response(200, json={"ok": True, "status": "processing"})

    async def main():
        client = make_async_client(handler)
        async with client:
            return await client.wait_for("pkt_1", timeout=0.05, interval=0.001)

    result = run(main())
    assert result["timed_out"] is True
    assert result["status"] == "processing"


def test_wait_for_zero_timeout_polls_exactly_once():
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(200, json={"ok": True, "status": "processing"})

    async def main():
        client = make_async_client(handler)
        async with client:
            return await client.wait_for("pkt_1", timeout=0)

    result = run(main())
    assert len(calls) == 1
    assert result["timed_out"] is True


def test_wait_for_scopes_the_poll_to_the_same_user_space():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        return httpx.Response(200, json={"ok": True, "status": "enriched"})

    async def main():
        client = make_async_client(handler)
        async with client:
            await client.wait_for("pkt_1", user_id="ada")

    run(main())
    assert "userId=ada" in seen["url"]


def test_aclose_closes_the_transport():
    async def main():
        client = make_async_client(ok())
        await client.aclose()
        return client._client.is_closed

    assert run(main()) is True


def test_async_context_manager_closes_on_exit():
    async def main():
        client = make_async_client(ok())
        async with client:
            await client.status()
        return client._client.is_closed

    assert run(main()) is True


# ----------------------------------------------------- event-loop discipline
def test_async_retries_never_block_the_event_loop():
    """A blocking sleep in an async client stalls every other task in the host."""
    calls = []

    def handler(request):
        calls.append(1)
        if len(calls) < 2:
            return httpx.Response(500, json={"error": "boom"})
        return httpx.Response(200, json={"ok": True})

    def exploding_sleep(_seconds):
        raise AssertionError("the async client must never call time.sleep")

    async def main():
        client = make_async_client(handler, max_retries=2)
        async with client:
            return await client.status()

    original = time.sleep
    time.sleep = exploding_sleep
    try:
        assert run(main())["ok"] is True
    finally:
        time.sleep = original
    assert len(calls) == 2


def test_async_client_yields_to_other_tasks_while_waiting():
    """Other tasks must make progress while a wait_for is polling."""
    ticks = []

    def handler(request):
        return httpx.Response(200, json={"ok": True, "status": "processing"})

    async def ticker():
        for _ in range(3):
            await asyncio.sleep(0.001)
            ticks.append(1)

    async def main():
        client = make_async_client(handler)
        async with client:
            background = asyncio.ensure_future(ticker())
            await client.wait_for("pkt_1", timeout=0.08, interval=0.005)
            await background

    run(main())
    assert len(ticks) == 3


def test_cancellation_propagates_and_stops_the_request():
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(429, headers={"retry-after": "30"}, json={"error": "rate_limited"})

    async def main():
        client = make_async_client(handler, max_retries=3, timeout=120)
        async with client:
            task = asyncio.ensure_future(client.status())
            await asyncio.sleep(0.01)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        return len(calls)

    # One request went out, then cancellation landed during the 30s backoff.
    assert run(main()) == 1


# --------------------------------------------------------------- sync parity
def _record_calls(store):
    def handler(request):
        store.append({
            "method": request.method,
            "url": str(request.url),
            "body": json.loads(request.content) if request.content else None,
            "authorization": request.headers.get("authorization"),
            "user_agent": request.headers.get("user-agent"),
        })
        return httpx.Response(200, json={"ok": True, "status": "enriched"})

    return handler


@pytest.mark.parametrize(
    "call",
    [
        ("add", ("Ada prefers email.",), {"user_id": "ada", "conversation_id": "c1"}),
        ("add_conversation", ([{"role": "user", "content": "hi"}],), {"user_id": "ada"}),
        ("search", ("email",), {"recall_scope": "project_only", "memory_scope": {"projectId": "p"}}),
        ("turn", ([{"role": "user", "content": "hi"}],), {"user_id": "ada"}),
        ("ingest", ([{"role": "user", "content": "hi"}],), {"flush": True}),
        ("status", (), {"user_id": "ada"}),
        ("jobs", ("processing", 1, 10), {"user_id": "ada"}),
        ("receipts", (25,), {"user_id": "ada"}),
        ("usage", ("7d",), {"user_id": "ada"}),
        ("delete", ("node_1",), {"user_id": "ada"}),
        ("delete_by_source", ("ingest", None, None, False), {"user_id": "ada"}),
        ("packet_status", ("pkt_1",), {"user_id": "ada"}),
        ("get_rules", (), {"user_id": "ada"}),
        ("export_all", (), {"user_id": "ada"}),
    ],
)
def test_async_and_sync_put_identical_bytes_on_the_wire(call):
    name, args, kwargs = call
    sync_calls = []
    async_calls = []

    sync_client = make_sync_client(_record_calls(sync_calls))
    getattr(sync_client, name)(*args, **kwargs)
    sync_client.close()

    async def main():
        client = make_async_client(_record_calls(async_calls))
        async with client:
            await getattr(client, name)(*args, **kwargs)

    run(main())
    assert sync_calls == async_calls


def test_async_and_sync_reject_the_same_arguments():
    bad_calls = [
        ("add", (), {}),
        ("add", ("a",), {"content": "b"}),
        ("turn", ([],), {}),
        ("search", ("",), {}),
        ("usage", ("99d",), {}),
        ("jobs", ("nonsense",), {}),
        ("receipts", (0,), {}),
        ("delete", ("  ",), {}),
        ("wait_for", ("pkt_1",), {"timeout": -1}),
        ("wait_for", ("pkt_1",), {"interval": 0}),
        ("set_rules", ("not-a-dict",), {}),
    ]

    for name, args, kwargs in bad_calls:
        sync_client = make_sync_client(ok())
        with pytest.raises(MemoryAPIError) as sync_error:
            getattr(sync_client, name)(*args, **kwargs)
        sync_client.close()

        async def main():
            client = make_async_client(ok())
            async with client:
                await getattr(client, name)(*args, **kwargs)

        with pytest.raises(MemoryAPIError) as async_error:
            run(main())

        assert str(sync_error.value) == str(async_error.value), name


def test_both_clients_expose_the_same_public_surface():
    public = lambda obj: {
        name for name in dir(obj)
        if not name.startswith("_") and callable(getattr(obj, name, None))
    }
    sync_surface = public(MemoryClient)
    async_surface = public(AsyncMemoryClient)
    # close/__enter__ are the sync spellings of aclose/__aenter__.
    assert sync_surface - {"close"} == async_surface - {"aclose"}
