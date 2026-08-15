"""Make the real ChatDev host importable for the store tests.

ChatDev is an application repo, not a pip package, and its top-level
``runtime`` package eagerly imports the whole SDK (fastmcp, openai, the LLM
stack) at import time. The memory-store contract lives in a handful of leaf
modules that do NOT need any of that, so this conftest loads exactly those
files against the real ChatDev source while stubbing out only the heavy eager
``__init__`` chain that stands in front of them.

The result is a genuine real-host proof: the tests below run against ChatDev's
own ``MemoryBase``, ``MemoryItem``, ``MemoryContentSnapshot``,
``MemoryWritePayload``, ``MemoryStoreConfig`` and ``register_memory_store`` —
not against local stand-ins.

Point CHATDEV_SRC at a ChatDev 2.0 checkout to enable these tests; without it
they skip, and the package's non-host tests still run.
"""

from __future__ import annotations

import importlib
import importlib.util
import os
import sys
import types
from pathlib import Path

import pytest


def _candidate_roots():
    env = os.environ.get("CHATDEV_SRC")
    if env:
        yield Path(env)
    # A sibling checkout, or the scratchpad clone the audit used.
    here = Path(__file__).resolve()
    for parent in here.parents:
        yield parent / "ChatDev"


def _find_chatdev() -> Path | None:
    for root in _candidate_roots():
        if (root / "runtime" / "node" / "agent" / "memory" / "memory_base.py").exists():
            return root
    return None


def _load_leaf(root: Path, dotted: str) -> types.ModuleType:
    """Load one ChatDev module by file path, bypassing package __init__ code."""
    rel = Path(*dotted.split(".")).with_suffix(".py")
    path = root / rel
    spec = importlib.util.spec_from_file_location(dotted, path)
    assert spec and spec.loader, dotted
    module = importlib.util.module_from_spec(spec)
    sys.modules[dotted] = module
    spec.loader.exec_module(module)
    return module


def _prepare_host(root: Path) -> None:
    if "runtime.node.agent.memory.memory_base" in sys.modules:
        return
    sys.path.insert(0, str(root))

    # The light packages (entity, schema_registry, utils) import cleanly on
    # their own, so let the normal machinery handle them.
    for pkg in ("entity", "entity.configs", "entity.configs.node",
                "schema_registry", "utils"):
        importlib.import_module(pkg)

    # Stub the heavy package __init__ chain: these packages' __init__.py pull in
    # the whole runtime SDK, but the memory leaf modules underneath them do not
    # need any of it. Register empty package objects with the right __path__ so
    # submodule-by-file loading works.
    for pkg in ("runtime", "runtime.node", "runtime.node.agent",
                "runtime.node.agent.memory"):
        if pkg not in sys.modules:
            module = types.ModuleType(pkg)
            module.__path__ = [str(root / Path(*pkg.split(".")))]  # type: ignore[attr-defined]
            sys.modules[pkg] = module

    # Now load the real leaf modules, in dependency order.
    _load_leaf(root, "runtime.node.agent.memory.embedding")
    _load_leaf(root, "runtime.node.agent.memory.memory_base")
    _load_leaf(root, "runtime.node.agent.memory.registry")


_CHATDEV_ROOT = _find_chatdev()
if _CHATDEV_ROOT is not None:
    try:
        _prepare_host(_CHATDEV_ROOT)
        HOST_AVAILABLE = True
    except Exception as exc:  # pragma: no cover - diagnostic
        HOST_AVAILABLE = False
        _HOST_ERROR = repr(exc)
    else:
        _HOST_ERROR = ""
else:
    HOST_AVAILABLE = False
    _HOST_ERROR = "no ChatDev checkout found (set CHATDEV_SRC)"


requires_chatdev = pytest.mark.skipif(
    not HOST_AVAILABLE,
    reason=f"real ChatDev host not available: {_HOST_ERROR}",
)
