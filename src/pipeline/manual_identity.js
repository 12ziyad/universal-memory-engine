import { canonicalizeCategory } from "./gates.js";

const GENERIC_IDENTITY_WORDS = new Set([
	"app",
	"application",
	"database",
	"framework",
	"habit",
	"project",
	"service",
	"skill",
	"system",
	"tool",
	"workspace",
]);

const ACRONYM_STOPWORDS = new Set(["a", "an", "and", "for", "of", "the", "to"]);

export const MANUAL_IDENTITY_MERGE_MIN = 0.94;
export const MANUAL_IDENTITY_MARGIN_MIN = 0.08;

const CLUB_NAME_MARKERS = new Set([
	"albion",
	"athletic",
	"city",
	"county",
	"dynamo",
	"inter",
	"olympic",
	"olympique",
	"real",
	"rovers",
	"sporting",
	"town",
	"united",
	"wanderers",
]);

const HUMAN_CATEGORIES = new Set(["person", "family", "relationship"]);

function safeJsonArray(value) {
	if (Array.isArray(value)) return value.map(String).filter(Boolean);
	try {
		const parsed = JSON.parse(value || "[]");
		return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
	} catch {
		return [];
	}
}

/**
 * Canonical identity text used only by the isolated manual lane. It keeps common
 * programming-language identities distinct (C, C++, C#) and supports Unicode
 * letters instead of collapsing every non-ASCII name to an empty string.
 */
export function canonicalIdentity(value) {
	return String(value ?? "")
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "")
		.replace(/\bc\+\+/gi, " cpp ")
		.replace(/\bc#/gi, " csharp ")
		.replace(/\.net\b/gi, " dotnet ")
		.replace(/node\.js\b/gi, " nodejs ")
		.toLocaleLowerCase("en-US")
		.replace(/&/g, " and ")
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function manualNodeAliases(node) {
	return safeJsonArray(node?.aliases_json ?? node?.aliases);
}

export function manualIdentityNames(node) {
	return [node?.label, node?.canonical_label, ...manualNodeAliases(node)]
		.map((value) => String(value ?? "").trim())
		.filter(Boolean);
}

function identityTokens(value) {
	return canonicalIdentity(value).split(" ").filter(Boolean);
}

function compactIdentity(value) {
	return canonicalIdentity(value).replace(/\s+/g, "");
}

function singularToken(value) {
	if (value.length > 4 && value.endsWith("ies")) return `${value.slice(0, -3)}y`;
	if (value.length > 4 && value.endsWith("s") && !value.endsWith("ss")) return value.slice(0, -1);
	return value;
}

function singularIdentity(value) {
	return identityTokens(value).map(singularToken).join(" ");
}

function coreIdentity(value) {
	const all = identityTokens(value);
	const core = all.filter((token) => !GENERIC_IDENTITY_WORDS.has(token));
	return (core.length ? core : all).join(" ");
}

function acronym(value) {
	const words = identityTokens(value).filter((word) => !ACRONYM_STOPWORDS.has(word));
	if (words.length < 2) return "";
	return words.map((word) => word[0]).join("");
}

function stripClubSuffix(value) {
	const tokens = Array.isArray(value) ? [...value] : identityTokens(value);
	let stripped = false;
	if (tokens.length >= 2 && tokens.at(-2) === "football" && tokens.at(-1) === "club") {
		tokens.splice(-2, 2);
		stripped = true;
	} else if (tokens.length >= 2 && tokens.at(-2) === "f" && tokens.at(-1) === "c") {
		tokens.splice(-2, 2);
		stripped = true;
	} else if (tokens.at(-1) === "fc") {
		tokens.pop();
		stripped = true;
	}
	return { tokens, stripped };
}

function clubAcronym(value) {
	const { tokens } = stripClubSuffix(value);
	if (tokens.length < 2 || !tokens.some((token) => CLUB_NAME_MARKERS.has(token))) return "";
	return `${tokens.map((token) => token[0]).join("")}fc`;
}

function safeTokenAbbreviation(left, right) {
	const a = stripClubSuffix(left).tokens;
	const b = stripClubSuffix(right).tokens;
	if (a.length < 2 || a.length !== b.length) return false;
	let abbreviated = 0;
	let exactDistinctive = 0;
	for (let index = 0; index < a.length; index++) {
		if (a[index] === b[index]) {
			if (a[index].length >= 4) exactDistinctive++;
			continue;
		}
		const shorter = a[index].length <= b[index].length ? a[index] : b[index];
		const longer = a[index].length > b[index].length ? a[index] : b[index];
		if (shorter.length < 3 || longer.length < 6 || !longer.startsWith(shorter)) return false;
		abbreviated++;
	}
	return abbreviated === 1 && exactDistinctive >= 1;
}

function jaccard(left, right) {
	const a = new Set(identityTokens(left));
	const b = new Set(identityTokens(right));
	if (!a.size || !b.size) return 0;
	let shared = 0;
	for (const token of a) if (b.has(token)) shared++;
	return shared / (a.size + b.size - shared);
}

function levenshtein(left, right) {
	const a = canonicalIdentity(left);
	const b = canonicalIdentity(right);
	if (!a.length) return b.length;
	if (!b.length) return a.length;
	let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
	let current = new Array(b.length + 1);
	for (let i = 1; i <= a.length; i++) {
		current[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
		}
		[previous, current] = [current, previous];
	}
	return previous[b.length];
}

function editRatio(left, right) {
	const a = canonicalIdentity(left);
	const b = canonicalIdentity(right);
	const longest = Math.max(a.length, b.length);
	return longest ? 1 - levenshtein(a, b) / longest : 1;
}

/**
 * Name-only identity evidence. Context, graph affinity, vectors, pages, and
 * topic similarity deliberately do not participate in this score.
 */
export function manualIdentityEvidence(left, right) {
	const a = canonicalIdentity(left);
	const b = canonicalIdentity(right);
	if (!a || !b) return { score: 0, kind: "none", authoritative: false, reason_codes: [] };
	if (a === b) return { score: 1, kind: "exact", authoritative: true, reason_codes: ["exact_name"] };
	if (compactIdentity(a) === compactIdentity(b)) {
		return { score: 0.98, kind: "compact", authoritative: false, reason_codes: ["compact_name_match"] };
	}
	if (singularIdentity(a) === singularIdentity(b)) {
		return { score: 0.96, kind: "singular", authoritative: false, reason_codes: ["singular_name_match"] };
	}
	const aClub = stripClubSuffix(a);
	const bClub = stripClubSuffix(b);
	if (
		(aClub.stripped || bClub.stripped) &&
		aClub.tokens.length >= 2 &&
		aClub.tokens.join(" ") === bClub.tokens.join(" ")
	) {
		return { score: 0.97, kind: "club_suffix", authoritative: false, reason_codes: ["club_suffix_match"] };
	}
	if (safeTokenAbbreviation(a, b)) {
		return { score: 0.95, kind: "token_abbreviation", authoritative: false, reason_codes: ["safe_token_abbreviation"] };
	}
	const aAcronym = acronym(a);
	const bAcronym = acronym(b);
	const aCompact = compactIdentity(a);
	const bCompact = compactIdentity(b);
	if (
		(clubAcronym(a) && clubAcronym(a) === bCompact) ||
		(clubAcronym(b) && clubAcronym(b) === aCompact)
	) {
		return { score: 0.95, kind: "club_acronym", authoritative: false, reason_codes: ["safe_club_acronym"] };
	}
	if ((aAcronym && aAcronym === bCompact) || (bAcronym && bAcronym === aCompact)) {
		return { score: 0.94, kind: "acronym", authoritative: false, reason_codes: ["acronym_match"] };
	}
	if (
		coreIdentity(a) === coreIdentity(b) &&
		(coreIdentity(a) !== a || coreIdentity(b) !== b) &&
		coreIdentity(a)
	) {
		// Sharing a distinctive stem after stripping a generic type word is useful
		// shortlist evidence, but it is not identity. "Atlas Database" and "Atlas
		// Service", for example, may be separate durable objects. Keep this score in
		// the resolver's conflict band instead of the automatic-merge band.
		return { score: 0.84, kind: "shared_core", authoritative: false, reason_codes: ["shared_distinctive_core"] };
	}
	const overlap = jaccard(a, b);
	const edit = editRatio(a, b);
	if (Math.min(a.length, b.length) >= 5 && edit >= 0.92) {
		return {
			score: edit * 0.96,
			kind: "spelling",
			authoritative: false,
			reason_codes: ["close_spelling"],
		};
	}
	if (overlap >= 0.88 && edit >= 0.82) {
		return {
			score: Math.min(0.9, overlap * 0.55 + edit * 0.4),
			kind: "token_overlap",
			authoritative: false,
			reason_codes: ["name_token_overlap"],
		};
	}
	return { score: 0, kind: "none", authoritative: false, reason_codes: [] };
}

/** A deliberately conservative identity score. Content similarity is not identity. */
export function manualIdentitySimilarity(left, right) {
	return manualIdentityEvidence(left, right).score;
}

export function manualCategoryCompatibility(identity, node) {
	const wanted = canonicalizeCategory(identity?.category);
	const existing = canonicalizeCategory(node?.category);
	if (!wanted || !existing || wanted === "other" || existing === "other") {
		return { compatible: true, hard_conflict: false, reason_code: "category_unknown" };
	}
	if (wanted === existing) return { compatible: true, hard_conflict: false, reason_code: "category_exact" };
	if (wanted === "place" || existing === "place") {
		return { compatible: false, hard_conflict: true, reason_code: "place_category_conflict" };
	}
	if (HUMAN_CATEGORIES.has(wanted) !== HUMAN_CATEGORIES.has(existing)) {
		return { compatible: false, hard_conflict: true, reason_code: "human_category_conflict" };
	}
	if (wanted === "life_event" || existing === "life_event") {
		return { compatible: false, hard_conflict: true, reason_code: "event_category_conflict" };
	}
	return { compatible: true, hard_conflict: false, reason_code: "category_compatible" };
}

export function scoreManualIdentity(identity, node) {
	let bestEvidence = manualIdentityEvidence("", "");
	let matchedName = null;
	for (const name of manualIdentityNames(node)) {
		const evidence = manualIdentityEvidence(identity?.label, name);
		if (evidence.score > bestEvidence.score) {
			bestEvidence = evidence;
			matchedName = name;
		}
	}
	const category = manualCategoryCompatibility(identity, node);
	return {
		node,
		score: category.hard_conflict ? 0 : bestEvidence.score,
		nameScore: bestEvidence.score,
		matchedName,
		evidence: bestEvidence,
		category,
	};
}

export function rankManualIdentityCandidates(identity, nodes = []) {
	return nodes
		.map((node) => scoreManualIdentity(identity, node))
		.sort((left, right) =>
			right.score - left.score ||
			right.nameScore - left.nameScore ||
			String(left.node.id).localeCompare(String(right.node.id)));
}

function publicMatch(match) {
	return {
		id: match.node.id,
		label: match.node.label,
		category: match.node.category ?? null,
		score: Number(match.score.toFixed(3)),
		name_score: Number(match.nameScore.toFixed(3)),
		category_compatible: !match.category.hard_conflict,
		matched_name: match.matchedName,
		reason_codes: [
			...(match.evidence.reason_codes ?? []),
			...(match.category.reason_code ? [match.category.reason_code] : []),
		],
	};
}

function insideIdentityMargin(best, second) {
	return Boolean(second && best.score - second.score < MANUAL_IDENTITY_MARGIN_MIN);
}

/**
 * Resolve a proposed identity without trusting the model's node id. Ambiguous
 * near matches fail closed so the caller can return a conflict receipt instead
 * of creating or mutating the wrong node.
 */
export function resolveManualIdentity(identity, nodes = []) {
	const label = String(identity?.label ?? "").trim();
	const key = canonicalIdentity(label);
	if (!key) return { decision: "invalid", label, reason: "empty_identity" };
	if (identity?._manual_conflict_reason) {
		return {
			decision: "ambiguous",
			label,
			reason: String(identity._manual_conflict_reason),
			matches: [],
		};
	}

	const requestedId = identity?.existing_node_id ?? identity?.matches_existing ?? null;
	const ranked = rankManualIdentityCandidates(identity, nodes);
	if (requestedId) {
		const requested = ranked.find((match) => match.node.id === requestedId);
		if (!requested) {
			return {
				decision: "ambiguous",
				label,
				reason: "unknown_existing_node_hint",
				matches: [],
			};
		}
		if (requested.category.hard_conflict || requested.score < MANUAL_IDENTITY_MERGE_MIN) {
			return {
				decision: "ambiguous",
				label,
				reason: "existing_node_hint_mismatch",
				matches: [publicMatch(requested)],
			};
		}
	}

	const scored = ranked
		.filter((match) => !match.category.hard_conflict)
		.filter((match) => match.score >= 0.8)
		.sort((left, right) => right.score - left.score || String(left.node.id).localeCompare(String(right.node.id)));
	const categoryConflicts = ranked.filter((match) =>
		match.category.hard_conflict && match.nameScore >= MANUAL_IDENTITY_MERGE_MIN);

	if (requestedId) {
		const requested = scored.find((match) => match.node.id === requestedId);
		const rivals = scored.filter((match) =>
			match.node.id !== requestedId && match.score >= MANUAL_IDENTITY_MERGE_MIN);
		const rival = requested.evidence.authoritative
			? rivals.find((match) => match.evidence.authoritative)
			: rivals.find((match) => insideIdentityMargin(requested, match) || match.score > requested.score);
		if (rival) {
			return {
				decision: "ambiguous",
				label,
				reason: "existing_node_hint_conflicts_with_identity",
				matches: [requested, rival].map(publicMatch),
			};
		}
		return { decision: "existing", label, node: requested.node, score: requested.score, matched_name: requested.matchedName };
	}

	const exact = scored.filter((match) => match.evidence.authoritative);
	if (exact.length === 1) {
		const best = exact[0];
		return { decision: "existing", label, node: best.node, score: best.score, matched_name: best.matchedName };
	}
	if (exact.length > 1) {
		return {
			decision: "ambiguous",
			label,
			reason: "multiple_existing_nodes_match",
			matches: exact.slice(0, 4).map(publicMatch),
		};
	}

	const deterministic = scored.filter((match) => match.score >= MANUAL_IDENTITY_MERGE_MIN);
	if (deterministic.length) {
		const best = deterministic[0];
		const second = scored.find((match) => match.node.id !== best.node.id);
		if (insideIdentityMargin(best, second)) {
			return {
				decision: "ambiguous",
				label,
				reason: "multiple_existing_nodes_match",
				matches: deterministic.slice(0, 4).map(publicMatch),
			};
		}
		return { decision: "existing", label, node: best.node, score: best.score, matched_name: best.matchedName };
	}
	if (categoryConflicts.length) {
		return {
			decision: "ambiguous",
			label,
			reason: "identity_category_conflict",
			matches: categoryConflicts.slice(0, 4).map(publicMatch),
		};
	}
	if (!scored.length) return { decision: "new", label, canonical_key: key };
	return {
		decision: "ambiguous",
		label,
		reason: "possible_existing_node_match",
		matches: scored.slice(0, 4).map(publicMatch),
	};
}

export function candidateMatchesManualNode(candidate, node, observedLabels = []) {
	if (!candidate || !node) return false;
	const candidateNames = [candidate.label_guess, candidate.label, candidate.canonical_key].filter(Boolean);
	const nodeNames = [...manualIdentityNames(node), ...observedLabels].filter(Boolean);
	if (!candidateNames.length || !nodeNames.length) return false;
	// possible_existing_node_id is a stale/heuristic hint, never proof and never
	// lowers the deterministic identity threshold.
	const threshold = MANUAL_IDENTITY_MERGE_MIN;
	return candidateNames.some((candidateName) =>
		nodeNames.some((nodeName) => manualIdentitySimilarity(candidateName, nodeName) >= threshold));
}
