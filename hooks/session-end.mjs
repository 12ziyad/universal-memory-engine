/**
 * Itsuki SessionEnd hook — send the session's conversation to the save door
 * with the plugin (coding) profile: decisions, conventions, and error→fix
 * pairs get remembered; file paths, stack traces, and tool chatter are
 * discarded by the server's deterministic gates.
 *
 * Same two rules as session-start: never block (always exit 0), and never
 * fail invisibly (say why nothing was saved). The save is accepted by the
 * server and extracted in the background, so this only waits for the
 * acknowledgement, capped hard.
 */

import { basename } from "node:path";
import { createInterface } from "node:readline";
import { createReadStream, existsSync } from "node:fs";

const API_KEY = process.env.ITSUKI_API_KEY;
const BASE_URL = (process.env.ITSUKI_BASE_URL || "https://itsuki.app").replace(/\/+$/, "");
const TIMEOUT_MS = Number(process.env.ITSUKI_TIMEOUT_MS) > 0 ? Number(process.env.ITSUKI_TIMEOUT_MS) : 10000;
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

/** Tell the user nothing was saved, and why. Always paired with exit 0. */
function notSaved(reason, fix) {
	process.stdout.write(JSON.stringify({
		systemMessage: `Itsuki: this session was NOT saved to memory — ${reason} ${fix}`,
	}));
}

const SETUP_FIX =
	"Create a key at https://itsuki.app under API keys, set ITSUKI_API_KEY in your shell profile, then restart your shell. Run /itsuki:doctor to verify.";

/** Same pre-flight as session-start: a header-unsafe key must be named, not
 * allowed to throw inside fetch and masquerade as a network failure. */
function keyProblem(key) {
	if (!key) return "ITSUKI_API_KEY is not set.";
	if (!/^[!-~]+$/.test(key)) {
		return "ITSUKI_API_KEY contains characters that cannot go in an HTTP header (a mangled paste, most likely).";
	}
	return null;
}

function describeNetworkError(error) {
	if (error?.name === "AbortError" || error?.name === "TimeoutError") {
		return `${BASE_URL} did not answer within ${TIMEOUT_MS / 1000}s.`;
	}
	const cause = error?.cause?.code || error?.cause?.message || error?.message || String(error);
	return `could not reach ${BASE_URL} (${cause}).`;
}

async function main() {
	const problem = keyProblem(API_KEY);
	if (problem) {
		notSaved(problem, SETUP_FIX);
		return;
	}

	const payload = await readStdin();
	const messages = await messagesFromTranscript(payload?.transcript_path);
	// Nothing worth sending is the normal quiet case, not a failure.
	if (!messages.length) return;

	const project = basename(payload?.cwd || process.cwd()) || "project";
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

	let res;
	try {
		res = await fetch(`${BASE_URL}/v1/ingest`, {
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
	} catch (error) {
		notSaved(describeNetworkError(error), "Run /itsuki:doctor for a full connection check.");
		return;
	} finally {
		clearTimeout(timer);
	}

	if (res.status === 401 || res.status === 403) {
		notSaved(`the server rejected ITSUKI_API_KEY (HTTP ${res.status}).`, `The key is revoked or mistyped. ${SETUP_FIX}`);
		return;
	}
	if (!res.ok) {
		notSaved(`the memory service answered HTTP ${res.status}.`, "Nothing to fix locally — try again next session.");
	}
}

main().then(() => process.exit(0), () => process.exit(0));
