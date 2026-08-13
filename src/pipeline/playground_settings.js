/**
 * Thread-scoped memory policy for the Playground.
 *
 * The Playground is a SANDBOX. It may narrow what this one chat captures; it
 * may never change how the shared admission path behaves for any other door.
 * So nothing here asks rules.js to grow a concept for the Playground's benefit
 * — no parent chain, no capture mode, no extra field the SDK, MCP, Claude Code
 * and Codex lanes would then have to carry. This module composes the account's
 * saved rules and the chat's policy into the SAME flat rules object /v1/rules
 * already produces, and enforces the rest at its own boundary.
 *
 * Composition is narrowing in every branch:
 *
 *   excludes   union — a chat may add denials, never drop one the account made.
 *   includes   the account's allow-list when it has one, because that is the
 *              one the flat shape can express. The chat's own allow-list is
 *              enforced here instead, by threadRefusal(), since "matches one of
 *              A and one of B" is not any single term list.
 *   capture    "off" is not a rule at all: the caller simply does not run the
 *              capture lane. Nothing downstream needs to know.
 *   categories union — a category is classification metadata, never permission.
 *
 * threadRefusal() is the authority on whether a message may be captured, and it
 * checks the account FIRST. The shared pipeline then re-checks the account's
 * rules independently, so a mistake in this file can only ever store less.
 */

import { normalizeMemoryRules, rulesRejection } from "./rules.js";

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

/** True when this chat captures nothing at all, whatever the account allows. */
export function threadCaptureDisabled(settings) {
	return normalizeThreadSettings(settings ?? {}).captureMode === "off";
}

/** The chat's own allow-list as a rules object — its policy, not the account's. */
function threadOwnRules(settings) {
	// Includes only. The chat's excludes are unioned into threadRulesFrom()'s
	// flat object and enforced downstream per item; repeating them here would
	// refuse the whole message over one refused fact inside it.
	return normalizeMemoryRules({ includes: settings.includeTopics ?? [] });
}

/**
 * The rules this thread extracts under, in the flat shape every lane speaks.
 * Returns null when the thread adds nothing, so the pipeline loads the
 * account's rules itself and this path stays invisible.
 */
export function threadRulesFrom(accountRules, threadSettings) {
	const settings = normalizeThreadSettings(threadSettings ?? {});
	if (threadSettingsAreEmpty(settings)) return null;
	const accountIncludes = accountRules?.includes ?? [];
	return normalizeMemoryRules({
		...accountRules,
		excludes: [...(accountRules?.excludes ?? []), ...settings.excludeTopics],
		includes: accountIncludes.length ? accountIncludes : settings.includeTopics,
		customCategories: [
			...(accountRules?.customCategories ?? []),
			...settings.customCategories,
		],
	});
}

/**
 * Why this chat may not capture this text at all, or null when it may.
 *
 * Deliberately narrow. Almost everything a chat declares rides in the flat
 * object threadRulesFrom() returns, and is enforced by the pipeline per
 * extracted item — the same granularity as the account's own rules, so a chat
 * exclude drops the one fact it names rather than the whole message around it.
 * Re-checking those here would be strictly more aggressive than the account
 * rules are, and would throw away captures the account plainly permits.
 *
 * Two things genuinely cannot ride down there:
 *
 *   capture off      there is nothing to enforce; the lane is not called.
 *   a chat allow-list when the account already has one, because "matches one of
 *                    A and one of B" is not any single term list. Judged here,
 *                    on the message, which errs toward storing less.
 */
export function threadRefusal(accountRules, threadSettings, ...texts) {
	const settings = normalizeThreadSettings(threadSettings ?? {});
	if (settings.captureMode === "off") return "capture_off";
	if (!settings.includeTopics.length) return null;
	if (!(accountRules?.includes ?? []).length) return null;
	return rulesRejection(threadOwnRules(settings), ...texts);
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
