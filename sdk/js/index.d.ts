export const VERSION: "0.2.1";

export type UserId = string | null;
export type RecallScope = "global" | "project_only" | "project_then_global";
export type CaptureDensity = "standard" | "dense";
export type MessageRole = "user" | "assistant" | "system" | "tool";
export type SourceEventKind =
	| "user_prompt"
	| "assistant_prose"
	| "tool_call"
	| "tool_result"
	| "command_result"
	| "file_change"
	| "test_result"
	| "git_commit"
	| "deployment_result"
	| "error"
	| "plan"
	| "decision"
	| "architecture_decision"
	| "bug_fix"
	| "user_preference"
	| "unresolved_issue";
export type SourceEventOutcome = "success" | "failure" | "partial" | "skipped" | "unknown";
export type JobStatus = "queued" | "staged" | "processing" | "enriched" | "failed" | "completed";
export type TerminalJobStatus = "enriched" | "failed" | "completed";
export type UsageRange = "1d" | "7d" | "30d" | "all";

export interface MemoryClientOptions {
	apiKey: string;
	baseUrl?: string;
	userId?: UserId;
	/** Total milliseconds allowed for one request, including retry backoff and attempts. */
	timeoutMs?: number;
	/** Retry count for reads and writes carrying an idempotency key (0 through 10). */
	maxRetries?: number;
}

export interface ScopeOptions {
	/**
	 * Select an isolated end-user memory space for this call. `null` explicitly
	 * selects the API-key owner's root space, even when the client has a default.
	 */
	userId?: UserId;
}

export interface MemoryScope {
	projectId?: string | null;
	projectName?: string | null;
	workspaceId?: string | null;
	appId?: string | null;
	[key: string]: unknown;
}

export interface ContentScope {
	subject?: string;
	topic?: string;
	speakerScope?: string;
	speaker_scope?: string;
	includeAssistantFacts?: boolean;
	include_assistant_facts?: boolean;
	excludeOtherPeople?: boolean;
	exclude_other_people?: boolean;
}

export interface SourceEvent {
	schema: "itsuki.source-event/v1";
	kind: SourceEventKind;
	event_id?: string;
	parent_event_id?: string;
	tool_name?: string;
	outcome?: SourceEventOutcome;
	exit_code?: number;
	sequence?: number;
	truncated?: boolean;
	[key: string]: unknown;
}

export interface MemoryMessageObject {
	content: string;
	role?: MessageRole;
	id?: string;
	ts?: number | string;
	source_event?: SourceEvent;
	sourceEvent?: SourceEvent;
	[key: string]: unknown;
}

export type MemoryMessage = string | MemoryMessageObject;

export interface MemoryRules {
	autoCollect?: boolean;
	captureDefault?: "auto" | "graph_only";
	captureDensity?: CaptureDensity;
	customInstructions?: string;
	includes?: string[];
	excludes?: string[];
	customCategories?: Array<{ name: string; description?: string }>;
	retentionDays?: number | null;
	[key: string]: unknown;
}

export interface CommonMemoryOptions extends ScopeOptions {
	memoryScope?: MemoryScope;
	sourceScope?: MemoryScope;
	conversationId?: string;
	threadId?: string;
	sourceId?: string;
	idempotencyKey?: string;
	source?: string;
	captureDensity?: CaptureDensity;
	rules?: MemoryRules;
}

export interface AddOptions extends CommonMemoryOptions {
	scope?: "full" | "lastN" | "topic" | "summary";
	n?: number;
	topic?: string;
	recentContext?: string;
	contentScope?: ContentScope;
}

export interface AddConversationOptions extends AddOptions {}

export interface SearchOptions extends CommonMemoryOptions {
	topic?: string;
	limit?: number;
	recallScope?: RecallScope;
}

export interface TurnOptions extends CommonMemoryOptions {
	query?: string;
	recallScope?: RecallScope;
}

export interface CaptureRedactions {
	private_key?: number;
	connection_credentials?: number;
	query_secret?: number;
	api_key?: number;
	bearer_token?: number;
	high_entropy?: number;
	named_secret?: number;
}

export interface CaptureEvidence {
	schema: "itsuki.capture-evidence/v1";
	inputRows: number;
	capturedEvents: number;
	returnedEvents: number;
	omittedEvents: number;
	malformedRows: number;
	ineligibleRows: number;
	ignoredThinkingBlocks: number;
	ignoredMetaRows: number;
	ignoredToolEvents: number;
	ignoredRecallEvents: number;
	ignoredRecallEchoEvents: number;
	ignoredUnprotectedAssistantEvents: number;
	ignoredNoiseEvents: number;
	ambiguousOutcomeRows: number;
	companionLimitRejectedOutcomeRows: number;
	closureEventLimitRejectedOutcomeRows: number;
	truncatedEvents: number;
	redactions: CaptureRedactions;
	tailReturnedRecords: number;
	tailScannedBytes: number;
	tailOversizedLines: number;
	tailMalformedLines: number;
	tailIneligibleLines: number;
	tailEmptyLines: number;
}

export interface IngestDelivery {
	schema: "itsuki.ingest.delivery/v1";
	groupId: string;
	batchIndex: number;
	batchCount: number;
	sourceMessageCount: number;
	segmentCount: number;
	splitSourceMessages: number;
	captureTruncated: boolean;
	truncationReason?: string | null;
	captureEvidence?: CaptureEvidence;
}

export interface IngestOptions extends CommonMemoryOptions {
	flush?: boolean;
	delivery?: IngestDelivery;
}

export interface MemoryScopeResult {
	project_id: string | null;
	project_name: string | null;
	workspace_id?: string | null;
	app_id?: string | null;
	source_scope?: string | null;
}

export interface ReceiptCounts {
	received?: number | null;
	held?: number | null;
	skipped?: number;
	savedTotal?: number;
	pages?: number;
	nodes?: number;
	slices?: number;
	events?: number;
	edges?: number;
	candidates?: number;
	items?: number;
	[key: string]: number | null | undefined;
}

export interface APIResponse {
	[key: string]: unknown;
}

export interface CommandResult extends APIResponse {
	ok: boolean;
	command_mode?: string;
	mode?: string;
	source?: string;
	fired?: boolean;
	processing?: boolean;
	summary?: string;
	source_packet_id?: string | null;
	receipt_id?: string | null;
	receipt?: APIResponse | null;
	counts?: ReceiptCounts;
	memory_scope?: MemoryScopeResult;
	job_id?: string;
	duplicate?: boolean;
}

export interface RecallResult extends CommandResult {
	context?: string;
	count?: number;
	items?: unknown[];
	nodes?: unknown[];
	pages?: unknown[];
	recall_scope?: RecallScope;
}

export interface TurnResult extends APIResponse {
	ok: boolean;
	recall: Partial<RecallResult> & { count?: number; summary?: string; packet?: unknown };
	collect: Partial<CommandResult> & { enabled: boolean };
	rules: { autoCollect: boolean; captureDefault: "auto" | "graph_only" };
}

export interface JobCounts {
	nodes: number;
	edges: number;
	slices: number;
	events: number;
	pages: number;
}

export interface MemoryJob extends APIResponse {
	job_id: string;
	source_packet_id: string | null;
	status: JobStatus;
	type: string;
	lane: string | null;
	project_id: string | null;
	project_name: string | null;
	delivery: IngestDelivery | null;
	attempts: number;
	created_at: number;
	updated_at: number;
	completed_at: number | null;
	receipt_id: string | null;
	counts: JobCounts;
	remaining_messages: number | null;
	error?: string;
}

export interface PacketStatusResult extends MemoryJob {
	ok: true;
}

export interface TimedOutPacketStatus extends Omit<Partial<PacketStatusResult>, "status"> {
	status: JobStatus | "unknown";
	timed_out: true;
}

export interface JobsResult extends APIResponse {
	ok: true;
	jobs: MemoryJob[];
	count: number;
}

export interface ReceiptsResult extends APIResponse {
	receipts: APIResponse[];
}

export interface DeleteResult extends APIResponse {
	ok?: boolean;
	deleted?: boolean | Record<string, number>;
	dry_run?: boolean;
	would_delete?: Record<string, number>;
}

export interface ReceiptsOptions extends ScopeOptions {
	limit?: number;
}

export interface UsageOptions extends ScopeOptions {
	range?: UsageRange;
}

export interface JobsOptions extends ScopeOptions {
	status?: JobStatus;
	since?: number;
	limit?: number;
}

export interface DeleteBySourceOptions extends ScopeOptions {
	source?: string;
	before?: number;
	after?: number;
	confirm?: boolean;
}

export interface WaitForOptions extends ScopeOptions {
	timeoutMs?: number;
	intervalMs?: number;
}

export class MemoryAPIError extends Error {
	constructor(message: string, options?: {
		status?: number;
		code?: string | null;
		body?: unknown;
		retryAfterMs?: number | null;
		cause?: unknown;
	});
	status: number;
	code: string | null;
	body: unknown;
	retryAfterMs: number | null;
}

export class MemoryClient {
	constructor(options: MemoryClientOptions);

	readonly apiKey: string;
	readonly baseUrl: string;
	readonly userId: UserId;
	readonly timeoutMs: number;
	readonly maxRetries: number;

	add(content: string, options?: AddOptions): Promise<CommandResult>;
	save(content: string, options?: AddOptions): Promise<CommandResult>;
	addConversation(messages: MemoryMessage[], options?: AddConversationOptions): Promise<CommandResult>;
	search(query: string, options?: SearchOptions): Promise<RecallResult>;
	recall(query: string, options?: SearchOptions): Promise<RecallResult>;
	turn(messages: MemoryMessage[], options?: TurnOptions): Promise<TurnResult>;
	ingest(messages: MemoryMessage[], options?: IngestOptions): Promise<CommandResult>;

	graph(options?: ScopeOptions): Promise<APIResponse>;
	status(options?: ScopeOptions): Promise<APIResponse>;
	receipts(options?: ReceiptsOptions): Promise<ReceiptsResult>;
	usage(options?: UsageOptions): Promise<APIResponse>;
	getRules(options?: ScopeOptions): Promise<{ ok?: boolean; rules: MemoryRules } & APIResponse>;
	setRules(rules: MemoryRules, options?: ScopeOptions): Promise<{ ok: boolean; rules: MemoryRules } & APIResponse>;
	exportAll(options?: ScopeOptions): Promise<APIResponse>;

	delete(memoryId: string, options?: ScopeOptions): Promise<DeleteResult>;
	deleteBySource(options?: DeleteBySourceOptions): Promise<DeleteResult>;
	packetStatus(sourcePacketId: string, options?: ScopeOptions): Promise<PacketStatusResult>;
	jobs(options?: JobsOptions): Promise<JobsResult>;
	waitFor(sourcePacketId: string, options?: WaitForOptions): Promise<PacketStatusResult | TimedOutPacketStatus>;

	static newIdempotencyKey(): string;
	newIdempotencyKey(): string;
}

export const Memory: typeof MemoryClient;
export default MemoryClient;
