/**
 * Thread-scoped memory settings for the Playground.
 *
 * These are NOT a second rules system. A thread's settings are normalized by
 * the same normalizeMemoryRules() and then layered over the account's saved
 * rules, so whatever the person types in the Settings tab reaches extraction
 * through exactly the path /v1/rules already uses. A field the thread does not
 * set falls through to the account.
 */

import { normalizeMemoryRules } from "./rules.js";

export const EMPTY_THREAD_SETTINGS = Object.freeze({
	customInstructions: "",
	customCategories: Object.freeze([]),
});

/** Clean whatever the Settings tab sent into a storable thread-settings shape. */
export function normalizeThreadSettings(input = {}) {
	const normalized = normalizeMemoryRules({
		customInstructions: input.customInstructions ?? input.custom_instructions ?? "",
		customCategories: input.customCategories ?? input.custom_categories ?? [],
	});
	return {
		customInstructions: normalized.customInstructions,
		customCategories: normalized.customCategories,
	};
}

/** True when the thread adds nothing and the account rules apply unchanged. */
export function threadSettingsAreEmpty(settings) {
	return !settings?.customInstructions && !(settings?.customCategories ?? []).length;
}

/**
 * The rules this thread extracts under. Returns null when the thread adds
 * nothing, so the pipeline loads the account's rules itself and this path
 * stays invisible.
 */
export function threadRulesFrom(accountRules, threadSettings) {
	if (!threadSettings || threadSettingsAreEmpty(threadSettings)) return null;
	const instructions = [accountRules?.customInstructions, threadSettings.customInstructions]
		.map((line) => String(line ?? "").trim())
		.filter(Boolean)
		.join(" ");
	return normalizeMemoryRules({
		...accountRules,
		customInstructions: instructions,
		customCategories: [
			...(accountRules?.customCategories ?? []),
			...(threadSettings.customCategories ?? []),
		],
	});
}
