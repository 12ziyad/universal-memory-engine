/**
 * Server-side error capture for the admin Health tab. One rule everywhere:
 * users see calm messages, the real detail lands here. Lives in lib (not
 * index.js) so background lanes — the Durable Object's enrichment jobs — can
 * report without importing the router.
 */

import { scrubText } from "../pipeline/scrub.js";

/** Best-effort. Logs always; the D1 write may fail silently, never throws. */
export async function reportServerError(env, scope, error, userId = null, { reportId = null } = {}) {
	console.error(`unhandled error scope=${scope}:`, error?.stack ?? error?.message ?? error);
	try {
		await env.DB.prepare(
			`INSERT INTO error_reports (id, user_id, side, scope, message, created_at)
			 VALUES (?, ?, 'server', ?, ?, ?)
			 ON CONFLICT(id) DO NOTHING`,
		).bind(
			reportId ?? `err_${crypto.randomUUID()}`,
			userId,
			String(scope ?? "unknown").slice(0, 120),
			// Scrubbed before it lands: an extraction or parse failure can quote
			// the payload that broke it, and this table must never become a copy
			// of memory text or a credential. Same scrubber the model inputs use.
			scrubText(String(error?.message ?? error ?? "unknown")).text.slice(0, 400),
			Date.now(),
		).run();
	} catch (writeError) {
		console.warn("error report write failed:", writeError?.message ?? writeError);
	}
}
