/**
 * Reading Mastra messages.
 *
 * Text lives in `content.parts`, not on `content` — a processor that reads
 * `message.content` directly gets an object, and the memory it stores is
 * "[object Object]". Everything here goes through the parts array and ignores
 * tool traffic, files and reasoning, which are not things a user said.
 */

import { stripRecallBlocks } from "./kernel/inject.js";
import type { CaptureMessage } from "./kernel/types.js";
import type { MessageLike } from "./identity.js";

interface PartLike {
	type?: unknown;
	text?: unknown;
}

/** Concatenate the text parts of one message. */
export function textOf(message: MessageLike | undefined): string {
	if (!message) return "";
	const content = message.content as { parts?: unknown } | string | undefined;
	if (typeof content === "string") return content.trim();
	const parts = (content as { parts?: unknown } | undefined)?.parts;
	if (!Array.isArray(parts)) return "";
	return parts
		.filter((part): part is PartLike & { text: string } =>
			(part as PartLike)?.type === "text" && typeof (part as PartLike)?.text === "string")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

/**
 * The whole conversation for this run.
 *
 * `processOutputResult` is handed only the messages the model just produced —
 * the assistant turn, and nothing the user said. Capturing from that alone
 * would store an answer with no question attached. The full list lives on the
 * host's MessageList, so that is what capture reads.
 *
 * The accessor shape is host-owned and young, so it is probed defensively and
 * falls back to whatever the processor was handed directly. A wrong guess here
 * must degrade to capturing nothing, never to throwing inside an agent run.
 */
export function conversationMessages(args: {
	messages?: readonly MessageLike[];
	messageList?: unknown;
}): readonly MessageLike[] {
	const list = args.messageList as { get?: unknown } | undefined;
	const get = list?.get as { all?: unknown } | undefined;
	const all = get?.all;
	const candidates: unknown[] = [];
	try {
		if (typeof all === "function") candidates.push((all as () => unknown).call(get));
		else if (all && typeof (all as { db?: unknown }).db === "function") {
			candidates.push((all as { db: () => unknown }).db());
		} else if (all) candidates.push(all);
	} catch {
		// A host accessor that throws is not a reason to fail the run.
	}
	for (const candidate of candidates) {
		if (Array.isArray(candidate) && candidate.length > 0) return candidate as MessageLike[];
	}
	return args.messages ?? [];
}

/** The text of the most recent user message — what recall is about. */
export function latestUserText(messages: readonly MessageLike[]): string {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (message?.role !== "user") continue;
		const text = textOf(message);
		if (text) return text;
	}
	return "";
}

/**
 * The exchange to capture: the settled user turn plus the assistant's answer.
 *
 * Both are required. An answer with no question has nobody to attribute the
 * memory to, and a question with no answer has not settled — in a tool loop
 * that is simply a step that has not finished yet.
 */
export function settledExchange(
	messages: readonly MessageLike[],
	assistantText: string,
): CaptureMessage[] {
	const userText = latestUserText(messages);
	if (!userText) return [];
	const assistant = stripRecallBlocks(assistantText).trim();
	if (!assistant) return [];
	return [
		{ role: "user", content: userText },
		{ role: "assistant", content: assistant },
	];
}
