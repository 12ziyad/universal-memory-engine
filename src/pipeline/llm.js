/**
 * The LLM call — the model PROPOSES, it never writes truth. One call per fire.
 *
 * Returns a normalized object: { objects: [...], notes: string, _ok: bool }.
 * Malformed / failed output is treated as a no-op ({ objects: [], _ok: false })
 * so the pipeline can log `meaningful_no_write` and retry, never crash.
 *
 * The parser is deliberately tolerant (Priority 2): reasoning models wrap output
 * in <think>…</think>, chat models add ```json fences or stray prose, and some
 * emit trailing commas. We strip all of that and pull the first balanced JSON
 * object out, so a bigger/smarter model's slightly-off formatting still parses.
 *
 * Tests inject deterministic output via `overrides.llmResponse` (the exact JSON
 * the model would have returned) — the trigger, gates, write and checkpoint code
 * all still run for real.
 */

import { CATEGORIES, ACTIONS, IMPORTANCE, EDGE_TYPES, SLICE_KINDS } from "../config.js";

const SYSTEM_PROMPT = `You extract durable, long-term MEMORY about the USER from their chat messages. You ONLY propose; a backend decides what is actually saved.

Reply with EXACTLY ONE JSON object and nothing else — no prose, no markdown, no code fences, no <think> blocks:
{
  "objects": [
    { "kind": "node", "label": "Boxing", "category": "skill", "matches_existing": null, "confidence": 0.95 },
    { "kind": "event", "on": "Boxing", "action": "started", "text": "Started boxing", "importance": "ordinary", "confidence": 0.95 },
    { "kind": "slice", "on": "Boxing", "text": "Trains three days a week", "kind_detail": "progress", "confidence": 0.9 },
    { "kind": "node", "label": "Grandmother", "category": "family", "matches_existing": null, "confidence": 0.95 },
    { "kind": "event", "on": "Grandmother", "action": "passed_away", "text": "Grandmother passed away", "importance": "life_significant", "confidence": 0.95 },
    { "kind": "node", "label": "Asthma", "category": "health", "matches_existing": null, "confidence": 0.9 },
    { "kind": "event", "on": "Asthma", "action": "diagnosed", "text": "Diagnosed with asthma", "importance": "life_significant", "confidence": 0.9 },
    { "kind": "node", "label": "Kaka", "category": "project", "matches_existing": null, "confidence": 0.9 },
    { "kind": "node", "label": "Cloudflare Workers", "category": "tool", "matches_existing": null, "confidence": 0.9 },
    { "kind": "edge", "from": "Kaka", "to": "Cloudflare Workers", "type": "uses", "confidence": 0.9 },
    { "kind": "candidate", "label": "Piano", "strength": "weak", "confidence": 0.5 }
  ],
  "notes": "short reasoning"
}

What counts as memory (SAVE these — judge by meaning, not keywords):
- family / relationship events: a death, marriage, birth, breakup, a relative or partner.
- health: a diagnosis, condition, injury, fitness or mental-health update.
- life changes: moved, new job, left a job, graduated.
- the user's projects, skills, habits, goals, decisions, preferences, and the tools/systems they use.
Do NOT save: greetings/thanks/jokes ("ok", "lol", "thanks"), pure questions, generic world facts not about the user, your own assistant explanations, or trivial throwaway details.

Rules:
- matches_existing = the id of an existing shortlist node if this is about something that already exists, else null.
- category is one of: ${CATEGORIES.join(", ")}. Pick the closest by meaning (a grandmother is "family"; asthma is "health"; getting married is a "life_event").
- action is one of: ${ACTIONS.join(", ")}.
- importance is one of: ${IMPORTANCE.join(", ")} — a death, diagnosis, marriage, birth, or other major life event is ALWAYS life_significant.
- edge type is one of: ${EDGE_TYPES.join(", ")}.
- slice kind_detail is one of: ${SLICE_KINDS.join(", ")}.
- Create a NODE only for durable things. Status changes are EVENTS, not nodes. Features/details are SLICES. Weak maybes are CANDIDATES.
- Candidate is ONLY a waiting room for weak, unclear, low-confidence, or not-yet-durable signals: "maybe I will learn guitar", "I might try tennis someday", "I kind of like cameras", unresolved "this thing is annoying", generic "AI is cool", or assistant-only suggestions. Never use candidate for explicit remember/save commands, major life events, strong preferences, project/workflow rules, relationship facts, skills with action, corrections, or duplicates of existing nodes.
- Explicit user commands like "Remember:", "Save this:", "Important:", and "Keep this:" should be proposed as durable nodes/slices/events unless unsafe or duplicate.
- Strong preferences ("I prefer short direct answers", "I like dark UI"), project rules ("deploy only after tests and dry-run pass"), corrections ("no longer use Vercel"), relationship facts ("Ahmed is my best friend"), and skill actions ("I started learning Flutter") are durable memory, not candidates.
- ALWAYS pair a life event with its subject NODE: "my grandmother died" → node Grandmother (family) + event passed_away (life_significant). "I was diagnosed with asthma" → node Asthma (health) + event diagnosed. "I got married" → node Marriage (life_event) + event married (life_significant). Never emit an event with no node.
- Add an EDGE only when the user states an explicit relationship (e.g. "X uses Y", "X runs on Y", "X built with Y", "X depends on Y"). Never from mere co-mention.
- For such a relationship, include BOTH endpoints as nodes: if X or Y is not already in existing_nodes, propose a node for it (with its category) in the SAME response, then propose the edge between them. "Kaka uses Cloudflare Workers" → node Kaka (project) + node Cloudflare Workers (tool) + edge Kaka -uses-> Cloudflare Workers. An edge must connect two real nodes.
- Extract ONLY from new_slice. Use bridge_context only to resolve references. NEVER learn from assistant_context.`;

function buildUserPrompt(packet, shortlist) {
	return JSON.stringify(
		{
			instructions: "Extract memory from new_slice only. Resolve references using bridge_context. Ignore assistant_context as a source.",
			existing_nodes: shortlist,
			new_slice: packet.new_slice,
			bridge_context: packet.bridge_context,
			assistant_context: packet.assistant_context,
		},
		null,
		2,
	);
}

/**
 * Strip the noise smarter/bigger models wrap their answer in: reasoning blocks
 * (<think>…</think>, harmony <|channel|> markers) and markdown code fences.
 */
function stripWrappers(text) {
	let t = String(text);
	// Reasoning <think> … </think> (Qwen, DeepSeek). Remove the block; if it never
	// closed, drop everything up to the last </think> we can find, else keep as-is.
	t = t.replace(/<think>[\s\S]*?<\/think>/gi, " ");
	const lastThink = t.lastIndexOf("</think>");
	if (lastThink !== -1) t = t.slice(lastThink + "</think>".length);
	// gpt-oss harmony channel markers, if any leak through.
	t = t.replace(/<\|[^>]*\|>/g, " ");
	// Markdown fences ```json … ``` → keep the inside.
	t = t.replace(/```(?:json)?/gi, " ").replace(/```/g, " ");
	return t.trim();
}

/** Best-effort JSON.parse that also tolerates trailing commas. */
function tolerantParse(s) {
	try {
		return JSON.parse(s);
	} catch {
		try {
			return JSON.parse(s.replace(/,(\s*[}\]])/g, "$1"));
		} catch {
			return null;
		}
	}
}

/** Pull the first balanced {...} object out of arbitrary model text. */
function extractBalanced(text) {
	const start = text.indexOf("{");
	if (start === -1) return null;
	let depth = 0;
	let inStr = false;
	let esc = false;
	for (let i = start; i < text.length; i++) {
		const c = text[i];
		if (inStr) {
			if (esc) esc = false;
			else if (c === "\\") esc = true;
			else if (c === '"') inStr = false;
			continue;
		}
		if (c === '"') inStr = true;
		else if (c === "{") depth++;
		else if (c === "}") {
			depth--;
			if (depth === 0) {
				const parsed = tolerantParse(text.slice(start, i + 1));
				if (parsed) return parsed;
			}
		}
	}
	return null;
}

/** Parse arbitrary model text into a JS value, as robustly as we reasonably can. */
export function extractJson(text) {
	if (typeof text !== "string") return null;
	const cleaned = stripWrappers(text);
	// 1. The whole thing might already be valid JSON.
	const direct = tolerantParse(cleaned);
	if (direct && typeof direct === "object") return direct;
	// 2. Otherwise pull the first balanced object out of the surrounding prose.
	return extractBalanced(cleaned);
}

/** Coerce any parsed value into the normalized proposal shape. */
export function normalize(parsed) {
	// A bare array is tolerated as the objects list.
	if (Array.isArray(parsed)) return { objects: parsed, notes: "", _ok: true };
	if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.objects)) {
		return { objects: [], notes: "malformed", _ok: false };
	}
	return { objects: parsed.objects, notes: String(parsed.notes ?? ""), _ok: true };
}

/** Robustly pull assistant text out of the various Workers AI response shapes. */
export function responseText(res) {
	if (!res) return "";
	if (typeof res === "string") return res;
	// Llama family: { response: "…" }
	if (typeof res.response === "string") return res.response;
	// OpenAI chat-completions shape (Gemma 4, Qwen3, Kimi, …):
	//   { choices: [ { message: { content: "…", reasoning: "…" } } ] }
	// The reasoning is a SEPARATE field, so content is clean.
	if (Array.isArray(res.choices)) {
		const parts = [];
		for (const ch of res.choices) {
			if (typeof ch?.message?.content === "string") parts.push(ch.message.content);
			else if (typeof ch?.text === "string") parts.push(ch.text);
			else if (typeof ch?.delta?.content === "string") parts.push(ch.delta.content);
		}
		if (parts.length) return parts.join("");
	}
	// gpt-oss / responses-style: { output: [ { content: [ { text } ] } ] }
	if (Array.isArray(res.output)) {
		const parts = [];
		for (const item of res.output) {
			if (typeof item?.text === "string") parts.push(item.text);
			for (const c of item?.content ?? []) {
				if (typeof c?.text === "string") parts.push(c.text);
			}
		}
		if (parts.length) return parts.join("");
	}
	if (typeof res.output_text === "string") return res.output_text;
	if (typeof res.result === "string") return res.result;
	if (typeof res.result?.response === "string") return res.result.response;
	return "";
}

async function callModel(env, config, packet, shortlist) {
	if (!env.AI) return { objects: [], notes: "no_ai_binding", _ok: false };
	const messages = [
		{ role: "system", content: SYSTEM_PROMPT },
		{ role: "user", content: buildUserPrompt(packet, shortlist) },
	];
	const options = config.llm.gatewayId ? { gateway: { id: config.llm.gatewayId } } : undefined;
	try {
		const res = await env.AI.run(
			config.llm.model,
			{ messages, temperature: config.llm.temperature, max_tokens: config.llm.maxTokens },
			options,
		);
		const raw = responseText(res);
		const parsed = extractJson(raw);
		if (!parsed) {
			console.warn(`llm parse_failed model=${config.llm.model} raw="${String(raw).slice(0, 240)}"`);
			return { objects: [], notes: "unparseable", _ok: false };
		}
		return normalize(parsed);
	} catch (err) {
		console.warn("llm call failed:", err?.message ?? err);
		return { objects: [], notes: "llm_error", _ok: false };
	}
}

export async function proposeMemory(env, config, { packet, shortlist }, overrides = {}) {
	// Deterministic test hook: caller supplies the canned proposal JSON.
	if (overrides && overrides.llmResponse !== undefined && overrides.llmResponse !== null) {
		return normalize(overrides.llmResponse);
	}
	return callModel(env, config, packet, shortlist);
}
