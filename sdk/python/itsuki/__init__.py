"""Python client for the Itsuki memory API.

    from itsuki import MemoryClient

    memory = MemoryClient(api_key="itsuki_live_...")
    memory.add("I started learning Kotlin this week.")
    print(memory.search("what am I learning?")["context"])
"""

from __future__ import annotations

import asyncio
import ipaddress
import math
import random
import time
import uuid
from datetime import timezone
from email.utils import parsedate_to_datetime
from typing import (
    TYPE_CHECKING,
    Any,
    Dict,
    FrozenSet,
    Generator,
    List,
    Literal,
    NamedTuple,
    Optional,
    TypedDict,
    Union,
    cast,
    overload,
)
from urllib.parse import quote, urlsplit

import httpx

if TYPE_CHECKING:
    from typing_extensions import Unpack

DEFAULT_BASE_URL = "https://itsuki.app"
VERSION = "0.3.0"
_MAX_TIMEOUT_SECONDS = 2_147_483.647

MessageRole = Literal["user", "assistant", "system", "tool"]
SourceEventKind = Literal[
    "user_prompt",
    "assistant_prose",
    "tool_call",
    "tool_result",
    "command_result",
    "file_change",
    "test_result",
    "git_commit",
    "deployment_result",
    "error",
    "plan",
    "decision",
    "architecture_decision",
    "bug_fix",
    "user_preference",
    "unresolved_issue",
]
SourceEventOutcome = Literal["success", "failure", "partial", "skipped", "unknown"]
RecallScope = Literal["global", "project_only", "project_then_global"]
CaptureDensity = Literal["standard", "dense"]
JobStatus = Literal["queued", "staged", "processing", "enriched", "failed", "completed"]
TerminalJobStatus = Literal["enriched", "failed", "completed"]
UsageRange = Literal["1d", "7d", "30d", "all"]
CaptureDefault = Literal["auto", "graph_only"]
ConversationScope = Literal["full", "lastN", "topic", "summary"]
Timestamp = Union[int, float, str]
UserId = Optional[str]
APIResponse = Dict[str, Any]


class SourceEvent(TypedDict, total=False):
    schema: Literal["itsuki.source-event/v1"]
    kind: SourceEventKind
    event_id: str
    parent_event_id: str
    tool_name: str
    outcome: SourceEventOutcome
    exit_code: int
    sequence: int
    truncated: bool


class _MessageRequired(TypedDict):
    content: str


class Message(_MessageRequired, total=False):
    """One chronological conversation message accepted by write operations."""

    role: MessageRole
    id: str
    ts: Timestamp
    source_event: SourceEvent
    sourceEvent: SourceEvent


MemoryMessage = Union[str, Message]


class MemoryScope(TypedDict, total=False):
    """Project/provenance metadata. Project identity does not create a tenant."""

    project_id: Optional[str]
    project_name: Optional[str]
    projectId: Optional[str]
    projectName: Optional[str]
    workspace_id: Optional[str]
    workspaceId: Optional[str]
    app_id: Optional[str]
    appId: Optional[str]
    agent_id: Optional[str]
    agentId: Optional[str]
    source_scope: Optional[str]
    sourceScope: Optional[str]


class CustomCategory(TypedDict, total=False):
    name: str
    description: str


class MemoryRules(TypedDict, total=False):
    autoCollect: bool
    captureDefault: CaptureDefault
    captureDensity: CaptureDensity
    customInstructions: str
    includes: List[str]
    excludes: List[str]
    customCategories: List[CustomCategory]
    retentionDays: Optional[int]


class ContentScope(TypedDict, total=False):
    subject: str
    topic: str
    speaker_scope: str
    speakerScope: str
    include_assistant_facts: bool
    includeAssistantFacts: bool
    exclude_other_people: bool
    excludeOtherPeople: bool


class CommonOptions(TypedDict, total=False):
    """Python-spelled options shared by memory write/read request bodies."""

    user_id: Optional[str]
    memory_scope: MemoryScope
    source_scope: MemoryScope
    conversation_id: str
    thread_id: str
    source_id: str
    idempotency_key: str
    source: str
    capture_density: CaptureDensity
    rules: MemoryRules


class AddOptions(CommonOptions, total=False):
    scope: ConversationScope
    n: int
    topic: str
    recent_context: str
    content_scope: ContentScope


class RecallOptions(CommonOptions, total=False):
    topic: str
    limit: int
    recall_scope: RecallScope


class TurnOptions(CommonOptions, total=False):
    query: str
    recall_scope: RecallScope


class IngestOptions(CommonOptions, total=False):
    flush: bool
    delivery: "IngestDelivery"


class CaptureRedactions(TypedDict, total=False):
    private_key: int
    connection_credentials: int
    query_secret: int
    api_key: int
    bearer_token: int
    high_entropy: int
    named_secret: int


class CaptureEvidence(TypedDict):
    schema: Literal["itsuki.capture-evidence/v1"]
    inputRows: int
    capturedEvents: int
    returnedEvents: int
    omittedEvents: int
    malformedRows: int
    ineligibleRows: int
    ignoredThinkingBlocks: int
    ignoredMetaRows: int
    ignoredToolEvents: int
    ignoredRecallEvents: int
    ignoredRecallEchoEvents: int
    ignoredUnprotectedAssistantEvents: int
    ignoredNoiseEvents: int
    ambiguousOutcomeRows: int
    companionLimitRejectedOutcomeRows: int
    closureEventLimitRejectedOutcomeRows: int
    truncatedEvents: int
    redactions: CaptureRedactions
    tailReturnedRecords: int
    tailScannedBytes: int
    tailOversizedLines: int
    tailMalformedLines: int
    tailIneligibleLines: int
    tailEmptyLines: int


class _IngestDeliveryRequired(TypedDict):
    schema: Literal["itsuki.ingest.delivery/v1"]
    groupId: str
    batchIndex: int
    batchCount: int
    sourceMessageCount: int
    segmentCount: int
    splitSourceMessages: int
    captureTruncated: bool


class IngestDelivery(_IngestDeliveryRequired, total=False):
    truncationReason: Optional[str]
    captureEvidence: CaptureEvidence


class MemoryScopeResult(TypedDict, total=False):
    project_id: Optional[str]
    project_name: Optional[str]
    workspace_id: Optional[str]
    app_id: Optional[str]
    source_scope: Optional[str]


class ReceiptCounts(TypedDict, total=False):
    received: Optional[int]
    held: Optional[int]
    skipped: int
    savedTotal: int
    pages: int
    nodes: int
    slices: int
    events: int
    edges: int
    candidates: int
    items: int


class WriteResult(TypedDict, total=False):
    ok: bool
    command_mode: str
    mode: str
    source: str
    fired: bool
    processing: bool
    duplicate: bool
    summary: str
    source_packet_id: Optional[str]
    receipt_id: Optional[str]
    receipt: Optional[APIResponse]
    counts: ReceiptCounts
    memory_scope: MemoryScopeResult
    job_id: str


class RecallResult(WriteResult, total=False):
    context: str
    count: int
    processing_note: Optional[str]
    items: List[Any]
    nodes: List[Any]
    pages: List[Any]
    recall_scope: RecallScope
    packet: Any


class TurnCollectResult(WriteResult, total=False):
    enabled: bool


class TurnResult(TypedDict, total=False):
    ok: bool
    recall: RecallResult
    collect: TurnCollectResult
    rules: MemoryRules


class JobCounts(TypedDict, total=False):
    nodes: int
    edges: int
    slices: int
    events: int
    pages: int


class PacketStatus(TypedDict, total=False):
    ok: bool
    job_id: str
    source_packet_id: Optional[str]
    status: JobStatus
    type: str
    lane: Optional[str]
    project_id: Optional[str]
    project_name: Optional[str]
    attempts: int
    created_at: int
    updated_at: int
    completed_at: Optional[int]
    receipt_id: Optional[str]
    counts: JobCounts
    delivery: Optional[IngestDelivery]
    remaining_messages: Optional[int]
    error: str


PacketStatusResult = PacketStatus
MemoryJob = PacketStatus


class TimedOutPacketStatus(TypedDict, total=False):
    status: Union[JobStatus, Literal["unknown"]]
    timed_out: Literal[True]
    ok: bool
    job_id: str
    source_packet_id: Optional[str]
    type: str
    lane: Optional[str]
    project_id: Optional[str]
    project_name: Optional[str]
    attempts: int
    created_at: int
    updated_at: int
    completed_at: Optional[int]
    receipt_id: Optional[str]
    counts: JobCounts
    delivery: Optional[IngestDelivery]
    remaining_messages: Optional[int]
    error: str


class JobsResult(TypedDict, total=False):
    ok: bool
    jobs: List[MemoryJob]
    count: int


class ReceiptsResult(TypedDict, total=False):
    receipts: List[APIResponse]


class DeleteResult(TypedDict, total=False):
    ok: bool
    deleted: Union[bool, Dict[str, int]]
    dry_run: bool
    would_delete: Dict[str, int]


CommandResult = WriteResult
AddConversationOptions = AddOptions
SearchOptions = RecallOptions


TERMINAL_JOB_STATUSES: FrozenSet[TerminalJobStatus] = frozenset(("enriched", "failed", "completed"))
_USAGE_RANGES: FrozenSet[UsageRange] = frozenset(("1d", "7d", "30d", "all"))
_JOB_STATUSES: FrozenSet[JobStatus] = frozenset(
    ("queued", "staged", "processing", "enriched", "failed", "completed")
)

__all__ = [
    "AddOptions",
    "AddConversationOptions",
    "APIResponse",
    "CaptureEvidence",
    "CaptureRedactions",
    "CaptureDefault",
    "CaptureDensity",
    "CommonOptions",
    "CommandResult",
    "ContentScope",
    "ConversationScope",
    "CustomCategory",
    "DeleteResult",
    "IngestOptions",
    "IngestDelivery",
    "JobCounts",
    "JobsResult",
    "JobStatus",
    "Memory",
    "MemoryAPIError",
    "MemoryClient",
    "MemoryMessage",
    "MemoryJob",
    "MemoryRules",
    "MemoryScope",
    "MemoryScopeResult",
    "Message",
    "MessageRole",
    "PacketStatus",
    "PacketStatusResult",
    "RecallResult",
    "RecallOptions",
    "RecallScope",
    "ReceiptsResult",
    "ReceiptCounts",
    "TERMINAL_JOB_STATUSES",
    "SearchOptions",
    "SourceEvent",
    "SourceEventKind",
    "SourceEventOutcome",
    "TerminalJobStatus",
    "Timestamp",
    "TimedOutPacketStatus",
    "TurnResult",
    "TurnCollectResult",
    "TurnOptions",
    "UsageRange",
    "UserId",
    "VERSION",
    "WriteResult",
]

_UNSET = object()
_USER_ID_DEFAULT = cast(Optional[str], _UNSET)


class MemoryAPIError(Exception):
    """Raised for every non-2xx API response or transport failure."""

    status: int
    code: Optional[str]
    body: Any
    retry_after: Optional[float]

    def __init__(
        self,
        message: str,
        *,
        status: int = 0,
        code: Optional[str] = None,
        body: Any = None,
        retry_after: Optional[float] = None,
    ):
        super().__init__(message)
        self.status = status
        self.code = code
        self.body = body
        self.retry_after = retry_after


def _argument_error(message: str) -> MemoryAPIError:
    return MemoryAPIError(message, code="invalid_argument")


def _has_control_characters(value: str) -> bool:
    return any(ord(character) < 32 or ord(character) == 127 for character in value)


def _is_finite_number(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _validate_user_id(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise _argument_error("user_id must be a non-empty string or None")
    if value != value.strip():
        raise _argument_error("user_id must not have surrounding whitespace")
    if _has_control_characters(value):
        raise _argument_error("user_id must not contain control characters")
    return value


def _validate_identifier(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise _argument_error(f"{name} is required")
    if value != value.strip():
        raise _argument_error(f"{name} must not have surrounding whitespace")
    if _has_control_characters(value):
        raise _argument_error(f"{name} must not contain control characters")
    return value


def _validate_non_empty_string(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise _argument_error(f"{name} must be a non-empty string")
    return value


def _validate_messages(value: Any, *, allow_empty: bool) -> List[MemoryMessage]:
    if not isinstance(value, list) or (not allow_empty and not value):
        qualifier = "an array" if allow_empty else "a non-empty array"
        raise _argument_error(f"messages must be {qualifier}")
    return cast(List[MemoryMessage], value)


def _validate_number(
    value: Any,
    name: str,
    *,
    minimum: float,
    integer: bool = False,
) -> Union[int, float]:
    valid = _is_finite_number(value) and value >= minimum
    if integer:
        valid = valid and isinstance(value, int) and abs(value) <= 2 ** 53 - 1
    if not valid:
        qualifier = "safe integer" if integer else "finite number"
        raise _argument_error(
            f"{name} must be a {qualifier} greater than or equal to {minimum:g}"
        )
    return cast(Union[int, float], value)


def _reject_reserved_options(
    options: Dict[str, Any],
    label: str,
    reserved: FrozenSet[str],
) -> None:
    for key in reserved:
        if key in options:
            raise _argument_error(f"{label}.{key} is set by the method argument")


def _primary_argument(
    positional: Any,
    options: Dict[str, Any],
    name: str,
    label: str,
) -> Any:
    keyword = options.pop(name, _UNSET)
    if positional is not _UNSET and keyword is not _UNSET:
        raise _argument_error(f"{label}.{name} is set by the method argument")
    return positional if positional is not _UNSET else keyword


def _parse_retry_after(value: Optional[str]) -> Optional[float]:
    if not value:
        return None
    try:
        seconds = float(value)
    except ValueError:
        seconds = -1.0
    if math.isfinite(seconds) and seconds >= 0:
        return seconds
    try:
        retry_at = parsedate_to_datetime(value)
        if retry_at is None:
            return None
        if retry_at.tzinfo is None:
            retry_at = retry_at.replace(tzinfo=timezone.utc)
        delay = retry_at.timestamp() - time.time()
    except (OverflowError, TypeError, ValueError):
        return None
    return max(0.0, delay) if math.isfinite(delay) else None


def _validate_base_url(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise _argument_error("base_url is required")
    if value != value.strip():
        raise _argument_error("base_url must not have surrounding whitespace")
    if _has_control_characters(value):
        raise _argument_error("base_url must not contain control characters")
    if any(character.isspace() or character == "\\" for character in value):
        raise _argument_error("base_url must not contain whitespace or backslashes")
    try:
        parsed = urlsplit(value)
        # Accessing port also rejects malformed/non-numeric ports.
        parsed.port
    except ValueError as exc:
        raise _argument_error("base_url must be a valid URL") from exc
    if not parsed.hostname or parsed.username is not None or parsed.password is not None:
        raise _argument_error("base_url must be an origin without embedded credentials")
    if parsed.query or parsed.fragment or parsed.path not in ("", "/"):
        raise _argument_error("base_url must be an origin without a path, query, or fragment")

    scheme = parsed.scheme.lower()
    host = parsed.hostname.lower()
    try:
        ipaddress.ip_address(host)
    except ValueError:
        try:
            ascii_host = host.rstrip(".").encode("idna").decode("ascii")
        except UnicodeError as exc:
            raise _argument_error("base_url contains an invalid hostname") from exc
        labels = ascii_host.split(".")
        if (
            not ascii_host
            or len(ascii_host) > 253
            or any(
                not label
                or len(label) > 63
                or label.startswith("-")
                or label.endswith("-")
                or any(not (character.isascii() and (character.isalnum() or character == "-")) for character in label)
                for label in labels
            )
        ):
            raise _argument_error("base_url contains an invalid hostname")
    is_loopback = host == "localhost"
    if not is_loopback:
        try:
            is_loopback = ipaddress.ip_address(host).is_loopback
        except ValueError:
            is_loopback = False
    if scheme != "https" and not (scheme == "http" and is_loopback):
        raise _argument_error("base_url must use HTTPS (HTTP is allowed only for loopback development)")
    return value.rstrip("/")


# ------------------------------------------------------------------ plans
# A sync client and an async client that disagree about anything — retry
# arithmetic, tenant resolution, which errors are retriable — is a bug
# waiting for whichever caller is unlucky. So every decision lives exactly
# once, in a plan: a generator that yields the I/O it wants performed and is
# handed the outcome back. Plans never touch the network and never sleep;
# the two drivers below are the only code that does, and they are the only
# place the two worlds differ.


class _Sleep(NamedTuple):
    seconds: float


class _Send(NamedTuple):
    method: str
    path: str
    params: Optional[Dict[str, Any]]
    body: Optional[Dict[str, Any]]
    timeout: float


class _Outcome(NamedTuple):
    """What a driver hands back after performing one _Send."""

    failure: Optional["MemoryAPIError"] = None
    success: bool = False
    status: int = 0
    data: Any = None
    retry_after: Optional[float] = None


_Action = Union[_Sleep, _Send]
_Plan = Generator[_Action, Optional[_Outcome], Any]


def _default_headers(api_key: str) -> Dict[str, str]:
    return {
        "authorization": f"Bearer {api_key}",
        "content-type": "application/json",
        "user-agent": f"itsuki-python/{VERSION}",
    }


def _read_response(res: "httpx.Response") -> _Outcome:
    try:
        data = res.json()
    except (ValueError, UnicodeError):
        data = None
    return _Outcome(
        success=res.is_success,
        status=res.status_code,
        data=data,
        retry_after=_parse_retry_after(res.headers.get("retry-after")),
    )


def _timed_out(seconds: float) -> _Outcome:
    return _Outcome(
        failure=MemoryAPIError(
            f"request timed out after {seconds:g}s",
            status=0,
            code="timeout",
        )
    )


def _transport_failed(exc: Exception) -> _Outcome:
    return _Outcome(
        failure=MemoryAPIError(
            f"request failed: {exc}",
            status=0,
            code="transport_error",
        )
    )


class _ClientCore:
    """Everything both clients decide identically.

    Subclasses supply only a transport and a driver. Nothing here performs
    I/O, so the whole decision surface is testable without a network or an
    event loop.
    """

    user_id: Optional[str]
    timeout: float
    max_retries: int

    # ------------------------------------------------------- construction
    def _configure(
        self,
        api_key: str,
        base_url: str,
        user_id: Optional[str],
        timeout: float,
        max_retries: int,
    ) -> str:
        if not isinstance(api_key, str) or not api_key.strip():
            raise _argument_error("api_key is required")
        if api_key != api_key.strip():
            raise _argument_error("api_key must not have surrounding whitespace")
        if _has_control_characters(api_key):
            raise _argument_error("api_key must not contain control characters")
        if (
            isinstance(max_retries, bool)
            or not isinstance(max_retries, int)
            or max_retries < 0
            or max_retries > 10
        ):
            raise _argument_error("max_retries must be an integer between 0 and 10")
        if (
            not _is_finite_number(timeout)
            or timeout <= 0
            or timeout > _MAX_TIMEOUT_SECONDS
        ):
            raise _argument_error(
                "timeout must be greater than zero and no greater than 2147483.647 seconds"
            )
        validated_base_url = _validate_base_url(base_url)
        self.user_id = _validate_user_id(user_id)
        self.timeout = float(timeout)
        self.max_retries = max_retries
        return validated_base_url

    # ------------------------------------------------------------ helpers
    @staticmethod
    def new_idempotency_key() -> str:
        """A fresh idempotency key — pass to writes to make retries safe."""
        return f"idem_{uuid.uuid4()}"

    # Python callers write snake_case; the wire is camelCase. Translating here
    # is what keeps `add(..., user_id="alice")` from becoming an unrecognised
    # key — which is exactly how sub-tenancy once failed silently.
    _WIRE_NAMES = {
        "user_id": "userId",
        "external_user_id": "userId",
        "end_user_id": "userId",
        "tenant_id": "userId",
        "conversation_id": "conversationId",
        "thread_id": "threadId",
        "source_id": "sourceId",
        "idempotency_key": "idempotencyKey",
        "capture_density": "captureDensity",
        "memory_scope": "memoryScope",
        "recall_scope": "recallScope",
        "source_scope": "sourceScope",
        "content_scope": "contentScope",
        "recent_context": "recentContext",
        "metadata_only": "metadataOnly",
        "run_id": "runId",
    }

    def _to_wire(self, body: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        if not body:
            return body
        out: Dict[str, Any] = {}
        for key, value in body.items():
            wire = self._WIRE_NAMES.get(key, key)
            if wire in out:
                raise _argument_error(f"'{key}' and '{wire}' mean the same thing — pass only one.")
            out[wire] = value
        return out

    # ------------------------------------------------------- write plans
    def _plan_add(self, *args: Any, **opts: Any) -> _Plan:
        if len(args) > 1:
            raise _argument_error("add accepts at most one positional content argument")
        content = _primary_argument(
            args[0] if args else _UNSET,
            opts,
            "content",
            "add options",
        )
        messages = _primary_argument(_UNSET, opts, "messages", "add options")
        _reject_reserved_options(opts, "add options", frozenset(("mode",)))
        if messages is not _UNSET:
            if content is not _UNSET:
                raise _argument_error("Pass either content= or messages=, not both.")
            return self._plan_add_conversation(
                _validate_messages(messages, allow_empty=False), **opts
            )
        if content is _UNSET:
            raise _argument_error(
                "add() needs content='...' (a sentence to remember) or "
                "messages=[{'role': 'user', 'content': '...'}]."
            )
        validated_content = _validate_non_empty_string(content, "content")
        return self._request_plan("POST", "/v1/save", {**opts, "content": validated_content})

    def _plan_add_conversation(self, *args: Any, **opts: Any) -> _Plan:
        if len(args) > 1:
            raise _argument_error(
                "add_conversation accepts at most one positional messages argument"
            )
        messages = _primary_argument(
            args[0] if args else _UNSET,
            opts,
            "messages",
            "add_conversation options",
        )
        _reject_reserved_options(
            opts,
            "add_conversation options",
            frozenset(("content", "mode")),
        )
        messages = _validate_messages(messages, allow_empty=False)
        return self._request_plan(
            "POST",
            "/v1/save",
            {**opts, "mode": "conversation", "messages": messages},
        )

    def _plan_turn(self, *args: Any, **opts: Any) -> _Plan:
        if len(args) > 1:
            raise _argument_error("turn accepts at most one positional messages argument")
        messages = _primary_argument(
            args[0] if args else _UNSET,
            opts,
            "messages",
            "turn options",
        )
        messages = _validate_messages(messages, allow_empty=True)
        if not messages and (
            not isinstance(opts.get("query"), str) or not opts["query"].strip()
        ):
            raise _argument_error("turn needs at least one message or a non-empty query")
        return self._request_plan("POST", "/v1/turn", {**opts, "messages": messages})

    def _plan_ingest(self, *args: Any, **opts: Any) -> _Plan:
        if len(args) > 1:
            raise _argument_error("ingest accepts at most one positional messages argument")
        messages = _primary_argument(
            args[0] if args else _UNSET,
            opts,
            "messages",
            "ingest options",
        )
        messages = _validate_messages(messages, allow_empty=True)
        return self._request_plan("POST", "/v1/ingest", {**opts, "messages": messages})

    # -------------------------------------------------------- read plans
    def _plan_search(self, *args: Any, **opts: Any) -> _Plan:
        if len(args) > 1:
            raise _argument_error("search accepts at most one positional query argument")
        query = _primary_argument(
            args[0] if args else _UNSET,
            opts,
            "query",
            "search options",
        )
        query = _validate_non_empty_string(query, "query")
        return self._request_plan("POST", "/v1/recall", {**opts, "query": query})

    def _plan_graph(self, *, user_id: Optional[str]) -> _Plan:
        return self._request_plan("GET", "/v1/graph", user_id=user_id)

    def _plan_status(self, *, user_id: Optional[str]) -> _Plan:
        return self._request_plan("GET", "/v1/status", user_id=user_id)

    def _plan_receipts(self, limit: int, *, user_id: Optional[str]) -> _Plan:
        validated_limit = _validate_number(limit, "limit", minimum=1, integer=True)
        return self._request_plan(
            "GET",
            "/v1/receipts",
            params={"limit": validated_limit},
            user_id=user_id,
        )

    def _plan_usage(self, range: UsageRange, *, user_id: Optional[str]) -> _Plan:
        if not isinstance(range, str) or range not in _USAGE_RANGES:
            raise _argument_error("range must be 1d, 7d, 30d, or all")
        return self._request_plan(
            "GET", "/v1/usage", params={"range": range}, user_id=user_id
        )

    def _plan_get_rules(self, *, user_id: Optional[str]) -> _Plan:
        return self._request_plan("GET", "/v1/rules", user_id=user_id)

    def _plan_set_rules(self, rules: MemoryRules, *, user_id: Optional[str]) -> _Plan:
        if not isinstance(rules, dict):
            raise _argument_error("rules must be an object")
        return self._request_plan("PUT", "/v1/rules", {"rules": rules}, user_id=user_id)

    def _plan_export_all(self, *, user_id: Optional[str]) -> _Plan:
        return self._request_plan("GET", "/v1/export", user_id=user_id)

    def _plan_list_memories(
        self,
        *,
        kind: Optional[str],
        limit: Optional[int],
        cursor: Optional[str],
        q: Optional[str],
        user_id: Optional[str],
    ) -> _Plan:
        if kind is not None and kind not in ("all", "node", "page"):
            raise _argument_error("kind must be all, node, or page")
        validated_limit = (
            None
            if limit is None
            else _validate_number(limit, "limit", minimum=1, integer=True)
        )
        if validated_limit is not None and validated_limit > 200:
            raise _argument_error("limit must be no greater than 200")
        return self._request_plan(
            "GET",
            "/v1/memories",
            params={"kind": kind, "limit": validated_limit, "cursor": cursor, "q": q},
            user_id=user_id,
        )

    def _plan_get_memory(self, memory_id: str, *, user_id: Optional[str]) -> _Plan:
        memory_id = _validate_identifier(memory_id, "memory_id")
        return self._request_plan(
            "GET",
            f"/v1/memories/{quote(memory_id, safe='')}",
            user_id=user_id,
        )

    # ------------------------------------------------------ delete plans
    def _plan_delete(self, memory_id: str, *, user_id: Optional[str]) -> _Plan:
        memory_id = _validate_identifier(memory_id, "memory_id")
        return self._request_plan(
            "DELETE",
            f"/v1/memories/{quote(memory_id, safe='')}",
            user_id=user_id,
        )

    def _plan_delete_by_source(
        self,
        source: Optional[str],
        before: Optional[float],
        after: Optional[float],
        confirm: bool,
        *,
        user_id: Optional[str],
    ) -> _Plan:
        if not isinstance(confirm, bool):
            raise _argument_error("confirm must be a boolean")
        validated_source = None if source is None else _validate_identifier(source, "source")
        validated_before = (
            None if before is None else _validate_number(before, "before", minimum=1)
        )
        validated_after = (
            None if after is None else _validate_number(after, "after", minimum=1)
        )
        params: Dict[str, Any] = {
            "source": validated_source,
            "before": validated_before,
            "after": validated_after,
        }
        if confirm:
            params["confirm"] = "true"
            params["dry_run"] = "false"
        return self._request_plan("DELETE", "/v1/memories", params=params, user_id=user_id)

    # --------------------------------------------------- lifecycle plans
    def _plan_packet_status(self, source_packet_id: str, *, user_id: Optional[str]) -> _Plan:
        source_packet_id = _validate_identifier(source_packet_id, "source_packet_id")
        return self._packet_status_plan(source_packet_id, user_id=user_id)

    def _packet_status_plan(
        self,
        source_packet_id: str,
        *,
        user_id: Optional[str],
        retry_deadline: Optional[float] = None,
        request_timeout: Optional[float] = None,
        max_retries: Optional[int] = None,
    ) -> _Plan:
        return self._request_plan(
            "GET",
            f"/v1/packets/{quote(source_packet_id, safe='')}/status",
            user_id=user_id,
            retry_deadline=retry_deadline,
            request_timeout=request_timeout,
            max_retries=max_retries,
        )

    def _plan_jobs(
        self,
        status: Optional[JobStatus],
        since: Optional[float],
        limit: Optional[int],
        *,
        user_id: Optional[str],
    ) -> _Plan:
        if status is not None and (
            not isinstance(status, str) or status not in _JOB_STATUSES
        ):
            raise _argument_error(
                "status must be one of: queued, staged, processing, enriched, failed, completed"
            )
        validated_since = (
            None if since is None else _validate_number(since, "since", minimum=1)
        )
        validated_limit = (
            None
            if limit is None
            else _validate_number(limit, "limit", minimum=1, integer=True)
        )
        return self._request_plan(
            "GET",
            "/v1/jobs",
            params={"status": status, "since": validated_since, "limit": validated_limit},
            user_id=user_id,
        )

    def _plan_wait_for(
        self,
        source_packet_id: str,
        timeout: float,
        interval: float,
        *,
        user_id: Optional[str],
    ) -> _Plan:
        if (
            not _is_finite_number(timeout)
            or timeout < 0
            or timeout > _MAX_TIMEOUT_SECONDS
        ):
            raise _argument_error(
                "timeout must be non-negative and no greater than 2147483.647 seconds"
            )
        if (
            not _is_finite_number(interval)
            or interval <= 0
            or interval > _MAX_TIMEOUT_SECONDS
        ):
            raise _argument_error(
                "interval must be greater than zero and no greater than 2147483.647 seconds"
            )
        source_packet_id = _validate_identifier(source_packet_id, "source_packet_id")
        return self._wait_plan(source_packet_id, timeout, interval, user_id=user_id)

    def _wait_plan(
        self,
        source_packet_id: str,
        timeout: float,
        interval: float,
        *,
        user_id: Optional[str],
    ) -> _Plan:
        deadline = time.monotonic() + timeout
        # Always inspect once. timeout=0 means one immediate status check.
        last: Optional[PacketStatus] = None
        first_poll = True
        while first_poll or time.monotonic() < deadline:
            initial_poll = first_poll
            first_poll = False
            remaining_before_poll = deadline - time.monotonic()
            request_timeout = (
                self.timeout
                if initial_poll and timeout == 0
                else max(0.001, min(self.timeout, remaining_before_poll))
            )
            # Whether this poll is bounded by the POLLING budget rather than the
            # client's own request timeout. Decided here, at dispatch: a timeout
            # of a budget-bounded poll IS the polling deadline expiring, and
            # re-reading the clock in the except below raced the abort timer —
            # when the request timed out a hair before the deadline, wait_for
            # raised instead of returning the documented timed_out snapshot.
            budget_bounded = (
                not (initial_poll and timeout == 0)
                and remaining_before_poll <= self.timeout
            )
            try:
                last = cast(PacketStatus, (yield from self._packet_status_plan(
                    source_packet_id,
                    user_id=user_id,
                    retry_deadline=deadline,
                    request_timeout=request_timeout,
                    max_retries=0,
                )))
            except MemoryAPIError as error:
                if error.code != "timeout" or not budget_bounded:
                    raise
                break
            if last.get("status") in TERMINAL_JOB_STATUSES:
                if timeout == 0 or time.monotonic() < deadline:
                    return last
                break
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            yield _Sleep(min(interval, remaining))
        timeout_snapshot: Dict[str, Any] = dict(last) if last is not None else {"status": "unknown"}
        out = cast(TimedOutPacketStatus, timeout_snapshot)
        out["timed_out"] = True
        return out

    # ------------------------------------------------------ request plan
    def _request_plan(
        self,
        method: str,
        path: str,
        body: Optional[Dict[str, Any]] = None,
        params: Optional[Dict[str, Any]] = None,
        *,
        user_id: Optional[str] = _USER_ID_DEFAULT,
        retry_deadline: Optional[float] = None,
        request_timeout: Optional[float] = None,
        max_retries: Optional[int] = None,
    ) -> _Plan:
        body = self._to_wire(body)
        params = {key: value for key, value in (params or {}).items() if value is not None}

        if body is not None and body.get("idempotencyKey") is not None:
            body = {
                **body,
                "idempotencyKey": _validate_identifier(
                    body["idempotencyKey"],
                    "idempotency_key",
                ),
            }

        # Body endpoints authenticate their tenant from the body. Query-only
        # endpoints use userId in the URL. Keeping one authority avoids sending
        # contradictory constructor and per-call tenant ids on the same POST.
        if body is not None:
            if user_id is not _UNSET:
                if "userId" in body:
                    raise _argument_error("user_id was provided twice")
                body = {**body, "userId": _validate_user_id(user_id)}
            elif "userId" in body:
                body = {**body, "userId": _validate_user_id(body["userId"])}
            elif self.user_id is not None:
                body = {**body, "userId": self.user_id}
        else:
            request_user_id = self.user_id if user_id is _UNSET else _validate_user_id(user_id)
            if request_user_id is not None:
                params["userId"] = request_user_id

        # Writes retry only when the caller opted into idempotency; reads always may.
        retryable = method == "GET" or (
            body is not None and isinstance(body.get("idempotencyKey"), str)
        )
        retry_count = self.max_retries if max_retries is None else max_retries
        attempts = retry_count + 1 if retryable else 1
        deadline = retry_deadline if retry_deadline is not None else time.monotonic() + self.timeout
        attempt_timeout = self.timeout if request_timeout is None else request_timeout

        last_error: Optional[MemoryAPIError] = None
        for attempt in range(attempts):
            if attempt:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                delay = (
                    last_error.retry_after
                    if last_error and last_error.retry_after is not None
                    else 0.25 * 2 ** (attempt - 1) + random.random() * 0.1
                )
                if not math.isfinite(delay) or delay < 0:
                    delay = 0.0
                yield _Sleep(min(delay, remaining))
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
            else:
                remaining = deadline - time.monotonic()
            # timeout=0 polling still gets one immediate request. Retries never
            # start after their enclosing operation's deadline.
            current_timeout = (
                attempt_timeout
                if attempt == 0 and remaining <= 0
                else min(attempt_timeout, remaining)
            )
            outcome = yield _Send(method, path, params or None, body, current_timeout)
            assert outcome is not None  # a driver always answers a _Send
            if outcome.failure is not None:
                last_error = outcome.failure
                continue
            if outcome.success:
                return outcome.data

            data = outcome.data
            error_data = data if isinstance(data, dict) else {}
            raw_message = error_data.get("message") or error_data.get("error")
            message = raw_message if isinstance(raw_message, str) and raw_message else None
            raw_code = error_data.get("code") or error_data.get("error")
            code = raw_code if isinstance(raw_code, str) and raw_code else None
            error = MemoryAPIError(
                str(message) if message else f"{method} {path} failed with {outcome.status}",
                status=outcome.status,
                code=code,
                body=data,
                retry_after=outcome.retry_after,
            )
            if outcome.status == 429 or outcome.status >= 500:
                last_error = error
                continue
            raise error

        if last_error is None:
            raise MemoryAPIError(f"{method} {path} failed")
        raise last_error


class MemoryClient(_ClientCore):
    """Thin synchronous client over the Itsuki REST API.

    api_key:  itsuki_live_... Bearer key (legacy uml_live_ keys also work).
    user_id:  optional sub-tenant selector — a stable string per end user of
              YOUR app; each value maps to an isolated memory space.
    """

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        user_id: Optional[str] = None,
        timeout: float = 30.0,
        max_retries: int = 2,
    ):
        base_url = self._configure(api_key, base_url, user_id, timeout, max_retries)
        self._client = httpx.Client(
            base_url=base_url,
            timeout=timeout,
            follow_redirects=False,
            headers=_default_headers(api_key),
        )

    # ----------------------------------------------------------- write
    @overload
    def add(self, content: str, /, **opts: Unpack[AddOptions]) -> WriteResult: ...

    @overload
    def add(self, *, content: str, **opts: Unpack[AddOptions]) -> WriteResult: ...

    @overload
    def add(self, *, messages: List[MemoryMessage], **opts: Unpack[AddOptions]) -> WriteResult: ...

    def add(  # Runtime parser accepts positional and keyword primaries.
        self,
        *args: Any,
        **opts: Any,
    ) -> WriteResult:
        """Save one durable fact, or a list of messages.

        user_id="alice" scopes this write to one of YOUR end users — an
        isolated memory space inside your account. Omit it and the memory
        belongs to the key's owner.

            memory.add("Ada prefers email.", user_id="ada")
            memory.add(messages=[{"role": "user", "content": "..."}], user_id="ada")
        """
        return cast(WriteResult, self._drive(self._plan_add(*args, **opts)))

    save = add

    @overload
    def add_conversation(
        self, messages: List[MemoryMessage], /, **opts: Unpack[AddConversationOptions]
    ) -> WriteResult: ...

    @overload
    def add_conversation(
        self, *, messages: List[MemoryMessage], **opts: Unpack[AddConversationOptions]
    ) -> WriteResult: ...

    def add_conversation(self, *args: Any, **opts: Any) -> WriteResult:
        """Save a conversation (messages oldest first)."""
        return cast(WriteResult, self._drive(self._plan_add_conversation(*args, **opts)))

    @overload
    def turn(self, messages: List[MemoryMessage], /, **opts: Unpack[TurnOptions]) -> TurnResult: ...

    @overload
    def turn(self, *, messages: List[MemoryMessage], **opts: Unpack[TurnOptions]) -> TurnResult: ...

    def turn(self, *args: Any, **opts: Any) -> TurnResult:
        """Recall + auto-capture in one call — send the latest chat messages."""
        return cast(TurnResult, self._drive(self._plan_turn(*args, **opts)))

    @overload
    def ingest(self, messages: List[MemoryMessage], /, **opts: Unpack[IngestOptions]) -> WriteResult: ...

    @overload
    def ingest(self, *, messages: List[MemoryMessage], **opts: Unpack[IngestOptions]) -> WriteResult: ...

    def ingest(self, *args: Any, **opts: Any) -> WriteResult:
        """Bulk ingestion; pass flush=True to force digestion now."""
        return cast(WriteResult, self._drive(self._plan_ingest(*args, **opts)))

    # ------------------------------------------------------------ read
    @overload
    def search(self, query: str, /, **opts: Unpack[RecallOptions]) -> RecallResult: ...

    @overload
    def search(self, *, query: str, **opts: Unpack[RecallOptions]) -> RecallResult: ...

    def search(self, *args: Any, **opts: Any) -> RecallResult:
        """Look up relevant memory. result["context"] is the prompt-ready block."""
        return cast(RecallResult, self._drive(self._plan_search(*args, **opts)))

    recall = search

    def graph(self, *, user_id: Optional[str] = _USER_ID_DEFAULT) -> Dict[str, Any]:
        return cast(Dict[str, Any], self._drive(self._plan_graph(user_id=user_id)))

    def status(self, *, user_id: Optional[str] = _USER_ID_DEFAULT) -> Dict[str, Any]:
        return cast(Dict[str, Any], self._drive(self._plan_status(user_id=user_id)))

    def receipts(
        self,
        limit: int = 50,
        *,
        user_id: Optional[str] = _USER_ID_DEFAULT,
    ) -> ReceiptsResult:
        return cast(ReceiptsResult, self._drive(self._plan_receipts(limit, user_id=user_id)))

    def usage(
        self,
        range: UsageRange = "30d",
        *,
        user_id: Optional[str] = _USER_ID_DEFAULT,
    ) -> Dict[str, Any]:
        return cast(Dict[str, Any], self._drive(self._plan_usage(range, user_id=user_id)))

    def get_rules(self, *, user_id: Optional[str] = _USER_ID_DEFAULT) -> Dict[str, Any]:
        return cast(Dict[str, Any], self._drive(self._plan_get_rules(user_id=user_id)))

    def set_rules(
        self,
        rules: MemoryRules,
        *,
        user_id: Optional[str] = _USER_ID_DEFAULT,
    ) -> Dict[str, Any]:
        return cast(Dict[str, Any], self._drive(self._plan_set_rules(rules, user_id=user_id)))

    def export_all(self, *, user_id: Optional[str] = _USER_ID_DEFAULT) -> Dict[str, Any]:
        return cast(Dict[str, Any], self._drive(self._plan_export_all(user_id=user_id)))

    def list_memories(
        self,
        *,
        kind: Optional[str] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
        q: Optional[str] = None,
        user_id: Optional[str] = _USER_ID_DEFAULT,
    ) -> Dict[str, Any]:
        """Browse stored memories, newest first. Cursor-paginated.

        This is inventory, not search: for meaning-based lookup use
        :meth:`search`. ``q`` filters labels and summaries by substring.
        """
        return cast(Dict[str, Any], self._drive(
            self._plan_list_memories(kind=kind, limit=limit, cursor=cursor, q=q, user_id=user_id)
        ))

    def get_memory(
        self,
        memory_id: str,
        *,
        user_id: Optional[str] = _USER_ID_DEFAULT,
    ) -> Dict[str, Any]:
        """Fetch one stored memory by id, with its slices and dated events."""
        return cast(Dict[str, Any], self._drive(
            self._plan_get_memory(memory_id, user_id=user_id)
        ))

    def delete(
        self,
        memory_id: str,
        *,
        user_id: Optional[str] = _USER_ID_DEFAULT,
    ) -> DeleteResult:
        """Delete one memory object (node_/page_/slice_/candidate_ id)."""
        return cast(DeleteResult, self._drive(self._plan_delete(memory_id, user_id=user_id)))

    def delete_by_source(
        self,
        source: Optional[str] = None,
        before: Optional[float] = None,
        after: Optional[float] = None,
        confirm: bool = False,
        *,
        user_id: Optional[str] = _USER_ID_DEFAULT,
    ) -> DeleteResult:
        """Bulk delete by source lane and/or time window.

        SAFE BY DEFAULT: without ``confirm=True`` this is a dry run that only
        reports what would go.
        """
        return cast(DeleteResult, self._drive(
            self._plan_delete_by_source(source, before, after, confirm, user_id=user_id)
        ))

    def packet_status(
        self,
        source_packet_id: str,
        *,
        user_id: Optional[str] = _USER_ID_DEFAULT,
    ) -> PacketStatus:
        """Background-processing status for one accepted write, by packet id."""
        return cast(PacketStatus, self._drive(
            self._plan_packet_status(source_packet_id, user_id=user_id)
        ))

    def jobs(
        self,
        status: Optional[JobStatus] = None,
        since: Optional[float] = None,
        limit: Optional[int] = None,
        *,
        user_id: Optional[str] = _USER_ID_DEFAULT,
    ) -> JobsResult:
        """The jobs ledger: every accepted write and where it is."""
        return cast(JobsResult, self._drive(
            self._plan_jobs(status, since, limit, user_id=user_id)
        ))

    def wait_for(self, source_packet_id: str, timeout: float = 60.0,
                 interval: float = 1.5, *,
                 user_id: Optional[str] = _USER_ID_DEFAULT) -> Union[
                     PacketStatus, TimedOutPacketStatus
                 ]:
        """Wait for an accepted write to finish background processing.

        Polls until ``enriched``, ``failed``, or compatibility status
        ``completed``, or until the timeout passes — then the last seen status
        is returned with ``timed_out: True``, never an exception (a timeout is
        not a failure)::

            receipt = memory.ingest(messages, flush=True)
            done = memory.wait_for(receipt["source_packet_id"])
        """
        return cast(Union[PacketStatus, TimedOutPacketStatus], self._drive(
            self._plan_wait_for(source_packet_id, timeout, interval, user_id=user_id)
        ))

    # --------------------------------------------------------- lifecycle
    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "MemoryClient":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    # ---------------------------------------------------------- driver
    def _perform(self, send: _Send) -> _Outcome:
        try:
            res = self._client.request(
                send.method,
                send.path,
                params=send.params,
                json=send.body,
                timeout=send.timeout,
            )
        except httpx.TimeoutException:
            return _timed_out(send.timeout)
        except httpx.HTTPError as exc:
            return _transport_failed(exc)
        except (TypeError, ValueError, OverflowError) as exc:
            raise _argument_error("request body must be JSON-serializable") from exc
        return _read_response(res)

    def _drive(self, plan: _Plan) -> Any:
        outcome: Optional[_Outcome] = None
        try:
            while True:
                try:
                    action = plan.send(outcome)
                except StopIteration as stop:
                    return stop.value
                if isinstance(action, _Sleep):
                    if action.seconds > 0:
                        time.sleep(action.seconds)
                    outcome = None
                else:
                    outcome = self._perform(action)
        finally:
            plan.close()


class AsyncMemoryClient(_ClientCore):
    """Asynchronous client over the Itsuki REST API.

    The same surface as :class:`MemoryClient`, awaited. Both clients share one
    decision path, so retries, tenant resolution, redirect refusal and error
    classification cannot drift apart between them::

        async with AsyncMemoryClient(api_key) as memory:
            found = await memory.search("boxing", user_id="ada")
    """

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        user_id: Optional[str] = None,
        timeout: float = 30.0,
        max_retries: int = 2,
    ):
        base_url = self._configure(api_key, base_url, user_id, timeout, max_retries)
        self._client = httpx.AsyncClient(
            base_url=base_url,
            timeout=timeout,
            follow_redirects=False,
            headers=_default_headers(api_key),
        )

    # ----------------------------------------------------------- write
    @overload
    async def add(self, content: str, /, **opts: Unpack[AddOptions]) -> WriteResult: ...

    @overload
    async def add(self, *, content: str, **opts: Unpack[AddOptions]) -> WriteResult: ...

    @overload
    async def add(
        self, *, messages: List[MemoryMessage], **opts: Unpack[AddOptions]
    ) -> WriteResult: ...

    async def add(self, *args: Any, **opts: Any) -> WriteResult:
        """Save one durable fact, or a list of messages."""
        return cast(WriteResult, await self._adrive(self._plan_add(*args, **opts)))

    save = add

    @overload
    async def add_conversation(
        self, messages: List[MemoryMessage], /, **opts: Unpack[AddConversationOptions]
    ) -> WriteResult: ...

    @overload
    async def add_conversation(
        self, *, messages: List[MemoryMessage], **opts: Unpack[AddConversationOptions]
    ) -> WriteResult: ...

    async def add_conversation(self, *args: Any, **opts: Any) -> WriteResult:
        """Save a conversation (messages oldest first)."""
        return cast(WriteResult, await self._adrive(self._plan_add_conversation(*args, **opts)))

    @overload
    async def turn(
        self, messages: List[MemoryMessage], /, **opts: Unpack[TurnOptions]
    ) -> TurnResult: ...

    @overload
    async def turn(
        self, *, messages: List[MemoryMessage], **opts: Unpack[TurnOptions]
    ) -> TurnResult: ...

    async def turn(self, *args: Any, **opts: Any) -> TurnResult:
        """Recall + auto-capture in one call — send the latest chat messages."""
        return cast(TurnResult, await self._adrive(self._plan_turn(*args, **opts)))

    @overload
    async def ingest(
        self, messages: List[MemoryMessage], /, **opts: Unpack[IngestOptions]
    ) -> WriteResult: ...

    @overload
    async def ingest(
        self, *, messages: List[MemoryMessage], **opts: Unpack[IngestOptions]
    ) -> WriteResult: ...

    async def ingest(self, *args: Any, **opts: Any) -> WriteResult:
        """Bulk ingestion; pass flush=True to force digestion now."""
        return cast(WriteResult, await self._adrive(self._plan_ingest(*args, **opts)))

    # ------------------------------------------------------------ read
    @overload
    async def search(self, query: str, /, **opts: Unpack[RecallOptions]) -> RecallResult: ...

    @overload
    async def search(self, *, query: str, **opts: Unpack[RecallOptions]) -> RecallResult: ...

    async def search(self, *args: Any, **opts: Any) -> RecallResult:
        """Look up relevant memory. result["context"] is the prompt-ready block."""
        return cast(RecallResult, await self._adrive(self._plan_search(*args, **opts)))

    recall = search

    async def graph(self, *, user_id: Optional[str] = _USER_ID_DEFAULT) -> Dict[str, Any]:
        return cast(Dict[str, Any], await self._adrive(self._plan_graph(user_id=user_id)))

    async def status(self, *, user_id: Optional[str] = _USER_ID_DEFAULT) -> Dict[str, Any]:
        return cast(Dict[str, Any], await self._adrive(self._plan_status(user_id=user_id)))

    async def receipts(
        self,
        limit: int = 50,
        *,
        user_id: Optional[str] = _USER_ID_DEFAULT,
    ) -> ReceiptsResult:
        return cast(ReceiptsResult, await self._adrive(self._plan_receipts(limit, user_id=user_id)))

    async def usage(
        self,
        range: UsageRange = "30d",
        *,
        user_id: Optional[str] = _USER_ID_DEFAULT,
    ) -> Dict[str, Any]:
        return cast(Dict[str, Any], await self._adrive(self._plan_usage(range, user_id=user_id)))

    async def get_rules(self, *, user_id: Optional[str] = _USER_ID_DEFAULT) -> Dict[str, Any]:
        return cast(Dict[str, Any], await self._adrive(self._plan_get_rules(user_id=user_id)))

    async def set_rules(
        self,
        rules: MemoryRules,
        *,
        user_id: Optional[str] = _USER_ID_DEFAULT,
    ) -> Dict[str, Any]:
        return cast(Dict[str, Any], await self._adrive(self._plan_set_rules(rules, user_id=user_id)))

    async def export_all(self, *, user_id: Optional[str] = _USER_ID_DEFAULT) -> Dict[str, Any]:
        return cast(Dict[str, Any], await self._adrive(self._plan_export_all(user_id=user_id)))

    async def list_memories(
        self,
        *,
        kind: Optional[str] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
        q: Optional[str] = None,
        user_id: Optional[str] = _USER_ID_DEFAULT,
    ) -> Dict[str, Any]:
        """Browse stored memories, newest first. Cursor-paginated."""
        return cast(Dict[str, Any], await self._adrive(
            self._plan_list_memories(kind=kind, limit=limit, cursor=cursor, q=q, user_id=user_id)
        ))

    async def get_memory(
        self,
        memory_id: str,
        *,
        user_id: Optional[str] = _USER_ID_DEFAULT,
    ) -> Dict[str, Any]:
        """Fetch one stored memory by id, with its slices and dated events."""
        return cast(Dict[str, Any], await self._adrive(
            self._plan_get_memory(memory_id, user_id=user_id)
        ))

    async def delete(
        self,
        memory_id: str,
        *,
        user_id: Optional[str] = _USER_ID_DEFAULT,
    ) -> DeleteResult:
        """Delete one memory object (node_/page_/slice_/candidate_ id)."""
        return cast(DeleteResult, await self._adrive(
            self._plan_delete(memory_id, user_id=user_id)
        ))

    async def delete_by_source(
        self,
        source: Optional[str] = None,
        before: Optional[float] = None,
        after: Optional[float] = None,
        confirm: bool = False,
        *,
        user_id: Optional[str] = _USER_ID_DEFAULT,
    ) -> DeleteResult:
        """Bulk delete by source lane and/or time window.

        SAFE BY DEFAULT: without ``confirm=True`` this is a dry run that only
        reports what would go.
        """
        return cast(DeleteResult, await self._adrive(
            self._plan_delete_by_source(source, before, after, confirm, user_id=user_id)
        ))

    async def packet_status(
        self,
        source_packet_id: str,
        *,
        user_id: Optional[str] = _USER_ID_DEFAULT,
    ) -> PacketStatus:
        """Background-processing status for one accepted write, by packet id."""
        return cast(PacketStatus, await self._adrive(
            self._plan_packet_status(source_packet_id, user_id=user_id)
        ))

    async def jobs(
        self,
        status: Optional[JobStatus] = None,
        since: Optional[float] = None,
        limit: Optional[int] = None,
        *,
        user_id: Optional[str] = _USER_ID_DEFAULT,
    ) -> JobsResult:
        """The jobs ledger: every accepted write and where it is."""
        return cast(JobsResult, await self._adrive(
            self._plan_jobs(status, since, limit, user_id=user_id)
        ))

    async def wait_for(
        self,
        source_packet_id: str,
        timeout: float = 60.0,
        interval: float = 1.5,
        *,
        user_id: Optional[str] = _USER_ID_DEFAULT,
    ) -> Union[PacketStatus, TimedOutPacketStatus]:
        """Wait for an accepted write to finish background processing.

        Polls until a terminal status or the timeout, then returns the last
        seen status with ``timed_out: True`` — never an exception. The wait
        yields to the event loop between polls, so it never blocks a host's
        other work::

            receipt = await memory.ingest(messages, flush=True)
            done = await memory.wait_for(receipt["source_packet_id"])
        """
        return cast(Union[PacketStatus, TimedOutPacketStatus], await self._adrive(
            self._plan_wait_for(source_packet_id, timeout, interval, user_id=user_id)
        ))

    # --------------------------------------------------------- lifecycle
    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "AsyncMemoryClient":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.aclose()

    # ---------------------------------------------------------- driver
    async def _aperform(self, send: _Send) -> _Outcome:
        try:
            res = await self._client.request(
                send.method,
                send.path,
                params=send.params,
                json=send.body,
                timeout=send.timeout,
            )
        except httpx.TimeoutException:
            return _timed_out(send.timeout)
        except httpx.HTTPError as exc:
            return _transport_failed(exc)
        except (TypeError, ValueError, OverflowError) as exc:
            raise _argument_error("request body must be JSON-serializable") from exc
        return _read_response(res)

    async def _adrive(self, plan: _Plan) -> Any:
        outcome: Optional[_Outcome] = None
        try:
            while True:
                try:
                    action = plan.send(outcome)
                except StopIteration as stop:
                    return stop.value
                if isinstance(action, _Sleep):
                    # asyncio.sleep, never time.sleep: a backoff that blocks the
                    # loop would stall every other task in the host process.
                    if action.seconds > 0:
                        await asyncio.sleep(action.seconds)
                    outcome = None
                else:
                    outcome = await self._aperform(action)
        finally:
            plan.close()


Memory = MemoryClient
AsyncMemory = AsyncMemoryClient
