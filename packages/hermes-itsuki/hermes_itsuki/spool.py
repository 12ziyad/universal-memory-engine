"""Durable staging for captures, partitioned by the credential that made them.

A capture is written here *before* any network call, so a crash between "the
turn settled" and "the service acknowledged" loses nothing. Two properties are
worth more than the code that provides them:

* **Authority partitioning.** Envelopes live under a one-way hash of the
  account that staged them. Re-key the install and yesterday's pending
  conversations cannot drain into the new project -- they are quarantined,
  counted, and eventually aged out. Without this, a spool is a machine for
  delivering one tenant's content under another tenant's credential.
* **Bounded, counted loss.** The spool has a hard ceiling. When it is hit the
  oldest envelope is dropped and a counter increments. That is a real loss and
  it is reported as one; the alternative -- unbounded growth on a user's disk --
  is worse, and pretending the bound does not exist would be dishonest.
"""

from __future__ import annotations

import json
import os
import stat
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple

SCHEMA = "itsuki.agent-spool/v1"

MAX_ENVELOPES = 64
MAX_TOTAL_BYTES = 8 * 1024 * 1024
MAX_AGE_SECONDS = 14 * 24 * 3600
TOMBSTONE_AGE_SECONDS = 7 * 24 * 3600
CLAIM_STALE_SECONDS = 600


class SpoolStats:
    """Counters a person can act on. Content-free by construction."""

    __slots__ = ("dropped_overflow", "quarantined_foreign", "corrupt", "aged_out", "delivered")

    def __init__(self) -> None:
        self.dropped_overflow = 0
        self.quarantined_foreign = 0
        self.corrupt = 0
        self.aged_out = 0
        self.delivered = 0

    def snapshot(self) -> Dict[str, int]:
        return {
            "dropped_overflow": self.dropped_overflow,
            "quarantined_foreign": self.quarantined_foreign,
            "corrupt": self.corrupt,
            "aged_out": self.aged_out,
            "delivered": self.delivered,
        }


class Spool:
    """An append-only set of pending captures for exactly one authority."""

    def __init__(self, state_dir: Any, authority: str, clock: Any = time.time) -> None:
        self.root = Path(state_dir)
        self.authority = authority
        self.partition = self.root / "spool" / authority
        self.stats = SpoolStats()
        self._clock = clock

    # ------------------------------------------------------------- lifecycle
    def ensure(self) -> None:
        """Create the state tree, refusing anything we do not own.

        A symlinked state directory is the classic way to make a program write
        somewhere it did not intend. We would rather not run than follow one.
        """
        if self.root.is_symlink() or (self.root / "spool").is_symlink() or self.partition.is_symlink():
            raise OSError("itsuki state path is a symlink; refusing to use it")
        self.partition.mkdir(parents=True, exist_ok=True)
        if os.name != "nt":
            for path in (self.root, self.root / "spool", self.partition):
                try:
                    os.chmod(path, 0o700)
                except OSError:
                    pass

    # ---------------------------------------------------------------- writes
    def stage(self, idempotency_key: str, body: Dict[str, Any]) -> Optional[Path]:
        """Persist one capture. Returns the path, or None if we shed it.

        The body arrives already scrubbed -- nothing unredacted ever reaches
        this file.
        """
        self.ensure()
        self._gc()
        if not self._has_room():
            if not self._drop_oldest():
                return None
        envelope = {
            "schema": SCHEMA,
            "authorityId": self.authority,
            "idempotencyKey": idempotency_key,
            "body": body,
            "createdAt": self._clock(),
            "attempts": 0,
            "lastErrorClass": None,
        }
        path = self.partition / f"{_safe_name(idempotency_key)}.json"
        _atomic_write(path, envelope)
        return path

    def mark_attempt(self, path: Path, error_class: Optional[str]) -> None:
        envelope = self.read(path)
        if envelope is None:
            return
        envelope["attempts"] = int(envelope.get("attempts") or 0) + 1
        envelope["lastErrorClass"] = error_class
        _atomic_write(path, envelope)

    def complete(self, path: Path) -> None:
        """Replace a delivered envelope with a body-free tombstone.

        The tombstone exists so a concurrent process does not re-stage work
        that already landed; it holds no content, only the key and a time.
        """
        envelope = self.read(path) or {}
        tombstone = {
            "schema": SCHEMA,
            "authorityId": self.authority,
            "idempotencyKey": envelope.get("idempotencyKey"),
            "deliveredAt": self._clock(),
            "tombstone": True,
        }
        _atomic_write(path.with_suffix(".done"), tombstone)
        _unlink(path)
        self.stats.delivered += 1

    def quarantine(self, path: Path, reason: str) -> None:
        """Set an envelope aside instead of retrying or deleting it.

        Used for conflicts and for the post-deletion fence: both mean "this
        will never succeed", and both are worth a person's attention.
        """
        envelope = self.read(path) or {}
        envelope["quarantine"] = reason
        _atomic_write(path.with_suffix(".quarantine"), envelope)
        _unlink(path)

    # ----------------------------------------------------------------- reads
    def read(self, path: Path) -> Optional[Dict[str, Any]]:
        try:
            with open(path, "r", encoding="utf-8") as handle:
                data = json.load(handle)
        except FileNotFoundError:
            return None
        except (OSError, ValueError):
            self.stats.corrupt += 1
            return None
        if not isinstance(data, dict) or data.get("schema") != SCHEMA:
            self.stats.corrupt += 1
            return None
        if data.get("authorityId") not in (None, self.authority):
            # Belt and braces: the partition already scopes this, but an
            # envelope that disagrees with its own location is never sent.
            self.stats.quarantined_foreign += 1
            return None
        return data

    def pending(self) -> List[Path]:
        self.ensure()
        return sorted(
            (p for p in self.partition.glob("*.json") if p.is_file()),
            key=lambda p: _mtime(p),
        )

    def claim(self, path: Path) -> Optional[Path]:
        """Take exclusive ownership of an envelope across processes.

        A rename is the only cheap operation that is atomic on both Windows
        and POSIX, so ownership is expressed by moving the file rather than by
        a lock file that a crash would leave behind forever.
        """
        claimed = path.with_suffix(f".claim{os.getpid()}")
        try:
            os.replace(path, claimed)
        except OSError:
            return None
        return claimed

    def release(self, claimed: Path, original: Path) -> None:
        try:
            os.replace(claimed, original)
        except OSError:
            pass

    def reclaim_stale(self) -> int:
        """Return abandoned claims to the pool.

        A process that died mid-delivery leaves a claim nobody will finish.
        After ten minutes we assume that happened; a duplicate delivery is
        harmless because the idempotency key collapses it server-side.
        """
        now = self._clock()
        count = 0
        for path in self.partition.glob("*.claim*"):
            if now - _mtime(path) < CLAIM_STALE_SECONDS:
                continue
            try:
                os.replace(path, path.with_suffix(".json"))
                count += 1
            except OSError:
                continue
        return count

    def foreign_partitions(self) -> List[str]:
        """Other authorities' partitions, which we never drain."""
        base = self.root / "spool"
        if not base.is_dir():
            return []
        return sorted(p.name for p in base.iterdir() if p.is_dir() and p.name != self.authority)

    # -------------------------------------------------------------------- gc
    def _gc(self) -> None:
        now = self._clock()
        for path in self.partition.glob("*.json"):
            if now - _mtime(path) > MAX_AGE_SECONDS:
                _unlink(path)
                self.stats.aged_out += 1
        for path in self.partition.glob("*.done"):
            if now - _mtime(path) > TOMBSTONE_AGE_SECONDS:
                _unlink(path)
        base = self.root / "spool"
        if base.is_dir():
            for other in base.iterdir():
                if not other.is_dir() or other.name == self.authority:
                    continue
                for path in other.glob("*.json"):
                    if now - _mtime(path) > MAX_AGE_SECONDS:
                        _unlink(path)
                        self.stats.aged_out += 1

    def _has_room(self) -> bool:
        entries = list(self.partition.glob("*.json"))
        if len(entries) >= MAX_ENVELOPES:
            return False
        total = sum(_size(p) for p in entries)
        return total < MAX_TOTAL_BYTES

    def _drop_oldest(self) -> bool:
        entries = sorted((p for p in self.partition.glob("*.json")), key=_mtime)
        if not entries:
            return True
        _unlink(entries[0])
        self.stats.dropped_overflow += 1
        return True

    # ----------------------------------------------------------------- stats
    def depth(self) -> int:
        try:
            return len(list(self.partition.glob("*.json")))
        except OSError:
            return 0

    def iter_pending(self) -> Iterator[Tuple[Path, Dict[str, Any]]]:
        for path in self.pending():
            envelope = self.read(path)
            if envelope is not None:
                yield path, envelope


def _atomic_write(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=".spool-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle)
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise
    if os.name != "nt":
        try:
            os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
        except OSError:
            pass


def _unlink(path: Path) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass


def _mtime(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


def _size(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


def _safe_name(key: str) -> str:
    """A filename derived from a key, never the key's raw bytes."""
    return "".join(ch for ch in key if ch.isalnum() or ch in "-_")[:96] or "envelope"
