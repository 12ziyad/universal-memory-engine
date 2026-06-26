/**
 * String helpers used by the trigger (classification) and the gates
 * (canonical/fuzzy node matching). Pure functions, no I/O.
 */

const STOPWORDS = new Set([
	"the",
	"a",
	"an",
	"to",
	"of",
	"and",
	"or",
	"in",
	"on",
	"at",
	"for",
	"with",
	"my",
	"i",
	"is",
	"now",
	"new",
]);

/** Lowercase, strip punctuation, collapse whitespace. */
export function normalizeLabel(s) {
	return String(s ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Content words of a string (normalized, stopwords removed). */
export function tokens(s) {
	return normalizeLabel(s)
		.split(" ")
		.filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Jaccard overlap of two token sets — 0 (disjoint) .. 1 (identical). */
export function jaccard(aTokens, bTokens) {
	const a = new Set(aTokens);
	const b = new Set(bTokens);
	if (a.size === 0 || b.size === 0) return 0;
	let inter = 0;
	for (const t of a) if (b.has(t)) inter++;
	return inter / (a.size + b.size - inter);
}

/** Levenshtein edit distance (small strings only). */
export function levenshtein(a, b) {
	const m = a.length;
	const n = b.length;
	if (m === 0) return n;
	if (n === 0) return m;
	let prev = Array.from({ length: n + 1 }, (_, i) => i);
	let curr = new Array(n + 1);
	for (let i = 1; i <= m; i++) {
		curr[0] = i;
		for (let j = 1; j <= n; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
		}
		[prev, curr] = [curr, prev];
	}
	return prev[n];
}

/** Similarity ratio 0..1 derived from edit distance. */
export function levenshteinRatio(a, b) {
	const max = Math.max(a.length, b.length);
	if (max === 0) return 1;
	return 1 - levenshtein(a, b) / max;
}

/**
 * Does `a` contain `b` (or vice versa) as a whole-word run? Catches
 * "Boxing Practice" ⊇ "Boxing" without matching "box" inside "boxer".
 */
export function wordContains(a, b) {
	if (!a || !b) return false;
	if (a === b) return true;
	const re = new RegExp(`\\b${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
	return re.test(a);
}
