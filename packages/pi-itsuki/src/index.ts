/**
 * pi-itsuki — Itsuki memory as a native Pi lifecycle extension.
 *
 * Recall runs in `before_agent_start`, so relevant memory is already in context
 * before the first model call of every turn — the agent never has to choose to
 * look. Capture runs in `agent_settled`, which is the only event pi documents
 * as "will not continue running automatically": using it means a turn that is
 * still auto-retrying, auto-compacting, or draining queued follow-ups is not
 * mistaken for a finished thought.
 *
 * The factory below only registers. Every resource is created in
 * `session_start` and released in `session_shutdown`, per pi's extension rules.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { loadConfig, type ItsukiConfig } from "./config.js";
import { Coordinator } from "./coordinator.js";
import { echoSessionKey } from "./inject.js";
import {
	CAPTURE_STATE_SCHEMA,
	CAPTURE_STATE_TYPE,
	type CaptureStateData,
	collectCaptureSpan,
	readCaptureState,
} from "./session.js";
import { Spool } from "./spool.js";
import { ItsukiTransport, validApiKeyShape } from "./transport.js";

const SOURCE = "pi";

interface SessionState {
	config: ItsukiConfig;
	coordinator: Coordinator;
	spool: Spool;
	/** Non-null only when the adapter is fully wired and usable. */
	ready: boolean;
	problem: string | null;
}

function sessionIdentity(ctx: ExtensionContext): { conversationId: string | undefined; echoKey: string | null } {
	const manager = ctx.sessionManager as unknown as {
		getSessionId?: () => string | undefined;
		getSessionFile?: () => string | null | undefined;
	};
	const id = manager.getSessionId?.() ?? manager.getSessionFile?.() ?? undefined;
	const conversationId = typeof id === "string" && id ? id : undefined;
	return { conversationId, echoKey: conversationId ? echoSessionKey(conversationId) : null };
}

function setupHint(): string {
	return "Create a key at https://itsuki.app under API Keys, then set ITSUKI_API_KEY in your environment and restart pi.";
}

export default function itsukiExtension(pi: ExtensionAPI): void {
	let state: SessionState | null = null;

	async function build(ctx: ExtensionContext): Promise<SessionState> {
		const config = await loadConfig();
		const spool = new Spool(config.dataDir);
		await spool.init();

		if (!config.apiKey) {
			return {
				config,
				spool,
				ready: false,
				problem: `the Itsuki API key is not configured. ${setupHint()}`,
				coordinator: null as unknown as Coordinator,
			};
		}
		if (!validApiKeyShape(config.apiKey)) {
			return {
				config,
				spool,
				ready: false,
				problem: `the Itsuki API key has an invalid format. ${setupHint()}`,
				coordinator: null as unknown as Coordinator,
			};
		}

		const { conversationId, echoKey } = sessionIdentity(ctx);
		let transport: ItsukiTransport;
		try {
			transport = new ItsukiTransport({
				apiKey: config.apiKey,
				baseUrl: config.baseUrl,
				timeoutMs: config.capture.timeoutMs,
			});
		} catch (error) {
			return {
				config,
				spool,
				ready: false,
				problem: (error as Error).message,
				coordinator: null as unknown as Coordinator,
			};
		}

		const coordinator = new Coordinator({
			transport,
			spool,
			scope: { userId: config.userId, conversationId, source: SOURCE },
			recall: config.recall,
			capture: config.capture,
		});
		coordinator.setEchoKey(echoKey);
		return { config, spool, coordinator, ready: true, problem: null };
	}

	// ---------------------------------------------------------- lifecycle

	pi.on("session_start", async (_event, ctx) => {
		state = await build(ctx);
		if (!state.ready) return;
		// Blocks injected by earlier processes are still in this session's
		// history. Reseed their fingerprints so a late echo of one of those
		// lines is suppressed exactly like a same-process echo.
		for (const raw of ctx.sessionManager.getBranch() as unknown[]) {
			const entry = raw as { type?: string; message?: { role?: string; customType?: string; content?: unknown } };
			if (entry?.type !== "message" || entry.message?.role !== "custom") continue;
			if (entry.message.customType !== "itsuki-recall") continue;
			const content = entry.message.content;
			const text = typeof content === "string"
				? content
				: Array.isArray(content)
					? content.map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: unknown }).text ?? "") : "")).join("\n")
					: "";
			if (text) state.coordinator.seedEchoContext(text);
		}
		// Anything left from a previous run (crash, offline, rate limit) goes
		// out before this session writes anything new.
		await state.coordinator.drain();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const active = state;
		if (!active?.ready) return;
		const prompt = typeof event.prompt === "string" ? event.prompt : "";
		const outcome = await active.coordinator.recall(prompt, ctx.signal);
		if (!outcome.block) return;
		return {
			message: {
				customType: "itsuki-recall",
				content: outcome.block,
				display: true,
			},
		};
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const active = state;
		if (!active?.ready) return;
		await captureSettled(active, ctx);
	});

	// Compaction rewrites what the model can see. Flush first so a long session
	// cannot lose its unsaved tail to a summary.
	pi.on("session_before_compact", async (_event, ctx) => {
		const active = state;
		if (!active?.ready) return;
		await captureSettled(active, ctx);
		return undefined;
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const active = state;
		state = null;
		if (!active?.ready) return;
		// Best effort: take ownership of anything outstanding, then try once.
		await captureSettled(active, ctx);
	});

	async function captureSettled(active: SessionState, ctx: ExtensionContext): Promise<void> {
		// With capture off, the watermark must NOT advance: turning capture back
		// on should resume from where it stopped, not skip what happened while
		// it was off.
		if (!active.config.capture.enabled) return;
		const branch = ctx.sessionManager.getBranch() as unknown[];
		const prior = readCaptureState(branch);
		const span = collectCaptureSpan(
			branch,
			prior?.watermarkEntryId ?? null,
			active.coordinator.transformCaptured,
		);
		if (!span.watermarkEntryId) return;

		const staged = await active.coordinator.stage(span.messages);
		// The watermark advances the moment the span is durably owned — before
		// any network call — so a crash mid-delivery cannot re-capture it under
		// a different (larger) span and duplicate the content.
		const data: CaptureStateData = {
			schema: CAPTURE_STATE_SCHEMA,
			watermarkEntryId: span.watermarkEntryId,
			idempotencyKey: staged.idempotencyKeys[staged.idempotencyKeys.length - 1] ?? "none",
			state: "spooled",
			at: new Date().toISOString(),
		};
		pi.appendEntry(CAPTURE_STATE_TYPE, data);
		if (staged.status !== "staged") return;
		await active.coordinator.drain(ctx.signal);
	}

	// ------------------------------------------------------------ command

	pi.registerCommand("itsuki", {
		description: "Itsuki memory: status, doctor, or a one-off recall",
		getArgumentCompletions: (prefix: string) => {
			const items = ["status", "doctor", "recall"].map((value) => ({ value, label: value }));
			const filtered = items.filter((item) => item.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args: string, ctx: ExtensionContext) => {
			const active = state;
			const [verb, ...rest] = String(args ?? "").trim().split(/\s+/);
			const query = rest.join(" ");

			if (!active) {
				ctx.ui.notify("Itsuki: no session state yet.", "warning");
				return;
			}
			if (!active.ready) {
				ctx.ui.notify(`Itsuki is not connected — ${active.problem}`, "error");
				return;
			}

			if (verb === "recall") {
				if (!query) {
					ctx.ui.notify("Usage: /itsuki recall <what to look for>", "warning");
					return;
				}
				const outcome = await active.coordinator.recall(query);
				ctx.ui.notify(
					outcome.block
						? `Itsuki recalled ${outcome.count} item(s).`
						: `Itsuki found nothing for that (${outcome.status}).`,
					"info",
				);
				return;
			}

			const health = await active.coordinator.health();
			const lines = [
				`Itsuki ${verb === "doctor" ? "doctor" : "status"}`,
				`  service:   ${active.config.baseUrl}`,
				`  key:       configured (${active.config.apiKey ? "valid format" : "missing"})`,
				`  scope:     ${active.config.userId ? `userId=${active.config.userId}` : "account default"}`,
				`  recall:    ${active.config.recall.enabled ? `on, ${active.config.recall.maxItems} items / ${active.config.recall.maxChars} chars / ${active.config.recall.timeoutMs}ms` : "off"}`,
				`  capture:   ${active.config.capture.enabled ? "on, after each settled turn" : "off"}`,
				`  spool:     ${health.spool.depth} pending, ${health.spool.dropped} dropped`,
				`  receipts:  last ${health.lastReceiptId ?? "none this session"}`,
				`  breaker:   ${health.breaker.open ? `open (${health.breaker.reason})` : "closed"}`,
				`  failures:  ${health.terminalFailures} permanently rejected`,
				`  data dir:  ${active.spool.directory}`,
				`  config:    ${active.config.configSource ?? "defaults + environment"}`,
			];
			if (health.lastError) lines.push(`  last error: ${health.lastError.message} — ${health.lastError.description}`);
			ctx.ui.notify(lines.join("\n"), health.breaker.open || health.spool.dropped > 0 ? "warning" : "info");
		},
	});

	// -------------------------------------------------------------- tools

	pi.registerTool({
		name: "itsuki_recall",
		label: "Recall memory",
		description: "Search long-term Itsuki memory for facts, decisions, and preferences from earlier sessions.",
		promptSnippet: "Search durable memory from previous sessions",
		promptGuidelines: [
			"Use itsuki_recall when the user refers to an earlier decision, preference, or session you cannot see in this conversation.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "What to look for, in natural language." }),
		}),
		async execute(_toolCallId: string, params: { query: string }, signal: AbortSignal | undefined) {
			const active = state;
			if (!active?.ready) {
				return {
					content: [{ type: "text" as const, text: `Itsuki is not connected: ${active?.problem ?? "no session"}` }],
					details: undefined,
				};
			}
			const outcome = await active.coordinator.recall(params.query, signal);
			if (!outcome.block) {
				return {
					content: [{
						type: "text" as const,
						text: outcome.status === "failed"
							? `Itsuki recall failed (${outcome.code ?? "unknown"}). Memory is unavailable right now; continue without it.`
							: "No stored memory matched that.",
					}],
					details: { count: outcome.count },
				};
			}
			return { content: [{ type: "text" as const, text: outcome.block }], details: { count: outcome.count } };
		},
	});

	pi.registerTool({
		name: "itsuki_save",
		label: "Save memory",
		description: "Store one durable fact in Itsuki memory so later sessions can recall it.",
		promptSnippet: "Store a durable fact in long-term memory",
		promptGuidelines: [
			"Use itsuki_save only when the user states a durable fact, preference, or decision worth keeping beyond this session.",
		],
		parameters: Type.Object({
			content: Type.String({ description: "The fact to remember, in plain language." }),
		}),
		async execute(_toolCallId: string, params: { content: string }, signal: AbortSignal | undefined) {
			const active = state;
			if (!active?.ready) {
				return {
					content: [{ type: "text" as const, text: `Itsuki is not connected: ${active?.problem ?? "no session"}` }],
					details: undefined,
				};
			}
			const text = String(params.content ?? "").trim();
			if (!text) {
				return {
					content: [{ type: "text" as const, text: "Nothing to save: content was empty." }],
					details: undefined,
				};
			}

			const staged = await active.coordinator.stage([{ role: "user", content: text }]);
			if (staged.status !== "staged") {
				return {
					content: [{ type: "text" as const, text: `Itsuki did not accept that (${staged.status}).` }],
					details: undefined,
				};
			}
			const drained = await active.coordinator.drain(signal);
			const health = await active.coordinator.health();
			// Never claim a save without a receipt. "Queued" is the honest word
			// for an accepted write that has not been acknowledged yet.
			return {
				content: [{
					type: "text" as const,
					text: drained.delivered > 0
						? `Saved. Receipt ${health.lastReceiptId ?? "(pending)"}.`
						: "Queued locally; Itsuki has not acknowledged it yet. It will be delivered automatically.",
				}],
				details: { delivered: drained.delivered, spoolDepth: health.spool.depth },
			};
		},
	});
}
