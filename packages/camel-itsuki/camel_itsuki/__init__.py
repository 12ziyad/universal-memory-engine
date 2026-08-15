"""Itsuki memory for CAMEL.

    from camel.memories import ChatHistoryMemory
    from camel_itsuki import ItsukiStorage

    memory = ChatHistoryMemory(
        context_creator,
        storage=ItsukiStorage(user_id="u_42", agent_id="researcher"),
    )

History stays lossless locally; durable memory is mirrored to Itsuki and read
back through ItsukiContextBlock.
"""

from .block import ItsukiContextBlock
from .storage import DEFAULT_MAX_RECORDS, SETUP_HINT, SOURCE, ItsukiStorage

__all__ = [
    "ItsukiStorage",
    "ItsukiContextBlock",
    "DEFAULT_MAX_RECORDS",
    "SETUP_HINT",
    "SOURCE",
]
__version__ = "0.1.0"
