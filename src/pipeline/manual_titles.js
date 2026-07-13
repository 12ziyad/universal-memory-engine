import { extractJson, responseText } from "./llm.js";
import { canonicalIdentity, resolveManualIdentity } from "./manual_identity.js";
import {
	cleanManualEntityLabel,
	fallbackManualEntityTitle,
	needsManualTitleGeneration,
	unsafeManualEntityLabel,
} from "./manual_language.js";
import { isBadTitle } from "./title.js";

const TITLE_SYSTEM = `Generate one concise canonical title for a durable memory entity.
Return exactly {"title":"..."}.
Use a human-readable noun phrase, preferably 2-6 meaningful words.
Name the entity, never the command or full sentence.
Remove correction/remember/save wrappers, pronouns, negation, and relationship predicates.
Do not invent words that are not supported by the submitted content or proposed label.`;

function titleWords(value) {
	return canonicalIdentity(value).split(" ").filter(Boolean);
}

function shortTechnicalTitle(value) {
	return /^[A-Z][A-Za-z0-9+#./-]{1,15}$/.test(String(value ?? "").trim());
}

function validGeneratedTitle(title, rawLabel, submittedContent) {
	const clean = cleanManualEntityLabel(title);
	const words = titleWords(clean);
	if (!clean || unsafeManualEntityLabel(clean) || (!shortTechnicalTitle(clean) && isBadTitle(clean))) return false;
	if (!words.length || words.length > 6) return false;
	const support = new Set(titleWords(`${rawLabel}\n${submittedContent}`));
	return words.every((word) => support.has(word));
}

function titleFromOverride(value, identity) {
	if (typeof value === "string") return value;
	if (!value || typeof value !== "object") return null;
	const key = canonicalIdentity(identity?._raw_label ?? identity?.label);
	return value[key] ?? value.title ?? null;
}

async function generateManualTitle(env, config, identity, input) {
	const override = titleFromOverride(input.titleResponse, identity);
	if (override != null) return String(override);
	if (!env?.AI) return null;
	try {
		const result = await env.AI.run(
			config.llm.summaryModel,
			{
				messages: [
					{ role: "system", content: TITLE_SYSTEM },
					{ role: "user", content: JSON.stringify({
						proposed_label: identity?._raw_label ?? identity?.label,
						category: identity?.category ?? "other",
						submitted_content: input.submittedContent,
					}) },
				],
				temperature: 0,
				max_tokens: Math.min(96, config.llm.summaryMaxTokens),
			},
			config.llm.gatewayId ? { gateway: { id: config.llm.gatewayId } } : undefined,
		);
		const text = responseText(result);
		const parsed = extractJson(text);
		return String(parsed?.title ?? text ?? "").trim();
	} catch (error) {
		console.warn("manual title generation failed:", error?.message ?? error);
		return null;
	}
}

function identityLists(integrity) {
	return [
		...(integrity?.facts ?? []).map((item) => item.identity),
		...(integrity?.relationships ?? []).flatMap((item) => [item.from, item.to]),
		...(integrity?.corrections ?? []).flatMap((item) => [item.subject, item.old_target, item.new_target]),
	].filter(Boolean);
}

/**
 * Canonicalize grounded identities before planning. Existing nodes always win;
 * AI title generation is used only for genuinely new, sentence-shaped labels.
 */
export async function refineManualIdentityTitles(env, config, integrity, state, input = {}) {
	const cache = new Map();
	for (const identity of identityLists(integrity)) {
		const rawLabel = String(identity._raw_label ?? identity.label ?? "").trim();
		const cleaned = cleanManualEntityLabel(identity.label ?? rawLabel);
		const manualResolution = identity._manual_resolution ?? null;
		const cacheKey = [
			canonicalIdentity(rawLabel),
			identity.category ?? "other",
			manualResolution?.decision ?? "legacy",
			identity.existing_node_id ?? manualResolution?.selected_ref ?? "",
		].join(":");
		if (cache.has(cacheKey)) {
			const cached = cache.get(cacheKey);
			Object.assign(identity, cached);
			const entityRef = identity.ref ?? identity.entity_ref ?? null;
			const entity = entityRef ? (integrity?.entities ?? []).find((item) => item.ref === entityRef) : null;
			if (entity && entity !== identity) Object.assign(entity, cached);
			continue;
		}

		const proposed = { ...identity, label: cleaned || fallbackManualEntityTitle(rawLabel) };
		let resolved;
		if (manualResolution?.decision === "merge_existing") {
			const selected = (state?.nodes ?? []).find((node) => node.id === identity.existing_node_id);
			resolved = selected
				? {
					label: proposed.label,
					existing_node_id: selected.id,
					aliases: [...new Set(identity.aliases ?? [])],
				}
				: {
					label: proposed.label,
					existing_node_id: null,
					_manual_conflict_reason: identity._manual_conflict_reason ?? "adjudication_reference_unavailable",
				};
		} else if (manualResolution?.decision === "identity_conflict") {
			resolved = {
				label: proposed.label,
				existing_node_id: null,
				_manual_conflict_reason: identity._manual_conflict_reason ??
					manualResolution.reason_codes?.[0] ?? "identity_conflict",
			};
		} else if (manualResolution?.decision === "create_new") {
			if (needsManualTitleGeneration(rawLabel, proposed.label)) {
				const generated = await generateManualTitle(env, config, identity, input);
				const title = validGeneratedTitle(generated, rawLabel, input.submittedContent)
					? cleanManualEntityLabel(generated)
					: fallbackManualEntityTitle(proposed.label || rawLabel);
				resolved = {
					label: title || proposed.label,
					existing_node_id: null,
					aliases: [...new Set([...(identity.aliases ?? []), proposed.label].filter(Boolean))],
				};
			} else {
				resolved = { label: proposed.label, existing_node_id: null };
			}
		} else {
			const decision = resolveManualIdentity(proposed, state?.nodes ?? []);
			if (decision.decision === "existing") {
				resolved = {
					// Keep the grounded submitted name for the planner and receipt. The
					// existing node itself retains its stable canonical label.
					label: proposed.label,
					existing_node_id: decision.node.id,
					aliases: [...new Set(identity.aliases ?? [])],
				};
			} else if (decision.decision === "new" && needsManualTitleGeneration(rawLabel, proposed.label)) {
				const generated = await generateManualTitle(env, config, identity, input);
				const title = validGeneratedTitle(generated, rawLabel, input.submittedContent)
					? cleanManualEntityLabel(generated)
					: fallbackManualEntityTitle(proposed.label || rawLabel);
				resolved = {
					label: title || proposed.label,
					existing_node_id: null,
					aliases: [...new Set([...(identity.aliases ?? []), proposed.label].filter(Boolean))],
				};
			} else {
				resolved = { label: proposed.label, existing_node_id: identity.existing_node_id ?? null };
			}
		}
		cache.set(cacheKey, resolved);
		Object.assign(identity, resolved);
		const entityRef = identity.ref ?? identity.entity_ref ?? null;
		if (entityRef) {
			const entity = (integrity?.entities ?? []).find((item) => item.ref === entityRef);
			if (entity && entity !== identity) Object.assign(entity, resolved);
		}
	}
	return integrity;
}
