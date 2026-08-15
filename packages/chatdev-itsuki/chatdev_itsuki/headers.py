"""Stripping ChatDev's pipeline framing before capture.

Kept free of any ChatDev import so it is testable and reusable without the host
present. ChatDev frames stage input with headers ("### Task", "[Stage: gen]",
"Role: Programmer"); those are scaffolding, not something the user said, and
feeding them to the extractor teaches it the scaffolding rather than the fact.
"""

from __future__ import annotations

import re

_HEADER_PATTERNS = [
    re.compile(r"^\s*#{1,6}\s+.*$", re.MULTILINE),
    re.compile(r"^\s*\[[A-Za-z][^\]\n]{0,80}\]\s*$", re.MULTILINE),
    re.compile(r"^\s*<[A-Za-z_][A-Za-z0-9_\- ]{0,60}>\s*$", re.MULTILINE),
    re.compile(r"^\s*(?:Task|Stage|Role|Phase|Instruction|Context)\s*:\s*.*$", re.MULTILINE),
]


def strip_pipeline_headers(text: str) -> str:
    """Remove ChatDev's own framing so the extractor sees the user's words."""
    out = str(text or "")
    for pattern in _HEADER_PATTERNS:
        out = pattern.sub("", out)
    return re.sub(r"\n{3,}", "\n\n", out).strip()
