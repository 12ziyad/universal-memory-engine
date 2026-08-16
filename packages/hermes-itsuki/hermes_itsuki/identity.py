"""Who a memory belongs to.

Tenancy comes from the credential. Everything here only ever *narrows* that
authority: it picks an isolated sub-space under the key, and it can never widen
one. No value derived from model output or message content reaches any field in
this module.

The one subtlety is gateways. A single Hermes install can serve a Telegram group
or a Discord channel, where several humans share one process and one API key. A
configured ``user_id`` must therefore never *replace* the sender identity, only
namespace it -- otherwise two people's memories merge, which is the one failure
this file exists to prevent.
"""

from __future__ import annotations

import hashlib
from typing import Any, Mapping, Optional, Tuple

#: Version tags keep two different derivations from ever colliding, and let a
#: future scheme change be a new tag rather than a silent reinterpretation.
USER_TAG = "hermes-itsuki:user:v1"
ECHO_TAG = "hermes-itsuki:echo:v1"
AUTHORITY_TAG = "itsuki-spool-auth:v1"

_HASH_LENGTH = 32


def digest(tag: str, *parts: Optional[str], length: int = _HASH_LENGTH) -> str:
    """A length-prefixed hash over an ordered tuple of parts.

    Length prefixing is the whole point: ``("ab", "c")`` and ``("a", "bc")``
    are different inputs and must produce different digests. Plain
    concatenation makes them identical, which is how two channels' senders
    end up sharing a memory space.
    """
    hasher = hashlib.sha256()
    hasher.update(tag.encode("utf-8"))
    for part in parts:
        raw = (part or "").encode("utf-8")
        hasher.update(len(raw).to_bytes(8, "big"))
        hasher.update(raw)
    return hasher.hexdigest()[:length]


class Tenancy:
    """The resolved answer to "whose memory is this?" for one provider instance.

    ``configured`` is the operator's optional ``user_id``. On a single-operator
    CLI install it selects the space directly. On a gateway it is only a
    namespace: the authenticated sender always partitions.
    """

    __slots__ = ("configured", "_gateway")

    def __init__(self, configured: Optional[str] = None) -> None:
        self.configured = (configured or "").strip() or None
        self._gateway = False

    def observe_host_kwargs(self, kwargs: Mapping[str, Any]) -> None:
        """Note whether this session came in through a gateway.

        Hermes passes platform identity into ``initialize``. Presence of a
        platform other than the CLI means several humans may share this
        process, and per-sender partitioning becomes mandatory.
        """
        platform = _text(kwargs.get("platform"))
        self._gateway = bool(platform) and platform not in ("cli", "tui")

    def effective_user_id(self, kwargs: Mapping[str, Any]) -> Tuple[Optional[str], Optional[str]]:
        """Return ``(user_id, skip_reason)``.

        A skip reason means we could not attribute this traffic to a person,
        and the caller must not read or write anything. Failing closed is the
        only safe answer: a shared fallback space would merge strangers.
        """
        platform = _text(kwargs.get("platform"))
        sender = _text(kwargs.get("user_id")) or _text(kwargs.get("sender_id"))

        if self._gateway or (platform and platform not in ("cli", "tui")):
            if not sender:
                # Gateway traffic with no sender identity: refuse rather than
                # merge it into the operator's own space.
                return None, "no_identity"
            return "hg1_" + digest(USER_TAG, self.configured or "", platform, sender), None

        if self.configured:
            return self.configured, None
        # No configured id on a local install: the key's own default space.
        return None, None

    def echo_scope_key(self, user_id: Optional[str]) -> str:
        """The bucket key for echo fingerprints.

        Deliberately independent of session: recall happens before the host
        tells us which session we are in, so anything session-keyed would be
        stale exactly when it matters.
        """
        return digest(ECHO_TAG, user_id or "")


def authority_id(base_url: str, api_key: str) -> str:
    """A stable, one-way name for "the account this spool belongs to".

    Envelopes staged under one credential must never drain under another --
    a re-keyed install could otherwise ship one project's conversations into
    a different project. The key is hashed, never stored: this identifies an
    authority without persisting anything that could authenticate as it.
    """
    key_digest = hashlib.sha256(api_key.encode("utf-8")).hexdigest()
    return "auth1_" + digest(AUTHORITY_TAG, base_url, key_digest, length=16)


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""
