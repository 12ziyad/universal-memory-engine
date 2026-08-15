"""Static public-surface contract; checked with mypy --strict, never executed."""

from typing import List, Union

from itsuki import (
    APIResponse,
    AsyncMemoryClient,
    CaptureEvidence,
    CommandResult,
    DeleteResult,
    JobsResult,
    MemoryAPIError,
    MemoryClient,
    MemoryMessage,
    PacketStatusResult,
    RecallResult,
    ReceiptsResult,
    TimedOutPacketStatus,
    TurnResult,
)


CAPTURE_EVIDENCE: CaptureEvidence = {
    "schema": "itsuki.capture-evidence/v1",
    "inputRows": 1,
    "capturedEvents": 1,
    "returnedEvents": 1,
    "omittedEvents": 0,
    "malformedRows": 0,
    "ineligibleRows": 0,
    "ignoredThinkingBlocks": 0,
    "ignoredMetaRows": 0,
    "ignoredToolEvents": 0,
    "ignoredRecallEvents": 0,
    "ignoredRecallEchoEvents": 0,
    "ignoredUnprotectedAssistantEvents": 0,
    "ignoredNoiseEvents": 0,
    "ambiguousOutcomeRows": 0,
    "companionLimitRejectedOutcomeRows": 0,
    "closureEventLimitRejectedOutcomeRows": 0,
    "truncatedEvents": 0,
    "redactions": {},
    "tailReturnedRecords": 1,
    "tailScannedBytes": 100,
    "tailOversizedLines": 0,
    "tailMalformedLines": 0,
    "tailIneligibleLines": 0,
    "tailEmptyLines": 0,
}


def check_client_contract(client: MemoryClient, messages: List[MemoryMessage]) -> None:
    command: CommandResult = client.add("fact")
    command = client.add(content="fact")
    command = client.add(messages=messages)
    command = client.add_conversation(messages)
    command = client.add_conversation(messages=messages)
    command = client.ingest([], delivery={
        "schema": "itsuki.ingest.delivery/v1",
        "groupId": "claude_delivery_v1_0000000000000000000000000000000000000000",
        "batchIndex": 0,
        "batchCount": 1,
        "sourceMessageCount": 1,
        "segmentCount": 1,
        "splitSourceMessages": 0,
        "captureTruncated": False,
        "captureEvidence": CAPTURE_EVIDENCE,
    })
    recalled: RecallResult = client.search("fact")
    recalled = client.search(query="fact")
    turn: TurnResult = client.turn(messages)
    turn = client.turn(messages=[], query="fact")
    receipts: ReceiptsResult = client.receipts(limit=10, user_id=None)
    jobs: JobsResult = client.jobs(status="processing", since=1, limit=10, user_id=None)
    packet: PacketStatusResult = client.packet_status("packet-1", user_id=None)
    waited: Union[PacketStatusResult, TimedOutPacketStatus] = client.wait_for(
        "packet-1", user_id=None
    )
    deleted: DeleteResult = client.delete("node-1", user_id=None)
    deleted = client.delete_by_source(source="ingest", before=1, confirm=False, user_id=None)
    generic: APIResponse = client.status(user_id=None)

    # Strict consumers must not silently accept misspelled write options.
    client.add("fact", idempotency_keey="typo")  # type: ignore[call-overload]

    check_error_contract()

    # Keep all assignments live for strict unused-variable linters/type checkers.
    print(command, recalled, turn, receipts, jobs, packet, waited, deleted, generic)


async def check_async_client_contract(
    client: AsyncMemoryClient, messages: List[MemoryMessage]
) -> None:
    """The async surface must type-check exactly like the sync one, awaited."""
    command: CommandResult = await client.add("fact")
    command = await client.add(content="fact")
    command = await client.add(messages=messages)
    command = await client.add_conversation(messages)
    command = await client.add_conversation(messages=messages)
    command = await client.ingest([])
    recalled: RecallResult = await client.search("fact")
    recalled = await client.search(query="fact")
    turn: TurnResult = await client.turn(messages)
    turn = await client.turn(messages=[], query="fact")
    receipts: ReceiptsResult = await client.receipts(limit=10, user_id=None)
    jobs: JobsResult = await client.jobs(status="processing", since=1, limit=10, user_id=None)
    packet: PacketStatusResult = await client.packet_status("packet-1", user_id=None)
    waited: Union[PacketStatusResult, TimedOutPacketStatus] = await client.wait_for(
        "packet-1", user_id=None
    )
    deleted: DeleteResult = await client.delete("node-1", user_id=None)
    deleted = await client.delete_by_source(source="ingest", before=1, confirm=False, user_id=None)
    generic: APIResponse = await client.status(user_id=None)
    await client.aclose()

    # Strict consumers must not silently accept misspelled write options.
    await client.add("fact", idempotency_keey="typo")  # type: ignore[call-overload]

    print(command, recalled, turn, receipts, jobs, packet, waited, deleted, generic)


def check_error_contract() -> None:
    error = MemoryAPIError("failure", status=503, code="busy", retry_after=1.5)
    status: int = error.status
    code: Union[str, None] = error.code
    body: object = error.body
    retry_after: Union[float, None] = error.retry_after

    # Keep all assignments live for strict unused-variable linters/type checkers.
    print(status, code, body, retry_after)
