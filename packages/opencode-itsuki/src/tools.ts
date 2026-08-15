/**
 * Model-facing tools.
 *
 * Read and write only. There is deliberately no delete, no bulk delete, no
 * entity operation and no update here:
 *
 *  - Destruction needs a confirmation UX that a tool call cannot provide, and
 *    the server's own dry-run/confirm gating lives behind the MCP door and the
 *    dashboard where a human can see what is about to vanish.
 *  - Itsuki has no safe caller-addressable update, and faking one by deleting
 *    and re-creating would destroy history and break idempotency. It stays
 *    absent and is documented as absent.
 *
 * No tool takes a tenancy argument. The model cannot choose whose memory it
 * reads or writes — that is fixed by configuration and the credential.
 */

import { tool } from "@opencode-ai/plugin";

import type { ItsukiConfig } from "./config.js";
import type { Coordinator } from "./coordinator.js";
import { ItsukiError } from "./kernel/errors.js";
import { captureIdempotencyKey } from "./kernel/idempotency.js";
import type { CaptureScope } from "./kernel/types.js";
import type { Spool } from "./spool.js";

const z = tool.schema;

export interface ToolRuntime {
	config: ItsukiConfig;
	coordinator: Coordinator | null;
	spool: Spool;
	envNames: { apiKey: string; baseUrl: string; stateDir: string };
	source: string;
}

export interface BuildToolsInput {
	runtime: ToolRuntime;
	scopeFor: (sessionID: string) => CaptureScope;
}

function notReady(runtime: ToolRuntime): string {
	const problems = runtime.config.problems;
	const head = `Itsuki memory is not connected. Set ${runtime.envNames.apiKey} in the environment that starts OpenCode, then restart it.`;
	return problems.length > 0 ? `${head}\n\n${problems.join("\n")}` : head;
}

function describeError(error: unknown): string {
	if (error instanceof ItsukiError) return `${error.message} (${error.errorClass})`;
	return error instanceof Error ? error.message : "Unknown error";
}

export function buildTools(input: BuildToolsInput): Record<string, unknown> {
	const { runtime, scopeFor } = input;

	const itsuki_recall = tool({
		description:
			"Search the user's long-term Itsuki memory and return what is stored about a topic. Use when the user refers to something from an earlier session, or when you need context the current conversation does not contain.",
		args: {
			query: z.string().min(1).describe("What to look up, in natural language."),
		},
		async execute(args: { query: string }, ctx: { sessionID: string }) {
			const coordinator = runtime.coordinator;
			if (!coordinator) return notReady(runtime);
			const outcome = await coordinator.recall(args.query, scopeFor(ctx.sessionID));
			if (outcome.status === "failed") {
				return `Recall failed (${outcome.code ?? "unknown"}). The turn is unaffected; memory is temporarily unavailable.`;
			}
			if (!outcome.block) return "No stored memories matched that query.";
			return { title: `Itsuki: ${outcome.count} memor${outcome.count === 1 ? "y" : "ies"}`, output: outcome.block };
		},
	});

	const itsuki_save = tool({
		description:
			"Save one durable fact to the user's long-term Itsuki memory. Use when the user states a preference, decision, or detail worth remembering in future sessions. Send one clear fact in the user's own words. Routine conversation is captured automatically and does not need this tool.",
		args: {
			content: z.string().min(1).describe("The single fact to remember, in the user's own words."),
		},
		async execute(args: { content: string }, ctx: { sessionID: string }) {
			const coordinator = runtime.coordinator;
			if (!coordinator) return notReady(runtime);
			const scope = scopeFor(ctx.sessionID);
			const messages = [{ role: "user" as const, content: args.content }];
			const key = captureIdempotencyKey({ scope, messages, discriminator: "tool:save" });
			const outcome = coordinator.stage(messages, scope, () => false);
			if (outcome.status !== "staged") {
				return outcome.status === "duplicate"
					? "That exact fact was already saved."
					: "Nothing to save.";
			}
			const drain = await coordinator.drain();
			if (drain.delivered > 0 && drain.lastReceiptId) {
				return `Saved. Receipt ${drain.lastReceiptId}.`;
			}
			// Never claim a save without a receipt.
			return `Staged locally and queued for delivery (key ${key.slice(0, 12)}…). It will be sent automatically; it is not confirmed saved yet.`;
		},
	});

	const itsuki_memories = tool({
		description:
			"List what is stored in the user's Itsuki memory, newest first. Use for \"what do you remember about me\" and for audits. For meaning-based lookup use itsuki_recall instead.",
		args: {
			limit: z.number().int().min(1).max(50).optional().describe("How many to list (default 20)."),
		},
		async execute(args: { limit?: number }, ctx: { sessionID: string }) {
			const coordinator = runtime.coordinator;
			if (!coordinator) return notReady(runtime);
			try {
				const payload = await coordinator.listMemories(scopeFor(ctx.sessionID), args.limit ?? 20);
				return payload;
			} catch (error) {
				return `Could not list memories: ${describeError(error)}`;
			}
		},
	});

	const itsuki_memory = tool({
		description:
			"Fetch one stored memory by its id, as returned by itsuki_memories or a save receipt.",
		args: {
			id: z.string().min(1).describe("The memory id, e.g. node_abc123."),
		},
		async execute(args: { id: string }, ctx: { sessionID: string }) {
			const coordinator = runtime.coordinator;
			if (!coordinator) return notReady(runtime);
			try {
				return await coordinator.getMemory(scopeFor(ctx.sessionID), args.id);
			} catch (error) {
				return `Could not fetch that memory: ${describeError(error)}`;
			}
		},
	});

	const itsuki_status = tool({
		description:
			"Report the health of the Itsuki memory connection: whether it is configured, what is queued for delivery, and the last receipt. Never prints the API key. Use when memory seems not to be working.",
		args: {},
		async execute() {
			const lines: string[] = [];
			lines.push(`connected: ${runtime.coordinator ? "yes" : "no"}`);
			lines.push(`recall: ${runtime.config.recall.enabled ? "on" : "off"} (budget ${runtime.config.recall.timeoutMs}ms, max ${runtime.config.recall.maxItems} items / ${runtime.config.recall.maxChars} chars)`);
			lines.push(`capture: ${runtime.config.capture.enabled ? "on" : "off"}`);
			lines.push(`tenant: ${runtime.config.userId ? "configured sub-tenant" : "account default"}`);
			lines.push(`project attribution: ${runtime.config.projectId ?? "none"}`);
			if (runtime.coordinator) {
				const health = runtime.coordinator.health();
				lines.push(`queued for delivery: ${health.spool.depth}`);
				lines.push(`dropped (spool full): ${health.spool.dropped}`);
				lines.push(`quarantined: ${health.spool.quarantined}`);
				lines.push(`breaker: ${health.breaker.open ? `open (${health.breaker.reason ?? "unknown"})` : "closed"}`);
				lines.push(`last receipt: ${health.lastReceiptId ?? "none yet"}`);
				if (health.lastError) lines.push(`last error: ${health.lastError.code} — ${health.lastError.message}`);
				lines.push(`terminal failures: ${health.terminalFailures}`);
			}
			for (const problem of runtime.config.problems) lines.push(`problem: ${problem}`);
			return { title: "Itsuki status", output: lines.join("\n") };
		},
	});

	return { itsuki_recall, itsuki_save, itsuki_memories, itsuki_memory, itsuki_status };
}
