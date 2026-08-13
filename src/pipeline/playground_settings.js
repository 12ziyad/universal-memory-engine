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
 *   includes   whichever side has one; when BOTH do, the terms they agree on,
 *              which is narrower than either. Two lists that agree on nothing
 *              cannot be written as one, so threadRefusal() refuses the turn.
 *   capture    "off" is not a rule at all: the caller simply does not run the
 *              capture lane. Nothing downstream needs to know.
 *   categories union — a category is classification metadata, never permission.
 *
 * The shared pipeline then enforces the resulting object per extracted item,
 * independently, so a mistake in this file can only ever store less.
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

/** True when this chat captures nothing at all, whatever the account allows. */
export function threadCaptureDisabled(settings) {
	return normalizeThreadSettings(settings ?? {}).captureMode === "off";
}

/** The terms two allow-lists agree on, compared the way the matcher compares. */
function agreedTerms(a = [], b = []) {
	const other = new Set(b.map((term) => term.toLocaleLowerCase("en-US")));
	return a.filter((term) => other.has(term.toLocaleLowerCase("en-US")));
}

/**
 * True when a chat's allow-list and the account's cannot both be satisfied.
 *
 * Two allow-lists that share no term admit nothing in common, and an empty
 * intersection cannot be written into the flat object — an empty `includes`
 * means "no allow-list", which would capture EVERYTHING. So the pair is
 * detected here and refused, and threadRulesFrom() and threadRefusal() read the
 * same helper so the two can never drift into that silent widening.
 */
function allowListsConflict(accountRules, settings) {
	const account = accountRules?.includes ?? [];
	const chat = settings.includeTopics ?? [];
	return Boolean(account.length && chat.length && !agreedTerms(account, chat).length);
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
	const chatIncludes = settings.includeTopics ?? [];
	// Two allow-lists are the one case a single term list cannot express. The
	// terms they AGREE on can be, and that set is narrower than either — so it
	// goes down and gets enforced per extracted item like any other allow-list.
	// Passing the account's list alone was a hole: a chat saying "only Mochi"
	// still kept a boxing fact, because the account's list is what reached the
	// filter and the chat's was only ever judged against the whole message.
	const includes = accountIncludes.length && chatIncludes.length
		? agreedTerms(accountIncludes, chatIncludes)
		: (accountIncludes.length ? accountIncludes : chatIncludes);
	return normalizeMemoryRules({
		...accountRules,
		excludes: [...(accountRules?.excludes ?? []), ...settings.excludeTopics],
		includes,
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
 *   capture off        there is nothing to enforce; the lane is not called.
 *   two allow-lists    that share no term. Their intersection is empty, an
 *                      empty `includes` reads as "no allow-list" and would
 *                      capture everything, so the turn is refused instead.
 *
 * Everything else — including two allow-lists that DO overlap — is expressible
 * as a flat rules object and is enforced per extracted item behind this.
 */
export function threadRefusal(accountRules, threadSettings) {
	const settings = normalizeThreadSettings(threadSettings ?? {});
	if (settings.captureMode === "off") return "capture_off";
	if (allowListsConflict(accountRules, settings)) return "outside_include_rules";
	return null;
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
