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
		autoCollect: row.auto_collect === undefined && row.autoCollect === undefined
			? true
			: Number(row.auto_collect ?? (row.autoCollect ? 1 : 0)) === 1,
		retentionDays: Number.isFinite(retention) && retention > 0 ? Math.floor(retention) : null,
	};
}

export function memoryRulesAreDefault(rules) {
	return !rules.customInstructions && !rules.includes.length && !rules.excludes.length &&
		!rules.customCategories.length && rules.captureDefault === "auto" && rules.autoCollect === true &&
		rules.retentionDays === null;
}

export async function getMemoryRules(env, userId) {
	try {
		const row = await env.DB.prepare("SELECT * FROM memory_rules WHERE user_id = ?").bind(userId).first();
		return row ? normalizeMemoryRules(row) : { ...DEFAULT_MEMORY_RULES };
	} catch (err) {
		// Rules must never break a save. Missing table (pre-migration) → defaults.
		console.warn(`memory rules load failed user=${userId}:`, err?.message ?? err);
		return { ...DEFAULT_MEMORY_RULES };
	}
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
		retentionDays: patch.retentionDays !== undefined
			? patch.retentionDays
			: patch.retention_days !== undefined ? patch.retention_days : current.retentionDays,
	});
	const now = Date.now();
	await env.DB.prepare(
		`INSERT INTO memory_rules
			(user_id, custom_instructions, includes_json, excludes_json, custom_categories_json,
			 capture_default, auto_collect, retention_days, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(user_id) DO UPDATE SET
			custom_instructions = excluded.custom_instructions,
			includes_json = excluded.includes_json,
			excludes_json = excluded.excludes_json,
			custom_categories_json = excluded.custom_categories_json,
			capture_default = excluded.capture_default,
			auto_collect = excluded.auto_collect,
			retention_days = excluded.retention_days,
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
		now,
		now,
	).run();
	return merged;
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
	if ((rules.excludes ?? []).some((term) => termMatches(combined, term))) return false;
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
	if ((rules.excludes ?? []).some((term) => termMatches(combined, term))) return "excluded_by_rule";
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
