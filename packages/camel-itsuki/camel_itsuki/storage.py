"""Itsuki as a CAMEL key-value storage backend.

`ChatHistoryMemory` hands its storage a list of serialized `MemoryRecord`s and
expects to get exactly those back. Mem0's CAMEL backend does not do that: its
`load()` reconstructs "history" out of extracted memories, so what the agent
reads back is a paraphrase of what it wrote. `BaseKeyValueStorage` says in its
own docstring that it stores records "without any loss of information", and an
agent whose history quietly rewrites itself between turns is a genuinely hard
bug to find.

So this keeps the two jobs separate:

- ``save``/``load``/``clear`` are a lossless local mirror. Byte-for-byte what
  went in comes out, which is the contract the base class actually states.
- Durable, cross-session, semantic memory is mirrored to Itsuki in the same
  ``save`` call, and read back through :class:`ItsukiContextBlock` — a memory
  block, which is the host's own abstraction for "context from elsewhere".

Writes are best-effort and local-first: the mirror file is written before the
network is touched, so an outage costs the agent durable memory but never its
own history.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

from camel.storages.key_value_storages import BaseKeyValueStorage
from itsuki import MemoryClient

from ._kernel import (
    DEFAULT_TIMEOUT_SECONDS,
    capture_idempotency_key,
    clamp,
    emit,
    scrub_messages,
)

SOURCE = "camel"

SETUP_HINT = (
    "Create a key at https://itsuki.app under API Keys, then set ITSUKI_API_KEY "
    "in the environment."
)

#: Records kept in the local mirror. A society that runs for days should not
#: grow an unbounded file on the way.
DEFAULT_MAX_RECORDS = 5_000


def _state_root() -> Path:
    override = os.environ.get("ITSUKI_STATE_DIR")
    if override:
        return Path(override)
    return Path.home() / ".itsuki" / "camel"


def _mirror_filename(user_id: str, agent_id: Optional[str]) -> str:
    """A safe, deterministic filename for a tenant's mirror.

    Traversal-proof by construction: the identity is hashed, so no ``..``, path
    separator or reserved character in a user id can reach the resulting name.
    A short sanitized prefix is kept purely so the directory is legible to a
    human debugging it. Two distinct tenants cannot collide, because the hash
    covers the full raw identity, not the sanitized prefix.
    """
    identity = f"{user_id}\x00{agent_id or ''}"
    digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:16]
    prefix = re.sub(r"[^A-Za-z0-9._-]", "_", user_id)[:32].strip("._-") or "tenant"
    return f"{prefix}-{digest}.json"


def _text_of(record: Dict[str, Any]) -> str:
    """The message text inside a serialized CAMEL MemoryRecord."""
    message = record.get("message")
    if isinstance(message, dict):
        for key in ("content", "text"):
            value = message.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    if isinstance(message, str):
        return message.strip()
    return ""


def _role_of(record: Dict[str, Any]) -> str:
    """user or assistant, from whichever field this CAMEL version used."""
    backend = str(record.get("role_at_backend") or "").lower()
    if backend in ("assistant", "user"):
        return backend
    message = record.get("message")
    if isinstance(message, dict):
        role = str(message.get("role_name") or message.get("role") or "").lower()
        if "assistant" in role:
            return "assistant"
    return "user"


class ItsukiStorage(BaseKeyValueStorage):
    """A lossless local history that also mirrors durable memory to Itsuki.

    ``ItsukiStorage(user_id="u_42", agent_id="researcher")``

    Each agent in a multi-agent society gets its own instance and therefore its
    own mirror file and its own agent attribution, which is what keeps two
    agents from reading each other's history.
    """

    def __init__(
        self,
        user_id: str,
        agent_id: Optional[str] = None,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        project_id: Optional[str] = None,
        mirror_path: Optional[str] = None,
        max_records: int = DEFAULT_MAX_RECORDS,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        mirror_to_itsuki: bool = True,
        allow_remote_clear: bool = False,
        event_hook: Any = None,
        client: Optional[MemoryClient] = None,
    ) -> None:
        if not str(user_id or "").strip():
            raise ValueError(
                "user_id is required — it selects the isolated memory space for "
                "this end user, and there is no safe default for whose memory this is."
            )
        self.user_id = str(user_id).strip()
        self.agent_id = (agent_id or "").strip() or None
        self.project_id = (project_id or "").strip() or None
        self.max_records = clamp(int(max_records), 1, 1_000_000)
        self.mirror_to_itsuki = bool(mirror_to_itsuki)
        self.allow_remote_clear = bool(allow_remote_clear)
        self.event_hook = event_hook
        self._lock = threading.Lock()

        # A tenant identifier is not a filename. A user_id of "../../secrets"
        # or "a/b/c" would otherwise steer the mirror out of the state directory
        # — writing an agent's transcript wherever the identifier points, or
        # overwriting an unrelated file. The identity is hashed into the name,
        # which is traversal-proof by construction and still deterministic (the
        # same tenant always resolves to the same file). A short sanitized
        # prefix is kept only so a human debugging the directory can tell the
        # files apart. An explicit mirror_path is the developer's own choice and
        # is trusted as given.
        self._path = (
            Path(mirror_path)
            if mirror_path
            else _state_root() / _mirror_filename(self.user_id, self.agent_id)
        )

        if client is not None:
            self.client = client
        elif self.mirror_to_itsuki:
            resolved = (api_key or os.environ.get("ITSUKI_API_KEY") or "").strip()
            if not resolved:
                raise ValueError(f"The Itsuki API key is not configured. {SETUP_HINT}")
            self.client = MemoryClient(
                api_key=resolved,
                base_url=(base_url or os.environ.get("ITSUKI_BASE_URL") or "https://itsuki.app"),
                timeout=timeout,
            )
        else:
            self.client = None  # type: ignore[assignment]

    # ------------------------------------------------------- local mirror
    def _read(self) -> List[Dict[str, Any]]:
        try:
            raw = self._path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return []
        except OSError:
            return []
        try:
            loaded = json.loads(raw)
        except (ValueError, UnicodeError):
            # A truncated file is history we cannot vouch for. Losing it is
            # better than handing an agent a half-record it will treat as fact.
            return []
        return loaded if isinstance(loaded, list) else []

    def _write(self, records: List[Dict[str, Any]]) -> None:
        """Atomic replace, so a crash mid-write cannot corrupt the history.

        Windows will not rename onto an existing path, so the temp file is
        replaced with os.replace, which is atomic on both platforms.
        """
        self._path.parent.mkdir(parents=True, exist_ok=True)
        handle = tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=str(self._path.parent),
            prefix=f".{self._path.name}.",
            suffix=".tmp",
            delete=False,
        )
        try:
            with handle as stream:
                json.dump(records, stream, ensure_ascii=False, default=str)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(handle.name, self._path)
        except BaseException:
            try:
                os.unlink(handle.name)
            except OSError:
                pass
            raise

    # ------------------------------------------------- BaseKeyValueStorage
    def save(self, records: List[Dict[str, Any]]) -> None:
        """Append records, losslessly, then mirror the user's turns to Itsuki."""
        if not records:
            return
        with self._lock:
            existing = self._read()
            existing.extend(records)
            if len(existing) > self.max_records:
                existing = existing[-self.max_records:]
            # Local first: durable history must survive an Itsuki outage.
            self._write(existing)

        if self.mirror_to_itsuki and self.client is not None:
            self._mirror(records)

    def load(self) -> List[Dict[str, Any]]:
        """Exactly what was saved, in order. No reconstruction, no paraphrase."""
        with self._lock:
            return self._read()

    def clear(self) -> None:
        """Clear the local history.

        Server-side memory is NOT touched unless the caller explicitly opted
        in. An agent restarting its own chat history is not a user asking to
        be forgotten, and conflating the two is how a framework integration
        deletes somebody's memory by accident.
        """
        with self._lock:
            try:
                self._path.unlink()
            except FileNotFoundError:
                pass
            except OSError:
                self._write([])

        if self.allow_remote_clear and self.client is not None:
            try:
                self.client.delete_by_source(
                    source=SOURCE, confirm=True, user_id=self.user_id
                )
                emit(self.event_hook, "remote.cleared")
            except Exception:  # noqa: BLE001 — clearing history must not raise
                emit(self.event_hook, "remote.clear_failed")

    # --------------------------------------------------------- mirroring
    def _mirror(self, records: List[Dict[str, Any]]) -> None:
        """Stage the exchange with Itsuki. Never raises into the agent."""
        payload = []
        for record in records:
            text = _text_of(record)
            if text:
                payload.append({"role": _role_of(record), "content": text})
        if not payload:
            return

        scrubbed, _ = scrub_messages(payload)
        try:
            options: Dict[str, Any] = {
                "user_id": self.user_id,
                "source": SOURCE,
                "idempotency_key": capture_idempotency_key(
                    messages=scrubbed,
                    source=SOURCE,
                    user_id=self.user_id,
                    conversation_id=self.agent_id,
                    project_id=self.project_id,
                ),
            }
            scope: Dict[str, Any] = {}
            if self.project_id:
                scope["projectId"] = self.project_id
            if self.agent_id:
                scope["agentId"] = self.agent_id
            if scope:
                options["memory_scope"] = scope
            self.client.ingest(scrubbed, **options)
            emit(self.event_hook, "capture.staged", messages=len(scrubbed))
        except Exception:  # noqa: BLE001 — the agent's turn is not ours to fail
            emit(self.event_hook, "capture.fail")
