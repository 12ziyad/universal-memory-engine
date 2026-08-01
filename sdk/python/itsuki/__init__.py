"""Itsuki Python SDK — one private memory for every AI.

    from itsuki import MemoryClient

    memory = MemoryClient(api_key="itsuki_live_...")
    memory.add("I started learning Kotlin this week.")
    print(memory.search("what am I learning?")["context"])
"""

from __future__ import annotations

import random
import time
import uuid
from typing import Any, Optional

import httpx

DEFAULT_BASE_URL = "https://itsuki.app"
VERSION = "0.1.1"

__all__ = ["MemoryClient", "Memory", "MemoryAPIError", "VERSION"]


class MemoryAPIError(Exception):
    """Raised for every non-2xx API response or transport failure."""

    def __init__(self, message: str, *, status: int = 0, code: Optional[str] = None, body: Any = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.body = body


class MemoryClient:
    """Thin synchronous client over the Itsuki REST API.

    api_key:  itsuki_live_... Bearer key (legacy uml_live_ keys also work).
    user_id:  optional sub-tenant selector — a stable string per end user of
              YOUR app; each value maps to an isolated memory space.
    """

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        user_id: Optional[str] = None,
        timeout: float = 30.0,
        max_retries: int = 2,
    ):
        if not api_key:
            raise MemoryAPIError("api_key is required")
        self.user_id = user_id
        self.max_retries = max_retries
        self._client = httpx.Client(
            base_url=base_url.rstrip("/"),
            timeout=timeout,
            headers={
                "authorization": f"Bearer {api_key}",
                "content-type": "application/json",
                "user-agent": f"itsuki-python/{VERSION}",
            },
        )

    # ----------------------------------------------------------- write
    def add(self, content: str, **opts: Any) -> dict:
        """Save one durable fact. Returns the write receipt."""
        return self._request("POST", "/v1/save", {"content": content, **opts})

    save = add

    def add_conversation(self, messages: list, **opts: Any) -> dict:
        """Save a conversation (messages oldest first)."""
        return self._request("POST", "/v1/save", {"mode": "conversation", "messages": messages, **opts})

    def turn(self, messages: list, **opts: Any) -> dict:
        """Recall + auto-capture in one call — send the latest chat messages."""
        return self._request("POST", "/v1/turn", {"messages": messages, **opts})

    def ingest(self, messages: list, **opts: Any) -> dict:
        """Bulk ingestion; pass flush=True to force digestion now."""
        return self._request("POST", "/v1/ingest", {"messages": messages, **opts})

    # ------------------------------------------------------------ read
    def search(self, query: str, **opts: Any) -> dict:
        """Look up relevant memory. result["context"] is the prompt-ready block."""
        return self._request("POST", "/v1/recall", {"query": query, **opts})

    recall = search

    def graph(self) -> dict:
        return self._request("GET", "/v1/graph")

    def status(self) -> dict:
        return self._request("GET", "/v1/status")

    def receipts(self, limit: int = 50) -> dict:
        return self._request("GET", f"/v1/receipts?limit={limit}")

    def usage(self, range: str = "30d") -> dict:
        return self._request("GET", f"/v1/usage?range={range}")

    def get_rules(self) -> dict:
        return self._request("GET", "/v1/rules")

    def set_rules(self, rules: dict) -> dict:
        return self._request("PUT", "/v1/rules", {"rules": rules})

    def export_all(self) -> dict:
        return self._request("GET", "/v1/export")

    # --------------------------------------------------------- helpers
    @staticmethod
    def new_idempotency_key() -> str:
        """A fresh idempotency key — pass to writes to make retries safe."""
        return f"idem_{uuid.uuid4()}"

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "MemoryClient":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    # -------------------------------------------------------- internal
    def _request(self, method: str, path: str, body: Optional[dict] = None) -> dict:
        params = {}
        if self.user_id:
            params["userId"] = self.user_id
            if body is not None and "userId" not in body:
                body = {**body, "userId": self.user_id}

        # Writes retry only when the caller opted into idempotency; reads always may.
        retryable = method == "GET" or (body is not None and isinstance(body.get("idempotencyKey"), str))
        attempts = self.max_retries + 1 if retryable else 1

        last_error: Optional[MemoryAPIError] = None
        for attempt in range(attempts):
            if attempt:
                delay = getattr(last_error, "retry_after", None) or (0.25 * 2 ** (attempt - 1) + random.random() * 0.1)
                time.sleep(delay)
            try:
                res = self._client.request(method, path, params=params or None, json=body)
            except httpx.HTTPError as exc:
                last_error = MemoryAPIError(str(exc), status=0)
                continue
            try:
                data = res.json()
            except ValueError:
                data = None
            if res.is_success:
                return data
            error = MemoryAPIError(
                (data or {}).get("message") or (data or {}).get("error") or f"{method} {path} failed with {res.status_code}",
                status=res.status_code,
                code=(data or {}).get("error"),
                body=data,
            )
            if res.status_code == 429 or res.status_code >= 500:
                retry_after = res.headers.get("retry-after")
                if retry_after and retry_after.isdigit():
                    error.retry_after = int(retry_after)
                last_error = error
                continue
            raise error
        raise last_error  # type: ignore[misc]


Memory = MemoryClient
