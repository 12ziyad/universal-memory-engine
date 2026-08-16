"""Optional: teach `adk run/web/api_server` the `itsuki://` scheme.

ADK has no entry-point discovery, so a third-party service is reached either by
passing an instance to the Runner or by registering a URI scheme from a
`services.py` next to the agent. Registering makes the dev UI able to construct
the service -- but it does NOT attach the preload tool or this package's capture
plugin, so that route is a partial installation and the README says so rather
than implying otherwise.
"""

from __future__ import annotations

from typing import Any

from .config import SCHEME
from .service import ItsukiMemoryService


def _factory(uri: str, **kwargs: Any) -> ItsukiMemoryService:
    # ADK's CLI passes agents_dir alongside the uri; the service swallows it.
    return ItsukiMemoryService(uri=uri, **kwargs)


def register(scheme: str = SCHEME) -> None:
    """Wire `itsuki://` into ADK's service registry."""
    from google.adk.cli.service_registry import get_service_registry

    get_service_registry().register_memory_service(scheme, _factory)
