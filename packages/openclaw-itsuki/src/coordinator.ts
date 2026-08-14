/**
 * The host-neutral lifecycle coordinator.
 *
 * Nothing here knows what OpenClaw is. It answers two questions — "what should
 * I inject before this turn?" and "what should I persist after it?" — and owns
 * the failure policy for both. The policy is identical to the published
 * pi-itsuki adapter, and the shared corpus pins both to it:
 *
 *   Recall fails OPEN. A memory outage must never become an agent outage, so a
 *   failed or slow recall injects nothing and the turn proceeds untouched.
 *
 *   Capture fails OPEN toward the host and LOUD toward the data. The turn is
 *   never blocked, but a span that cannot be delivered is spooled durably and,
 *   if it is ever genuinely lost, counted and reported.
 */

import { planBatches } from "./batching.js";
import { type ErrorClass, ItsukiError } from "./errors.js";
import { type CaptureMessage, type CaptureScope, captureIdentity } from "./identity.js";
import { echoFingerprints, formatRecallBlock, suppressEchoLines, truncateToCodePoints } from "./inject.js";
import { scrubText } from "./scrub.js";
import { SPOOL_LIMITS, SPOOL_SCHEMA, type Spool, type SpoolEnvelope } from "./spool.js";
import type { ItsukiTransport } from "./transport.js";

const BREAKER_THRESHOLD = 3;
const BREAKER_OPEN_MS = 60_000;
/** Auth failures do not heal on a timer; they heal when the operator fixes the key. */
const BREAKER_AUTH_OPEN_MS = 10 * 60_000;

/** Classes where redelivery can never succeed — keeping them would spin forever. */
const TERMINAL_CLASSES: ReadonlySet<ErrorClass> = new Set<ErrorClass>([
	"invalid",
	"too_large",
	"conflict",
	"not_found",
	"confirmation",
]);
/** Classes where the payload is fine and only the moment is wrong. */
const HOLD_CLASSES: ReadonlySet<ErrorClass> = new Set<ErrorClass>(["auth", "quota"]);

export interface CoordinatorOptions {
	transport: ItsukiTransport;
	spool: Spool;
	recall: { enabled: boolean; maxItems: number; maxChars: number; timeoutMs: number };
	capture: { enabled: boolean; timeoutMs: number };
	now?: () => number;
	log?: (line: string) => void;
}

export interface RecallOutcome {
	block: string | null;
	status: "injected" | "empty" | "disabled" | "breaker_open" | "failed";
	count: number;
	/** Fingerprints of what was injected, for the caller to persist per session. */
	fingerprints: string[];
	code?: ErrorClass;
	detail?: string;
}

export interface StageOutcome {
	status: "staged" | "empty" | "disabled";
	batches: number;
	idempotencyKeys: string[];
}

export interface HealthReport {
	breaker: { open: boolean; until: number | null; failures: number; reason: ErrorClass | null };
	spool: { depth: number; dropped: number };
	lastReceiptId: string | null;
	lastError: { code: ErrorClass; message: string; description: string } | null;
	terminalFailures: number;
}

export class Coordinator {
	private readonly transport: ItsukiTransport;
	private readonly spool: Spool;
	private readonly recallConfig: CoordinatorOptions["recall"];
	private readonly captureConfig: CoordinatorOptions["capture"];
	private readonly now: () => number;
	private readonly log: (line: string) => void;

	private failures = 0;
	private openUntil = 0;
	private breakerReason: ErrorClass | null = null;
	private lastError: HealthReport["lastError"] = null;
	private lastReceiptId: string | null = null;
	private terminalFailures = 0;
	private draining = false;

	constructor(options: CoordinatorOptions) {
		this.transport = options.transport;
		this.spool = options.spool;
		this.recallConfig = options.recall;
		this.captureConfig = options.capture;
		this.now = options.now ?? Date.now;
		this.log = options.log ?? (() => {});
	}

	private breakerOpen(): boolean {
		return this.now() < this.openUntil;
	}

	private recordSuccess(): void {
		this.failures = 0;
		this.openUntil = 0;
		this.breakerReason = null;
	}

	private recordFailure(error: unknown): ItsukiError {
		const mapped = error instanceof ItsukiError
			? error
			: new ItsukiError(
				{
					message: "Unexpected adapter failure",
					description: this.transport.redact(String((error as Error)?.message ?? error)),
					errorClass: "unknown",
					retriable: false,
				},
				0,
			);
		if (mapped.errorClass === "cancelled") return mapped;
		this.lastError = { code: mapped.errorClass, message: mapped.message, description: mapped.description };
		this.failures += 1;
		if (mapped.errorClass === "auth") {
			this.openUntil = this.now() + BREAKER_AUTH_OPEN_MS;
			this.breakerReason = "auth";
		} else if (this.failures >= BREAKER_THRESHOLD) {
			this.openUntil = this.now() + BREAKER_OPEN_MS;
			this.breakerReason = mapped.errorClass;
		}
		return mapped;
	}

	/**
	 * Bounded pre-turn recall. Never throws; the turn always proceeds.
	 *
	 * Unlike the Pi adapter, echo fingerprints are RETURNED rather than held in
	 * memory: OpenClaw sessions outlive the process and are keyed by session,
	 * so the caller persists them per session and hands them back on the way in.
	 */
	async recall(
		query: string,
		scope: CaptureScope,
		options: { echoKey: string | null; signal?: AbortSignal } = { echoKey: null },
	): Promise<RecallOutcome> {
		if (!this.recallConfig.enabled) return { block: null, status: "disabled", count: 0, fingerprints: [] };
		const trimmed = String(query ?? "").trim();
		if (!trimmed) return { block: null, status: "empty", count: 0, fingerprints: [] };
		if (this.breakerOpen()) {
			this.log("itsuki recall skip code=breaker_open");
			return {
				block: null,
				status: "breaker_open",
				count: 0,
				fingerprints: [],
				code: this.breakerReason ?? "unknown",
			};
		}

		const started = this.now();
		try {
			const response = await this.transport.recall(truncateToCodePoints(trimmed, 2_000), {
				limit: this.recallConfig.maxItems,
				userId: scope.userId,
				timeoutMs: this.recallConfig.timeoutMs,
				signal: options.signal,
			});
			this.recordSuccess();
			const count = Number(response["count"] ?? 0);
			const context = response["context"];
			const block = formatRecallBlock(context, this.recallConfig.maxChars);
			const fingerprints = block && options.echoKey
				? [...echoFingerprints(String(context ?? ""), options.echoKey)]
				: [];
			this.log(`itsuki recall ok count=${count} ms=${this.now() - started}`);
			return block
				? { block, status: "injected", count, fingerprints }
				: { block: null, status: "empty", count, fingerprints: [] };
		} catch (error) {
			const mapped = this.recordFailure(error);
			this.log(`itsuki recall fail code=${mapped.errorClass} ms=${this.now() - started}`);
			return {
				block: null,
				status: mapped.errorClass === "cancelled" ? "empty" : "failed",
				count: 0,
				fingerprints: [],
				code: mapped.errorClass,
				detail: mapped.message,
			};
		}
	}

	/** Scrub + echo-suppress one message's text, against this session's fingerprints. */
	makeTransform(fingerprints: Set<string>, echoKey: string | null) {
		return (text: string, _role: "user" | "assistant"): string => {
			const scrubbed = scrubText(text).text;
			return echoKey ? suppressEchoLines(scrubbed, fingerprints, echoKey) : scrubbed;
		};
	}

	/**
	 * Take durable ownership of a span. No network, so this cannot fail halfway
	 * across a wire. The caller must advance its watermark between this and
	 * `drain()`.
	 */
	async stage(messages: CaptureMessage[], scope: CaptureScope): Promise<StageOutcome> {
		if (!this.captureConfig.enabled) return { status: "disabled", batches: 0, idempotencyKeys: [] };
		if (messages.length === 0) return { status: "empty", batches: 0, idempotencyKeys: [] };

		const batches = planBatches(messages);
		if (batches.length === 0) return { status: "empty", batches: 0, idempotencyKeys: [] };

		const idempotencyKeys: string[] = [];
		for (const batch of batches) {
			const idempotencyKey = captureIdentity(scope, batch);
			idempotencyKeys.push(idempotencyKey);
			const envelope: SpoolEnvelope = {
				schema: SPOOL_SCHEMA,
				idempotencyKey,
				messages: batch,
				scope: {
					userId: scope.userId ?? null,
					conversationId: scope.conversationId ?? null,
					source: scope.source,
				},
				createdAt: new Date(this.now()).toISOString(),
				attempts: 0,
			};
			await this.spool.enqueue(envelope);
		}
		return { status: "staged", batches: batches.length, idempotencyKeys };
	}

	/** Deliver spooled envelopes, bounded per pass. Never throws. */
	async drain(signal?: AbortSignal): Promise<{ delivered: number; terminal: number; lastSourcePacketId: string | null }> {
		if (this.draining) return { delivered: 0, terminal: 0, lastSourcePacketId: null };
		this.draining = true;
		let delivered = 0;
		let terminal = 0;
		let lastSourcePacketId: string | null = null;
		try {
			if (this.breakerOpen()) return { delivered, terminal, lastSourcePacketId };
			const pending = await this.spool.list();
			for (const { name, envelope } of pending.slice(0, SPOOL_LIMITS.maxDrainPerPass)) {
				if (signal?.aborted) break;
				if (this.breakerOpen()) break;
				try {
					const response = await this.transport.saveConversation(envelope.messages, {
						idempotencyKey: envelope.idempotencyKey,
						userId: envelope.scope.userId ?? undefined,
						conversationId: envelope.scope.conversationId ?? undefined,
						sourceId: envelope.scope.source,
						timeoutMs: this.captureConfig.timeoutMs,
						signal,
					});
					this.recordSuccess();
					await this.spool.remove(name);
					delivered += 1;
					const receiptId = response["receipt_id"];
					const packetId = response["source_packet_id"];
					if (typeof receiptId === "string") this.lastReceiptId = receiptId;
					if (typeof packetId === "string") lastSourcePacketId = packetId;
					this.log(`itsuki capture ok receipt=${typeof receiptId === "string" ? receiptId : "none"}`);
				} catch (error) {
					const mapped = this.recordFailure(error);
					if (mapped.errorClass === "cancelled") break;
					if (TERMINAL_CLASSES.has(mapped.errorClass)) {
						// This payload will never be accepted. Remove it, but count
						// it as a real loss rather than pretending it was saved.
						await this.spool.remove(name);
						this.terminalFailures += 1;
						terminal += 1;
						this.log(`itsuki capture drop code=${mapped.errorClass}`);
						continue;
					}
					await this.spool.update(name, {
						...envelope,
						attempts: envelope.attempts + 1,
						lastErrorCode: mapped.errorClass,
					});
					this.log(`itsuki capture hold code=${mapped.errorClass} attempts=${envelope.attempts + 1}`);
					if (HOLD_CLASSES.has(mapped.errorClass)) break;
				}
			}
			return { delivered, terminal, lastSourcePacketId };
		} finally {
			this.draining = false;
		}
	}

	async health(): Promise<HealthReport> {
		const stats = await this.spool.stats();
		return {
			breaker: {
				open: this.breakerOpen(),
				until: this.breakerOpen() ? this.openUntil : null,
				failures: this.failures,
				reason: this.breakerReason,
			},
			spool: stats,
			lastReceiptId: this.lastReceiptId,
			lastError: this.lastError,
			terminalFailures: this.terminalFailures,
		};
	}
}
