/**
 * Itsuki SessionEnd hook — send the session's conversation to the save door
 * with the plugin (coding) profile: decisions, conventions, and error→fix
 * pairs get remembered; file paths, stack traces, and tool chatter are
 * discarded by the server's deterministic gates.
 *
 * Same absolute rule as session-start: fail silently, never block. The save
 * is accepted by the server and extracted in the background, so this only
 * waits for the acknowledgement, capped hard.
 */

import { basename } from "node:path";
import { createInterface } from "node:readline";
import { createReadStream, existsSync } from "node:fs";

const API_KEY = process.env.ITSUKI_API_KEY;
const BASE_URL = (process.env.ITSUKI_BASE_URL || "https://itsuki.app").replace(/\/+$/, "");
const TIMEOUT_MS = 8000;
const MAX_MESSAGES = 80;
const MAX_CHARS_PER_MESSAGE = 4000;

/** Read the hook payload Claude Code pipes in on stdin. */
async function readStdin() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		return {};
	}
}

/**
 * Extract plain conversation text from the session transcript (JSONL). Only
 * text parts — tool calls, tool results, and thinking stay out of the
 * payload; the server's plugin gates would drop them anyway, but not sending
 * them keeps the request small and the memory clean.
 */
async function messagesFromTranscript(path) {
	if (!path || !existsSync(path)) return [];
	const out = [];
	const rl = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
	for await (const line of rl) {
		let row;
		try { row = JSON.parse(line); } catch { continue; }
		if (row?.type !== "user" && row?.type !== "assistant") continue;
		const message = row.message ?? {};
		const content = message.content;
		let text = "";
		if (typeof content === "string") text = content;
		else if (Array.isArray(content)) {
			text = content.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
		}
		text = String(text ?? "").trim();
		if (!text) continue;
		out.push({
			role: row.type === "assistant" ? "assistant" : "user",
			content: text.length > MAX_CHARS_PER_MESSAGE ? `${text.slice(0, MAX_CHARS_PER_MESSAGE)}…` : text,
			ts: Date.parse(row.timestamp ?? "") || Date.now(),
		});
	}
	return out.slice(-MAX_MESSAGES);
}

async function main() {
	if (!API_KEY) return;

	const payload = await readStdin();
	const messages = await messagesFromTranscript(payload?.transcript_path);
	if (!messages.length) return;

	const project = basename(payload?.cwd || process.cwd()) || "project";
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

	try {
		await fetch(`${BASE_URL}/v1/ingest`, {
			method: "POST",
			signal: controller.signal,
			headers: {
				authorization: `Bearer ${API_KEY}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				userId: `project:${project}`,
				source: "plugin",
				flush: true,
				conversationId: payload?.session_id ?? undefined,
				messages: messages.map((m, i) => ({ id: `${payload?.session_id ?? "sess"}-${i}`, ...m })),
			}),
		});
	} catch {
		// Silent by design.
	} finally {
		clearTimeout(timer);
	}
}

main().then(() => process.exit(0), () => process.exit(0));
