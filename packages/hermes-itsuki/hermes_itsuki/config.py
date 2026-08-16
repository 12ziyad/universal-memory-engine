"""Configuration, and the one file this package owns under HERMES_HOME.

The credential is not configuration. It is read from the environment, which is
where the host's own ``secret: True`` schema fields put it, and it is never
written here, never echoed, and never placed in a URL. Everything else -- the
service address, an optional sub-space, and the two off switches -- lives in
``<hermes_home>/itsuki.json``.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlsplit

DEFAULT_BASE_URL = "https://itsuki.app"
API_KEY_ENV = "ITSUKI_API_KEY"
CONFIG_FILENAME = "itsuki.json"
STATE_DIRNAME = "itsuki"

#: Prompted by `hermes memory setup`, one field per line. Secrets carry an
#: env_var so the host routes them into its own .env instead of our file.
CONFIG_SCHEMA: List[Dict[str, Any]] = [
    {
        "key": "api_key",
        "description": "Itsuki API key",
        "secret": True,
        "required": True,
        "env_var": API_KEY_ENV,
        "url": "https://itsuki.app",
    },
    {
        "key": "base_url",
        "description": "Itsuki service URL",
        "default": DEFAULT_BASE_URL,
    },
    {
        "key": "user_id",
        "description": "Optional memory sub-space for this install",
        "required": False,
    },
    {
        "key": "capture",
        "description": "Automatically remember settled turns",
        "choices": ["auto", "off"],
        "default": "auto",
    },
    {
        "key": "recall",
        "description": "Automatically recall before each turn",
        "choices": ["auto", "off"],
        "default": "auto",
    },
]


class ConfigError(ValueError):
    """A configuration value we refuse to act on."""


def validate_base_url(value: Any) -> str:
    """Accept only an origin we are willing to send a bearer token to.

    Rejecting userinfo and query strings is not pedantry: both are places a
    credential can hide in a URL, and a URL is the one place this package must
    never carry one.
    """
    if value is None or value == "":
        return DEFAULT_BASE_URL
    if not isinstance(value, str):
        raise ConfigError("base_url must be a string")
    url = value.strip().rstrip("/")
    parts = urlsplit(url)
    if parts.scheme not in ("https", "http"):
        raise ConfigError("base_url must be an http(s) URL")
    if parts.scheme == "http" and parts.hostname not in ("localhost", "127.0.0.1", "::1"):
        raise ConfigError("base_url must use https outside localhost")
    if not parts.hostname:
        raise ConfigError("base_url must include a host")
    if parts.username or parts.password:
        raise ConfigError("base_url must not contain credentials")
    if parts.query or parts.fragment:
        raise ConfigError("base_url must not contain a query or fragment")
    return url


class Config:
    """Resolved settings for one provider instance."""

    __slots__ = ("hermes_home", "base_url", "user_id", "capture_enabled", "recall_enabled")

    def __init__(
        self,
        hermes_home: Path,
        base_url: str = DEFAULT_BASE_URL,
        user_id: Optional[str] = None,
        capture: str = "auto",
        recall: str = "auto",
    ) -> None:
        self.hermes_home = Path(hermes_home)
        self.base_url = validate_base_url(base_url)
        self.user_id = (user_id or "").strip() or None
        self.capture_enabled = capture != "off"
        self.recall_enabled = recall != "off"

    @property
    def config_path(self) -> Path:
        return self.hermes_home / CONFIG_FILENAME

    @property
    def state_dir(self) -> Path:
        return self.hermes_home / STATE_DIRNAME

    @classmethod
    def load(cls, hermes_home: Any) -> "Config":
        home = Path(hermes_home)
        raw: Dict[str, Any] = {}
        path = home / CONFIG_FILENAME
        try:
            with open(path, "r", encoding="utf-8") as handle:
                loaded = json.load(handle)
            if isinstance(loaded, dict):
                raw = loaded
        except FileNotFoundError:
            pass
        except (OSError, ValueError):
            # A corrupt config file must not stop the agent from starting.
            # Defaults plus an honest doctor line beat a crashed provider.
            raw = {}
        return cls(
            hermes_home=home,
            base_url=str(raw.get("base_url") or DEFAULT_BASE_URL),
            user_id=raw.get("user_id"),
            capture=str(raw.get("capture") or "auto"),
            recall=str(raw.get("recall") or "auto"),
        )


def api_key_from_env(env: Optional[Dict[str, str]] = None) -> Optional[str]:
    """The credential, from the environment only."""
    source = env if env is not None else os.environ
    key = (source.get(API_KEY_ENV) or "").strip()
    return key or None


def save_config_values(values: Dict[str, Any], hermes_home: Any) -> Path:
    """Persist the non-secret half of the schema, atomically and privately.

    Any key-shaped value that reaches this function is dropped rather than
    written: the host is supposed to route secrets to its own .env, and if
    that ever changes we still must not be the component that writes a key
    to disk.
    """
    home = Path(hermes_home)
    home.mkdir(parents=True, exist_ok=True)
    path = home / CONFIG_FILENAME

    existing: Dict[str, Any] = {}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            loaded = json.load(handle)
        if isinstance(loaded, dict):
            existing = loaded
    except (OSError, ValueError):
        existing = {}

    allowed = {"base_url", "user_id", "capture", "recall"}
    for key, value in (values or {}).items():
        if key not in allowed:
            continue
        if key == "base_url":
            value = validate_base_url(value)
        existing[key] = value
    existing.pop("api_key", None)

    handle_fd, tmp_name = tempfile.mkstemp(dir=str(home), prefix=".itsuki-", suffix=".tmp")
    try:
        with os.fdopen(handle_fd, "w", encoding="utf-8") as tmp:
            json.dump(existing, tmp, indent="\t", sort_keys=True)
            tmp.write("\n")
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise
    _restrict(path)
    return path


def _restrict(path: Path) -> None:
    """Owner-only, where the platform expresses that with mode bits."""
    if os.name != "nt":
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
