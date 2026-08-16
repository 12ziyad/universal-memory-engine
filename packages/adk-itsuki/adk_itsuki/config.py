"""Where the service address and the credential come from.

The credential is read from the environment by default. A constructor argument
is allowed because embedding apps and tests need one, but it is never persisted,
never logged, and never accepted from a URI -- a URI ends up in `ps` output and
in shell history, which is not a place a bearer token belongs.
"""

from __future__ import annotations

import os
from typing import NamedTuple, Optional
from urllib.parse import urlsplit

DEFAULT_BASE_URL = "https://itsuki.app"
API_KEY_ENV = "ITSUKI_API_KEY"
SCHEME = "itsuki"


class ConfigError(ValueError):
    """A configuration value we refuse to act on."""


class Settings(NamedTuple):
    api_key: str
    base_url: str

    def __repr__(self) -> str:  # pragma: no cover - trivial, but load-bearing
        # Never let a repr in a traceback or a debugger print the key.
        return f"Settings(api_key='***', base_url={self.base_url!r})"


def _base_url_from_uri(uri: str) -> Optional[str]:
    """Read an override host out of ``itsuki://host[:port]``.

    A query string is refused outright rather than ignored: the obvious thing
    to put there is `?api_key=`, and accepting it once would make it a habit.
    """
    parts = urlsplit(uri)
    if parts.scheme and parts.scheme != SCHEME:
        raise ConfigError(f"unsupported memory service scheme: {parts.scheme}")
    if parts.query or parts.fragment:
        raise ConfigError("the itsuki:// URI must not carry a query string (never put a key in a URI)")
    if parts.username or parts.password:
        raise ConfigError("the itsuki:// URI must not carry credentials")
    if not parts.netloc:
        return None
    return f"https://{parts.netloc}"


def validate_base_url(value: str) -> str:
    url = value.strip().rstrip("/")
    parts = urlsplit(url)
    if parts.scheme not in ("https", "http"):
        raise ConfigError("base_url must be an http(s) URL")
    if parts.scheme == "http" and parts.hostname not in ("localhost", "127.0.0.1", "::1"):
        raise ConfigError("base_url must use https outside localhost")
    if not parts.hostname:
        raise ConfigError("base_url must include a host")
    if parts.username or parts.password or parts.query or parts.fragment:
        raise ConfigError("base_url must not carry credentials, a query or a fragment")
    return url


def resolve(
    *,
    uri: Optional[str] = None,
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
) -> Settings:
    key = (api_key or os.environ.get(API_KEY_ENV) or "").strip()
    if not key:
        raise ConfigError(
            f"No Itsuki API key. Set {API_KEY_ENV}, or pass api_key= when constructing the service."
        )
    resolved = base_url
    if resolved is None and uri:
        resolved = _base_url_from_uri(uri)
    return Settings(api_key=key, base_url=validate_base_url(resolved or DEFAULT_BASE_URL))
