"""The YAML config a `type: itsuki` memory node accepts.

ChatDev builds these from workflow YAML through its schema registry. The class
below is a plain dataclass so it can be constructed and validated without
importing ChatDev at all — which is what lets this package be tested, and what
lets the upstream patch subclass the host's own BaseConfig without duplicating
the field list.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from typing import Any, Optional

#: ChatDev expands ${VAR} in workflow YAML. The same expansion is applied here
#: so the package behaves identically whether the host expanded it or not.
_ENV_PATTERN = re.compile(r"^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$")


def expand_env(value: Optional[str]) -> Optional[str]:
    """Resolve a bare ${VAR} reference. Anything else is returned unchanged."""
    if not isinstance(value, str):
        return value
    match = _ENV_PATTERN.match(value.strip())
    if not match:
        return value
    return os.environ.get(match.group(1))


@dataclass
class ItsukiMemoryConfig:
    """Configuration for one Itsuki memory node.

    The credential is excluded from :meth:`to_dict`, so exporting or logging a
    workflow cannot leak it — workflow files get shared, pasted into issues and
    committed, and a key that rides along in one is a key that is now public.
    """

    api_key: str = ""
    base_url: Optional[str] = None
    user_id: Optional[str] = None
    agent_id: Optional[str] = None
    project_id: Optional[str] = None
    top_k: int = 5
    max_context_chars: int = 4_000
    timeout_s: float = 8.0
    allow_clear: bool = False
    # Not part of the YAML surface; used by tests and by embedding hosts.
    client: Any = field(default=None, repr=False, compare=False)
    event_hook: Any = field(default=None, repr=False, compare=False)

    def __post_init__(self) -> None:
        self.api_key = (expand_env(self.api_key) or "").strip()
        self.base_url = expand_env(self.base_url)
        self.user_id = (expand_env(self.user_id) or "").strip() or None
        self.agent_id = (expand_env(self.agent_id) or "").strip() or None
        self.project_id = (expand_env(self.project_id) or "").strip() or None
        if not self.api_key:
            self.api_key = (os.environ.get("ITSUKI_API_KEY") or "").strip()

    def to_dict(self) -> dict:
        """A serializable view with the credential removed."""
        return {
            "base_url": self.base_url,
            "user_id": self.user_id,
            "agent_id": self.agent_id,
            "project_id": self.project_id,
            "top_k": self.top_k,
            "max_context_chars": self.max_context_chars,
            "timeout_s": self.timeout_s,
            "allow_clear": self.allow_clear,
        }

    def __repr__(self) -> str:  # pragma: no cover - trivial
        return f"ItsukiMemoryConfig({self.to_dict()})"
