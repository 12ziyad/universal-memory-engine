/**
 * Per-user memory rules — the customization layer behind the Rules tab and
 * /v1/rules. One row per user in `memory_rules`:
 *
 *   - customInstructions: free-text guidance injected into extraction prompts
 *     ("always save exam progress; never save jokes").
 *   - includes: when non-empty, only content matching at least one term may
 *     become memory (allow-list).
 *   - excludes: content matching any term never becomes memory (deny-list).
 *     Excludes always win over includes.
 *   - customCategories: user-defined category names + descriptions, surfaced
 *     to the extractors alongside the built-in category set.
 *   - captureDefault: "auto" (whole-chat capture pages allowed) | "graph_only"
 *     (never build capture pages).
 *   - autoCollect: whether /v1/turn feeds the turn into auto-collect.
 *
 * Prompts get the rules as guidance; the FILTERS here are the enforcement —
 * a model that ignores the guidance still cannot write excluded content.
 */

const CAPTURE_DEFAULTS = new Set(["auto", "graph_only"]);
const MAX_TERMS = 32;
const MAX_TERM_LENGTH = 80;
const MAX_INSTRUCTIONS_LENGTH = 2000;
const MAX_CATEGORIES = 16;

export const DEFAULT_MEMORY_RULES = Object.freeze({
	customInstructions: "",
	includes: Object.freeze([]),
	excludes: Object.freeze([]),
	customCategories: Object.freeze([]),
	captureDefault: "auto",
	captureDensity: "standard",
	autoCollect: true,
	retentionDays: null,
});

function parseJsonArray(value) {
	if (Array.isArray(value)) return value;
	try {
		const parsed = JSON.parse(value || "[]");
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function cleanTerm(value) {
	return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TERM_LENGTH);
}

function cleanTermList(values) {
	const seen = new Set();
	const output = [];
	for (const raw of parseJsonArray(values)) {
		const term = cleanTerm(typeof raw === "string" ? raw : raw?.term ?? raw?.text);
		const key = term.toLocaleLowerCase("en-US");
		if (!term || seen.has(key)) continue;
		seen.add(key);
		output.push(term);
		if (output.length >= MAX_TERMS) break;
	}
	return output;
}

function cleanCategories(values) {
	const seen = new Set();
	const output = [];
	for (const raw of parseJsonArray(values)) {
		const name = cleanTerm(typeof raw === "string" ? raw : raw?.name)
			.toLocaleLowerCase("en-US")
			.replace(/[^a-z0-9]+/g, "_")
			.replace(/^_+|_+$/g, "")
			.slice(0, 40);
		if (!name || seen.has(name)) continue;
		seen.add(name);
		output.push({
			name,
			description: cleanTerm(typeof raw === "object" ? raw?.description : "").slice(0, 160),
		});
		if (output.length >= MAX_CATEGORIES) break;
	}
	return output;
}

export function normalizeMemoryRules(row = {}) {
	const captureDefault = String(row.capture_default ?? row.captureDefault ?? "auto");
	const retention = Number(row.retention_days ?? row.retentionDays);
	return {
		customInstructions: String(row.custom_instructions ?? row.customInstructions ?? "")
			.trim()
			.slice(0, MAX_INSTRUCTIONS_LENGTH),
		includes: cleanTermList(row.includes_json ?? row.includes),
		excludes: cleanTermList(row.excludes_json ?? row.excludes),
		customCategories: cleanCategories(row.custom_categories_json ?? row.customCategories),
		captureDefault: CAPTURE_DEFAULTS.has(captureDefault) ? captureDefault : "auto",
		// "standard" = selective high-precision capture (the default character of
		// the product); "dense" = exhaustive capture for users who want every
		// durable detail kept (lower gate floor, enumerate-everything prompt).
		captureDensity: String(row.capture_density ?? row.captureDensity ?? "standard") === "dense" ? "dense" : "standard",
		autoCollect: row.auto_collect === undefined && row.autoCollect === undefined
			? true
			: Number(row.auto_collect ?? (row.autoCollect ? 1 : 0)) === 1,
		retentionDays: Number.isFinite(retention) && retention > 0 ? Math.floor(retention) : null,
	};
}

export function memoryRulesAreDefault(rules) {
	return !rules.customInstructions && !rules.includes.length && !rules.excludes.length &&
		!rules.customCategories.length && rules.captureDefault === "auto" && rules.autoCollect === true &&
		rules.captureDensity === "standard" && rules.retentionDays === null;
}

/**
 * The rules row could not be read, and we do not know what it said.
 *
 * Distinct from "there is no rules row", which is a real answer meaning
 * defaults. This one means the question was never answered, and an admission
 * lane that treats it as defaults is admitting content it cannot prove is
 * permitted.
 */
export class MemoryRulesUnavailableError extends Error {
	constructor(cause) {
		super(`memory rules could not be read: ${cause}`);
		this.name = "MemoryRulesUnavailableError";
		this.code = "memory_rules_unavailable";
	}
}

/**
 * Load an account's memory rules.
 *
 * `failClosed` decides what an UNREADABLE rules store means. Display and
 * reporting callers want defaults — a rules page that 500s over a transient
 * read is worse than one showing defaults. Admission callers want the throw,
 * because the alternative is storing content the user asked us never to keep,
 * on the basis of a rules set we never actually saw.
 *
 * A missing TABLE is not ambiguous either way: a table that does not exist
 * cannot hold a rule, so it is defaults in both modes. That was the original
 * reason this swallowed everything, and it is preserved exactly.
 */
export async function getMemoryRules(env, userId, { failClosed = false } = {}) {
	try {
		const row = await env.DB.prepare("SELECT * FROM memory_rules WHERE user_id = ?").bind(userId).first();
		return row ? normalizeMemoryRules(row) : { ...DEFAULT_MEMORY_RULES };
	} catch (err) {
		const message = String(err?.message ?? err);
		if (/no such table/i.test(message)) return { ...DEFAULT_MEMORY_RULES };
		console.warn(`memory rules load failed user=${userId}:`, message);
		if (failClosed) throw new MemoryRulesUnavailableError(message);
		return { ...DEFAULT_MEMORY_RULES };
	}
}

/**
 * Layer rule overrides over a base set, field by field: account rules < the
 * API key's own rules < the per-request body. The caller's rules take
 * priority over Itsuki defaults — that IS the SDK profile. Replacement, not
 * union: a caller that says `excludes: ["health"]` means exactly that list.
 */
export function mergeRuleOverride(base, override) {
	if (!override || typeof override !== "object") return base;
	return normalizeMemoryRules({
		customInstructions: override.customInstructions ?? base.customInstructions,
		includes: override.includes ?? base.includes,
		excludes: override.excludes ?? base.excludes,
		customCategories: override.customCategories ?? base.customCategories,
		captureDefault: override.captureDefault ?? base.captureDefault,
		captureDensity: override.captureDensity ?? base.captureDensity,
		autoCollect: override.autoCollect ?? base.autoCollect,
		retentionDays: override.retentionDays ?? base.retentionDays,
	});
}

export async function saveMemoryRules(env, userId, patch = {}) {
	const current = await getMemoryRules(env, userId);
	const merged = normalizeMemoryRules({
		customInstructions: patch.customInstructions ?? patch.custom_instructions ?? current.customInstructions,
		includes: patch.includes ?? current.includes,
		excludes: patch.excludes ?? current.excludes,
		customCategories: patch.customCategories ?? patch.custom_categories ?? current.customCategories,
		captureDefault: patch.captureDefault ?? patch.capture_default ?? current.captureDefault,
		autoCollect: patch.autoCollect ?? patch.auto_collect ?? current.autoCollect,
		captureDensity: patch.captureDensity ?? patch.capture_density ?? current.captureDensity,
		retentionDays: patch.retentionDays !== undefined
			? patch.retentionDays
			: patch.retention_days !== undefined ? patch.retention_days : current.retentionDays,
	});
	const now = Date.now();
	await env.DB.prepare(
		`INSERT INTO memory_rules
			(user_id, custom_instructions, includes_json, excludes_json, custom_categories_json,
			 capture_default, auto_collect, retention_days, capture_density, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(user_id) DO UPDATE SET
			custom_instructions = excluded.custom_instructions,
			includes_json = excluded.includes_json,
			excludes_json = excluded.excludes_json,
			custom_categories_json = excluded.custom_categories_json,
			capture_default = excluded.capture_default,
			auto_collect = excluded.auto_collect,
			retention_days = excluded.retention_days,
			capture_density = excluded.capture_density,
			updated_at = excluded.updated_at`,
	).bind(
		userId,
		merged.customInstructions,
		JSON.stringify(merged.includes),
		JSON.stringify(merged.excludes),
		JSON.stringify(merged.customCategories),
		merged.captureDefault,
		merged.autoCollect ? 1 : 0,
		merged.retentionDays,
		merged.captureDensity,
		now,
		now,
	).run();
	return merged;
}

/**
 * Plain-language instructions are mostly one shape: "never save X", "don't
 * store X", "never capture anything about X". A prompt line is guidance and a
 * model can ignore it, so those phrases are ALSO compiled into deny terms and
 * enforced by the same filter as `excludes`. Nothing else in the instruction is
 * interpreted — anything the pattern does not match stays guidance only, which
 * is why this stays deliberately narrow.
 */
const NEVER_SAVE_RE = /\b(?:never|do\s+not|don['’]t)\s+(?:save|store|capture|keep|record|remember)\s+(?:anything\s+)?(?:about\s+|related\s+to\s+|regarding\s+|to\s+do\s+with\s+)?([^.;\n]+)/gi;

// Terms so broad that enforcing them would silently disable memory entirely.
const GENERIC_DENY_TERMS = new Set([
	"anything", "everything", "it", "that", "this", "them", "these", "those",
	"me", "us", "things", "stuff", "information", "data", "info", "details",
]);

export function instructionDenyTerms(instructions) {
	const text = String(instructions ?? "");
	if (!text.trim()) return [];
	const terms = [];
	const seen = new Set();
	for (const match of text.matchAll(NEVER_SAVE_RE)) {
		for (const part of String(match[1] ?? "").split(/\s*(?:,|\bor\b|\band\b)\s*/i)) {
			const term = cleanTerm(part)
				.replace(/^(?:any|all|my|our|the|a|an)\s+/i, "")
				.replace(/[.!?]+$/, "")
				.trim();
			const key = term.toLocaleLowerCase("en-US");
			if (term.length < 3 || GENERIC_DENY_TERMS.has(key) || seen.has(key)) continue;
			seen.add(key);
			terms.push(term);
			if (terms.length >= MAX_TERMS) return terms;
		}
	}
	return terms;
}

// Compiling on every gated object would re-run the regex thousands of times per
// extraction; rules objects are stable for the length of one run.
const denyCache = new WeakMap();

function denyTermsFor(rules) {
	if (!rules || typeof rules !== "object") return [];
	const cached = denyCache.get(rules);
	if (cached) return cached;
	const terms = [...(rules.excludes ?? []), ...instructionDenyTerms(rules.customInstructions)];
	denyCache.set(rules, terms);
	return terms;
}

function normalizeMatchText(value) {
	return String(value ?? "")
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "")
		.toLocaleLowerCase("en-US");
}

function termMatches(text, term) {
	const haystack = normalizeMatchText(text);
	const needle = normalizeMatchText(term);
	if (!haystack || !needle) return false;
	const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
	return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u").test(haystack);
}

/** True when this text may become memory under the user's include/exclude rules. */
export function rulesAllowText(rules, ...texts) {
	if (!rules) return true;
	const combined = texts.filter(Boolean).join(" ");
	if (!combined.trim()) return true;
	if (denyTermsFor(rules).some((term) => termMatches(combined, term))) return false;
	if ((rules.includes ?? []).length) {
		return rules.includes.some((term) => termMatches(combined, term));
	}
	return true;
}

/** Reason string used everywhere a rule drops something, so receipts explain it. */
export function rulesRejection(rules, ...texts) {
	if (!rules) return null;
	const combined = texts.filter(Boolean).join(" ");
	if (!combined.trim()) return null;
	if (denyTermsFor(rules).some((term) => termMatches(combined, term))) return "excluded_by_rule";
	if ((rules.includes ?? []).length && !rules.includes.some((term) => termMatches(combined, term))) {
		return "outside_include_rules";
	}
	return null;
}

/** Compact rules block for extraction/digest prompts (guidance, not enforcement). */
export function rulesPromptLines(rules) {
	if (!rules || memoryRulesAreDefault(rules)) return [];
	const lines = [];
	if (rules.customInstructions) lines.push(`User rules: ${rules.customInstructions}`);
	if (rules.includes.length) lines.push(`Only keep content about: ${rules.includes.join(", ")}.`);
	if (rules.excludes.length) lines.push(`Never save content about: ${rules.excludes.join(", ")}.`);
	if (rules.customCategories.length) {
		lines.push(`Preferred user categories: ${rules.customCategories
			.map((category) => category.description ? `${category.name} (${category.description})` : category.name)
			.join(", ")}.`);
	}
	return lines;
}
