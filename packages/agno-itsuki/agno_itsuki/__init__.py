"""Itsuki memory as an Agno toolkit — model-called, not automatic.

    from agno.agent import Agent
    from agno_itsuki import ItsukiTools

    agent = Agent(tools=[ItsukiTools()], ...)

Agno's own memory remains the automatic layer; this runs alongside it.
"""

from .toolkit import INSTRUCTIONS, SOURCE, ItsukiTools

__all__ = ["ItsukiTools", "INSTRUCTIONS", "SOURCE"]
__version__ = "0.1.1"
