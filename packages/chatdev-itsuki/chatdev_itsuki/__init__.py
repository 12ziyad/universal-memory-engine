"""Itsuki memory for ChatDev 2.0 (operator-wired).

    import chatdev_itsuki.register  # noqa: F401

Then declare a memory node with ``type: itsuki`` in your workflow YAML.
Until the upstream change lands this is an operator-wired integration, not a
built-in backend — see the README.
"""

from .config import ItsukiMemoryConfig, expand_env
from .store import SOURCE, ItsukiMemoryStore, strip_pipeline_headers

__all__ = [
    "ItsukiMemoryStore",
    "ItsukiMemoryConfig",
    "strip_pipeline_headers",
    "expand_env",
    "SOURCE",
]
__version__ = "0.1.0"
