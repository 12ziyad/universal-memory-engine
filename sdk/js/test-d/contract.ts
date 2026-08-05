import MemoryClient, {
	Memory,
	MemoryAPIError,
	type JobStatus,
	type MemoryMessage,
	type PacketStatusResult,
	type RecallResult,
	VERSION,
} from "../index.js";

const client = new MemoryClient({
	apiKey: "itsuki_live_type_test",
	userId: "ada",
	timeoutMs: 10_000,
	maxRetries: 1,
});

const messages: MemoryMessage[] = [
	{ id: "m1", role: "user", content: "Remember Atlas." },
	{ id: "m2", role: "assistant", content: "Atlas deploys from main." },
];

const captureEvidence = {
	schema: "itsuki.capture-evidence/v1" as const,
	inputRows: 1,
	capturedEvents: 1,
	returnedEvents: 1,
	omittedEvents: 0,
	malformedRows: 0,
	ineligibleRows: 0,
	ignoredThinkingBlocks: 0,
	ignoredMetaRows: 0,
	ignoredToolEvents: 0,
	ignoredRecallEvents: 0,
	ignoredRecallEchoEvents: 0,
	ignoredUnprotectedAssistantEvents: 0,
	ignoredNoiseEvents: 0,
	ambiguousOutcomeRows: 0,
	companionLimitRejectedOutcomeRows: 0,
	closureEventLimitRejectedOutcomeRows: 0,
	truncatedEvents: 0,
	redactions: {},
	tailReturnedRecords: 1,
	tailScannedBytes: 100,
	tailOversizedLines: 0,
	tailMalformedLines: 0,
	tailIneligibleLines: 0,
	tailEmptyLines: 0,
};

async function contract(): Promise<void> {
	const receipt = await client.add("Atlas deploys from main.", {
		userId: "ada",
		memoryScope: { projectId: "atlas", projectName: "Atlas" },
		contentScope: { subject: "Atlas", includeAssistantFacts: false },
		idempotencyKey: client.newIdempotencyKey(),
	});
	await client.addConversation(messages, { conversationId: "conv-1" });
	await client.turn(messages, { query: "How does Atlas deploy?" });
	await client.ingest(messages, {
		flush: true,
		delivery: {
			schema: "itsuki.ingest.delivery/v1",
			groupId: "claude_delivery_v1_0000000000000000000000000000000000000000",
			batchIndex: 0,
			batchCount: 1,
			sourceMessageCount: 2,
			segmentCount: 2,
			splitSourceMessages: 0,
			captureTruncated: false,
			captureEvidence,
		},
	});

	const recalled: RecallResult = await client.recall("How does Atlas deploy?", {
		recallScope: "project_then_global",
		memoryScope: { projectId: "atlas" },
	});
	const packet: PacketStatusResult = await client.packetStatus(receipt.source_packet_id ?? "src_pending");
	const status: JobStatus = packet.status;
	await client.jobs({ status, userId: null });
	await client.waitFor(packet.source_packet_id ?? "src_pending", { timeoutMs: 0, intervalMs: 1 });
	await client.delete("slice_123", { userId: "ada" });
	await client.deleteBySource({ source: "ingest", after: Date.now() - 60_000 });
	await client.graph({ userId: null });
	await client.setRules({ autoCollect: true }, { userId: "ada" });
	void recalled.context;
}

void contract;
void Memory;
void MemoryAPIError;
void VERSION;

// @ts-expect-error JavaScript uses userId; a snake_case typo must not type-check.
client.status({ user_id: "ada" });
// @ts-expect-error unsupported terminal/job status
client.jobs({ status: "done" });
// @ts-expect-error delete requires a string memory id
client.delete(123);
