/**
 * Itsuki SessionStart hook — print project memory into the session so the
 * agent knows the project before the user types.
 *
 * Two rules, and they are not in conflict:
 *
 *   1. NEVER block or break a session. Always exit 0. A memory tool that
 *      breaks someone's coding session gets uninstalled the same afternoon.
 *   2. NEVER fail invisibly. A plugin that is installed but doing nothing
 *      must say so, or the user spends an hour proving it themselves.
 *
 * So: every failure exits 0, and every failure says why. `systemMessage` is
 * shown to the user; `additionalContext` tells the agent memory is off so it
 * doesn't imply it has history it never received.
 */

import { basename } from "node:path";

const API_KEY = process.env.ITSUKI_API_KEY;
const BASE_URL = (process.env.ITSUKI_BASE_URL || "https://itsuki.app").replace(/\/+$/, "");
const TIMEOUT_MS = 4000;

/** The one stdout write. Claude Code parses a single JSON payload per hook. */
function emit(payload) {
	process.stdout.write(JSON.stringify(payload));
}

/**
 * Report that memory is off, to the user and to the agent, then exit 0.
 * `fix` is the concrete next action — never just "something went wrong".
 */
function unavailable(reason, fix) {
	emit({
		systemMessage: `Itsuki: ${reason} Project memory is OFF for this session. ${fix}`,
		hookSpecificOutput: {
			hookEventName: "SessionStart",
			additionalContext:
				`Itsuki project memory is unavailable this session (${reason}). ` +
				`Do not claim to have memory of previous sessions. If the user asks about it, tell them: ${fix}`,
		},
	});
}

const SETUP_FIX =
	"Create a key at https://itsuki.app under API keys, set ITSUKI_API_KEY in your shell profile, then restart your shell.";

async function main() {
	const project = basename(process.cwd()) || "project";

	if (!API_KEY) {
		unavailable("ITSUKI_API_KEY is not set.", SETUP_FIX);
		return;
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

	let res;
	try {
		res = await fetch(`${BASE_URL}/v1/recall`, {
			method: "POST",
			signal: controller.signal,
			headers: {
				authorization: `Bearer ${API_KEY}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				// The project name selects an isolated project-scoped memory
				// space (a sub-tenant of the key's account) — the plugin door
				// gets project scope, personal chat memory stays out of repos.
				userId: `project:${project}`,
				query: `project decisions, conventions, architecture, and fixes for ${project}`,
			}),
		});
	} catch (error) {
		const timedOut = error?.name === "AbortError";
		unavailable(
			timedOut ? `${BASE_URL} did not answer within ${TIMEOUT_MS / 1000}s.` : `could not reach ${BASE_URL}.`,
			"This is usually a network problem, not a setup problem. The session continues normally.",
		);
		return;
	} finally {
		clearTimeout(timer);
	}

	if (res.status === 401 || res.status === 403) {
		unavailable(`the server rejected ITSUKI_API_KEY (HTTP ${res.status}).`, `The key is revoked or mistyped. ${SETUP_FIX}`);
		return;
	}
	if (!res.ok) {
		unavailable(`the memory service answered HTTP ${res.status}.`, "Nothing to fix locally — the session continues normally.");
		return;
	}

	let context = "";
	try {
		const data = await res.json();
		context = String(data?.context ?? "").trim();
	} catch {
		unavailable("the memory service sent a response this hook could not read.", "The session continues normally.");
		return;
	}

	// A new project with nothing stored yet is the normal, quiet case — the key
	// works, there is simply no history. Saying nothing here is correct.
	if (!context) return;

	emit({
		hookSpecificOutput: {
			hookEventName: "SessionStart",
			additionalContext:
				`Itsuki project memory for ${project} (from previous sessions):\n${context}\n` +
				`(Use this as established context. Durable new decisions from this session are saved automatically at session end.)`,
		},
	});
}

main().then(() => process.exit(0), () => process.exit(0));
