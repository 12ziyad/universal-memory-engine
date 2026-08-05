/**
 * Itsuki SessionStart hook — print project memory into the session so the
 * agent knows the project before the user types.
 *
 * Two rules, and they are not in conflict:
 *
 *   1. NEVER block or break a session. Always exit 0. A memory tool that
 *      breaks someone's coding session gets uninstalled the same afternoon.
 *   2. NEVER fail invisibly, and never fail with the WRONG reason. A garbage
 *      key used to be reported as "could not reach the server" because the
 *      fetch threw on the Authorization header before any network I/O
 *      (undici UND_ERR_INVALID_ARG). Diagnose locally first, and when the
 *      network really is the problem, name the underlying error code.
 */

import {
	PROJECT_RECALL_SCOPE,
	claudeProjectDirectory,
	projectMemoryScope,
	resolveProjectIdentity,
} from "./project-identity.mjs";

const API_KEY = process.env.ITSUKI_API_KEY;
const BASE_URL = (process.env.ITSUKI_BASE_URL || "https://itsuki.app").replace(/\/+$/, "");
const TIMEOUT_MS = Number(process.env.ITSUKI_TIMEOUT_MS) > 0 ? Number(process.env.ITSUKI_TIMEOUT_MS) : 8000;

/** SessionStart includes the project cwd on stdin. Invalid or absent input
 * falls back to the process cwd, preserving the hook's non-blocking behavior. */
async function readStdin() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	if (!chunks.length) return {};
	try {
		const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		return payload && typeof payload === "object" ? payload : {};
	} catch {
		return {};
	}
}

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
	"Create a key at https://itsuki.app under API keys, set ITSUKI_API_KEY in your shell profile, then restart your shell. Run /itsuki:doctor to verify.";

/**
 * A key that cannot ride in an HTTP header must be caught BEFORE fetch, or
 * undici throws and the failure gets misread as a network problem. This is
 * exactly what a mangled paste produces: a control character (Ctrl-V typed
 * into a console that doesn't paste), a copied placeholder, a stray newline.
 */
function keyProblem(key) {
	if (!key) return "ITSUKI_API_KEY is not set.";
	if (!/^[!-~]+$/.test(key)) {
		return (
			"ITSUKI_API_KEY is set but is not a usable key — it contains characters " +
			"that cannot go in an HTTP header (length " + key.length + "). This is usually a paste that " +
			"didn't paste: Ctrl-V in some Windows consoles inserts a control character instead. " +
			"Real keys are plain text starting with itsuki_live_."
		);
	}
	return null;
}

/** Name the real cause: DNS, TLS, refused, timeout — not just "unreachable". */
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
		unavailable(problem, SETUP_FIX);
		return;
	}

	const payload = await readStdin();
	const project = await resolveProjectIdentity(claudeProjectDirectory(payload?.cwd));
	const memoryScope = projectMemoryScope(project);

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
				query: `project decisions, conventions, architecture, and fixes for ${project.projectName}`,
				memoryScope,
				recallScope: PROJECT_RECALL_SCOPE,
			}),
		});
	} catch (error) {
		unavailable(describeNetworkError(error), "Run /itsuki:doctor for a full connection check. The session continues normally.");
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
				`Itsuki project memory for ${project.projectName} (from previous sessions):\n${context}\n` +
				`(Use this as established context. Durable new decisions from this session are saved automatically at session end.)`,
		},
	});
}

main().then(() => process.exit(0), () => process.exit(0));
