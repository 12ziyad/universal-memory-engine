/**
 * Model-callable memory tools.
 *
 * The processors give an agent memory whether or not it thinks to ask. These
 * are for the cases where you WANT the decision to be the model's — "save that
 * for later", an explicit lookup, an audit of what is stored.
 *
 * The hard rule: no tool takes a user id, a project id, or any other tenancy
 * parameter. A model that can name the memory space it writes to is a model
 * that can be talked into writing somewhere else, and every prompt it reads is
 * attacker-influenced. Tenancy comes from the run, never from an argument.
 *
 * Deletion is off unless the application turns it on, and even then the bulk
 * form previews by default — the server's own contract, kept at the tool
 * boundary so a confused model cannot skip it.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import type { ResolvedConfig } from "./config.js";
import { configFor, resolveIdentity, type ContextLike } from "./identity.js";
import { emit } from "./kernel/events.js";
import { ItsukiError } from "./kernel/errors.js";
import { captureIdempotencyKey } from "./kernel/idempotency.js";
import { scrubText } from "./kernel/scrub.js";
import { ItsukiMemory } from "./kernel/memory.js";
import { bound } from "./util.js";

export interface ToolOptions {
	/** Register delete tools. Off by default; they still confirm. */
	enableDelete?: boolean;
	memory?: ItsukiMemory;
}

interface ExecutionContext {
	requestContext?: ContextLike;
	abortSignal?: AbortSignal;
}

/** A tool result the model can read, whatever happened. */
function failure(error: unknown): { ok: false; error: string; message: string } {
	if (error instanceof ItsukiError) {
		return { ok: false, error: error.errorClass, message: `${error.message}. ${error.description}` };
	}
	return { ok: false, error: "unknown", message: "The memory service could not be reached." };
}

export function itsukiTools(config: ResolvedConfig, options: ToolOptions = {}) {
	const memory = options.memory ?? new ItsukiMemory(config);

	/**
	 * Resolve the run's tenancy. Returns null when there is no identity, which
	 * every tool reports as a readable refusal rather than a silent write.
	 */
	const scopeFor = (context: ExecutionContext | undefined): ResolvedConfig | null => {
		const identity = resolveIdentity(config, [], context?.requestContext);
		if (!identity.userId) return null;
		return configFor(config, identity);
	};

	const noIdentity = {
		ok: false as const,
		error: "no_identity",
		message: "No user is associated with this run, so there is no memory to read or write.",
	};

	const itsukiSearch = createTool({
		id: "itsuki-search-memory",
		description:
			"Search this user's long-term memory for anything relevant to a question. "
			+ "Use whenever the user refers to something personal, past, or context-dependent.",
		inputSchema: z.object({
			query: z.string().min(1).describe("What to look up, e.g. 'what are my projects'."),
		}),
		execute: async ({ query }: { query: string }, context?: ExecutionContext) => {
			const scope = scopeFor(context);
			if (!scope) return noIdentity;
			const started = Date.now();
			try {
				const payload = await memory.transport.recall(query, {
					userId: scope.userId,
					limit: scope.maxItems,
					recallScope: scope.recallScope,
					projectId: scope.projectId,
					conversationId: scope.conversationId,
					timeoutMs: scope.timeoutMs,
					...(context?.abortSignal ? { signal: context.abortSignal } : {}),
				});
				emit(config.onEvent, { type: "tool.ok", tool: "search", ms: Date.now() - started });
				return {
					ok: true as const,
					context: String(payload["context"] ?? ""),
					count: Number(payload["count"] ?? 0),
				};
			} catch (error) {
				emit(config.onEvent, {
					type: "tool.fail",
					tool: "search",
					ms: Date.now() - started,
					errorClass: error instanceof ItsukiError ? error.errorClass : "unknown",
				});
				return failure(error);
			}
		},
	});

	const itsukiSave = createTool({
		id: "itsuki-save-memory",
		description:
			"Save one durable fact about the user. Call when they state a preference, "
			+ "decision, personal detail or anything worth remembering later. One fact per call.",
		inputSchema: z.object({
			content: z.string().min(1).describe("The fact, in the user's own words."),
		}),
		execute: async ({ content }: { content: string }, context?: ExecutionContext) => {
			const scope = scopeFor(context);
			if (!scope) return noIdentity;
			const started = Date.now();
			try {
				// Scrub first: a model asked to "remember my key" must not be able
				// to make that key durable.
				const safe = scrubText(content).text;
				const payload = await memory.transport.saveMemory(safe, {
					idempotencyKey: captureIdempotencyKey({
						scope: {
							userId: scope.userId,
							conversationId: scope.conversationId,
							projectId: scope.projectId,
							source: scope.source,
						},
						messages: [{ role: "user", content: safe }],
						discriminator: "tool:save",
					}),
					userId: scope.userId,
					conversationId: scope.conversationId,
					projectId: scope.projectId,
					source: scope.source,
					timeoutMs: scope.captureTimeoutMs,
					...(context?.abortSignal ? { signal: context.abortSignal } : {}),
				});
				emit(config.onEvent, { type: "tool.ok", tool: "save", ms: Date.now() - started });
				return {
					ok: true as const,
					saved: true,
					sourcePacketId: (payload["source_packet_id"] as string | null) ?? null,
					message: "Staged. Processing finishes in the background.",
				};
			} catch (error) {
				emit(config.onEvent, {
					type: "tool.fail",
					tool: "save",
					ms: Date.now() - started,
					errorClass: error instanceof ItsukiError ? error.errorClass : "unknown",
				});
				return failure(error);
			}
		},
	});

	const itsukiList = createTool({
		id: "itsuki-list-memories",
		description:
			"Browse stored memories newest first, for \"what do you remember\" and audits. "
			+ "For meaning-based lookup use itsuki-search-memory instead.",
		inputSchema: z.object({
			limit: z.number().int().min(1).max(50).optional().describe("Items per page, default 20."),
			cursor: z.string().optional().describe("Opaque cursor from a previous call."),
		}),
		execute: async (
			{ limit, cursor }: { limit?: number; cursor?: string },
			context?: ExecutionContext,
		) => {
			const scope = scopeFor(context);
			if (!scope) return noIdentity;
			try {
				const payload = await memory.transport.listMemories({
					userId: scope.userId,
					limit: limit ?? 20,
					cursor,
					timeoutMs: scope.timeoutMs,
					...(context?.abortSignal ? { signal: context.abortSignal } : {}),
				});
				const items = Array.isArray(payload["items"]) ? (payload["items"] as unknown[]) : [];
				return {
					ok: true as const,
					items: bound(items, limit ?? 20),
					nextCursor: (payload["next_cursor"] as string | null) ?? null,
				};
			} catch (error) {
				return failure(error);
			}
		},
	});

	const itsukiGet = createTool({
		id: "itsuki-get-memory",
		description: "Fetch one stored memory by the id that list or search returned.",
		inputSchema: z.object({
			id: z.string().min(1).describe("The memory id, e.g. node_abc123."),
		}),
		execute: async ({ id }: { id: string }, context?: ExecutionContext) => {
			const scope = scopeFor(context);
			if (!scope) return noIdentity;
			try {
				const payload = await memory.transport.getMemory(id, {
					userId: scope.userId,
					timeoutMs: scope.timeoutMs,
					...(context?.abortSignal ? { signal: context.abortSignal } : {}),
				});
				return { ok: true as const, memory: payload["memory"] ?? payload };
			} catch (error) {
				return failure(error);
			}
		},
	});

	const tools: Record<string, unknown> = {
		itsukiSearch,
		itsukiSave,
		itsukiList,
		itsukiGet,
	};

	if (options.enableDelete === true) {
		tools["itsukiDelete"] = createTool({
			id: "itsuki-delete-memory",
			description:
				"Permanently delete ONE stored memory by id. Only call when the user has "
				+ "explicitly asked to forget that specific thing — confirm which one first.",
			inputSchema: z.object({
				id: z.string().min(1).describe("The exact id to delete."),
				confirmed: z.boolean().describe("True only if the user explicitly asked for this deletion."),
			}),
			execute: async (
				{ id, confirmed }: { id: string; confirmed: boolean },
				context?: ExecutionContext,
			) => {
				const scope = scopeFor(context);
				if (!scope) return noIdentity;
				if (confirmed !== true) {
					return {
						ok: false as const,
						error: "confirmation",
						message: "Nothing was deleted. Ask the user to confirm, then call again with confirmed=true.",
					};
				}
				try {
					const payload = await memory.transport.deleteMemory(id, {
						userId: scope.userId,
						timeoutMs: scope.timeoutMs,
						...(context?.abortSignal ? { signal: context.abortSignal } : {}),
					});
					return { ok: true as const, deleted: true, id, result: payload };
				} catch (error) {
					return failure(error);
				}
			},
		});
	}

	return tools;
}
