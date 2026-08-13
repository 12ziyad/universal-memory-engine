/**
 * Thread-scoped memory policy for the Playground.
 *
 * These are NOT a second rules system. A thread's policy is normalized by the
 * same normalizeMemoryRules() and then LAYERED UNDER the account's saved rules
 * as a child, so whatever the person selects reaches extraction through exactly
 * the path /v1/rules already uses.
 *
 * "Layered under", not "merged over". mergeRuleOverride() replaces field by
 * field, which is right for an SDK profile declaring its own rule set and wrong
 * here: a chat that said `excludes: ["cats"]` would replace the account's deny
 * list rather than add to it, quietly handing back everything the account had
 * refused. A chat may only ever narrow. rulesRejection() enforces that by
 * consulting `parent` first and treating its refusal as final.
 */

import { normalizeMemoryRules } from "./rules.js";

export const CAPTURE_MODES = new Set(["standard", "only_topics", "off"]);

export const EMPTY_THREAD_SETTINGS = Object.freeze({
	captureMode: "standard",
	includeTopics: Object.freeze([]),
	excludeTopics: Object.freeze([]),
	customCategories: Object.freeze([]),
});

/** Clean whatever the policy panel sent into a storable shape. */
export function normalizeThreadSettings(input = {}) {
	const requested = String(input.captureMode ?? input.capture_mode ?? "standard");
	// Reuse the rules normalizer for the term lists so a topic typed here obeys
	// exactly the same length, count and de-duplication limits as one saved on
	// the account. One cleaner, one set of bounds.
	const normalized = normalizeMemoryRules({
		includes: input.includeTopics ?? input.include_topics ?? [],
		excludes: input.excludeTopics ?? input.exclude_topics ?? [],
		customCategories: input.customCategories ?? input.custom_categories ?? [],
	});
	const captureMode = CAPTURE_MODES.has(requested) ? requested : "standard";
	return {
		// "Only these topics" with no topics would silently mean "capture
		// nothing", which nobody intends while still filling the field in.
		captureMode: captureMode === "only_topics" && !normalized.includes.length ? "standard" : captureMode,
		includeTopics: normalized.includes,
		excludeTopics: normalized.excludes,
		customCategories: normalized.customCategories,
	};
}

/** True when the thread adds nothing and the account rules apply unchanged. */
export function threadSettingsAreEmpty(settings) {
	return !settings
		|| ((settings.captureMode ?? "standard") === "standard"
			&& !(settings.includeTopics ?? []).length
			&& !(settings.excludeTopics ?? []).length
			&& !(settings.customCategories ?? []).length);
}

/**
 * The rules this thread extracts under. Returns null when the thread adds
 * nothing, so the pipeline loads the account's rules itself and this path stays
 * invisible.
 *
 * The account rules become the returned object's `parent`, so they are checked
 * first and cannot be weakened. Categories are the one field that unions rather
 * than narrows: a category is classification metadata, never a permission.
 */
export function threadRulesFrom(accountRules, threadSettings) {
	if (threadSettingsAreEmpty(threadSettings)) return null;
	const child = normalizeMemoryRules({
		...accountRules,
		includes: threadSettings.includeTopics ?? [],
		excludes: threadSettings.excludeTopics ?? [],
		customCategories: [
			...(accountRules?.customCategories ?? []),
			...(threadSettings.customCategories ?? []),
		],
	});
	child.captureMode = threadSettings.captureMode ?? "standard";
	child.parent = accountRules ?? null;
	return child;
}

/**
 * What the panel should show as actually enforced. The UI must not badge
 * anything "enforced" that this does not return.
 */
export function threadPolicySummary(settings) {
	const normalized = normalizeThreadSettings(settings ?? {});
	return {
		captureMode: normalized.captureMode,
		enforcedIncludes: normalized.includeTopics,
		enforcedExcludes: normalized.excludeTopics,
		categories: normalized.customCategories,
	};
}
