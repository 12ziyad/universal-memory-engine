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

/** A deliberately conservative identity score. Content similarity is not identity. */
export function manualIdentitySimilarity(left, right) {
	const a = canonicalIdentity(left);
	const b = canonicalIdentity(right);
	if (!a || !b) return 0;
	if (a === b) return 1;
	if (compactIdentity(a) === compactIdentity(b)) return 0.98;
	if (singularIdentity(a) === singularIdentity(b)) return 0.96;
	const aAcronym = acronym(a);
	const bAcronym = acronym(b);
	if ((aAcronym && aAcronym === compactIdentity(b)) || (bAcronym && bAcronym === compactIdentity(a))) return 0.94;
	if (
		coreIdentity(a) === coreIdentity(b) &&
		(coreIdentity(a) !== a || coreIdentity(b) !== b) &&
		coreIdentity(a)
	) {
		// Sharing a distinctive stem after stripping a generic type word is useful
		// shortlist evidence, but it is not identity. "Atlas Database" and "Atlas
		// Service", for example, may be separate durable objects. Keep this score in
		// the resolver's conflict band instead of the automatic-merge band.
		return 0.84;
	}
	const overlap = jaccard(a, b);
	const edit = editRatio(a, b);
	if (Math.min(a.length, b.length) >= 5 && edit >= 0.92) return edit * 0.96;
	if (overlap >= 0.88 && edit >= 0.82) return Math.min(0.9, overlap * 0.55 + edit * 0.4);
	return 0;
}

function categoryAdjustment(identity, node) {
	const wanted = canonicalizeCategory(identity?.category);
	const existing = canonicalizeCategory(node?.category);
	if (!wanted || !existing || wanted === "other" || existing === "other") return 0;
	return wanted === existing ? 0.01 : -0.02;
}

function scoreNode(identity, node) {
	let best = 0;
	let matchedName = null;
	for (const name of manualIdentityNames(node)) {
		const score = manualIdentitySimilarity(identity?.label, name);
		if (score > best) {
			best = score;
			matchedName = name;
		}
	}
	return { node, score: Math.max(0, Math.min(1, best + categoryAdjustment(identity, node))), matchedName };
}

function publicMatch(match) {
	return {
		id: match.node.id,
		label: match.node.label,
		category: match.node.category ?? null,
		score: Number(match.score.toFixed(3)),
		matched_name: match.matchedName,
	};
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
	if (requestedId) {
		const requested = nodes.find((node) => node.id === requestedId);
		if (!requested) {
			return {
				decision: "ambiguous",
				label,
				reason: "unknown_existing_node_hint",
				matches: [],
			};
		}
		const scored = scoreNode(identity, requested);
		if (scored.score < 0.8) {
			return {
				decision: "ambiguous",
				label,
				reason: "existing_node_hint_mismatch",
				matches: [publicMatch(scored)],
			};
		}
	}

	const scored = nodes
		.map((node) => scoreNode(identity, node))
		.filter((match) => match.score >= 0.8)
		.sort((left, right) => right.score - left.score || String(left.node.id).localeCompare(String(right.node.id)));

	if (requestedId) {
		const requested = scored.find((match) => match.node.id === requestedId);
		const rival = scored.find((match) => match.node.id !== requestedId && match.score >= requested.score - 0.04);
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

	if (!scored.length) return { decision: "new", label, canonical_key: key };
	const best = scored[0];
	const second = scored[1];
	if (second && second.score >= best.score - 0.06) {
		const wantedCategory = canonicalizeCategory(identity?.category);
		const categoryWinners = wantedCategory && wantedCategory !== "other"
			? scored.filter((match) => canonicalizeCategory(match.node.category) === wantedCategory)
			: [];
		if (best.score >= 0.88 && categoryWinners.length === 1 && categoryWinners[0].node.id === best.node.id) {
			return { decision: "existing", label, node: best.node, score: best.score, matched_name: best.matchedName };
		}
		return {
			decision: "ambiguous",
			label,
			reason: "multiple_existing_nodes_match",
			matches: scored.slice(0, 4).map(publicMatch),
		};
	}
	if (best.score >= 0.88) {
		return { decision: "existing", label, node: best.node, score: best.score, matched_name: best.matchedName };
	}
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
	// possible_existing_node_id is a stale/heuristic hint, never proof. It may
	// relax a small spelling-variation threshold, but compatible identity text is
	// still required before a manual save resolves the pending review item.
	const threshold = candidate.possible_existing_node_id === node.id ? 0.88 : 0.92;
	return candidateNames.some((candidateName) =>
		nodeNames.some((nodeName) => manualIdentitySimilarity(candidateName, nodeName) >= threshold));
}
