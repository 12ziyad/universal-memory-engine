import { canonicalIdentity } from "./manual_identity.js";
import { isBadTitle, titleCaseWords } from "./title.js";

const ENTITY_TYPES = "project|app|application|service|system|tool|database|workspace|product|site|website";
const DESCRIPTORS = "test|main|current|personal|side|work|new|old|primary|internal|client";
const RELATION_VERBS = "uses|use|runs on|depends on|is built with|is powered by";
const CORRECTION_CUE_RE = /\b(?:correction|actually|instead of|no longer|replace(?:s|d)?|not)\b/i;
const NEGATED_PREFIX_RE = /^(?:not|no longer|instead of|rather than)\s+/i;

const FALLBACK_STOPWORDS = new Set([
	"a", "an", "and", "are", "for", "from", "i", "is", "it", "my", "not", "of", "on",
	"our", "project", "remember", "save", "that", "the", "this", "to", "uses", "using", "want", "with",
]);

function cleanText(value, limit = 240) {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	return text.length <= limit ? text : text.slice(0, limit).trim();
}

export function stripManualDirective(value) {
	let text = cleanText(value);
	for (let pass = 0; pass < 3; pass++) {
		const prior = text;
		text = text
			.replace(/^(?:please\s+)?(?:correction|correct this|update this)\s*[:,-]?\s*/i, "")
			.replace(/^(?:please\s+)?actually\s*[:,-]?\s*/i, "")
			.replace(/^(?:please\s+)?(?:remember|save|store|keep)(?:\s+this|\s+that)?\s*[:,-]?\s*/i, "")
			.trim();
		if (text === prior) break;
	}
	return text;
}

export function cleanManualEntityLabel(value, { stripPredicate = true } = {}) {
	let text = stripManualDirective(value)
		.replace(/^[\s'"`“”‘’():;,.-]+|[\s'"`“”‘’():;,.-]+$/gu, "")
		.trim();
	text = text.replace(NEGATED_PREFIX_RE, "").trim();
	text = text
		.replace(new RegExp(`^(?:my|our|the user's|the users?)\\s+(?:(?:${DESCRIPTORS})\\s+){0,3}(?:${ENTITY_TYPES})\\s+(?:(?:is|called|named)\\s+)?`, "i"), "")
		.replace(new RegExp(`^(?:an?|the)\\s+(?:(?:${DESCRIPTORS})\\s+){0,3}(?:${ENTITY_TYPES})\\s+(?:(?:is|called|named)\\s+)?`, "i"), "")
		.replace(new RegExp(`^(?:(?:${DESCRIPTORS})\\s+){1,3}(?:${ENTITY_TYPES})\\s+(?:(?:is|called|named)\\s+)?`, "i"), "")
		.replace(/^(?:called|named)\s+/i, "")
		.trim();
	if (stripPredicate) {
		text = text.replace(new RegExp(`\\s+(?:${RELATION_VERBS})\\s+.+$`, "i"), "").trim();
	}
	text = text
		.replace(NEGATED_PREFIX_RE, "")
		.replace(/^[\s'"`“”‘’():;,.-]+|[\s'"`“”‘’():;,.-]+$/gu, "")
		.trim();
	if (!text) return "";
	return text === text.toLocaleLowerCase("en-US") ? titleCaseWords(text) : text;
}

export function unsafeManualEntityLabel(value) {
	const raw = cleanText(value);
	const key = canonicalIdentity(raw);
	if (!key || NEGATED_PREFIX_RE.test(raw)) return true;
	if (CORRECTION_CUE_RE.test(raw) && /^(?:correction|actually|not|no longer|instead of)\b/i.test(raw)) return true;
	if (new RegExp(`\\b(?:${RELATION_VERBS})\\b`, "i").test(raw)) return true;
	return /[.!?]$/.test(raw) || key.split(" ").length > 8;
}

export function needsManualTitleGeneration(rawLabel, cleanedLabel) {
	const raw = cleanText(rawLabel);
	const clean = cleanText(cleanedLabel);
	const shortTechnical = /^[A-Z][A-Za-z0-9+#./-]{1,15}$/.test(clean);
	if (!clean || unsafeManualEntityLabel(clean) || (!shortTechnical && isBadTitle(clean))) return true;
	if (raw !== clean && new RegExp(
		`^(?:(?:please\\s+)?(?:remember|save|store|keep)\\b|(?:my|our|the user's|the users?)\\s+(?:(?:${DESCRIPTORS})\\s+){0,3}(?:${ENTITY_TYPES})\\b)`,
		"i",
	).test(raw)) return true;
	if (raw !== clean && (CORRECTION_CUE_RE.test(raw) || unsafeManualEntityLabel(raw))) return true;
	const words = canonicalIdentity(clean).split(" ").filter(Boolean);
	return words.length > 6;
}

export function fallbackManualEntityTitle(value) {
	const cleaned = cleanManualEntityLabel(value);
	const shortTechnical = /^[A-Z][A-Za-z0-9+#./-]{1,15}$/.test(cleaned);
	if (cleaned && !unsafeManualEntityLabel(cleaned) && (shortTechnical || !isBadTitle(cleaned))) return cleaned;
	const words = canonicalIdentity(cleaned || value)
		.split(" ")
		.filter((word) => word.length > 1 && !FALLBACK_STOPWORDS.has(word))
		.slice(-6);
	return titleCaseWords(words.join(" "));
}

function relationshipType(verb) {
	const key = String(verb ?? "").toLocaleLowerCase("en-US");
	if (key === "depends on" || key === "is powered by") return "depends_on";
	return "uses";
}

function correctionRecord({ subject, verb = "uses", oldTarget = null, newTarget = null, text }) {
	const fromLabel = cleanManualEntityLabel(subject);
	const oldLabel = cleanManualEntityLabel(oldTarget);
	const newLabel = cleanManualEntityLabel(newTarget);
	if (!fromLabel || (!oldLabel && !newLabel)) return null;
	const type = relationshipType(verb);
	const noun = type === "depends_on" ? "Dependency" : "Technology";
	const historyText = oldLabel && newLabel
		? `${noun} corrected from ${oldLabel} to ${newLabel}.`
		: oldLabel
			? `${noun} removed: ${oldLabel}.`
			: `${noun} corrected to ${newLabel}.`;
	const currentText = newLabel
		? `${fromLabel} ${type === "depends_on" ? "depends on" : "uses"} ${newLabel}.`
		: `${fromLabel} no longer ${type === "depends_on" ? "depends on" : "uses"} ${oldLabel}.`;
	return {
		subject: { label: fromLabel, category: "project", existing_node_id: null, aliases: [] },
		old_target: oldLabel ? { label: oldLabel, category: "tool", existing_node_id: null, aliases: [] } : null,
		new_target: newLabel ? { label: newLabel, category: "tool", existing_node_id: null, aliases: [] } : null,
		type,
		text: cleanText(text, 1200),
		current_text: currentText,
		history_text: historyText,
		confidence: 0.98,
	};
}

export function parseManualRelationshipCorrection(value) {
	const raw = cleanText(value, 1200);
	if (!raw || !CORRECTION_CUE_RE.test(raw)) return null;
	const line = stripManualDirective(raw);
	const verbPattern = `(${RELATION_VERBS})`;

	let match = line.match(new RegExp(`^(.+?)\\s+${verbPattern}\\s+(.+?)(?:,?\\s+)(?:not|instead of)\\s+(.+?)[.!]?$`, "i"));
	if (match) {
		return correctionRecord({ subject: match[1], verb: match[2], newTarget: match[3], oldTarget: match[4], text: raw });
	}

	match = line.match(new RegExp(`^(.+?)\\s+no longer\\s+${verbPattern}\\s+(.+?)(?:[.;]\\s*(?:it|the project|the app|the system)\\s+(?:now\\s+)?${verbPattern}\\s+(.+?))?[.!]?$`, "i"));
	if (match) {
		return correctionRecord({
			subject: match[1],
			verb: match[2],
			oldTarget: match[3],
			newTarget: match[5] ?? null,
			text: raw,
		});
	}

	match = line.match(/^(.+?)\s+replace(?:s|d)?(?:\s+(?:the\s+)?(?:tool|technology|dependency))?\s+(.+?)\s+with\s+(.+?)[.!]?$/i);
	if (match) {
		return correctionRecord({ subject: match[1], oldTarget: match[2], newTarget: match[3], text: raw });
	}

	match = line.match(/^replace(?:\s+(?:the\s+)?(?:tool|technology|dependency))?\s+(.+?)\s+with\s+(.+?)\s+(?:in|for|on)\s+(.+?)[.!]?$/i);
	if (match) {
		return correctionRecord({ subject: match[3], oldTarget: match[1], newTarget: match[2], text: raw });
	}

	match = line.match(new RegExp(`^(.+?)\\s+actually\\s+${verbPattern}\\s+(.+?)(?:,?\\s+(?:not|instead of)\\s+(.+?))?[.!]?$`, "i"));
	if (match) {
		return correctionRecord({ subject: match[1], verb: match[2], newTarget: match[3], oldTarget: match[4] ?? null, text: raw });
	}

	return null;
}
