import { jaccard, normalizeLabel, tokens } from "../lib/text.js";

const GENERIC_TOPIC_WORDS = new Set([
	"about",
	"application",
	"chat",
	"conversation",
	"details",
	"discussion",
	"feedback",
	"memory",
	"page",
	"plan",
	"review",
	"session",
	"summary",
	"user",
]);

export const DOMAIN_PROFILES = [
	{
		id: "career_applications",
		label: "Career & Applications",
		title: "Microsoft SWE Application and Resume Review",
		terms: [
			"application",
			"acknowledgment",
			"ats",
			"bangalore",
			"career",
			"dsa",
			"interview",
			"job",
			"microsoft",
			"recruiter",
			"recruiting",
			"resume",
			"sde",
			"software engineer",
			"swe",
		],
	},
	{
		id: "business_product",
		label: "Business & Product",
		title: "Product Landing Page and Login Plan",
		terms: ["business", "customer", "landing page", "login", "pricing", "publishing", "signup", "startup"],
	},
	{
		id: "projects_systems",
		label: "Projects & Systems",
		title: "GPMai Memory Graph Cluster Rules",
		terms: ["cluster", "gpm", "gpmai", "graph", "memory graph", "rules", "uml", "universal memory"],
	},
	{
		id: "software_product",
		label: "Software Product",
		title: "Software Product Architecture Plan",
		terms: ["app", "architecture", "backend", "frontend", "product", "software product", "ux"],
	},
	{
		id: "fitness_habits",
		label: "Fitness & Habits",
		title: "Boxing Shoulder Pain and Return Plan",
		terms: ["boxing", "fitness", "injury", "pain", "return plan", "shoulder", "training"],
	},
	{
		id: "preferences_research",
		label: "Preferences & Research",
		title: "GTA 6 / PS5 Research",
		terms: ["bike", "car", "gta", "gta 6", "playstation", "ps5", "research"],
	},
];

export function safeJsonArray(value) {
	try {
		const parsed = JSON.parse(value || "[]");
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function countPhrase(haystack, phrase) {
	const norm = normalizeLabel(phrase);
	if (!norm) return 0;
	const re = new RegExp(`\\b${norm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
	return [...haystack.matchAll(re)].length;
}

export function scoreDomains(text) {
	const haystack = normalizeLabel(text);
	return DOMAIN_PROFILES.map((profile) => {
		const score = profile.terms.reduce((total, term) => {
			const hits = countPhrase(haystack, term);
			const weight = term.includes(" ") || term.length >= 6 ? 3 : 2;
			return total + hits * weight;
		}, 0);
		return { ...profile, score };
	}).sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
}

export function dominantDomain(text, minScore = 4) {
	const [best, second] = scoreDomains(text);
	if (!best || best.score < minScore) return null;
	if (second && best.score < second.score + 2) return null;
	return best;
}

export function keyTerms(value, limit = 24) {
	const counts = new Map();
	for (const token of tokens(value)) {
		if (token.length < 3 || GENERIC_TOPIC_WORDS.has(token)) continue;
		counts.set(token, (counts.get(token) || 0) + 1);
	}
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, limit)
		.map(([token]) => token);
}

export function keyEntities(value, limit = 16) {
	const text = String(value ?? "");
	const caps = text.match(/\b[A-Z][A-Za-z0-9/+.-]{1,}(?:\s+[A-Z][A-Za-z0-9/+.-]{1,}){0,3}\b/g) ?? [];
	const known = [
		"bangalore",
		"cloudflare",
		"d1",
		"dsa",
		"gpmai",
		"mcp",
		"microsoft",
		"ps5",
		"resume",
		"uml",
		"vectorize",
	];
	const values = new Map();
	for (const item of caps) {
		const norm = normalizeLabel(item);
		if (!norm || GENERIC_TOPIC_WORDS.has(norm)) continue;
		values.set(norm, item.trim());
	}
	const normText = normalizeLabel(text);
	for (const item of known) {
		if (normText.includes(item)) values.set(item, item.toUpperCase() === item ? item : item);
	}
	return [...values.keys()].slice(0, limit);
}

export function contentSignature(input = {}) {
	const text = [
		input.title,
		input.topic,
		input.summary,
		input.text,
		input.full_markdown,
		input.key_points_json,
		input.related_concepts_json,
	].filter(Boolean).join("\n");
	const domain = dominantDomain(text);
	return {
		text,
		normalized: normalizeLabel(text),
		domainId: domain?.id ?? null,
		domainScore: domain?.score ?? 0,
		terms: keyTerms(text),
		entities: keyEntities(text),
	};
}

export function overlapRatio(a = [], b = []) {
	const left = new Set(a);
	const right = new Set(b);
	if (!left.size || !right.size) return 0;
	let hits = 0;
	for (const item of left) if (right.has(item)) hits++;
	return hits / Math.min(left.size, right.size);
}

export function topicSimilarity(a, b) {
	const sigA = contentSignature(a);
	const sigB = contentSignature(b);
	const termScore = jaccard(sigA.terms, sigB.terms);
	const entityScore = overlapRatio(sigA.entities, sigB.entities);
	const sameDomain = sigA.domainId && sigA.domainId === sigB.domainId ? 0.24 : 0;
	return {
		score: Math.min(1, termScore * 0.48 + entityScore * 0.36 + sameDomain),
		termScore,
		entityScore,
		sameDomain: Boolean(sameDomain),
		left: sigA,
		right: sigB,
	};
}

export function normalizeEvidenceText(text) {
	return normalizeLabel(text)
		.replace(/\b\d{10,}\b/g, "#")
		.replace(/\s+/g, " ")
		.trim();
}

export function dedupeEvidence(evidence = [], limit = 12) {
	const seen = new Set();
	const out = [];
	for (const item of evidence || []) {
		const snippet = String(item?.snippet ?? "").replace(/\s+/g, " ").trim();
		if (!snippet) continue;
		const key = normalizeEvidenceText(snippet).slice(0, 240);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		out.push({ ...item, snippet });
		if (out.length >= limit) break;
	}
	return out;
}
