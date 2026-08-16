"""Itsuki memory for Google ADK."""

from __future__ import annotations

from typing import Any

__version__ = "0.1.0"
__all__ = ["ItsukiMemoryService", "ItsukiMemoryPlugin", "register", "__version__"]


def __getattr__(name: str) -> Any:
    # Deferred so that importing the package does not pull in google.adk
    # before an application has configured it.
    if name == "ItsukiMemoryService":
        from .service import ItsukiMemoryService

        return ItsukiMemoryService
    if name == "ItsukiMemoryPlugin":
        from .plugin import ItsukiMemoryPlugin

        return ItsukiMemoryPlugin
    if name == "register":
        from .registry import register

        return register
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
