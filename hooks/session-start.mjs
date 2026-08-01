/**
 * Itsuki SessionStart hook — print project memory into the session so the
 * agent knows the project before the user types.
 *
 * The one absolute rule: this must NEVER block or break a session. No key →
 * exit 0 silently. Slow network → abort at 4s, exit 0. Any error at all →
 * exit 0. A memory tool that breaks someone's coding session gets uninstalled
 * the same afternoon.
 */

import { basename } from "node:path";

const API_KEY = process.env.ITSUKI_API_KEY;
const BASE_URL = (process.env.ITSUKI_BASE_URL || "https://itsuki.app").replace(/\/+$/, "");
const TIMEOUT_MS = 4000;

async function main() {
	if (!API_KEY) return; // not configured — stay invisible

	const project = basename(process.cwd()) || "project";
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

	try {
		const res = await fetch(`${BASE_URL}/v1/recall`, {
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
		if (!res.ok) return;
		const data = await res.json();
		const context = String(data?.context ?? "").trim();
		if (!context) return;

		// Claude Code reads additionalContext from stdout JSON.
		process.stdout.write(JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "SessionStart",
				additionalContext:
					`Itsuki project memory for ${project} (from previous sessions):\n${context}\n` +
					`(Use this as established context. Durable new decisions from this session are saved automatically at session end.)`,
			},
		}));
	} catch {
		// Silent by design.
	} finally {
		clearTimeout(timer);
	}
}

main().then(() => process.exit(0), () => process.exit(0));
