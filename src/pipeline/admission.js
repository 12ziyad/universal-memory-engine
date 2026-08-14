/**
 * A2 — the canonical storage-admission boundary.
 *
 * Every representation that can later be recalled, exported, indexed,
 * embedded, graphed, staged, displayed, or used for read-your-writes MUST
 * pass the same admission sequence before it is written:
 *
 *   identity/scope
 *     → secret/privacy scrub            (scrub.js — BEFORE anything durable)
 *     → user/account memory rules       (rules.js — include/exclude/instructions)
 *     → bounds/normalization            (model_input.js, envelope caps)
 *     → immutable context/rule snapshot (extraction_context_snapshot)
 *     → storage/indexing
 *
 * The identity half of the rules step is the part that has actually broken
 * (SRV-04): rules belong to the ACCOUNT. A derived mem_ sub-tenant id owns no
 * rules row, so any lane that "just loads rules" for the id it is writing
 * under silently gets defaults. The door resolves the account rules ONCE
 * (doorOverrides) and hands the object down; every enforcement site accepts
 * that object first and self-loads only for identities that own their rules
 * row (the account root).
 *
 * resolveAdmissionRules is that contract as code. Converted sites:
 * staged_text (staging index), gates (graph admission), extract (extraction
 * snapshot), /v1/turn (write-path recall door), mcp_engine (page content +
 * extraction — root-identity door). The three scrubbers are corpus-locked by
 * test/fixtures/security_corpus.mjs; rules behavior is locked by
 * rules_precedence + rules_staged_exclusion (incl. the Bearer-door SRV-04
 * cases).
 */

import { activeCategoryRules } from "../lib/project_categories.js";
import {
	getMemoryRules,
	mergeRuleOverride,
	narrowManagedMemoryRules,
} from "./rules.js";

/**
 * The one way an enforcement lane obtains rules: the door's resolved account
 * rules when present, its own row otherwise. `overrideRules` must be the
 * object the door resolved — never re-derive rules for a scoped mem_ id.
 */
export async function resolveAdmissionRules(env, userId, overrideRules) {
	if (overrideRules !== undefined && overrideRules !== null) return overrideRules;
	// FAIL CLOSED. This is the admission boundary: every caller here is about to
	// write something the user can later recall, export, or search. An
	// unreadable rules store used to come back as DEFAULTS, which meant a
	// transient D1 error on one SELECT silently converted "never keep my salary"
	// into "keep everything" — and the fail-closed handling every caller already
	// had could never fire, because nothing ever threw.
	return getMemoryRules(env, userId, { failClosed: true });
}

/**
 * Re-resolve the server-owned parent policy when accepted work actually begins
 * extraction. The source/content snapshot is immutable, but an administrator's
 * later policy edit must reach queued work that has not written memory yet.
 *
 * Credential/request layers are acceptance-time authority and therefore stay
 * immutable. Managed layers can only narrow the freshly loaded parent; legacy
 * unmanaged credentials retain their historical replacement semantics. The
 * descriptor is produced by trusted doors and rides inside the durable queue --
 * callers cannot provide it through the public request body.
 */
export async function resolveQueuedAdmissionRules(env, userId, overrideRules, policy, meta = {}) {
	if (!policy || policy.schema !== "itsuki.admission-policy/v1") {
		return resolveAdmissionRules(env, userId, overrideRules);
	}

	const accountUserId = String(
		// Policy belongs to the immutable memory owner. `account_user_id` is the
		// authenticated actor and can be a different organization member.
		meta.owner_user_id
		?? meta.ownerUserId
		?? meta.account_user_id
		?? meta.accountUserId
		?? userId,
	).trim();
	if (!accountUserId) throw new Error("queued admission policy has no account owner");

	let rules = await getMemoryRules(env, accountUserId, { failClosed: true });
	const layers = Array.isArray(policy.layers) ? policy.layers.slice(0, 2) : [];
	if (policy.mode === "managed_narrow") {
		for (const layer of layers) rules = narrowManagedMemoryRules(rules, layer);
	} else if (policy.mode === "legacy_replace") {
		for (const layer of layers) rules = mergeRuleOverride(rules, layer);
	} else if (policy.mode !== "account") {
		throw new Error("queued admission policy mode is invalid");
	}

	const managedProjectId = String(
		meta.managed_project_id ?? meta.managedProjectId ?? "",
	).trim();
	if (policy.refresh_project_categories === true) {
		if (!managedProjectId) throw new Error("queued managed policy has no project boundary");
		rules.projectCategories = await activeCategoryRules(env, {
			projectId: managedProjectId,
			memoryOwnerUserId: meta.owner_user_id ?? meta.ownerUserId ?? userId,
			legacy: rules.customCategories ?? [],
		});
	}
	return rules;
}
