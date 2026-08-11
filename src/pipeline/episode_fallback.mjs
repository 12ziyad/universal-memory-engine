/**
 * E9B: bounded lexical fallback over scrubbed source episodes.
 *
 * This is deliberately not a second semantic memory system. It runs only when
 * the selected semantic result is structurally thin, retrieves a small scoped
 * FTS pool, removes exact-source duplicates, and contributes bounded evidence
 * to the existing context compiler.
 */

import { findSourceEpisodesDetailed } from "./episodes.js";
import { scrubText } from "./scrub.js";

export const EPISODE_FALLBACK_CANDIDATE_MAX = 8;
export const EPISODE_FALLBACK_RENDER_MAX = 4;
export const EPISODE_FALLBACK_TEXT_CODEPOINT_MAX = 700;
export const EPISODE_FALLBACK_CHAR_MAX = 3200;
export const EPISODE_FALLBACK_QUERY_TERM_MAX = 12;

const QUERY_STOPWORDS = new Set(
	"a an the and or but of in on at to for with is are was were be been being it its this that these those he she they them his her their i you we my your our as from by what which why how when where does did do".split(" "),
);

export function emptyEpisodeFallbackResult(overrides = {}) {
	return {
		lines: [],
		triggered: false,
		reason: "disabled",
		queryTerms: 0,
		candidates: 0,
		eligible: 0,
		episodes: 0,
		chars: 0,
		duplicateEpisodes: 0,
		latencyMs: 0,
		episodeIds: [],
		failed: false,
		...overrides,
	};
}

export function episodeFallbackQueryTokens(value) {
	const normalized = String(value ?? "")
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase();
	const out = [];
	const seen = new Set();
	for (const token of normalized.match(/[\p{L}\p{N}]+/gu) ?? []) {
		if (token.length <= 1 || QUERY_STOPWORDS.has(token) || seen.has(token)) continue;
		seen.add(token);
		out.push(token);
		if (out.length >= EPISODE_FALLBACK_QUERY_TERM_MAX) break;
	}
	return out;
}

export function episodeFallbackDecision({ entries = [], sourceExpansion = {} } = {}) {
	const semanticItems = Array.isArray(entries) ? entries.length : 0;
	if (semanticItems <= 2) return { triggered: true, reason: "sparse_semantic_items", semanticItems };
	const assertions = Number(sourceExpansion?.assertions ?? 0);
	const linked = Number(sourceExpansion?.linkedAssertions ?? 0);
	if (assertions > 0 && linked === 0) {
		return { triggered: true, reason: "unbacked_semantic_assertions", semanticItems };
	}
	return { triggered: false, reason: "semantic_evidence_sufficient", semanticItems };
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

function clipUtf16Units(value, limit) {
	const input = String(value ?? "");
	if (input.length <= limit) return input;
	let out = "";
	for (const point of input) {
		if (out.length + point.length + 1 > limit) break;
		out += point;
	}
	return `${out}…`;
}

function tokenOverlap(queryTokens, text) {
	const present = new Set(episodeFallbackQueryTokens(text));
	return queryTokens.filter((token) => present.has(token)).length;
}

export async function findEpisodeFallbackEvidence(env, userId, query, {
	entries = [],
	sourceExpansion = {},
	recallScope = "global",
	projectId = null,
} = {}) {
	const startedAt = Date.now();
	const decision = episodeFallbackDecision({ entries, sourceExpansion });
	if (!decision.triggered) return emptyEpisodeFallbackResult({ ...decision, latencyMs: Date.now() - startedAt });
	const queryTokens = episodeFallbackQueryTokens(query);
	if (!queryTokens.length || typeof userId !== "string" || !userId) {
		return emptyEpisodeFallbackResult({
			...decision,
			reason: queryTokens.length ? "missing_user" : "no_query_terms",
			queryTerms: queryTokens.length,
			latencyMs: Date.now() - startedAt,
		});
	}
	const search = await findSourceEpisodesDetailed(env, userId, queryTokens, {
		limit: EPISODE_FALLBACK_CANDIDATE_MAX,
		recallScope,
		projectId,
	});
	if (search.failed) {
		return emptyEpisodeFallbackResult({
			...decision,
			queryTerms: queryTokens.length,
			failed: true,
			latencyMs: Date.now() - startedAt,
		});
	}

	const existingEpisodes = new Set((sourceExpansion?.episodeIds ?? []).map(String));
	const seenHashes = new Set();
	const eligible = [];
	let duplicateEpisodes = 0;
	const requiredOverlap = Math.min(2, queryTokens.length);
	for (const row of search.rows) {
		const episodeId = String(row?.id ?? "");
		const textHash = String(row?.text_hash ?? "");
		if (!episodeId || existingEpisodes.has(episodeId) || (textHash && seenHashes.has(textHash))) {
			duplicateEpisodes += 1;
			continue;
		}
		if (tokenOverlap(queryTokens, row?.text) < requiredOverlap) continue;
		if (textHash) seenHashes.add(textHash);
		eligible.push(row);
	}

	const lines = [];
	const episodeIds = [];
	let chars = 0;
	for (const row of eligible) {
		if (lines.length >= EPISODE_FALLBACK_RENDER_MAX || chars >= EPISODE_FALLBACK_CHAR_MAX) break;
		const rescrubbed = scrubText(row?.text).text.replace(/\s+/g, " ").trim();
		if (!rescrubbed) continue;
		const sourceText = clipCodePoints(rescrubbed, EPISODE_FALLBACK_TEXT_CODEPOINT_MAX);
		const line = `Episode fallback evidence [${timestampLabel(row)}; ${safeRole(row?.role)}]: ${sourceText}`;
		const remaining = EPISODE_FALLBACK_CHAR_MAX - chars;
		if (line.length > remaining) {
			if (remaining < 120) break;
			const clipped = clipUtf16Units(line, remaining);
			lines.push(clipped);
			chars += clipped.length;
		} else {
			lines.push(line);
			chars += line.length;
		}
		episodeIds.push(String(row.id));
	}

	return emptyEpisodeFallbackResult({
		...decision,
		queryTerms: queryTokens.length,
		candidates: search.rows.length,
		eligible: eligible.length,
		episodes: lines.length,
		chars,
		duplicateEpisodes,
		latencyMs: Date.now() - startedAt,
		lines,
		episodeIds,
	});
}
