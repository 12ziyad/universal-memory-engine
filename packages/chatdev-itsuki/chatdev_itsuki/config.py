"""The ``type: itsuki`` memory-node config, as a real ChatDev ``BaseConfig``.

This binds to ChatDev's own configuration base rather than approximating it.
The earlier version of this file was a standalone dataclass written against a
research summary of the interface; it did not subclass ``BaseConfig``, so
ChatDev's YAML loader — which calls ``schema.config_cls.from_dict(...)`` — could
never have built it. A memory backend cannot be validated against a host it
does not actually speak to, which is the whole reason this package is only ever
installed into a ChatDev deployment (and therefore always has ChatDev present).

The credential is deliberately NOT stored expanded. The ``api_key`` field holds
exactly what the YAML said — typically the literal ``${ITSUKI_API_KEY}`` — and
expansion to the real secret happens once, inside the store, at client
construction time. So a serialized or exported workflow never contains the key,
which is stronger than the built-in mem0 config, whose field carries whatever
was written.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

from ._kernel import DEFAULT_TIMEOUT_SECONDS
from entity.configs.base import (
    BaseConfig,
    ConfigFieldSpec,
    optional_str,
    require_mapping,
    require_str,
)


def _optional_int(mapping: Mapping[str, Any], key: str, default: int) -> int:
    value = mapping.get(key)
    if value is None:
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _optional_float(mapping: Mapping[str, Any], key: str, default: float) -> float:
    value = mapping.get(key)
    if value is None:
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _optional_bool(mapping: Mapping[str, Any], key: str, default: bool) -> bool:
    value = mapping.get(key)
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in ("true", "1", "yes", "on")
    return bool(value)


@dataclass
class ItsukiMemoryConfig(BaseConfig):
    """Configuration for an Itsuki memory node.

    Declared in workflow YAML::

        memory:
          - name: team_memory
            type: itsuki
            config:
              api_key: ${ITSUKI_API_KEY}
              user_id: acme_team
    """

    api_key: str = ""
    base_url: str | None = None
    user_id: str | None = None
    agent_id: str | None = None
    project_id: str | None = None
    top_k: int = 5
    max_context_chars: int = 4_000
    timeout_s: float = DEFAULT_TIMEOUT_SECONDS
    allow_clear: bool = False

    @classmethod
    def from_dict(cls, data: Mapping[str, Any], *, path: str) -> "ItsukiMemoryConfig":
        mapping = require_mapping(data, path)
        return cls(
            # allow_empty: the key may legitimately arrive as a ${VAR} the store
            # expands later, or be supplied purely through the environment.
            api_key=require_str(mapping, "api_key", path, allow_empty=True),
            base_url=optional_str(mapping, "base_url", path),
            user_id=optional_str(mapping, "user_id", path),
            agent_id=optional_str(mapping, "agent_id", path),
            project_id=optional_str(mapping, "project_id", path),
            top_k=_optional_int(mapping, "top_k", 5),
            max_context_chars=_optional_int(mapping, "max_context_chars", 4_000),
            timeout_s=_optional_float(mapping, "timeout_s", 8.0),
            allow_clear=_optional_bool(mapping, "allow_clear", False),
            path=path,
        )

    FIELD_SPECS = {
        "api_key": ConfigFieldSpec(
            name="api_key",
            display_name="Itsuki API Key",
            type_hint="str",
            required=True,
            description="Itsuki API key (create one at itsuki.app under API Keys)",
            default="${ITSUKI_API_KEY}",
        ),
        "base_url": ConfigFieldSpec(
            name="base_url",
            display_name="Base URL",
            type_hint="str",
            required=False,
            description="Override the Itsuki API origin; defaults to https://itsuki.app",
        ),
        "user_id": ConfigFieldSpec(
            name="user_id",
            display_name="User ID",
            type_hint="str",
            required=False,
            description="Memory space for this workflow. At least one of user_id/agent_id is required.",
        ),
        "agent_id": ConfigFieldSpec(
            name="agent_id",
            display_name="Agent ID",
            type_hint="str",
            required=False,
            description="Agent attribution, and the memory space when no user_id is set.",
        ),
        "project_id": ConfigFieldSpec(
            name="project_id",
            display_name="Project ID",
            type_hint="str",
            required=False,
            description="Project attribution; enables project-scoped recall.",
        ),
        "top_k": ConfigFieldSpec(
            name="top_k",
            display_name="Top K",
            type_hint="int",
            required=False,
            description="Maximum memories to retrieve per stage (bounded to 20).",
            default=5,
        ),
        "max_context_chars": ConfigFieldSpec(
            name="max_context_chars",
            display_name="Max Context Characters",
            type_hint="int",
            required=False,
            description="Hard ceiling on the characters of memory returned per stage.",
            default=4_000,
        ),
        "timeout_s": ConfigFieldSpec(
            name="timeout_s",
            display_name="Timeout (seconds)",
            type_hint="float",
            required=False,
            description="Per-call timeout for Itsuki requests.",
            default=8.0,
        ),
        "allow_clear": ConfigFieldSpec(
            name="allow_clear",
            display_name="Allow Clear",
            type_hint="bool",
            required=False,
            description="When true, clear() deletes this workflow's own Itsuki memories. Off by default.",
            default=False,
        ),
    }
