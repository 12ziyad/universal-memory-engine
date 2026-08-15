"""Registering `type: itsuki` with ChatDev's memory-store registry.

ChatDev documents the extension route as: implement a Config plus a Store, then
call ``register_memory_store()``. There is no entry-point discovery, so a
deployment has to import this module once — one line in the entrypoint:

    import chatdev_itsuki.register  # noqa: F401

That import IS the honest limit of this package. Until the upstream change
lands, `type: itsuki` is operator-wired, not built in, and the README says so
in those words. Claiming otherwise would mean a user reads "native", copies a
YAML file into a fresh checkout, and finds a memory node that does not exist.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from .config import ItsukiMemoryConfig
from .store import ItsukiMemoryStore

logger = logging.getLogger(__name__)

STORE_TYPE = "itsuki"

SUMMARY = (
    "Itsuki: durable cross-session memory. Retrieval is injected at the "
    "configured stages and user input is captured after each one."
)


def build_store(config: Any) -> ItsukiMemoryStore:
    """Factory the registry calls with a validated config object."""
    return ItsukiMemoryStore(config)


def register(register_memory_store: Optional[Any] = None) -> bool:
    """Register the store with ChatDev, if ChatDev is importable.

    Returns True when registration happened. A deployment without ChatDev on
    the path — a unit test, a linter, a docs build — gets False rather than an
    ImportError, because failing to import is not an error in those contexts.
    """
    hook = register_memory_store
    if hook is None:
        try:
            from runtime.node.agent.memory.registry import (  # type: ignore[import-not-found]
                register_memory_store as hook,
            )
        except Exception:  # noqa: BLE001 — ChatDev absent is a normal outcome
            logger.debug("itsuki: ChatDev registry not importable; not registering")
            return False

    try:
        hook(
            STORE_TYPE,
            config_cls=ItsukiMemoryConfig,
            factory=build_store,
            summary=SUMMARY,
        )
    except TypeError:
        # Older or newer registries may not accept `summary`. Registering
        # without it beats not registering at all.
        hook(STORE_TYPE, config_cls=ItsukiMemoryConfig, factory=build_store)
    logger.info("itsuki: registered memory store type %r", STORE_TYPE)
    return True


# Importing this module is the documented way to wire the store up.
register()
