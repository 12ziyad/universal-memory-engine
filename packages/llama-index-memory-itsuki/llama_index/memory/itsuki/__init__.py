"""Itsuki memory for LlamaIndex, as a `BaseMemoryBlock`.

    from llama_index.memory.itsuki import itsuki_memory

    memory = itsuki_memory(user_id="u_42", session_id="thread_9")
    response = await agent.run("What am I working on?", memory=memory)
"""

from .block import DEFAULT_SEARCH_MSG_LIMIT, SOURCE, ItsukiMemoryBlock
from .factory import SETUP_HINT, itsuki_client, itsuki_memory, itsuki_memory_block

__all__ = [
    "ItsukiMemoryBlock",
    "itsuki_memory",
    "itsuki_memory_block",
    "itsuki_client",
    "DEFAULT_SEARCH_MSG_LIMIT",
    "SETUP_HINT",
    "SOURCE",
]
__version__ = "0.1.1"
