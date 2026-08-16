/**
 * The host-neutral lifecycle coordinator.
 *
 * Nothing in this file knows what OpenCode is. It answers two questions —
 * "what should I inject before this turn?" and "what should I persist after
 * it?" — and owns the failure policy for both:
 *
 *   Recall fails OPEN. A memory outage must never become an agent outage, so a
 *   failed or slow recall injects nothing and the turn proceeds untouched.
 *
 *   Capture fails OPEN toward the host and LOUD toward the data. Staging is
 *   local, atomic and synchronous-ish; delivery is a separate, resumable step.
 *   Nothing is ever reported as saved without a receipt.
 */

import { computeBackoffMs, type ErrorClass, ItsukiError } from "./kernel/errors.js";
import { emit, type EventHook, SKIP_REASONS } from "./kernel/events.js";
import { captureIdempotencyKey } from "./kernel/idempotency.js";
import {
	echoFingerprints,
	echoSessionKey,
	formatRecallBlock,
	RECALL_CLOSE_MARKER,
	RECALL_OPEN_MARKER,
	RECALL_PREAMBLE,
	suppressEchoLines,
	truncateToCodePoints,
} from "./kernel/inject.js";
import { planBatches } from "./kernel/batching.js";
import { scrubText } from "./kernel/scrub.js";
import { ItsukiTransport } from "./kernel/transport.js";
import type { CaptureMessage, CaptureScope } from "./kernel/types.js";
import { Spool, SPOOL_SCHEMA, type SpoolEnvelope } from "./spool.js";

/**
 * Inventory output is memory content, so it is hostile data exactly like a
 * recall block: delimited, labelled and bounded before a model ever reads it.
 * Structural delimitation is not a guarantee that a model will treat embedded
 * text as inert — nothing can promise that — but unlabelled, unbounded content
 * is strictly worse, and the markers make an injection attempt visible.
 */
/**
 * Neutralise fence-escape attempts in stored content.
 *
 * A memory whose text contains our own closing marker would end the data
 * block early, so everything after it reads as ordinary prompt — a working
 * prompt-injection escape via poisoned memory. The kernel's formatter fences
 * but does not escape, and the kernel is not ours to change in this campaign,
 * so the payload is defanged here, before it is ever wrapped.
 *
 * Replacement (not deletion) keeps the attempt visible to a reader.
 */
export function defuseMarkers(text: string): string {
	return text
		.split(RECALL_CLOSE_MARKER)
		.join("<!itsuki-escaped-close!>")
		.split(RECALL_OPEN_MARKER)
		.join("<!itsuki-escaped-open!>");
}

function wrapAsData(body: string, maxChars: number): string {
	const truncated = truncateToCodePoints(body, Math.max(200, maxChars));
	const note = truncated.length < body.length ? "\n[truncated]" : "";
	return `${RECALL_OPEN_MARKER}\n${RECALL_PREAMBLE}\n${truncated}${note}\n${RECALL_CLOSE_MARKER}`;
}

function summariseList(payload: Record<string, unknown>): string {
	const items = Array.isArray(payload["items"]) ? (payload["items"] as Array<Record<string, unknown>>) : [];
	if (items.length === 0) return "No memories stored.";
	return items
		.map((item) => {
			const id = typeof item["id"] === "string" ? item["id"] : "?";
			const label = typeof item["label"] === "string" ? item["label"] : "";
			const summary = typeof item["summary"] === "string" ? item["summary"] : "";
			return `- ${id}${label ? ` — ${label}` : ""}${summary ? `: ${summary}` : ""}`;
		})
		.join("\n");
}

const BREAKER_THRESHOLD = 3;
const BREAKER_OPEN_MS = 60_000;
/** Auth failures do not heal on a timer; they heal when the operator fixes the key. */
const BREAKER_AUTH_OPEN_MS = 10 * 60_000;

/** Redelivery can never succeed for these — keeping them would spin forever. */
const TERMINAL_CLASSES: ReadonlySet<ErrorClass> = new Set<ErrorClass>([
	"invalid",
	"too_large",
	"conflict",
	"not_found",
	"confirmation",
]);
/** The payload is fine and only the moment is wrong: keep it, wait. */
const HOLD_CLASSES: ReadonlySet<ErrorClass> = new Set<ErrorClass>(["auth", "quota"]);

export interface CoordinatorOptions {
	transport: ItsukiTransport;
	spool: Spool;
	recall: { enabled: boolean; maxItems: number; maxChars: number; timeoutMs: number };
	capture: { enabled: boolean; timeoutMs: number; drainTimeoutMs: number };
	onEvent?: EventHook | undefined;
	now?: () => number;
}

export interface RecallOutcome {
	block: string | null;
	fingerprints: Set<string>;
	status: "injected" | "empty" | "disabled" | "breaker_open" | "failed";
	count: number;
	code?: ErrorClass;
}

export interface StageOutcome {
	status: "staged" | "empty" | "disabled" | "duplicate";
	batches: number;
	keys: string[];
}

export interface DrainOutcome {
	delivered: number;
	failed: number;
	remaining: number;
	lastReceiptId: string | null;
}

export interface HealthReport {
	breaker: { open: boolean; until: number | null; failures: number; reason: ErrorClass | null };
	spool: { depth: number; dropped: number; quarantined: number };
	lastReceiptId: string | null;
	lastError: { code: ErrorClass; message: string } | null;
	terminalFailures: number;
}

export class Coordinator {
	private readonly transport: ItsukiTransport;
	private readonly spool: Spool;
	private readonly recallConfig: CoordinatorOptions["recall"];
	private readonly captureConfig: CoordinatorOptions["capture"];
	private readonly onEvent: EventHook | undefined;
	private readonly now: () => number;

	private failures = 0;
	private breakerUntil: number | null = null;
	private breakerReason: ErrorClass | null = null;
	private lastReceiptId: string | null = null;
	private lastError: { code: ErrorClass; message: string } | null = null;
	private terminalFailures = 0;
	/** One in-flight drain at a time; concurrent drains double-deliver. */
	private draining: Promise<DrainOutcome> | null = null;

	constructor(options: CoordinatorOptions) {
		this.transport = options.transport;
		this.spool = options.spool;
		this.recallConfig = options.recall;
		this.captureConfig = options.capture;
		this.onEvent = options.onEvent;
		this.now = options.now ?? Date.now;
	}

	private breakerOpen(): boolean {
		if (this.breakerUntil === null) return false;
		if (this.now() >= this.breakerUntil) {
			this.breakerUntil = null;
			this.failures = 0;
			this.breakerReason = null;
			return false;
		}
		return true;
	}

	private noteFailure(code: ErrorClass, message: string): void {
		this.lastError = { code, message };
		if (TERMINAL_CLASSES.has(code)) {
			this.terminalFailures += 1;
			return;
		}
		this.failures += 1;
		if (this.failures >= BREAKER_THRESHOLD) {
			this.breakerReason = code;
			this.breakerUntil = this.now() + (HOLD_CLASSES.has(code) ? BREAKER_AUTH_OPEN_MS : BREAKER_OPEN_MS);
		}
	}

	private noteSuccess(): void {
		this.failures = 0;
		this.breakerUntil = null;
		this.breakerReason = null;
	}

	/**
	 * Bounded recall. The AbortController is ours because the host enforces no
	 * hook timeout at all, and a hook that never settles silently loses the
	 * user's prompt (opencode#39031).
	 */
	async recall(query: string, scope: CaptureScope): Promise<RecallOutcome> {
		const empty: RecallOutcome = { block: null, fingerprints: new Set(), status: "empty", count: 0 };
		if (!this.recallConfig.enabled) {
			emit(this.onEvent, { type: "recall.skipped", reason: SKIP_REASONS.disabled });
			return { ...empty, status: "disabled" };
		}
		const trimmed = query.trim();
		if (!trimmed) {
			emit(this.onEvent, { type: "recall.skipped", reason: SKIP_REASONS.emptyQuery });
			return empty;
		}
		if (this.breakerOpen()) {
			emit(this.onEvent, { type: "recall.skipped", reason: "breaker_open" });
			return { ...empty, status: "breaker_open" };
		}

		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let budgetTimer: ReturnType<typeof setTimeout> | undefined;
		const started = this.now();
		try {
			timer = setTimeout(() => controller.abort(), this.recallConfig.timeoutMs);
			const call = this.transport.recall(trimmed, {
				userId: scope.userId,
				limit: this.recallConfig.maxItems,
				projectId: scope.projectId,
				conversationId: scope.conversationId,
				timeoutMs: this.recallConfig.timeoutMs,
				signal: controller.signal,
			});
			// The abort signal is necessary but NOT sufficient: it only helps if
			// the transport (and whatever fetch it was handed) honours it. The
			// host enforces no hook timeout of its own and a hook that never
			// settles silently loses the user's prompt (opencode#39031), so the
			// budget is enforced here too, unconditionally.
			const budget = new Promise<never>((_resolve, reject) => {
				budgetTimer = setTimeout(
					() => reject(new ItsukiError(
						{ message: "Recall exceeded its budget", description: "The turn continued without memory.", errorClass: "timeout", retriable: true },
						0,
					)),
					this.recallConfig.timeoutMs + 100,
				);
			});
			const payload = await Promise.race([call, budget]);
			// A late-settling call must not leave a dangling rejection.
			void Promise.resolve(call).catch(() => undefined);
			const block = formatRecallBlock(defuseMarkers(String(payload["context"] ?? "")), this.recallConfig.maxChars);
			const rawCount = Number(payload["count"] ?? 0);
			const count = Number.isFinite(rawCount) ? rawCount : 0;
			const sessionKey = echoSessionKey(scope.conversationId ?? scope.userId ?? "");
			const fingerprints = block && sessionKey
				? echoFingerprints(String(payload["context"] ?? ""), sessionKey)
				: new Set<string>();
			this.noteSuccess();
			emit(this.onEvent, {
				type: "recall.ok",
				ms: this.now() - started,
				count,
				injectedChars: block ? block.length : 0,
			});
			return { block, fingerprints, status: block ? "injected" : "empty", count };
		} catch (error) {
			const code = error instanceof ItsukiError ? error.errorClass : "unknown";
			this.noteFailure(code, error instanceof Error ? error.message : "recall failed");
			emit(this.onEvent, { type: "recall.fail", ms: this.now() - started, errorClass: code });
			return { ...empty, status: "failed", code };
		} finally {
			if (timer) clearTimeout(timer);
			if (budgetTimer) clearTimeout(budgetTimer);
			controller.abort();
		}
	}

	/**
	 * Stage a settled span durably. This is the ONLY step that must complete
	 * before the host may kill us — hence no network here at all.
	 */
	stage(
		messages: CaptureMessage[],
		scope: CaptureScope,
		alreadyStaged: (key: string) => boolean,
	): StageOutcome {
		if (!this.captureConfig.enabled) {
			emit(this.onEvent, { type: "capture.skipped", reason: SKIP_REASONS.disabled });
			return { status: "disabled", batches: 0, keys: [] };
		}
		const scrubbed = messages
			.map((m) => ({ role: m.role, content: scrubText(m.content).text }))
			.filter((m) => m.content.trim().length > 0);
		if (scrubbed.length === 0) {
			emit(this.onEvent, { type: "capture.skipped", reason: SKIP_REASONS.nothingToCapture });
			return { status: "empty", batches: 0, keys: [] };
		}

		const batches = planBatches(scrubbed);
		const keys: string[] = [];
		let stagedAny = false;
		let duplicates = 0;

		for (let i = 0; i < batches.length; i += 1) {
			const batch = batches[i];
			if (!batch || batch.length === 0) continue;
			const discriminator = batches.length > 1 ? `batch:${i}/${batches.length}` : null;
			const key = captureIdempotencyKey({
				scope,
				messages: batch,
				discriminator: discriminator ?? undefined,
			});
			if (alreadyStaged(key)) {
				duplicates += 1;
				continue;
			}
			const envelope: SpoolEnvelope = {
				schema: SPOOL_SCHEMA,
				idempotencyKey: key,
				scope,
				messages: batch,
				discriminator,
				stagedAt: this.now(),
				attempts: 0,
			};
			if (this.spool.stage(envelope)) {
				keys.push(key);
				stagedAny = true;
			}
		}

		if (!stagedAny) {
			if (duplicates > 0) {
				emit(this.onEvent, { type: "capture.skipped", reason: SKIP_REASONS.duplicate });
				return { status: "duplicate", batches: 0, keys: [] };
			}
			emit(this.onEvent, { type: "capture.skipped", reason: SKIP_REASONS.nothingToCapture });
			return { status: "empty", batches: 0, keys: [] };
		}
		emit(this.onEvent, {
			type: "capture.staged",
			ms: 0,
			messages: scrubbed.length,
			batches: keys.length,
			packetId: null,
		});
		return { status: "staged", batches: keys.length, keys };
	}

	/**
	 * Deliver whatever is spooled. Safe to call often; serialised internally so
	 * two callers can never double-deliver the same envelope.
	 */
	drain(budgetMs?: number): Promise<DrainOutcome> {
		if (this.draining) return this.draining;
		const run = this.drainOnce(budgetMs ?? this.captureConfig.timeoutMs).finally(() => {
			this.draining = null;
		});
		this.draining = run;
		return run;
	}

	private async drainOnce(budgetMs: number): Promise<DrainOutcome> {
		const deadline = this.now() + budgetMs;
		let delivered = 0;
		let failed = 0;

		if (this.breakerOpen()) {
			const stats = this.spool.stats();
			return { delivered: 0, failed: 0, remaining: stats.depth, lastReceiptId: this.lastReceiptId };
		}

		for (const { path, envelope } of this.spool.list()) {
			if (this.now() >= deadline) break;
			if (this.breakerOpen()) break;
			const remaining = Math.max(500, deadline - this.now());
			try {
				const receipt = await this.transport.saveConversation(envelope.messages, {
					idempotencyKey: envelope.idempotencyKey,
					userId: envelope.scope.userId,
					conversationId: envelope.scope.conversationId,
					projectId: envelope.scope.projectId,
					agentId: envelope.scope.agentId,
					source: envelope.scope.source,
					timeoutMs: Math.min(remaining, this.captureConfig.timeoutMs),
				});
				const receiptId =
					(typeof receipt["receipt_id"] === "string" && receipt["receipt_id"]) ||
					(typeof receipt["source_packet_id"] === "string" && receipt["source_packet_id"]) ||
					null;
				if (receiptId) this.lastReceiptId = receiptId;
				this.spool.remove(path);
				this.noteSuccess();
				delivered += 1;
			} catch (error) {
				const code = error instanceof ItsukiError ? error.errorClass : "unknown";
				this.noteFailure(code, error instanceof Error ? error.message : "capture failed");
				emit(this.onEvent, { type: "capture.fail", ms: 0, errorClass: code });
				failed += 1;
				if (TERMINAL_CLASSES.has(code)) {
					// It will never succeed. Dropping it is the honest outcome,
					// and it is counted, not hidden.
					this.spool.remove(path);
				} else {
					this.spool.recordAttempt(path, envelope);
				}
				if (HOLD_CLASSES.has(code)) break;
				// Space the next attempt out a little without blocking long.
				const backoff = Math.min(computeBackoffMs(envelope.attempts ?? 0), 250);
				if (this.now() + backoff < deadline) await new Promise((r) => setTimeout(r, backoff));
			}
		}

		const stats = this.spool.stats();
		return { delivered, failed, remaining: stats.depth, lastReceiptId: this.lastReceiptId };
	}

	/** Read-only inventory: list. Bounded and marker-wrapped by the caller. */
	async listMemories(scope: CaptureScope, limit: number): Promise<string> {
		const payload = await this.transport.listMemories({
			userId: scope.userId,
			limit: Math.min(Math.max(limit, 1), 50),
			timeoutMs: this.recallConfig.timeoutMs * 4,
		});
		return wrapAsData(defuseMarkers(summariseList(payload)), this.recallConfig.maxChars);
	}

	/** Read-only inventory: get one by id. */
	async getMemory(scope: CaptureScope, id: string): Promise<string> {
		const payload = await this.transport.getMemory(id, {
			userId: scope.userId,
			timeoutMs: this.recallConfig.timeoutMs * 4,
		});
		return wrapAsData(defuseMarkers(JSON.stringify(payload["memory"] ?? payload, null, 1)), this.recallConfig.maxChars);
	}

	/** Suppress lines we injected, so recall never re-enters memory as "new". */
	suppressEcho(text: string, fingerprints: Set<string>, sessionKey: string | null): string {
		if (!sessionKey || fingerprints.size === 0) return text;
		return suppressEchoLines(text, fingerprints, sessionKey);
	}

	health(): HealthReport {
		const stats = this.spool.stats();
		return {
			breaker: {
				open: this.breakerOpen(),
				until: this.breakerUntil,
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
