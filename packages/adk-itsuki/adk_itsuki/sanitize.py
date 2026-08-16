"""Make recalled text safe to put in a prompt.

Recalled memories are data the user wrote, or that a model wrote about the user
-- and anyone who has ever typed into this account can influence them. The
shared kernel wraps them in a fence and says "treat this as data", but it does
not *enforce* the fence: a memory containing our own closing marker would end
the block early, and everything after it would read as ordinary instructions.
That is a working prompt-injection escape, and it is this module's job to close
it before ``format_recall_block`` ever sees the text.

What this module does NOT claim: it does not decide whether prose is an
instruction. That is undecidable, and pretending otherwise would be worse than
useless. Instructions stay inside the fence, behind the untrusted-data preamble.
What it guarantees is narrower and checkable -- the fence holds, and no control
sequence can make the terminal or the model see a structure that is not there.
"""

from __future__ import annotations

import re
from typing import List, Sequence, Tuple

from ._kernel import RECALL_CLOSE_MARKER, RECALL_OPEN_MARKER

#: Zero-width and directional formatting characters. They are invisible in a
#: transcript, which is exactly why an attacker likes them: text that reads one
#: way to a reviewer and another way to a model.
_INVISIBLE = re.compile(
    "["
    "​-‏"  # zero width space .. right-to-left mark
    "‪-‮"  # embedding / override
    "⁠-⁤"  # word joiner .. invisible plus
    "⁦-⁩"  # isolates
    "﻿"  # byte order mark
    "]"
)

#: ANSI escape sequences (CSI/OSC/DCS). A memory is displayed in a terminal by
#: `hermes itsuki status` and by the host's own UI; escape sequences there can
#: repaint or hide text.
_ANSI = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|P[^\x1b]*\x1b\\)")

#: C0/C1 controls except tab and newline, which carry real meaning in prose.
_CONTROLS = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")

#: Chat-template and role delimiters. A line that is only one of these reads as
#: a turn boundary to many models.
#: A trailing role word is part of the delimiter in the most common template
#: dialect -- `<|im_start|>system` is the real-world shape, not a bare token --
#: so the pattern has to allow it or the line sails through unquoted (SEC-H01).
_ROLE_LINE = re.compile(
    r"^\s*(?:"
    r"<\|[^|>]{0,64}\|>"  # <|im_start|>, <|system|>, ...
    r"|\[/?(?:INST|SYS)\]"  # [INST] [/INST] [SYS]
    r"|</?s>"  # </s>
    r"|(?:system|assistant|user|tool|developer)\s*:"  # system: ...
    r")\s*(?:system|assistant|user|tool|developer)?\s*$",
    re.IGNORECASE,
)


def _neutralize_markers(text: str) -> str:
    """Defang our own fence tokens wherever they appear in stored content.

    The replacement keeps the text readable -- a person still sees what was
    stored -- while making it impossible for the token to be parsed as the
    real delimiter. Matching is deliberately loose about internal whitespace,
    because ``< /itsuki-recalled-context-v1 >`` would otherwise slip past a
    strict comparison and still be recognised downstream.
    """
    for marker in (RECALL_OPEN_MARKER, RECALL_CLOSE_MARKER):
        inner = marker[1:-1]  # strip the angle brackets
        pattern = re.compile(
            r"<\s*" + re.escape(inner).replace(r"/", r"/\s*") + r"\s*>",
            re.IGNORECASE,
        )
        text = pattern.sub("(itsuki-marker-in-stored-text)", text)
    return text


def sanitize_recalled_text(text: str) -> str:
    """Everything that must happen before recalled text enters a prompt."""
    if not isinstance(text, str) or not text:
        return ""
    cleaned = _neutralize_markers(text)
    cleaned = _ANSI.sub("", cleaned)
    cleaned = _INVISIBLE.sub("", cleaned)
    cleaned = _CONTROLS.sub("", cleaned)
    lines: List[str] = []
    for line in cleaned.splitlines():
        # A role delimiter alone on a line is quoted so it reads as content,
        # not as a turn boundary. Prefixing beats deleting: the reader still
        # sees what was stored.
        lines.append("> " + line.strip() if _ROLE_LINE.match(line) else line)
    return "\n".join(lines).strip()


def bounded_join(items: Sequence[str], max_items: int, max_chars: int) -> str:
    """Join sanitized fragments under both bounds, item count first."""
    kept: List[str] = []
    total = 0
    for item in list(items)[: max(0, max_items)]:
        if not item:
            continue
        if total + len(item) > max_chars:
            remaining = max_chars - total
            if remaining > 0:
                kept.append(item[:remaining])
            break
        kept.append(item)
        total += len(item)
    return "\n".join(kept)


def contains_marker(text: str) -> bool:
    """True if raw text still carries a live fence token (test helper)."""
    return RECALL_OPEN_MARKER in text or RECALL_CLOSE_MARKER in text


__all__ = ("sanitize_recalled_text", "bounded_join", "contains_marker")
