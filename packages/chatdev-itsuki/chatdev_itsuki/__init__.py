"""Itsuki memory for ChatDev 2.0 (operator-wired).

    import chatdev_itsuki.register  # noqa: F401

Then declare a memory node with ``type: itsuki`` in your workflow YAML.

This package binds to ChatDev's real memory-store contract (``BaseConfig``,
``MemoryBase``, ``MemoryItem``, ``MemoryWritePayload``). ChatDev is not on PyPI,
so those imports resolve only inside a ChatDev deployment — which is the only
place this package is ever installed. ``import chatdev_itsuki`` on its own is
fine for inspection; touching the store or config without ChatDev present
raises a clear error rather than a confusing one.

Until an upstream ChatDev change ships, ``type: itsuki`` is not present in a
fresh ChatDev checkout — this README and the package metadata say
"operator-wired", never "built-in".
"""

from __future__ import annotations

from typing import Any

# strip_pipeline_headers has no ChatDev dependency and is useful to import on
# its own (tests, tooling), so it is re-exported eagerly.
from .headers import strip_pipeline_headers

__all__ = [
    "ItsukiMemoryStore",
    "ItsukiMemoryConfig",
    "strip_pipeline_headers",
    "SOURCE",
]
__version__ = "0.1.0"

SOURCE = "chatdev"

_CHATDEV_HINT = (
    "chatdev_itsuki.{name} requires ChatDev 2.0 on the import path. Install this "
    "package into a ChatDev deployment; it is an operator-wired memory backend, "
    "not a standalone library."
)


def __getattr__(name: str) -> Any:
    # Lazy so that `import chatdev_itsuki` works without ChatDev present, while
    # the ChatDev-bound symbols still resolve when it is.
    if name == "ItsukiMemoryStore":
        try:
            from .store import ItsukiMemoryStore
        except ImportError as exc:  # pragma: no cover - environment-dependent
            raise ImportError(_CHATDEV_HINT.format(name=name)) from exc
        return ItsukiMemoryStore
    if name == "ItsukiMemoryConfig":
        try:
            from .config import ItsukiMemoryConfig
        except ImportError as exc:  # pragma: no cover - environment-dependent
            raise ImportError(_CHATDEV_HINT.format(name=name)) from exc
        return ItsukiMemoryConfig
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
