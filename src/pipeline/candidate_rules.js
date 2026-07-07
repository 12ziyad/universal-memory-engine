import { normalizeLabel } from "../lib/text.js";

const EXPLICIT_RE = /^\s*(remember|save this|important|keep this)\s*[:,-]?\s+/i;
const PREFERENCE_RE = /\b(i prefer|i like|i don't like|i do not like|my preference is)\b/i;
const PROJECT_RULE_RE = /\b(for\s+project\s+[^,.]+|always\s+check|deploy\s+(only\s+)?after|after tests|dry-?run|migration(s)? before deploy)\b/i;
const LIFE_EVENT_RE = /\b(died|passed away|passed on|diagnosed|injured|moved to|moved out|moved in|got married|married|born|broke up)\b/i;
const SKILL_ACTION_RE = /\b(started learning|start learning|am learning|i'm learning|learning|practiced|practised|trained|training)\b/i;
const RELATIONSHIP_RE = /\b(is my|my .* is|best friend|teammate|team mate|grandmother|grandfather|mother|father|sister|brother|friend)\b/i;
const CORRECTION_RE = /\b(actually|correction|replace|no longer|not anymore|from now on|instead|forget that)\b/i;
const WEAK_RE = /\b(maybe|might|someday|some day|kind of|kinda|probably|not sure|thinking about)\b/i;

function clean(value) {
	return String(value ?? "").replace(/\s+/g, " ").trim();
}

function titleCase(value) {
	return clean(value)
		.split(/\s+/)
		.filter(Boolean)
		.map((word) => word.slice(0, 1).toUpperCase() + word.slice(1).toLowerCase())
		.join(" ");
}

function sentenceWithoutPrefix(text) {
	return clean(text).replace(EXPLICIT_RE, "").trim();
}

function extractProjectLabel(text) {
	const match = clean(text).match(/\bfor\s+(project\s+[^,.]+?)(?:,|\s+deploy|\s+use|\s+always|\s+after|$)/i);
	if (match?.[1]) return titleCase(match[1]);
	if (/\bmigration(s)? before deploy|deploy|dry-?run|tests\b/i.test(text)) return "Deployment Workflow";
	return null;
}

function extractSkillLabel(text) {
	const patterns = [
		/\b(?:started learning|start learning|am learning|i'm learning|learning)\s+([a-z0-9][a-z0-9 .+#-]{1,50})/i,
		/\b(?:practiced|practised|trained|training)\s+([a-z0-9][a-z0-9 .+#-]{1,50})/i,
	];
	for (const pattern of patterns) {
		const match = clean(text).match(pattern);
		if (match?.[1]) {
			return titleCase(match[1]
				.replace(/\b(today|now|this week|daily)\b/gi, "")
				.replace(/[.,!?;:]+$/g, "")
				.trim());
		}
	}
	return null;
}

function extractRelationshipLabel(text) {
	const cleaned = clean(text);
	const named = cleaned.match(/\b([A-Z][a-zA-Z0-9_-]{1,40})\s+is my\s+([a-z ]{3,40})/);
	if (named?.[1]) return titleCase(named[1]);
	const friendMoved = cleaned.match(/\bmy friend\s+([A-Z]?[a-zA-Z0-9_-]{2,40})\s+moved\b/i);
	if (friendMoved?.[1]) return titleCase(friendMoved[1]);
	const relation = cleaned.match(/\bmy\s+(grandmother|grandfather|mother|father|sister|brother|friend|teammate|team mate|wife|husband|partner)\b/i);
	if (relation?.[1]) return titleCase(relation[1].replace("team mate", "teammate"));
	return null;
}

function lifeAction(text) {
	const lower = clean(text).toLowerCase();
	if (/\b(died|passed away|passed on)\b/.test(lower)) return "passed_away";
	if (/\bdiagnosed\b/.test(lower)) return "diagnosed";
	if (/\binjur/.test(lower)) return "injured";
	if (/\bmoved\b/.test(lower)) return "moved";
	if (/\bmarried\b/.test(lower)) return "married";
	if (/\bborn\b/.test(lower)) return "born";
	if (/\bbroke up\b/.test(lower)) return "broke_up";
	return "other";
}

function lifeLabel(text) {
	const relation = extractRelationshipLabel(text);
	if (relation) return relation;
	const lower = clean(text).toLowerCase();
	if (/\binjur/.test(lower)) return "Injury";
	if (/\bdiagnosed\b/.test(lower)) return "Health Diagnosis";
	if (/\bmarried\b/.test(lower)) return "Marriage";
	return null;
}

export function isWeakCandidateSignal(text) {
	const value = clean(text);
	return WEAK_RE.test(value) && !isStrongDurableSignal(value);
}

export function isStrongDurableSignal(text) {
	const value = clean(text);
	if (!value) return false;
	if (EXPLICIT_RE.test(value)) return true;
	if (PREFERENCE_RE.test(value)) return true;
	if (PROJECT_RULE_RE.test(value)) return true;
	if (LIFE_EVENT_RE.test(value)) return true;
	if (SKILL_ACTION_RE.test(value)) return true;
	if (RELATIONSHIP_RE.test(value) && /\bis my\b/i.test(value)) return true;
	if (CORRECTION_RE.test(value)) return true;
	return false;
}

export function durablePlanFromText(text, fallback = {}) {
	const raw = sentenceWithoutPrefix(text);
	const labelGuess = clean(fallback.label ?? fallback.label_guess ?? fallback.labelGuess);
	const confidence = Math.max(0.75, Number(fallback.confidence ?? 0.85));

	if (LIFE_EVENT_RE.test(raw)) {
		const action = lifeAction(raw);
		const label = lifeLabel(raw) ?? labelGuess ?? "Life Event";
		const category = action === "injured" || action === "diagnosed" ? "health"
			: action === "moved" ? "place"
				: ["passed_away", "born"].includes(action) ? "family"
					: "life_event";
		return {
			type: "event",
			label,
			category,
			action,
			text: raw,
			importance: ["passed_away", "diagnosed", "married", "born"].includes(action) ? "life_significant" : "important",
			confidence,
			reason: "strong_life_event",
		};
	}

	if (PREFERENCE_RE.test(raw)) {
		return {
			type: "slice",
			label: labelGuess || "Response Preferences",
			category: "preference",
			sliceKind: "preference",
			text: raw,
			confidence,
			reason: "strong_preference",
		};
	}

	if (PROJECT_RULE_RE.test(raw) || CORRECTION_RE.test(raw)) {
		return {
			type: "slice",
			label: (extractProjectLabel(raw) ?? labelGuess) || "Workflow Rules",
			category: "project",
			sliceKind: "decision",
			text: raw,
			confidence,
			reason: CORRECTION_RE.test(raw) ? "correction_rule" : "project_rule",
		};
	}

	if (SKILL_ACTION_RE.test(raw)) {
		const label = (extractSkillLabel(raw) ?? labelGuess) || "Skill Practice";
		return {
			type: "event",
			label,
			category: "skill",
			action: /\bpractic|trained|training\b/i.test(raw) ? "practiced" : "started",
			text: raw,
			importance: "ordinary",
			confidence,
			reason: "skill_action",
		};
	}

	if (RELATIONSHIP_RE.test(raw)) {
		const label = (extractRelationshipLabel(raw) ?? labelGuess) || "Relationship";
		return {
			type: "slice",
			label,
			category: /grand|mother|father|sister|brother/i.test(label) ? "family" : "relationship",
			sliceKind: "other",
			text: raw,
			confidence,
			reason: "relationship_fact",
		};
	}

	if (EXPLICIT_RE.test(text)) {
		return {
			type: "slice",
			label: labelGuess || titleCase(normalizeLabel(raw).split(" ").slice(0, 4).join(" ")) || "Remembered Fact",
			category: "other",
			sliceKind: "other",
			text: raw,
			confidence,
			reason: "explicit_memory",
		};
	}

	return null;
}
