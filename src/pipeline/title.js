import { normalizeLabel, tokens } from "../lib/text.js";

const BAD_STARTS = [
	"want",
	"wants",
	"see",
	"discuss",
	"discussing",
	"explore",
	"exploring",
	"asked",
	"user asked",
	"assistant",
	"the assistant",
	"the user",
	"how to",
	"what is",
	"this chat",
];

const BAD_PHRASES = [
	"in this chat",
	"from this chat",
	"save this",
	"save everything",
	"what we discussed",
	"user asked",
	"assistant said",
	"detailed and interactive",
	"impressive world facing",
	"modern conceptual adapters",
];

const STOPWORDS = new Set([
	"about",
	"above",
	"after",
	"again",
	"also",
	"and",
	"are",
	"because",
	"chat",
	"collect",
	"conversation",
	"details",
	"discussed",
	"everything",
	"from",
	"have",
	"into",
	"later",
	"memory",
	"more",
	"only",
	"save",
	"session",
	"skip",
	"summary",
	"that",
	"this",
	"topic",
	"user",
	"what",
	"with",
]);

const SPECIAL_TITLES = [
	{ re: /\b(graphrl|cypher|neo4j)\b/i, title: "GraphRL-Cypher Research Session" },
	{ re: /\b(gta\s*6|grand theft auto|ps5|playstation|emi|loan)\b/i, title: "GTA 6 / PS5 Research" },
	{ re: /\b(uml|universal memory|memory engine|mcp|cloudflare|vectorize|d1|durable object)\b/i, title: "UML Architecture Decisions" },
	{ re: /\b(car|cars|vehicle|vehicles)\b/i, title: "Car Research" },
	{ re: /\b(bike|bikes|motorcycle|motorcycles)\b/i, title: "Bike Research" },
];

const ACRONYMS = new Map([
	["ai", "AI"],
	["api", "API"],
	["d1", "D1"],
	["gpt", "GPT"],
	["gta", "GTA"],
	["llm", "LLM"],
	["lora", "LoRA"],
	["mcp", "MCP"],
	["neo4j", "Neo4j"],
	["ps5", "PS5"],
	["rag", "RAG"],
	["uml", "UML"],
	["ui", "UI"],
]);

export function canonicalTitle(title) {
	return normalizeLabel(title).replace(/\b(summary|session|research|memory|page)\b/g, "").trim() || normalizeLabel(title);
}

export function titleCaseWords(value) {
	return String(value ?? "")
		.split(/\s+/)
		.filter(Boolean)
		.map((word) => {
			const clean = word.replace(/[^\w/+.-]/g, "");
			const key = clean.toLowerCase();
			if (ACRONYMS.has(key)) return ACRONYMS.get(key);
			if (/^[A-Z0-9/+.-]{2,}$/.test(clean)) return clean;
			return clean.slice(0, 1).toUpperCase() + clean.slice(1).toLowerCase();
		})
		.join(" ");
}

export function isBadTitle(title) {
	const raw = String(title ?? "").trim();
	const norm = normalizeLabel(raw);
	if (!norm) return true;
	if (ACRONYMS.has(norm) || /^[a-z]+\d+$/i.test(raw) || /^[A-Z0-9]{2,}$/.test(raw)) return false;
	const words = norm.split(/\s+/).filter(Boolean);
	if (words.length > 9) return true;
	if (words.length === 1 && raw.length < 4) return true;
	if (/^[a-z]/.test(raw) && words.length >= 4) return true;
	if (/[?.!]$/.test(raw)) return true;
	if (BAD_STARTS.some((start) => norm === start || norm.startsWith(`${start} `))) return true;
	if (BAD_PHRASES.some((phrase) => norm.includes(phrase))) return true;
	if (/^(i|we|you|he|she|they)\b/.test(norm)) return true;
	return false;
}

function cleanTopic(topic) {
	const raw = String(topic ?? "")
		.replace(/\b(skip|except|from|this|chat|conversation|details)\b.*$/i, "")
		.replace(/[^\w/+.-]+/g, " ")
		.trim();
	return raw;
}

function topicTitle(topic) {
	const clean = cleanTopic(topic);
	if (!clean) return null;
	for (const hit of SPECIAL_TITLES) {
		if (hit.re.test(clean)) return hit.title;
	}
	return `${titleCaseWords(clean)} Research`;
}

export function generateTitle(text, { topic, preferred, fallback = "Memory Research Session" } = {}) {
	if (preferred && !isBadTitle(preferred)) return titleCaseWords(preferred);
	const fromTopic = topicTitle(topic);
	if (fromTopic && !isBadTitle(fromTopic)) return fromTopic;

	const haystack = String(text ?? "");
	for (const hit of SPECIAL_TITLES) {
		if (hit.re.test(haystack)) return hit.title;
	}

	const words = tokens(haystack)
		.filter((word) => word.length > 2 && !STOPWORDS.has(word))
		.slice(0, 5);
	if (words.length >= 2) {
		const title = `${titleCaseWords(words.join(" "))} Research Session`;
		if (!isBadTitle(title)) return title;
	}
	return fallback;
}
