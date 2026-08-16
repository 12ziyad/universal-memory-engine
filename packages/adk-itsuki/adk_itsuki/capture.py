"""Deciding what an invocation is worth remembering, and naming it stably.

Three rules do the work here.

**Only settled invocations are staged.** ADK's ``after_run_callback`` also fires
when a caller simply stops iterating the event stream, so "the callback ran" is
not evidence that a turn completed. The predicate below looks at the persisted
events instead: a user message *and* a finished assistant answer, no error, no
outstanding long-running tool.

**Attribution is by author name, not by branch.** An empty ``branch`` does not
prove root authorship -- ``SequentialAgent`` children can keep it -- so the rule
is the event's author matching the invocation's root agent, with the branch as a
second gate. The root agent's name is written into session state so a restart,
a delta import and an explicit re-import all reach the same verdict; an
invocation with no marker is skipped rather than guessed at.

**Chunking is deterministic, so replays are free.** Boundaries come from the
data (filter, order, limits, index) and never from process state, which is what
makes every path produce byte-identical idempotency keys.
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from ._kernel import capture_idempotency_key, scrub_messages

SOURCE = "google-adk"
STATE_KEY = "itsuki.root/v1"

MAX_MESSAGES_PER_CHUNK = 30
MAX_CHARS_PER_MESSAGE = 4_000
MAX_CHARS_PER_CHUNK = 120_000

#: Part kinds that mean "this event is machinery, not something a person said".
_TOOL_PART_FIELDS = (
    "function_call",
    "function_response",
    "executable_code",
    "code_execution_result",
    "tool_call",
    "tool_response",
    "inline_data",
    "file_data",
)


def event_text(event: Any) -> str:
    """The plain text of an event, or "" if it carries anything else.

    Returning "" for an event with a function call is not laziness: tool
    arguments and results are barred from memory, so an event that mixes them
    with text is excluded whole rather than partially scrubbed.
    """
    content = getattr(event, "content", None)
    parts = getattr(content, "parts", None) if content is not None else None
    if not parts:
        return ""
    texts: List[str] = []
    for part in parts:
        for field in _TOOL_PART_FIELDS:
            if getattr(part, field, None) is not None:
                return ""
        text = getattr(part, "text", None)
        if isinstance(text, str) and text.strip():
            texts.append(text.strip())
    return "\n".join(texts)


def is_final_assistant(event: Any) -> bool:
    if getattr(event, "partial", False):
        return False
    if getattr(event, "error_code", None):
        return False
    return bool(event_text(event))


def canonical_events(events: Iterable[Any]) -> List[Any]:
    """Deduplicate by id, then order deterministically.

    Deltas can arrive twice, out of order, or overlapping, so canonicalising
    here -- once, for every path -- is what lets automatic capture, a delta
    feed and a full-session import agree on the same bytes.

    The tie-break is the subtlety. Sorting by ``(timestamp, id)`` looks
    reasonable and is wrong: events inside one invocation routinely share a
    timestamp, and then the id decides, which put the agent's answer before
    the user's question (CAP-A01) and made the idempotency key depend on how
    ids happened to sort. Python's sort is stable, so ordering by timestamp
    alone keeps same-tick events in the sequence the session persisted -- the
    only signal that actually reflects what happened.
    """
    seen: Dict[str, Any] = {}
    for index, event in enumerate(events):
        key = getattr(event, "id", None) or f"anon-{index}"
        if key in seen:
            # Same id, different payload: keep the original. Letting a later
            # delta overwrite it would rewrite history we may already have
            # staged under a key derived from the first version.
            continue
        seen[key] = event
    return sorted(seen.values(), key=lambda e: getattr(e, "timestamp", 0.0) or 0.0)


def project_invocation(events: Sequence[Any], root_agent: str, root_branch: str = "") -> List[Dict[str, str]]:
    """The one projection every path uses: events in, capture messages out."""
    messages: List[Dict[str, str]] = []
    for event in canonical_events(events):
        author = getattr(event, "author", "") or ""
        branch = getattr(event, "branch", "") or ""
        text = event_text(event)
        if not text:
            continue
        if author == "user":
            messages.append({"role": "user", "content": text})
            continue
        if root_agent and author == root_agent and branch in ("", root_branch):
            if is_final_assistant(event):
                messages.append({"role": "assistant", "content": text})
    scrubbed, _counts = scrub_messages(messages)
    return scrubbed


def is_settled(events: Sequence[Any], root_agent: str, root_branch: str = "") -> Tuple[bool, Optional[str]]:
    """Did this invocation finish in a way worth remembering?"""
    if not root_agent:
        # No attribution marker: refuse rather than guess which agent spoke.
        return False, "no_attribution"
    has_user = False
    has_answer = False
    for event in events:
        if getattr(event, "error_code", None):
            return False, "errored"
        author = getattr(event, "author", "") or ""
        if author == "user" and event_text(event):
            has_user = True
        elif author == root_agent and is_final_assistant(event):
            branch = getattr(event, "branch", "") or ""
            if branch in ("", root_branch):
                has_answer = True
        if getattr(event, "long_running_tool_ids", None):
            # An unresolved human-in-the-loop or long tool means the turn is
            # still open, whatever the callback says.
            return False, "not_settled"
    if not has_user:
        return False, "no_user_message"
    if not has_answer:
        # This is the early-close case: the caller stopped iterating before a
        # final answer was persisted.
        return False, "not_settled"
    return True, None


def chunk(messages: Sequence[Dict[str, str]]) -> List[List[Dict[str, str]]]:
    """Split under the service's limits, deterministically."""
    chunks: List[List[Dict[str, str]]] = []
    current: List[Dict[str, str]] = []
    size = 0
    for message in messages:
        text = message.get("content", "")
        if len(text) > MAX_CHARS_PER_MESSAGE:
            message = {**message, "content": text[:MAX_CHARS_PER_MESSAGE]}
            text = message["content"]
        if current and (len(current) >= MAX_MESSAGES_PER_CHUNK or size + len(text) > MAX_CHARS_PER_CHUNK):
            chunks.append(current)
            current = []
            size = 0
        current.append(message)
        size += len(text)
    if current:
        chunks.append(current)
    return chunks


def chunk_key(
    messages: Sequence[Dict[str, str]],
    *,
    user_id: str,
    session_id: str,
    invocation_id: str,
    index: int,
) -> str:
    """Content-derived, with the chunk index in the discriminator.

    Because both the split and the index come from the data, a restart, a
    re-import and a delta feed of the same invocation regenerate identical
    keys, and the service collapses the replay.
    """
    return capture_idempotency_key(
        messages=list(messages),
        source=SOURCE,
        user_id=user_id,
        conversation_id=session_id,
        discriminator=f"{invocation_id}#c{index}",
    )


def read_marker(session: Any, invocation_id: str) -> Tuple[str, str]:
    """Recover (root_agent, root_branch) written when the invocation started."""
    state = getattr(session, "state", None) or {}
    markers = state.get(STATE_KEY) if isinstance(state, dict) else None
    if not isinstance(markers, dict):
        return "", ""
    entry = markers.get(invocation_id)
    if not isinstance(entry, dict):
        return "", ""
    return str(entry.get("root") or ""), str(entry.get("branch") or "")


def group_by_invocation(events: Sequence[Any]) -> Dict[str, List[Any]]:
    grouped: Dict[str, List[Any]] = {}
    for event in events:
        key = getattr(event, "invocation_id", "") or ""
        grouped.setdefault(key, []).append(event)
    return grouped
