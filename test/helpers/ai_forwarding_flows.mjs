/**
 * Golden-forwarding driver (Phase 0B acceptance harness).
 *
 * Drives one representative flow through every distinct AI input shape and
 * structured-output mechanism in the tree, with a spy standing in for the AI
 * binding, and returns the exact (argc, model, inputs, options) tuples the
 * binding saw. The fixture in eval/fixtures/ai_forwarding_golden.json was
 * captured BEFORE the provider-dispatch refactor; the spec replays this driver
 * forever after and any difference in what reaches the binding is a red build.
 *
 * Inputs are fixed constants and the env is an explicit object (never wrangler
 * vars), so the capture is deterministic across lanes and machines.
 */

import { getConfig } from "../../src/config.js";
import { proposeMemory } from "../../src/pipeline/llm.js";
import { proposeEdges, proposeReflexion } from "../../src/pipeline/engine_v2.js";
import { digestConversation } from "../../src/pipeline/digest.js";
import { embed } from "../../src/lib/embeddings.js";
import { rerankEntries } from "../../src/pipeline/rerank.js";
import { playgroundPreviewExtract } from "../../src/pipeline/playground.js";
import { reconcileTitle } from "../../src/pipeline/mcp_engine.js";
import { previewMemoryRules } from "../../src/lib/rules_preview.js";

const BASE_ENV = Object.freeze({
	LLM_MODEL: "@cf/qwen/qwen3-30b-a3b-fp8",
	LLM_SUMMARY_MODEL: "@cf/meta/llama-3.1-8b-instruct-fp8",
	LLM_DIGEST_MODEL: "@cf/meta/llama-3.1-8b-instruct-fp8",
	LLM_MAX_TOKENS: "4096",
	LLM_SUMMARY_MAX_TOKENS: "256",
	LLM_DIGEST_MAX_TOKENS: "768",
	EMBED_MODEL: "@cf/baai/bge-base-en-v1.5",
	USE_VECTORS: "true",
});

const PACKET = Object.freeze({
	new_slice: [
		{ role: "user", content: "I moved to Lisbon in June and started at Acme as a data engineer." },
	],
});

const SHORTLIST = Object.freeze([
	{ id: "node_lisbon", label: "Lisbon", category: "place", summary: "City the user moved to." },
]);

const ENTITIES = Object.freeze([
	{ n: 1, label: "Ziyad", category: "person" },
	{ n: 2, label: "Acme", category: "organization" },
]);

function spyEnv(script, extraVars = {}) {
	const calls = [];
	let i = 0;
	const env = {
		...BASE_ENV,
		...extraVars,
		AI: {
			run: async function run(model, inputs, options) {
				calls.push({
					argc: arguments.length,
					model,
					inputs,
					options: arguments.length >= 3 ? (options ?? null) : undefined,
				});
				const scripted = script[Math.min(i, script.length - 1)];
				i += 1;
				return scripted;
			},
		},
	};
	return { env, calls };
}

/** Runs every flow; returns [{ flow, calls }] as plain JSON-able data. */
export async function captureForwardingTuples() {
	const out = [];
	const record = (flow, calls) => out.push({ flow, calls: JSON.parse(JSON.stringify(calls)) });

	{
		const { env, calls } = spyEnv([
			{ response: '{"objects":[]}', usage: { prompt_tokens: 10, completion_tokens: 2 } },
		]);
		await proposeMemory(env, getConfig(env), { packet: PACKET, shortlist: [...SHORTLIST] }, {});
		record("extract", calls);
	}
	{
		// Constrained attempt returns garbage on purpose: the plain-text retry is
		// part of the preserved behavior and must be captured too.
		const { env, calls } = spyEnv([
			{ response: "::" },
			{ response: '{"edges":[]}' },
		]);
		await proposeEdges(env, getConfig(env), PACKET, [...ENTITIES], {});
		record("edges_constrained_then_plain", calls);
	}
	{
		const { env, calls } = spyEnv([
			{ response: '{"entities":[],"facts":[],"edges":[]}' },
		]);
		await proposeReflexion(env, getConfig(env), PACKET, [...ENTITIES], "", {});
		record("reflexion", calls);
	}
	{
		const { env, calls } = spyEnv([{ response: "Runs marathons." }]);
		await digestConversation(env, getConfig(env), [
			{ role: "user", content: "I run marathons every spring." },
			{ role: "assistant", content: "That is impressive!" },
		], {});
		record("digest", calls);
	}
	{
		const { env, calls } = spyEnv([{ data: [[0.1, 0.2, 0.3]] }]);
		await embed(env, getConfig(env), "hello world");
		record("embed", calls);
	}
	{
		const { env, calls } = spyEnv([{ response: [{ id: 0, score: 0.9 }, { id: 1, score: 0.1 }] }]);
		await rerankEntries(env, "marathon training", [
			{ type: "node", item: { label: "Marathon", category: "activity", summary: "Spring races." } },
			{ type: "node", item: { label: "Lisbon", category: "place", summary: "Home city." } },
		]);
		record("rerank", calls);
	}
	{
		const { env, calls } = spyEnv([{ response: "REPLY: noted" }]);
		await playgroundPreviewExtract(env, "Remember that I use Vim daily", {});
		record("playground_preview", calls);
	}
	{
		const { env, calls } = spyEnv([{ response: '{"title":"Lisbon Relocation Plans"}' }]);
		await reconcileTitle(env, getConfig(env), {
			entityLabels: ["Lisbon"],
			factLines: ["Moved to Lisbon in June."],
			fallbackTs: 1755820800000,
		});
		record("title", calls);
	}
	{
		const { env, calls } = spyEnv([{ response: { assignments: [] } }]);
		await previewMemoryRules(env, {
			samples: ["I use Vim daily"],
			rules: {},
			projectCategories: [{ id: "cat1", slug: "tools", name: "Tools", status: "active" }],
		});
		record("rules_preview", calls);
	}

	return out;
}
