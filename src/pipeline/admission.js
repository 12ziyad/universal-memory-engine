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

import { getMemoryRules } from "./rules.js";

/**
 * The one way an enforcement lane obtains rules: the door's resolved account
 * rules when present, its own row otherwise. `overrideRules` must be the
 * object the door resolved — never re-derive rules for a scoped mem_ id.
 */
export async function resolveAdmissionRules(env, userId, overrideRules) {
	if (overrideRules !== undefined && overrideRules !== null) return overrideRules;
	return getMemoryRules(env, userId);
}
