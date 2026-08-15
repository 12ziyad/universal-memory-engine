/**
 * Reading and rewriting an AI SDK prompt without changing what it means.
 *
 * Everything here is pure and non-mutating. The SDK hands middleware the same
 * params object it will hand the provider, and a middleware that edits it in
 * place corrupts retries, other middleware in the chain, and any caller that
 * kept a reference. So each function returns new arrays.
 */

import { isTextLike, type ModelContent, type ModelMessage, type ModelPrompt } from "./ai-types.js";
import { stripRecallBlocks } from "./kernel/inject.js";
import type { CaptureMessage } from "./kernel/types.js";

/** Concatenate the text parts of one message, ignoring files and tool traffic. */
function textOf(message: ModelMessage): string {
	const content: unknown = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(isTextLike)
		.map((part) => part.text)
		.join("\n")
		.trim();
}

/** The text of the most recent user message — what recall is about. */
export function latestUserText(prompt: ModelPrompt): string {
	for (let i = prompt.length - 1; i >= 0; i -= 1) {
		const message = prompt[i];
		if (!message || message.role !== "user") continue;
		const text = textOf(message);
		if (text) return text;
	}
	return "";
}

/**
 * The exchange to capture: the settled user turn plus the settled assistant
 * prose. Both sides go up because the assistant turn resolves references the
 * user turn leaves open ("do that again", "the second one"); the server's
 * extraction is user-anchored and stores the user's facts, not the model's
 * claims.
 */
export function settledExchange(prompt: ModelPrompt, assistantText: string): CaptureMessage[] {
	const userText = latestUserText(prompt);
	// A turn with no user text is a synthetic call — a summarizer, a
	// system-driven completion. There is nobody to attribute a memory to.
	if (!userText) return [];

	// No assistant prose means the turn has not settled. In a tool loop this is
	// the norm: the first model call returns only tool calls, and a later one
	// answers. Capturing the user turn alone here would store the SAME exchange
	// twice under two different keys — once bare, once complete — which is
	// precisely the duplicate that content-derived idempotency exists to
	// prevent. The later step still sees this user message in its prompt, so
	// nothing is lost by waiting for the answer.
	const assistant = stripRecallBlocks(assistantText).trim();
	if (!assistant) return [];

	return [
		{ role: "user", content: userText },
		{ role: "assistant", content: assistant },
	];
}

/** The assistant's prose from a completed generation, tool calls excluded. */
export function assistantTextFromContent(content: readonly ModelContent[] | undefined): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter(isTextLike)
		.map((part) => part.text)
		.join("")
		.trim();
}

/**
 * Put the recalled block where a model will read it as context: appended to
 * the existing system message when there is one, otherwise as a new leading
 * system message. Never inside the user's own turn — a user message is what
 * the user said, and rewriting it corrupts both the transcript and capture.
 */
export function injectContext(prompt: ModelPrompt, block: string): ModelPrompt {
	if (!block) return prompt;
	const first = prompt[0];
	if (first && first.role === "system" && typeof first.content === "string") {
		return [
			{ ...first, content: `${first.content}\n\n${block}` },
			...prompt.slice(1),
		];
	}
	return [{ role: "system", content: block }, ...prompt];
}

/** Did something already inject a block into this prompt? Guards double-injection. */
export function hasInjectedBlock(prompt: ModelPrompt, marker: string): boolean {
	return prompt.some((message) =>
		message.role === "system"
		&& typeof message.content === "string"
		&& message.content.includes(marker));
}
