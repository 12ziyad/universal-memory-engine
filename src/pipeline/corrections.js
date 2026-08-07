/**
 * Correction semantics (SUPERSEDE-01).
 *
 * A user correction must retire the fact it corrects — and nothing else.
 *
 * Two failures made that untrue. First, the correction vocabulary was narrow
 * enough that "we changed X from A to B" and a bare "X is now B" were not
 * recognised as corrections at all, so the pipeline never widened the set of
 * facts eligible to be retired. Second, retirement was keyed on the slice
 * KIND: the extractor classifies a correction however it likes, so a
 * correction filed as `decision` never retired an original filed as
 * `technical_detail`, and both stayed current. Measured result: 3 of 3
 * correction shapes left two contradictory "current" facts on one node.
 *
 * The fix keys retirement on the VALUE the correction replaces. That is the
 * narrow reading: "now uses canary, not blue-green" names blue-green as
 * obsolete, so the fact asserting blue-green stops being current, while
 * "uses Vectorize" and "uses Durable Objects" — which name nothing as obsolete
 * — both remain. Superseded rows are marked non-current, never deleted, so the
 * history stays readable.
 */

/**
 * Language that marks a statement as revising an earlier one. Deliberately
 * requires an explicit revision cue: an ordinary additive sentence must NOT
 * match, because matching widens what may be retired.
 */
const UPDATE_CUES = [
	/\bactually\b/i,
	/\bcorrection\b/i,
	/\bno longer\b/i,
	/\bfrom now on\b/i,
	/\breplaced?\b/i,
	/\binstead\b/i,
	/\bforget that\b/i,
	/\bnot anymore\b/i,
	/\bscratch that\b/i,
	/\bthat'?s wrong\b/i,
	/\bupdate:\s/i,
	// "changed/switched/moved/migrated … to X" — the shapes that were missed.
	/\b(?:changed|switched|moved|migrated|updated)\b[^.!?]*\bto\b/i,
	// "changed … from A to B" even when the verb and "to" are far apart.
	/\bfrom\b[^.!?]{1,60}\bto\b/i,
	// A bare value update: "the retention IS NOW 30 days".
	/\bis now\b|\bare now\b|\bit'?s now\b/i,
	// "no longer X, now Y" / "now uses … , not …"
	/\bnot\s+\w[\w-]*\s*\.?\s*$/i,
];

/** True when this text revises an earlier statement rather than adding one. */
export function detectUpdateMode(text) {
	const value = String(text ?? "");
	if (!value.trim()) return false;
	return UPDATE_CUES.some((re) => re.test(value));
}

const STOPWORDS = new Set([
	"the", "a", "an", "is", "are", "was", "were", "be", "been", "now", "not", "no", "longer",
	"to", "from", "of", "for", "and", "or", "but", "it", "its", "this", "that", "we", "i",
	"our", "my", "with", "on", "in", "at", "by", "uses", "use", "used", "using", "changed",
	"change", "switch", "switched", "moved", "migrated", "updated", "update", "instead",
	"actually", "correction", "anymore", "will", "has", "have", "had", "does", "do", "did",
	"runs", "run", "set", "sets", "keep", "keeps", "still", "any", "more", "than", "then",
]);

export function significantTerms(text) {
	return String(text ?? "")
		.toLowerCase()
		.split(/[^a-z0-9+#.-]+/i)
		.map((t) => t.replace(/^[.-]+|[.-]+$/g, ""))
		// Numbers carry the value in exactly the corrections that matter
		// ("retention is 14 days" -> "now 30 days"), so a short numeric token is
		// significant where a short word is noise.
		.filter((t) => (/^\d+$/.test(t) ? t.length > 0 : t.length > 2) && !STOPWORDS.has(t));
}

/**
 * The values a correction explicitly marks as obsolete.
 *
 * Only phrases in an obsoleting position count — what follows "not", what sits
 * between "from" and "to", what precedes "instead of". A term that merely
 * appears in the sentence is NOT obsolete, which is what keeps a correction
 * from retiring the very fact it establishes.
 */
export function obsoletedValues(text) {
	const value = String(text ?? "");
	const out = new Set();
	const add = (phrase) => {
		for (const term of significantTerms(phrase)) out.add(term);
	};
	// "…, not blue-green" / "not blue-green cutover"
	for (const m of value.matchAll(/\bnot\s+([^.,;!?]{1,60})/gi)) add(m[1]);
	// "from Postgres to SQLite" — the FROM side is the obsolete one.
	for (const m of value.matchAll(/\bfrom\s+([^.,;!?]{1,60}?)\s+to\b/gi)) add(m[1]);
	// "instead of 14 days"
	for (const m of value.matchAll(/\binstead of\s+([^.,;!?]{1,60})/gi)) add(m[1]);
	// "no longer us-east-1"
	for (const m of value.matchAll(/\bno longer\s+([^.,;!?]{1,60})/gi)) add(m[1]);
	// "replaced Postgres" / "replaces Postgres"
	for (const m of value.matchAll(/\breplaces?d?\s+([^.,;!?]{1,60})/gi)) add(m[1]);
	return out;
}

/**
 * The values a correction asserts as the new truth (never retired).
 *
 * An assertion ends where the obsoleting clause begins: in "is now 30 days
 * instead of 14 days" the new value is "30 days", and letting the capture run
 * to the end would pull "14 days" into the asserted set and cancel the very
 * supersession the sentence requests.
 */
const ASSERTION_END_RE = /\s+(?:instead\b|not\b|rather than\b|no longer\b|replacing\b)/i;
function assertedValues(text) {
	const value = String(text ?? "");
	const out = new Set();
	const add = (phrase) => {
		const clipped = String(phrase ?? "").split(ASSERTION_END_RE)[0];
		for (const term of significantTerms(clipped)) out.add(term);
	};
	for (const m of value.matchAll(/\bto\s+([^.,;!?]{1,60})/gi)) add(m[1]);
	for (const m of value.matchAll(/\b(?:is|are|it'?s)\s+now\s+([^.,;!?]{1,60})/gi)) add(m[1]);
	for (const m of value.matchAll(/\bnow\s+uses?\s+([^.,;!?]{1,60})/gi)) add(m[1]);
	return out;
}

/**
 * The attribute a copula statement asserts, and the value it assigns.
 *
 * "archive retention is 14 days" -> { attribute: "archive retention", value: "14 days" }
 * "archive retention is now 30 days" -> { attribute: "archive retention", value: "30 days" }
 *
 * Copula ONLY ("is/are/was/were"). A predicate like "uses" is deliberately not
 * an attribute assertion, because "uses D1" and "uses Vectorize" are both true
 * at once — treating them as one attribute is how blanket supersession
 * destroys legitimate multi-valued memory.
 */
export function attributeAssertion(text) {
	const value = String(text ?? "").trim();
	if (!value) return null;
	const m = value.match(/^(.{2,80}?)\s+(?:is|are|was|were)\s+(?:now\s+|currently\s+)?(.{1,80}?)\s*[.!?]?$/i);
	if (!m) return null;
	const attribute = significantTerms(m[1]).join(" ");
	const assigned = significantTerms(m[2]).join(" ");
	if (!attribute || !assigned) return null;
	return { attribute, value: assigned };
}

/**
 * Same-subject attributes, by the identityRelatedLabels standard: equal, or
 * whole-token containment in either direction. The shorter side must still be
 * a real multi-word attribute — a single generic token ("retention") must not
 * reach every qualified attribute ("archive retention") on the node.
 */
export function attributesRelated(a, b) {
	if (a === b) return true;
	const left = String(a ?? "").split(" ").filter(Boolean);
	const right = String(b ?? "").split(" ").filter(Boolean);
	const [shortSide, longSide] = left.length <= right.length ? [left, right] : [right, left];
	if (shortSide.length < 2) return false;
	const longSet = new Set(longSide);
	return shortSide.every((t) => longSet.has(t));
}

/**
 * A single-valued state change: the same attribute is re-asserted with a
 * different value. This is what lets "the retention is now 30 days" retire
 * "the retention is 14 days" WITHOUT the user repeating the obsolete value.
 *
 * Requires update-mode intent from the caller — a first-time assertion must
 * never retire anything — and refuses when either side is not a copula
 * assertion, which is the guard that protects multi-valued facts. Attribute
 * matching allows whole-token containment because the extractor drops subject
 * qualifiers nondeterministically (measured live: the slice said "Cache
 * backend is Redis" while the correction's attribute was "<tag> cache
 * backend" — exact equality left both values current).
 */
export function replacesAttributeValue(correction, existing) {
	const next = attributeAssertion(correction?.text);
	const prior = attributeAssertion(existing?.text);
	if (!next || !prior) return false;
	if (!attributesRelated(next.attribute, prior.attribute)) return false;
	return next.value !== prior.value;
}

/**
 * Is `candidateLabel` plausibly the same real-world subject as `correctionLabel`?
 *
 * Graphiti resolves entities before contradiction handling (exact normalized
 * name, then embeddings ≥0.6, then an LLM). Itsuki's conservative, deterministic
 * analogue: whole-token containment in either direction — "Alnwick deploy runner"
 * vs "Alnwick" — which is exactly how the extractor splits one subject across
 * nodes. No LLM on the write path, and an unrelated label can never match.
 */
export function identityRelatedLabels(a, b) {
	const norm = (v) => String(v ?? "").toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter(Boolean);
	const left = norm(a);
	const right = norm(b);
	if (!left.length || !right.length) return false;
	if (left.join(" ") === right.join(" ")) return true;
	const [shortSide, longSide] = left.length <= right.length ? [left, right] : [right, left];
	// Every token of the shorter label must appear in the longer one, and the
	// shorter must carry real identity (a single generic word is not enough).
	if (shortSide.length < 1) return false;
	const longSet = new Set(longSide);
	return shortSide.every((t) => longSet.has(t));
}

/**
 * Does `correction` obsolete `existing`?
 *
 * True only when the existing fact asserts a value the correction explicitly
 * marks obsolete, and does NOT merely restate the correction's new value. This
 * is the whole guard against retiring legitimately co-existing facts.
 */
export function supersedesValue(correction, existing) {
	const obsolete = obsoletedValues(correction?.text);
	if (!obsolete.size) return false;
	const existingTerms = new Set(significantTerms(existing?.text));
	if (!existingTerms.size) return false;
	const namesObsolete = [...obsolete].some((term) => existingTerms.has(term));
	if (!namesObsolete) return false;
	// If the existing row already states the correction's NEW value and nothing
	// obsolete beyond it, it is the current truth — never retire it.
	const asserted = assertedValues(correction?.text);
	const obsoleteOnly = [...obsolete].filter((t) => !asserted.has(t));
	if (!obsoleteOnly.length) return false;
	return obsoleteOnly.some((term) => existingTerms.has(term));
}
