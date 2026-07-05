import { normalizeLabel, tokens } from "../lib/text.js";
import { dominantDomain } from "./signals.js";

const BAD_STARTS = [
	"can you",
	"could you",
	"give me",
	"help me",
	"i want",
	"need to",
	"please",
	"want",
	"wants",
	"see",
	"see prototype",
	"discuss",
	"discussing",
	"explore",
	"exploring",
	"asked",
	"user asked",
	"assistant",
	"the assistant",
	"the user",
	"user wants",
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
	"assistant response",
	"chat phrasing",
	"example topic",
	"detailed and interactive",
	"impressive world facing",
	"impressive/world-facing",
	"modern conceptual adapters",
	"prototype preview",
	"request sentence",
	"vague request",
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

const TITLE_PROFILES = [
	{
		id: "uml",
		title: "UML Architecture Decisions",
		terms: [
			["uml", 8],
			["universal memory", 8],
			["memory engine", 7],
			["memory page", 7],
			["memory pages", 8],
			["graph ux", 8],
			["graph layout", 7],
			["cloudflare", 5],
			["workers", 4],
			["d1", 4],
			["vectorize", 4],
			["mcp", 5],
			["run 3.2", 7],
			["run 3.3", 7],
			["run 3.4", 7],
		],
	},
	{
		id: "graphrl",
		title: "GraphRL-Cypher Research Session",
		terms: [["graphrl", 8], ["cypher", 6], ["neo4j", 6]],
	},
	{
		id: "gta",
		title: "GTA 6 / PS5 Research",
		terms: [["gta 6", 8], ["grand theft auto", 8], ["ps5", 7], ["playstation", 6], ["emi", 4], ["loan", 3]],
	},
	{
		id: "car",
		title: "Car Research",
		terms: [["car", 4], ["cars", 4], ["vehicle", 4], ["vehicles", 4]],
	},
	{
		id: "bike",
		title: "Bike Research",
		terms: [["bike", 4], ["bikes", 4], ["motorcycle", 4], ["motorcycles", 4]],
	},
];

const ACRONYMS = new Map([
	["ai", "AI"],
	["api", "API"],
	["d1", "D1"],
	["gpt", "GPT"],
	["gta", "GTA"],
	["gpmai", "GPMai"],
	["llm", "LLM"],
	["lora", "LoRA"],
	["mcp", "MCP"],
	["dsa", "DSA"],
	["neo4j", "Neo4j"],
	["ps5", "PS5"],
	["rag", "RAG"],
	["swe", "SWE"],
	["uml", "UML"],
	["ui", "UI"],
	["ux", "UX"],
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
	if (words.length > 12) return true;
	if (words.length === 1 && raw.length < 4) return true;
	if (/^[a-z]/.test(raw) && words.length >= 4) return true;
	if (/[?.!]$/.test(raw)) return true;
	if (BAD_STARTS.some((start) => norm === start || norm.startsWith(`${start} `))) return true;
	if (BAD_PHRASES.some((phrase) => norm.includes(phrase))) return true;
	if (/\b(want|wants|need|needs|see|show|make|create|prototype)\b.*\b(prototype|interactive|world facing|demo)\b/.test(norm)) return true;
	if (/\b(user|assistant|chat|conversation)\b.*\b(asked|said|wants|request|reply|response)\b/.test(norm)) return true;
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
	const scored = scoreProfiles(clean, clean);
	if (scored[0]?.score >= 4) return titleForProfile(scored[0], clean);
	return `${titleCaseWords(clean)} Research`;
}

function countTerm(text, term) {
	const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
	let total = 0;
	let match;
	while ((match = re.exec(text))) {
		const before = text.slice(Math.max(0, match.index - 44), match.index);
		const after = text.slice(match.index + match[0].length, match.index + match[0].length + 44);
		const nearby = `${before} ${after}`;
		const exampleish = /\b(example|examples|like|e\.g|eg|skip|except|exclude|not|hypothetical|pretend)\b/i.test(nearby);
		total += exampleish ? 0.18 : 1;
	}
	return total;
}

function scoreProfiles(text, topic) {
	const haystack = String(text ?? "");
	const topicNorm = normalizeLabel(topic);
	return TITLE_PROFILES.map((profile) => {
		let score = 0;
		for (const [term, weight] of profile.terms) {
			score += countTerm(haystack, term) * weight;
			if (topicNorm && topicNorm.includes(normalizeLabel(term))) score += Math.min(5, weight);
		}
		return { ...profile, score };
	}).sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
}

function titleForProfile(profile, text) {
	if (profile.id !== "uml") return profile.title;
	const norm = normalizeLabel(text);
	const runHits = [];
	if (/\brun 3 2\b/.test(norm)) runHits.push("3.2");
	if (/\brun 3 3\b/.test(norm)) runHits.push("3.3");
	if (/\brun 3 4\b/.test(norm)) runHits.push("3.4");
	const hasPages = /\b(memory page|memory pages|manual collect)\b/.test(norm);
	const hasGraph = /\b(graph|layout|cluster|zoom|focus)\b/.test(norm);
	const hasReset = /\b(reset|delete all|danger zone)\b/.test(norm);
	if (/\bgpmai\b/.test(norm) && /\b(cluster|rules|graph)\b/.test(norm)) return "GPMai Memory Graph Cluster Rules";
	if (hasGraph && hasReset) return "UML Graph Layout and Reset UX";
	if (runHits.length && hasPages && hasGraph) {
		const run = runHits.length > 1 ? `Run ${runHits.join("/")}` : `Run ${runHits[0]}`;
		return `UML ${run} Memory Pages and Graph UX`;
	}
	if (hasPages && hasGraph) return "UML Memory Pages and Graph UX";
	if (hasGraph) return "UML Graph Layout and Repair";
	return profile.title;
}

function domainTitle(text, topic) {
	const norm = normalizeLabel(`${topic ?? ""}\n${text ?? ""}`);
	const domain = dominantDomain(`${topic ?? ""}\n${text ?? ""}`);
	if (!domain) return null;
	if (domain.id === "career_applications") {
		if (/\bmicrosoft\b/.test(norm) && /\b(resume|application|recruiting|swe|software engineer)\b/.test(norm)) {
			return "Microsoft SWE Application and Resume Review";
		}
		return "Career Application and Resume Review";
	}
	if (domain.id === "business_product") return "Product Landing Page and Login Plan";
	if (domain.id === "fitness_habits" || domain.id === "health_fitness") {
		if (/\bboxing\b/.test(norm) && /\b(shoulder|pain|injury|return)\b/.test(norm)) {
			return "Boxing Shoulder Pain and Return Plan";
		}
	}
	if (domain.id === "projects_systems" && /\bgpmai\b/.test(norm) && /\b(cluster|rules|graph)\b/.test(norm)) {
		return "GPMai Memory Graph Cluster Rules";
	}
	return null;
}

export function generateTitle(text, { topic, preferred, fallback = "Memory Research Session" } = {}) {
	if (preferred && !isBadTitle(preferred)) return titleCaseWords(preferred);
	const haystack = String(text ?? "");
	const fromDomain = domainTitle(haystack, topic);
	if (fromDomain && !isBadTitle(fromDomain)) return fromDomain;
	const scored = scoreProfiles(haystack, topic);
	const best = scored[0];
	const second = scored[1];
	if (best?.score >= 6 && best.score >= (second?.score ?? 0) + 2) {
		const title = titleForProfile(best, `${topic ?? ""}\n${haystack}`);
		if (!isBadTitle(title)) return title;
	}

	const fromTopic = topicTitle(topic);
	if (fromTopic && !isBadTitle(fromTopic)) return fromTopic;

	const words = tokens(haystack)
		.filter((word) => word.length > 2 && !STOPWORDS.has(word))
		.slice(0, 5);
	if (words.length >= 2) {
		const title = `${titleCaseWords(words.join(" "))} Research Session`;
		if (!isBadTitle(title)) return title;
	}
	return fallback;
}
