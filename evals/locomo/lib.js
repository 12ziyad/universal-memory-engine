/**
 * Shared harness plumbing for the LoCoMo benchmark run.
 *
 * The harness talks to a locally running UML worker (wrangler dev) over the
 * same REST API production serves: /v1/turn for ingestion, /v1/recall for
 * lookups. The answerer/judge goes through POST /eval/llm, a benchmark-only
 * pass-through to Workers AI that exists solely when EVAL_MODE=1 (never in
 * production) — UML's own recall path has no generative model.
 */

const fs = require("node:fs");
const path = require("node:path");

// UML memory operations (/v1/turn, /v1/recall) can target production — local
// wrangler dev has no working Vectorize binding, so recall only behaves like
// the real product against a deployed worker. The answerer/judge door
// (/eval/llm) stays on the local EVAL_MODE worker and never exists in prod.
const BASE = process.env.UML_BASE || "http://127.0.0.1:8799";
const EVAL_BASE = process.env.EVAL_BASE || "http://127.0.0.1:8799";
const PACE_MS = Number(process.env.PACE_MS ?? 350);

function apiKey() {
	const devVars = fs.readFileSync(path.join(__dirname, "..", "..", ".dev.vars"), "utf8");
	const match = devVars.match(/API_KEY="([^"]+)"/);
	if (!match) throw new Error("API_KEY not found in .dev.vars");
	return match[1];
}

const KEY = apiKey();

/** POST with 429/5xx backoff. Returns parsed JSON; throws after 8 attempts. */
async function post(route, body, { attempts = 8, base = BASE } = {}) {
	let lastError;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const res = await fetch(`${base}${route}`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": KEY },
				body: JSON.stringify(body),
			});
			if (res.status === 429 || res.status >= 500) {
				lastError = new Error(`${route} -> ${res.status}`);
				const retryAfter = Number(res.headers.get("retry-after")) || 0;
				await sleep(Math.max(retryAfter * 1000, 1500 * attempt));
				continue;
			}
			if (!res.ok) throw new Error(`${route} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
			return await res.json();
		} catch (error) {
			lastError = error;
			if (String(error?.cause?.code || error?.message).includes("ECONNREFUSED")) {
				throw new Error(`worker not reachable at ${base} — for /eval/llm start: npx wrangler dev --port 8799`);
			}
			await sleep(1500 * attempt);
		}
	}
	throw lastError;
}

/** LLM calls go to the local EVAL_MODE worker, never production. */
function postEval(route, body, options = {}) {
	return post(route, body, { ...options, base: EVAL_BASE });
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadDataset() {
	const file = process.env.LOCOMO_DATA
		|| path.join(__dirname, "EasyLocomo", "data", "locomo10.json");
	if (!fs.existsSync(file)) {
		throw new Error(
			`Dataset not found at ${file}.\nClone it first:\n  git clone https://github.com/playeriv65/EasyLocomo evals/locomo/EasyLocomo`,
		);
	}
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Sessions of a conversation in chronological order: [{ key, dateTime, turns }] */
function sessionsOf(conversation) {
	return Object.keys(conversation)
		.filter((key) => /^session_\d+$/.test(key) && Array.isArray(conversation[key]))
		.sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)))
		.map((key) => ({
			key,
			dateTime: conversation[`${key}_date_time`] || "",
			turns: conversation[key],
		}));
}

/** One turn rendered as the text UML ingests. Image turns keep their caption. */
function renderTurn(turn, dateTime) {
	let text = `${turn.speaker}: ${turn.text ?? ""}`.trim();
	if (turn.blip_caption) text += ` [shares a photo: ${turn.blip_caption}]`;
	return dateTime ? `[${dateTime}] ${text}` : text;
}

// --- SQuAD-style token F1 ---------------------------------------------------

function normalizeAnswer(text) {
	return String(text ?? "")
		.toLowerCase()
		.replace(/\b(a|an|the)\b/g, " ")
		.replace(/[^a-z0-9\s]/g, " ")
		.split(/\s+/)
		.filter(Boolean);
}

function tokenF1(prediction, gold) {
	const predTokens = normalizeAnswer(prediction);
	const goldTokens = normalizeAnswer(gold);
	if (predTokens.length === 0 || goldTokens.length === 0) {
		return predTokens.length === goldTokens.length ? 1 : 0;
	}
	const goldCounts = new Map();
	for (const token of goldTokens) goldCounts.set(token, (goldCounts.get(token) ?? 0) + 1);
	let overlap = 0;
	for (const token of predTokens) {
		const remaining = goldCounts.get(token) ?? 0;
		if (remaining > 0) {
			overlap++;
			goldCounts.set(token, remaining - 1);
		}
	}
	if (overlap === 0) return 0;
	const precision = overlap / predTokens.length;
	const recall = overlap / goldTokens.length;
	return (2 * precision * recall) / (precision + recall);
}

// --- JSONL ------------------------------------------------------------------

function appendJsonl(file, record) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
}

function readJsonl(file) {
	if (!fs.existsSync(file)) return [];
	return fs.readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

const CATEGORY_NAMES = { 1: "multi-hop", 2: "temporal", 3: "open-domain", 4: "single-hop" };

module.exports = {
	BASE,
	EVAL_BASE,
	PACE_MS,
	post,
	postEval,
	sleep,
	loadDataset,
	sessionsOf,
	renderTurn,
	tokenF1,
	appendJsonl,
	readJsonl,
	CATEGORY_NAMES,
};
