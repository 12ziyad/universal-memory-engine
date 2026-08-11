/**
 * E9A: bounded, exact source-evidence expansion.
 *
 * This module never searches source text and never guesses provenance. It can
 * only follow an E7 assertion that is about to be rendered through the durable
 * projection -> candidate -> scrubbed episode chain written by E4/E6.
 */

import { scrubText } from "./scrub.js";

export const SOURCE_EXPANSION_ASSERTION_MAX = 12;
export const SOURCE_EXPANSION_EPISODE_MAX = 8;
export const SOURCE_EXPANSION_TEXT_CODEPOINT_MAX = 700;

const OBJECT_KINDS = new Set(["slice", "event", "edge"]);

function emptyResult(overrides = {}) {
	return {
		lines: [],
		assertions: 0,
		linkedAssertions: 0,
		episodes: 0,
		chars: 0,
		latencyMs: 0,
		episodeIds: [],
		assertionIds: [],
		failed: false,
		...overrides,
	};
}

function selectedAssertions(entries, maxLineItems) {
	const selected = [];
	const seen = new Set();
	const lineLimit = Math.max(0, Number.isInteger(maxLineItems) ? maxLineItems : 4);
	for (const entry of entries ?? []) {
		if (entry?.type !== "node" || !Array.isArray(entry?.item?.evidence)) continue;
		for (const evidence of entry.item.evidence.slice(0, lineLimit)) {
			const key = String(evidence?.key ?? "");
			const colon = key.indexOf(":");
			if (colon <= 0) continue;
			const kind = key.slice(0, colon);
			const id = key.slice(colon + 1);
			if (!OBJECT_KINDS.has(kind) || !id || seen.has(key)) continue;
			seen.add(key);
			selected.push({ key, kind, id });
			if (selected.length >= SOURCE_EXPANSION_ASSERTION_MAX) return selected;
		}
	}
	return selected;
}

function projectPredicate(recallScope, projectId) {
	if (recallScope !== "global" && recallScope !== "project_only" && recallScope !== "project_then_global") {
		return { sql: " AND 1 = 0", bindings: [] };
	}
	if (recallScope === "project_only") {
		return projectId
			? { sql: " AND p.project_id = ?", bindings: [projectId] }
			: { sql: " AND 1 = 0", bindings: [] };
	}
	if (recallScope === "project_then_global") {
		return projectId
			? { sql: " AND (p.project_id = ? OR p.project_id IS NULL)", bindings: [projectId] }
			: { sql: " AND p.project_id IS NULL", bindings: [] };
	}
	return { sql: "", bindings: [] };
}

function validTimestamp(value) {
	const numeric = Number(value);
	if (!Number.isFinite(numeric) || numeric <= 0) return null;
	const date = new Date(numeric);
	return Number.isNaN(date.getTime()) ? null : date;
}

function timestampLabel(row) {
	const source = validTimestamp(row?.source_time);
	if (source) {
		const iso = source.toISOString();
		return `source message time ${row?.source_time_precision === "day" ? iso.slice(0, 10) : iso}`;
	}
	const observed = validTimestamp(row?.observed_at);
	if (observed) return `observed time ${observed.toISOString()}`;
	return "message time unavailable";
}

function safeRole(value) {
	const role = String(value ?? "").trim().toLowerCase();
	return role === "user" || role === "assistant" ? role : "speaker";
}

function clipCodePoints(value, limit) {
	const points = [...String(value ?? "")];
	if (points.length <= limit) return points.join("");
	return `${points.slice(0, Math.max(0, limit - 1)).join("")}…`;
}

/**
 * Resolve the source episode for each selected assertion. All identity and
 * scope constraints are in SQL before the bounded result; no global result is
 * ever fetched and post-filtered.
 */
export async function expandSelectedSourceEvidence(env, userId, entries = [], {
	maxLineItems = 4,
	recallScope = "global",
	projectId = null,
} = {}) {
	const startedAt = Date.now();
	const assertions = selectedAssertions(entries, maxLineItems);
	if (typeof userId !== "string" || !userId || !assertions.length) {
		return emptyResult({ assertions: assertions.length, latencyMs: Date.now() - startedAt });
	}
	const scope = projectPredicate(String(recallScope ?? "global"), projectId);
	const objectPredicates = assertions.map(() => "(p.object_kind = ? AND p.object_id = ?)").join(" OR ");
	const objectBindings = assertions.flatMap(({ kind, id }) => [kind, id]);
	try {
		const { results } = await env.DB.prepare(
			`WITH exact_source AS (
				SELECT p.object_kind, p.object_id, p.candidate_id,
					e.id AS episode_id, e.text, e.role, e.message_id, e.message_index,
					e.source_packet_id, e.project_id, e.source_time,
					e.source_time_offset_minutes, e.source_time_precision,
					e.observed_at, p.created_at AS projection_created_at,
					ROW_NUMBER() OVER (
						PARTITION BY p.object_kind, p.object_id
						ORDER BY p.created_at DESC, p.candidate_id DESC
					) AS source_rank
				 FROM semantic_atom_projections p
				 JOIN semantic_atom_candidates c
				   ON c.id = p.candidate_id AND c.user_id = p.user_id
				  AND c.project_id IS p.project_id
				  AND c.source_episode_id = p.source_episode_id
				  AND c.source_packet_id = p.source_packet_id
				  AND c.status = 'promoted'
				 JOIN source_episodes e
				   ON e.id = p.source_episode_id AND e.user_id = p.user_id
				  AND e.project_id IS p.project_id
				  AND e.source_packet_id = p.source_packet_id
				  AND e.message_id = c.source_message_id
				  AND e.memory_user_id IS c.memory_user_id
				  AND e.owner_user_id IS c.owner_user_id
				  AND e.external_user_id IS c.external_user_id
				 WHERE p.user_id = ? AND p.outcome IN ('promoted', 'reinforced')
				   AND (${objectPredicates})${scope.sql}
			)
			SELECT * FROM exact_source WHERE source_rank = 1
			ORDER BY projection_created_at DESC LIMIT ?`,
		).bind(
			userId,
			...objectBindings,
			...scope.bindings,
			SOURCE_EXPANSION_ASSERTION_MAX,
		).all();

		const byAssertion = new Map((results ?? []).map((row) => [
			`${row.object_kind}:${row.object_id}`,
			row,
		]));
		const linkedAssertionIds = assertions
			.filter((assertion) => byAssertion.has(assertion.key))
			.map((assertion) => assertion.key);
		const episodeIds = [];
		const lines = [];
		const seenEpisodes = new Set();
		for (const assertion of assertions) {
			const row = byAssertion.get(assertion.key);
			if (!row) continue;
			const episodeId = String(row.episode_id ?? "");
			if (!episodeId || seenEpisodes.has(episodeId)) continue;
			if (lines.length >= SOURCE_EXPANSION_EPISODE_MAX) break;
			const rescrubbed = scrubText(row.text).text.replace(/\s+/g, " ").trim();
			if (!rescrubbed) continue;
			const sourceText = clipCodePoints(rescrubbed, SOURCE_EXPANSION_TEXT_CODEPOINT_MAX);
			lines.push(`Source evidence [${timestampLabel(row)}; ${safeRole(row.role)}]: ${sourceText}`);
			seenEpisodes.add(episodeId);
			episodeIds.push(episodeId);
		}
		return emptyResult({
			lines,
			assertions: assertions.length,
			linkedAssertions: linkedAssertionIds.length,
			episodes: lines.length,
			chars: lines.reduce((total, line) => total + line.length, 0),
			latencyMs: Date.now() - startedAt,
			episodeIds,
			assertionIds: linkedAssertionIds,
		});
	} catch {
		// Content-free by design: an exception can include SQL or driver details,
		// and neither belongs in a privacy-safe quality counter.
		console.warn("source expansion lookup failed");
		return emptyResult({ assertions: assertions.length, latencyMs: Date.now() - startedAt, failed: true });
	}
}
