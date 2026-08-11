/**
 * Classify the source-episode acknowledgement without confusing a fresh write
 * with an exact terminal replay.
 *
 * Fresh/repaired writes carry the current call's top-level episode counters and
 * must prove exact conservation immediately. An already-terminal idempotent
 * replay returns its original receipt and deliberately omits those top-level
 * counters. That replay is allowed to defer conservation only to Stage E's
 * later exact source_episodes audit; an explicit zero or partial count remains
 * a hard failure.
 */
export function classifySourceEpisodeAcknowledgement(body, expected) {
	if (!Number.isInteger(expected) || expected <= 0) {
		throw new Error(`invalid expected source episode count: ${expected}`);
	}
	const present = Object.prototype.hasOwnProperty.call(body ?? {}, "source_episodes_written");
	const reported = present ? Number(body.source_episodes_written) : null;
	if (present && Number.isInteger(reported) && reported === expected) {
		return { mode: "response_verified", reported, expected };
	}
	if (!present && body?.duplicate === true) {
		return { mode: "deferred_exact_terminal_replay", reported: null, expected };
	}
	throw new Error(`source episode conservation failed: reported=${present ? reported : "missing"} expected=${expected} duplicate=${body?.duplicate === true}`);
}
