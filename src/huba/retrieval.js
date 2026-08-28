/**
 * Huba's retrieval: find the RIGHT documentation sections, including when the
 * asker misspells the thing and when the page is filed under a different name
 * than the one they used.
 *
 * This exists because of a real, observed failure. A user asked
 *
 *     "typscript sdk how to connect it and what all plugin methode itsuki providing?"
 *
 * and the old whole-page term-overlap scorer returned four /install/* pages —
 * `/sdk/js` never entered the top eight even when the query was spelled
 * correctly, because that page is titled "JavaScript SDK" and the word
 * "typescript" appears nowhere in its title or route. Huba then told the user
 * the SDK did not exist. Three separate defects, fixed here:
 *
 *   1. TYPOS      "typscript" matched nothing at all → bounded fuzzy matching
 *                 against a vocabulary built from the corpus.
 *   2. VOCABULARY the JS SDK *is* the TypeScript SDK → equivalence groups, so
 *                 a term reaches every name the product uses for one thing.
 *   3. GRANULARITY one 8 KB page ate the whole context budget → sections, so a
 *                 question spanning two subjects can carry both.
 *
 * Plus COVERAGE: certain question shapes must never miss their canonical
 * pages, whatever the scores say. Asking about SDKs pulls in every SDK page,
 * which is exactly the "look at all of them before answering" behaviour the
 * owner asked for.
 *
 * Everything here is deterministic, dependency-free, and costs zero neurons.
 */

import { HUBA_CHUNKS, HUBA_PAGES } from "./corpus.generated.js";

const STOPWORDS = new Set((
	"a an and any are as at be been but by can could do does doing for from get give had has have how i if in into is it its "
	+ "just like me my need not of on or our so some tell that the their them then there these they this to us use want was "
	+ "we were what when where which who why will with would you your"
).split(" "));

/**
 * Equivalence groups: every term in a group reaches every other term. These
 * encode what the PRODUCT calls things versus what a person types. The JS/TS
 * group is the one that caused the original failure — Itsuki ships one
 * TypeScript-typed JavaScript SDK, and people ask for it by both names.
 */
const EQUIVALENCE_GROUPS = [
	["typescript", "ts", "javascript", "js", "node", "nodejs", "npm", "esm", "tsx"],
	["python", "py", "pip", "pypi"],
	["sdk", "client", "library", "package", "binding", "wrapper"],
	["connect", "install", "setup", "configure", "integrate", "wire", "add", "connection"],
	["mcp", "server", "tool", "tools", "connector"],
	["key", "keys", "token", "tokens", "apikey", "credential", "credentials", "secret", "auth", "authentication"],
	["limit", "limits", "quota", "quotas", "allowance", "cap", "neuron", "neurons", "usage", "budget", "remaining", "throttle"],
	["delete", "remove", "erase", "purge", "forget", "wipe", "deletion"],
	["save", "saves", "saving", "store", "stored", "remember", "capture", "write", "ingest"],
	["recall", "search", "retrieve", "query", "find", "lookup", "retrieval"],
	["memory", "memories", "fact", "facts", "node", "nodes", "atom"],
	["graph", "cluster", "clusters", "edge", "edges", "relation", "relationship", "map"],
	["conversation", "conversations", "page", "pages", "thread", "transcript"],
	["webhook", "webhooks", "callback", "event", "events", "notification", "subscribe"],
	["export", "exports", "download", "backup", "dump", "portability"],
	["member", "members", "team", "teammate", "invite", "invitation", "collaborator", "role", "roles", "permission", "permissions", "rbac"],
	["project", "projects", "workspace", "org", "organization", "organisation", "tenant"],
	["receipt", "receipts", "history", "log", "audit", "trail"],
	["job", "jobs", "queue", "processing", "pending", "stuck", "backlog"],
	["error", "errors", "fail", "failed", "failure", "broken", "issue", "problem", "wrong"],
	["dashboard", "overview", "analytics", "stats", "statistics", "metrics", "insights"],
	["playground", "sandbox", "demo", "try", "test"],
	["rule", "rules", "policy", "policies", "extraction", "filter", "control"],
	["retention", "expiry", "expire", "ttl", "lifecycle", "archive"],
	["price", "pricing", "cost", "bill", "billing", "plan", "subscription", "upgrade", "free", "paid"],
	["rate", "ratelimit", "429", "throttled", "toomanyrequests"],
	["huba", "assistant", "chat", "bot", "helper"],
	["privacy", "gdpr", "data", "security", "compliance"],
	["claude", "anthropic"],
	["chatgpt", "openai", "gpt"],
	["cursor", "editor", "ide", "vscode"],
	["agent", "agents", "harness", "framework", "frameworks"],
];

const ALIASES = (() => {
	const map = new Map();
	for (const group of EQUIVALENCE_GROUPS) {
		for (const term of group) {
			const existing = map.get(term) ?? new Set();
			for (const sibling of group) if (sibling !== term) existing.add(sibling);
			map.set(term, existing);
		}
	}
	return map;
})();

/**
 * Question shapes whose canonical pages must ALWAYS be in context, whatever
 * the lexical scores say. This is the "read every SDK page before answering
 * about SDKs" guarantee.
 */
const TOPIC_RULES = [
	{ id: "sdk", terms: ["sdk", "typescript", "javascript", "python", "npm", "pip", "client", "library"],
		routes: ["/sdk/js", "/sdk/python", "/api/rest", "/integrations/typescript", "/integrations/python"] },
	{ id: "mcp", terms: ["mcp", "tool", "tools", "connector", "server"],
		routes: ["/api/mcp", "/install/claude-code", "/install/claude"] },
	{ id: "install", terms: ["connect", "install", "setup", "configure", "integrate"],
		routes: ["/quickstart", "/install/claude", "/install/claude-code", "/integrations/native"] },
	{ id: "limits", terms: ["limit", "quota", "neuron", "allowance", "usage", "remaining", "429", "ratelimit", "price", "cost", "upgrade"],
		routes: ["/api/limits", "/guides/usage", "/api/usage"] },
	{ id: "huba", terms: ["huba", "assistant"], routes: ["/guides/huba"] },
	{ id: "save", terms: ["save", "store", "remember", "capture", "ingest"],
		routes: ["/guides/save", "/api/save", "/api/ingest", "/concepts/extraction"] },
	{ id: "recall", terms: ["recall", "search", "retrieve", "find", "query"],
		routes: ["/guides/recall", "/api/recall", "/concepts/retrieval"] },
	{ id: "delete", terms: ["delete", "remove", "erase", "purge", "forget"],
		routes: ["/concepts/delete", "/api/memories-delete", "/guides/export"] },
	{ id: "graph", terms: ["graph", "cluster", "edge", "node", "relation"],
		routes: ["/concepts/graph", "/api/graph"] },
	{ id: "webhook", terms: ["webhook", "callback", "event", "subscribe"], routes: ["/api/webhooks"] },
	{ id: "members", terms: ["member", "team", "invite", "role", "permission", "organization", "project"],
		routes: ["/guides/projects", "/concepts/scope"] },
	{ id: "jobs", terms: ["job", "queue", "pending", "stuck", "failed", "processing"],
		routes: ["/api/jobs", "/operate/observability"] },
	{ id: "keys", terms: ["key", "token", "credential", "auth"], routes: ["/api/auth"] },
	{ id: "rules", terms: ["rule", "policy", "extraction", "filter"], routes: ["/guides/rules", "/concepts/receipts"] },
	{ id: "privacy", terms: ["privacy", "gdpr", "security", "compliance"], routes: ["/privacy"] },
	{ id: "errors", terms: ["error", "fail", "broken", "issue", "wrong"], routes: ["/api/errors", "/faq"] },
	{ id: "export", terms: ["export", "download", "backup"], routes: ["/guides/export", "/api/export"] },
];

function tokenize(text) {
	return String(text ?? "")
		.toLowerCase()
		.split(/[^a-z0-9_/-]+/)
		.filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

/** Bounded Levenshtein: returns a distance, or `max + 1` once it exceeds max. */
function editDistance(a, b, max) {
	if (Math.abs(a.length - b.length) > max) return max + 1;
	let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		let best = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
			if (current[j] < best) best = current[j];
		}
		if (best > max) return max + 1;
		previous = current;
	}
	return previous[b.length];
}

/**
 * Vocabulary of every token the corpus contains, bucketed by first character
 * and length so fuzzy lookup compares against dozens of candidates instead of
 * tens of thousands. Built once per isolate from static data — no per-request
 * or per-user state lives here.
 */
let vocabularyBuckets = null;
function vocabulary() {
	if (vocabularyBuckets) return vocabularyBuckets;
	const buckets = new Map();
	const seen = new Set();
	const add = (token) => {
		if (token.length < 4 || seen.has(token)) return;
		seen.add(token);
		const key = `${token[0]}:${token.length}`;
		const bucket = buckets.get(key);
		if (bucket) bucket.push(token);
		else buckets.set(key, [token]);
	};
	for (const chunk of HUBA_CHUNKS) {
		for (const token of tokenize(`${chunk.heading} ${chunk.title} ${chunk.route}`)) add(token);
		// Body tokens are what make a typo like "typscript" resolvable at all.
		for (const token of tokenize(chunk.text)) add(token);
	}
	vocabularyBuckets = buckets;
	return buckets;
}

/** Corpus terms within one or two edits of a term the user actually typed. */
function fuzzyMatches(term) {
	if (term.length < 5) return [];
	const max = term.length >= 7 ? 2 : 1;
	const buckets = vocabulary();
	const out = [];
	for (let length = term.length - max; length <= term.length + max; length++) {
		for (const candidate of buckets.get(`${term[0]}:${length}`) ?? []) {
			if (candidate === term) continue;
			if (editDistance(term, candidate, max) <= max) out.push(candidate);
			if (out.length >= 6) return out;
		}
	}
	return out;
}

/**
 * Expand what the user typed into every term that should reach the corpus,
 * each carrying a weight: what they wrote counts fully, a product synonym
 * nearly so, and a spelling repair less — a repair is a guess about intent.
 */
export function expandQuery(question) {
	const typed = [...new Set(tokenize(question))];
	const weighted = new Map();
	// INTENT is what the person meant: the words they typed, their spelling
	// repairs, and their singular/plural forms — but NOT product synonyms.
	// Topic routing reads this and never `weighted`, because a synonym is a
	// tool for matching text, not evidence about intent: "typescript" has
	// "node" as a sibling, and letting that classify intent dragged the whole
	// memory-graph topic into a question about SDKs.
	const intent = new Set();
	const bump = (term, weight) => {
		if (!term || STOPWORDS.has(term)) return;
		weighted.set(term, Math.max(weighted.get(term) ?? 0, weight));
	};
	/** sdks <-> sdk, edges <-> edge: only when the variant really exists. */
	const inflections = (term) => {
		const out = [];
		const singular = term.endsWith("es") && term.length > 4 ? term.slice(0, -2) : term.endsWith("s") && term.length > 3 ? term.slice(0, -1) : null;
		if (singular && (ALIASES.has(singular) || vocabularyHas(singular))) out.push(singular);
		for (const plural of [`${term}s`, `${term}es`]) {
			if (ALIASES.has(plural) || vocabularyHas(plural)) out.push(plural);
		}
		return out;
	};
	for (const term of typed) {
		bump(term, 1);
		intent.add(term);
		for (const variant of inflections(term)) {
			bump(variant, 0.9);
			intent.add(variant);
			for (const alias of ALIASES.get(variant) ?? []) bump(alias, 0.75);
		}
		for (const alias of ALIASES.get(term) ?? []) bump(alias, 0.8);
		if (!vocabularyHas(term)) {
			for (const repair of fuzzyMatches(term)) {
				bump(repair, 0.55);
				intent.add(repair);
				for (const alias of ALIASES.get(repair) ?? []) bump(alias, 0.45);
			}
		}
	}
	return { typed, weighted, intent };
}

function vocabularyHas(term) {
	return (vocabulary().get(`${term[0]}:${term.length}`) ?? []).includes(term);
}

function countOccurrences(haystack, needle, cap) {
	let index = 0;
	let hits = 0;
	while (hits < cap && (index = haystack.indexOf(needle, index)) !== -1) {
		hits += 1;
		index += needle.length;
	}
	return hits;
}

function scoreChunk(chunk, weighted, typed, phrase) {
	const heading = chunk.heading.toLowerCase();
	const title = chunk.title.toLowerCase();
	const route = chunk.route.toLowerCase();
	const body = chunk.text.toLowerCase();
	let score = 0;
	let matchedTyped = 0;
	for (const [term, weight] of weighted) {
		let termScore = 0;
		if (heading.includes(term)) termScore += 8;
		if (title.includes(term)) termScore += 5;
		if (route.includes(term)) termScore += 3;
		termScore += countOccurrences(body, term, 6);
		if (termScore > 0 && typed.includes(term)) matchedTyped += 1;
		score += termScore * weight;
	}
	// Answering the WHOLE question beats mentioning one of its words a lot:
	// "typescript sdk" must rank a chunk covering both over one repeating
	// "sdk" six times. This is the term that fixes the original failure.
	if (typed.length) score *= 1 + (matchedTyped / typed.length);
	if (phrase.length >= 10 && body.includes(phrase)) score += 15;
	return score;
}

/**
 * Retrieve the sections that should ground an answer.
 *
 * @returns {{ chunks: Array, routes: string[], topics: string[] }}
 */
export function retrieve(question, { budget = 18000, maxChunks = 14, perRoute = 3 } = {}) {
	const { typed, weighted, intent } = expandQuery(question);
	if (!weighted.size) return { chunks: [], routes: [], topics: [] };
	const phrase = String(question).toLowerCase().trim().slice(0, 80);

	const scored = [];
	for (const chunk of HUBA_CHUNKS) {
		const score = scoreChunk(chunk, weighted, typed, phrase);
		if (score > 0) scored.push({ chunk, score });
	}
	scored.sort((a, b) => b.score - a.score);

	// Coverage: every canonical page for a triggered topic contributes its
	// best section, even if lexical scoring alone would have missed it.
	// Triggered from INTENT only — see expandQuery.
	const topics = TOPIC_RULES.filter((rule) => rule.terms.some((term) => intent.has(term)));
	// TWO sections per canonical page, not one. A page intro often *describes*
	// what the page covers without carrying the thing itself: /sdk/js opens
	// with "Install the client…" while the actual `npm install itsuki` lives
	// under the next heading. Given only the intro, the model filled the gap
	// and invented a package name. The second-best section is what closes it.
	const guaranteed = [];
	for (const rule of topics) {
		for (const route of rule.routes) {
			const forRoute = scored.filter((entry) => entry.chunk.route === route).slice(0, 2);
			if (forRoute.length) guaranteed.push(...forRoute);
			else {
				const fallback = HUBA_CHUNKS.find((chunk) => chunk.route === route);
				if (fallback) guaranteed.push({ chunk: fallback, score: 0 });
			}
		}
	}

	const chosen = [];
	const perRouteCount = new Map();
	let used = 0;
	const take = (entry) => {
		if (!entry?.chunk) return;
		const { chunk } = entry;
		const key = `${chunk.route}#${chunk.index}`;
		if (chosen.some((existing) => `${existing.route}#${existing.index}` === key)) return;
		const count = perRouteCount.get(chunk.route) ?? 0;
		if (count >= perRoute) return;
		if (used + chunk.text.length > budget || chosen.length >= maxChunks) return;
		chosen.push(chunk);
		perRouteCount.set(chunk.route, count + 1);
		used += chunk.text.length;
	};
	// Guaranteed coverage first — it must never be crowded out by a long
	// high-scoring section from an adjacent page.
	for (const entry of guaranteed) take(entry);
	for (const entry of scored) take(entry);

	return {
		chunks: chosen,
		routes: [...new Set(chosen.map((chunk) => chunk.route))],
		topics: topics.map((rule) => rule.id),
	};
}

/** A compact map of the whole documentation set, for orientation. */
export function pageIndex() {
	return HUBA_PAGES.map((page) => `${page.route} — ${page.title}`).join("\n");
}
