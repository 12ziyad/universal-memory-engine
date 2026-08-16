"""Itsuki memory for Hermes Agent.

This module imports stdlib only. The provider lives one import away, in
``provider``, because that module needs ``agent.memory_provider`` -- which
exists only inside a Hermes environment. Keeping the split means the wheel can
be installed and imported anywhere (clean-room checks, packaging gates) while
``register`` still fails loudly and specifically when the host is absent.
"""

from __future__ import annotations

from typing import Any

__version__ = "0.1.0"
__all__ = ["register", "ItsukiMemoryProvider", "__version__"]


def register(ctx: Any) -> None:
    """Hand a provider instance to Hermes.

    Called by the host through the ``hermes_agent.memory_providers`` entry
    point, and by the deployed directory plugin.
    """
    from .provider import ItsukiMemoryProvider

    ctx.register_memory_provider(ItsukiMemoryProvider())


def __getattr__(name: str) -> Any:
    # Deferred so `import hermes_itsuki` never requires the host.
    if name == "ItsukiMemoryProvider":
        from .provider import ItsukiMemoryProvider

        return ItsukiMemoryProvider
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
