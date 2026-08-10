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
import { rulesPromptLines } from "./rules.js";
import { runAi } from "../lib/ai_meter.js";
import { normalizePersistedSourceEvent } from "../lib/source_event.mjs";

const SYSTEM_PROMPT = `You extract durable, long-term MEMORY about the USER from their chat messages. You ONLY propose; a backend decides what is actually saved.

Reply with EXACTLY ONE JSON object and nothing else — no prose, no markdown, no code fences, no <think> blocks:
{
  "objects": [
    { "kind": "node", "label": "Boxing", "category": "skill", "matches_existing": null, "confidence": 0.95 },
    { "kind": "event", "on": "Boxing", "action": "started", "text": "Started boxing", "importance": "ordinary", "confidence": 0.95, "date": "2023-05-08" },
    { "kind": "slice", "on": "Boxing", "text": "Trains three days a week", "kind_detail": "progress", "confidence": 0.9 },
    { "kind": "node", "label": "Grandmother", "category": "family", "matches_existing": null, "confidence": 0.95 },
    { "kind": "event", "on": "Grandmother", "action": "passed_away", "text": "Grandmother passed away", "importance": "life_significant", "confidence": 0.95 },
    { "kind": "node", "label": "Asthma", "category": "health", "matches_existing": null, "confidence": 0.9 },
    { "kind": "event", "on": "Asthma", "action": "diagnosed", "text": "Diagnosed with asthma", "importance": "life_significant", "confidence": 0.9 },
    { "kind": "node", "label": "Kaka", "category": "project", "matches_existing": null, "confidence": 0.9 },
    { "kind": "node", "label": "Cloudflare Workers", "category": "tool", "matches_existing": null, "confidence": 0.9 },
    { "kind": "edge", "from": "Kaka", "to": "Cloudflare Workers", "type": "uses", "confidence": 0.9 },
    { "kind": "node", "label": "Aveiro", "category": "place", "matches_existing": null, "confidence": 0.9 },
    { "kind": "slice", "on": "Aveiro", "text": "Sister lives in Aveiro", "kind_detail": "other", "confidence": 0.9 },
    { "kind": "candidate", "label": "Piano", "strength": "weak", "confidence": 0.5 }
  ],
  "notes": "short reasoning"
}

What counts as memory (SAVE these — judge by meaning, not keywords):
- family / relationship events: a death, marriage, birth, breakup, a relative or partner.
- health: a diagnosis, condition, injury, fitness or mental-health update.
- life changes: moved, new job, left a job, graduated.
- the user's projects, skills, habits, goals, decisions, preferences, and the tools/systems they use.
- PLACES the user's life happens in: home city, a relative's city, a workplace's location. "My sister lives in Aveiro" → node Aveiro (place), not just a fact about the sister.
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
- Extract ONLY from new_slice. Use bridge_context only to resolve references. NEVER learn from assistant_context.
- Events MAY carry "date" (YYYY-MM-DD): COPY it from an explicit date in the text or the message timestamp. NEVER invent or guess a date — omit the field instead.
- When a fact mentions when it happened, keep that timing inside the slice/event "text" too ("ran the charity race on 7 May 2023"), so the memory keeps its date even as plain text.`;

function buildUserPrompt(packet, shortlist) {
	return JSON.stringify(
		{
			instructions: "Extract memory from new_slice only. Resolve references using bridge_context. Ignore assistant_context as a source.",
			bridge_context: packet.bridge_context,
			assistant_context: packet.assistant_context,
			existing_nodes: shortlist,
			// Keep the authoritative source last. The central model-input guard
			// preserves the useful tail when an unusually large prompt is bounded.
			new_slice: packet.new_slice,
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

/**
 * Salvage whole objects from a response that was cut off mid-JSON.
 *
 * A truncated extraction is not an empty one. The model may have emitted
 * twenty complete, well-formed facts before the token budget ended the
 * twenty-first mid-string, and `extractBalanced` throws all twenty away
 * because the enclosing brace never arrives. That is a pure loss of captured
 * memory to a formatting accident, in a system whose dominant failure is
 * already "never stored".
 *
 * So: find the objects array, walk it, and keep every element that closed.
 * Anything still open at the end of the text is discarded — a half-parsed fact
 * is not a fact.
 */
export function salvageObjects(text) {
	const source = String(text ?? "");
	const marker = source.search(/"objects"\s*:\s*\[/);
	if (marker === -1) return null;
	const start = source.indexOf("[", marker);
	if (start === -1) return null;

	const objects = [];
	let depth = 0;
	let elementStart = -1;
	let inStr = false;
	let esc = false;
	for (let i = start + 1; i < source.length; i += 1) {
		const c = source[i];
		if (inStr) {
			if (esc) esc = false;
			else if (c === "\\") esc = true;
			else if (c === '"') inStr = false;
			continue;
		}
		if (c === '"') { inStr = true; continue; }
		if (c === "{") {
			if (depth === 0) elementStart = i;
			depth += 1;
			continue;
		}
		if (c === "}") {
			depth -= 1;
			if (depth === 0 && elementStart !== -1) {
				const parsed = tolerantParse(source.slice(elementStart, i + 1));
				if (parsed && typeof parsed === "object") objects.push(parsed);
				elementStart = -1;
			}
			continue;
		}
		// The array closed cleanly; anything after it is not our business.
		if (c === "]" && depth === 0) break;
	}
	return objects.length ? objects : null;
}

/** Parse arbitrary model text into a JS value, as robustly as we reasonably can. */
export function extractJson(text) {
	if (typeof text !== "string") return null;
	const cleaned = stripWrappers(text);
	// 1. The whole thing might already be valid JSON.
	const direct = tolerantParse(cleaned);
	if (direct && typeof direct === "object") return direct;
	// 2. Otherwise pull the first balanced object out of the surrounding prose.
	const balanced = extractBalanced(cleaned);
	if (balanced) return balanced;
	// 3. Nothing balanced. If the response was cut off, keep what did complete
	//    rather than discarding a whole call's worth of captured facts.
	const salvaged = salvageObjects(cleaned);
	return salvaged ? { objects: salvaged, notes: "salvaged_from_truncated_response", _truncated: true } : null;
}

/**
 * Did the model stop because it ran out of output budget, rather than because
 * it finished? Worth knowing separately from "did it parse": a truncated
 * response means the CHUNK was too big, which is a chunking decision, while an
 * unparseable one usually means the model wandered off format.
 */
export function responseTruncated(res) {
	if (!res || typeof res !== "string") {
		for (const choice of res?.choices ?? []) {
			const reason = choice?.finish_reason ?? choice?.finishReason;
			if (reason === "length" || reason === "max_tokens") return true;
		}
		if (res?.finish_reason === "length" || res?.stop_reason === "max_tokens") return true;
		if (res?.usage && Number.isFinite(res.usage.completion_tokens) && Number.isFinite(res.usage.max_tokens)) {
			if (res.usage.completion_tokens >= res.usage.max_tokens) return true;
		}
	}
	return false;
}

const EXTRACTION_OBJECT_KINDS = new Set(["node", "slice", "event", "edge", "candidate"]);

function nonEmptyString(value) {
	return typeof value === "string" && value.trim().length > 0;
}

function structurallyValidObject(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	if (!EXTRACTION_OBJECT_KINDS.has(value.kind)) return false;
	if (value.kind === "node" || value.kind === "candidate") return nonEmptyString(value.label);
	if (value.kind === "slice") return nonEmptyString(value.on) && nonEmptyString(value.text);
	if (value.kind === "event") return nonEmptyString(value.on) && nonEmptyString(value.action) && nonEmptyString(value.text);
	if (value.kind === "edge") return nonEmptyString(value.from) && nonEmptyString(value.to) && nonEmptyString(value.type);
	return false;
}

function canonicalValue(value, { includeConfidence = false } = {}) {
	if (Array.isArray(value)) return value.map((item) => canonicalValue(item, { includeConfidence }));
	if (value && typeof value === "object") {
		const result = {};
		for (const key of Object.keys(value).sort()) {
			if (key.startsWith("_")) continue;
			if (!includeConfidence && key === "confidence") continue;
			if (value[key] == null) continue;
			result[key] = canonicalValue(value[key], { includeConfidence });
		}
		return result;
	}
	if (typeof value === "string") return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
	return value;
}

function deduplicateObjects(objects) {
	const winners = new Map();
	for (const object of objects) {
		const key = JSON.stringify(canonicalValue(object));
		const current = winners.get(key);
		if (!current) {
			winners.set(key, object);
			continue;
		}
		const confidence = Number(object?.confidence);
		const currentConfidence = Number(current?.confidence);
		const candidateScore = Number.isFinite(confidence) ? confidence : -1;
		const currentScore = Number.isFinite(currentConfidence) ? currentConfidence : -1;
		const candidateTie = JSON.stringify(canonicalValue(object, { includeConfidence: true }));
		const currentTie = JSON.stringify(canonicalValue(current, { includeConfidence: true }));
		if (candidateScore > currentScore || (candidateScore === currentScore && candidateTie < currentTie)) {
			winners.set(key, object);
		}
	}
	return [...winners.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
}

/** Coerce and locally validate any parsed value into the proposal contract. */
export function normalize(parsed, { strict = false, dedupe = false } = {}) {
	const bareArray = Array.isArray(parsed);
	if (!bareArray && (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.objects))) {
		return { objects: [], notes: "malformed", _ok: false, _outcome: "schema_invalid", _invalid_objects: 0 };
	}
	const sourceObjects = bareArray ? parsed : parsed.objects;
	const invalidObjects = strict
		? sourceObjects.filter((object) => !structurallyValidObject(object)).length
		: 0;
	if (invalidObjects > 0) {
		return {
			objects: [],
			notes: "schema_invalid",
			_ok: false,
			_outcome: "schema_invalid",
			_invalid_objects: invalidObjects,
			...(parsed?._truncated ? { _truncated: true } : {}),
		};
	}
	const objects = dedupe ? deduplicateObjects(sourceObjects) : sourceObjects;
	const duplicates = sourceObjects.length - objects.length;
	return {
		objects,
		notes: bareArray ? "" : String(parsed.notes ?? ""),
		_ok: true,
		_outcome: parsed?._truncated
			? "truncated_salvaged"
			: objects.length ? "valid_nonempty" : "valid_empty",
		_duplicates: duplicates,
		_invalid_objects: 0,
		// Carried so the receipt can say the response was cut off and how much
		// survived, instead of the save looking like an ordinary small one.
		...(parsed?._truncated ? { _truncated: true } : {}),
	};
}

function responseRefused(res) {
	if (!res || typeof res !== "object") return false;
	if (res.refusal) return true;
	for (const choice of res.choices ?? []) {
		if (choice?.message?.refusal || choice?.refusal) return true;
	}
	for (const item of res.output ?? []) {
		if (item?.type === "refusal" || item?.refusal) return true;
		for (const content of item?.content ?? []) {
			if (content?.type === "refusal" || content?.refusal) return true;
		}
	}
	return false;
}

function failureKind(error) {
	const name = String(error?.name ?? "").toLowerCase();
	const code = String(error?.code ?? "").toLowerCase();
	if (name.includes("timeout") || name.includes("abort") || code.includes("timeout")) return "timeout";
	return "transport_error";
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

const DENSE_ADDENDUM = "\n\nDENSE CAPTURE MODE for this request: enumerate EVERY distinct durable fact as its own object — activities, plans, dates, quantities, names, relationships, preferences, outcomes. Do not summarize several facts into one object. Medium-confidence facts are wanted: propose them with honest confidence rather than dropping them.";

// Engine v2 stance: the deterministic gates downstream are what make it safe
// to be generous here. A missed fact is unrecoverable; an over-proposal is one
// named rejection on a receipt.
const GENEROUS_ADDENDUM = "\n\nSTANCE: when in doubt, EXTRACT — a backend gate reviews every proposal, so err on the side of proposing. Density target: a typical multi-fact message batch should yield 5-15 objects; one or two objects from a rich batch means you are summarizing, not extracting. Propose medium-confidence facts with honest confidence values instead of dropping them.";

// One extractor, three lenses. The lens tunes what counts as durable — it
// never changes the output contract, and the gates enforce the hard rules
// (the plugin lens's path/trace/diff bans are enforced deterministically in
// gates.js whatever the model does with this guidance).
const PROFILE_ADDENDA = {
	mcp: "\n\nLENS: personal memory. Focus on people, preferences, plans, decisions, and life events. Discard phatic turns (greetings, acknowledgements, banter) entirely.",
	sdk: "\n\nLENS: application memory. The caller's own rules (below, if any) take priority over these defaults — extract what THEY define as durable for their users.",
	plugin: "\n\nLENS: coding session. Durable memory here is: decisions and their reasons, conventions and preferences, error→fix pairs (what broke and what resolved it), architecture and component relationships, repeated commands/workflows, reported test/build outcomes, commits, and deployments. Coding-event text and metadata are bounded caller-supplied summaries, not authenticated proof that a host command ran or succeeded. Apply the same skepticism and confidence rules used for every other new_slice claim. Never invent omitted details. File paths are only ever an attribute inside a decision or component fact, never their own object. Raw commands, diffs, stack traces, and tool logs are never memory; the capture adapter intentionally excludes them.",
};

export const STRUCTURED_SOURCE_EVENT_ADDENDUM = "\n\nSTRUCTURED CALLER EVIDENCE: canonical source_event metadata is a bounded, scrubbed, caller-supplied classification and opaque trace identifier. It can help interpret the adjacent new_slice claim, but it does not authenticate host execution, authorship, or outcome. Never infer success from the metadata or [Claude coding event/v1] header alone.";

export function hasStructuredSourceEvent(packet) {
	return (packet?.new_slice ?? []).some((item) => (
		normalizePersistedSourceEvent(item?.source_event) !== null
	));
}

async function callModel(env, config, packet, shortlist, {
	dense = false,
	rules = null,
	profile = null,
	extractionV3 = false,
} = {}) {
	if (!env.AI) return { objects: [], notes: "no_ai_binding", _ok: false, _outcome: "no_ai_binding" };
	// The user's own rules, as guidance. The digest and manual lanes already did
	// this; the auto lane did not, so custom instructions never reached the
	// extractor at all. Enforcement still happens in the gates — a model that
	// ignores these lines still cannot write excluded content.
	const ruleLines = rulesPromptLines(rules);
	let base = SYSTEM_PROMPT + GENEROUS_ADDENDUM;
	if (dense) base += DENSE_ADDENDUM;
	if (PROFILE_ADDENDA[profile]) base += PROFILE_ADDENDA[profile];
	if (profile === "plugin" || hasStructuredSourceEvent(packet)) {
		base += STRUCTURED_SOURCE_EVENT_ADDENDUM;
	}
	const messages = [
		{ role: "system", content: ruleLines.length ? `${base}\n\n${ruleLines.join("\n")}` : base },
		{ role: "user", content: buildUserPrompt(packet, shortlist) },
	];
	const options = config.llm.gatewayId ? { gateway: { id: config.llm.gatewayId } } : undefined;
	try {
		const res = await runAi(
			env,
			config.llm.model,
			{
				messages,
				temperature: config.llm.temperature,
				max_tokens: config.llm.maxTokens,
				// Schema-constrained output, when the deployment says the model
				// supports it. DEFAULT OFF: whether a given Workers AI model honours
				// `response_format` is a live fact about that model, and asserting it
				// from a config file would be a guess. Enabling it is a measured
				// decision (ablation E2), not a deploy-time side effect.
				...(config.llm.jsonMode ? { response_format: { type: "json_object" } } : {}),
			},
			options,
			{ task: "extract" },
		);
		const raw = responseText(res);
		const truncated = responseTruncated(res);
		const refused = responseRefused(res);
		const parsed = extractJson(raw);
		if (!parsed) {
			// Say which failure this was. "Unparseable" and "ran out of output
			// budget" have different fixes — the second one is a chunking problem,
			// and it stayed invisible while both looked the same on a receipt.
			const outcome = refused ? "refusal" : truncated ? "truncated_unsalvageable" : "parse_invalid";
			// Never log source/model text. Length and a typed outcome are enough to
			// diagnose mechanics without turning ordinary logs into a shadow archive.
			console.warn(JSON.stringify({ event: "llm_extraction_failed", outcome, model: config.llm.model, output_chars: Array.from(raw).length }));
			return {
				objects: [],
				notes: outcome,
				_ok: false,
				_outcome: outcome,
				...(truncated ? { _truncated: true } : {}),
			};
		}
		const normalized = normalize(parsed, { strict: extractionV3, dedupe: extractionV3 });
		if (truncated && !normalized._truncated) {
			normalized._truncated = true;
			if (normalized._ok) normalized._outcome = "truncated_salvaged";
		}
		if (normalized._truncated) {
			console.warn(`llm truncated_salvage model=${config.llm.model} objects=${normalized.objects.length}`);
		}
		return normalized;
	} catch (err) {
		const outcome = failureKind(err);
		console.warn(JSON.stringify({
			event: "llm_extraction_failed",
			outcome,
			model: config.llm.model,
			error_name: String(err?.name ?? "Error").slice(0, 80),
			error_code: err?.code == null ? null : String(err.code).slice(0, 80),
		}));
		return { objects: [], notes: outcome, _ok: false, _outcome: outcome };
	}
}

export async function proposeMemory(env, config, { packet, shortlist }, overrides = {}) {
	// Deterministic test hook: caller supplies the canned proposal JSON, or a
	// function of ({ packet, shortlist }) when a test needs the response to
	// differ per call (how the split-rescue specs simulate a poisoned chunk).
	if (overrides && overrides.llmResponse !== undefined && overrides.llmResponse !== null) {
		const canned = typeof overrides.llmResponse === "function"
			? await overrides.llmResponse({ packet, shortlist })
			: overrides.llmResponse;
		return normalize(canned, {
			strict: overrides?.extractionV3 === true,
			dedupe: overrides?.extractionV3 === true,
		});
	}
	return callModel(env, config, packet, shortlist, {
		dense: overrides?.settings?.captureDensity === "dense",
		rules: overrides?.rules ?? null,
		profile: overrides?.profile ?? null,
		extractionV3: overrides?.extractionV3 === true,
	});
}
