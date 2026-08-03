/**
 * Part 5 — the five multi-hop questions that scored 0/5 on the Aug 2 load
 * test, frozen as permanent regression fixtures. The graph seeded here is the
 * one the dataset implies (extraction quality is measured separately by the
 * Part 6.7 gold file); these tests hold RECALL to it: relational-word seed
 * resolution, 2-hop expansion over active windows, hop-decayed ranking.
 *
 * Acceptance: >= 4 of 5 answered. Each question also asserts individually so
 * a regression names the exact chain that broke.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import worker from "../src";

const headers = { "x-api-key": env.API_KEY, "content-type": "application/json" };
const USER = "multihop-fixture-user";

async function recall(query) {
	const request = new Request("http://example.com/v1/recall", {
		method: "POST",
		headers,
		body: JSON.stringify({ userId: USER, query }),
	});
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return response.json();
}

const now = Date.now();
let nodeSeq = 0;
async function node(label, category, summary = null) {
	const id = `node_fix_${++nodeSeq}`;
	await env.DB.prepare(
		"INSERT INTO nodes (id, user_id, label, category, role, state, summary, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, 'active', ?, ?, ?)",
	).bind(id, USER, label, category, summary, now, now).run();
	return id;
}
let sliceSeq = 0;
async function slice(nodeId, text) {
	await env.DB.prepare(
		"INSERT INTO slices (id, user_id, node_id, text, kind, is_current, created_at) VALUES (?, ?, ?, ?, 'other', 1, ?)",
	).bind(`slice_fix_${++sliceSeq}`, USER, nodeId, text, now).run();
}
let edgeSeq = 0;
async function edge(from, to, type, fact) {
	await env.DB.prepare(
		"INSERT INTO edges (id, user_id, from_node, to_node, type, created_at, fact, valid_at, invalid_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)",
	).bind(`edge_fix_${++edgeSeq}`, USER, from, to, type, now, fact).run();
}

beforeAll(async () => {
	// The graph the 150-message dataset describes, in miniature.
	const marta = await node("Marta Coelho", "person");
	await slice(marta, "Marta Coelho is my partner");
	const atelier = await node("Atelier Barro", "organization");
	const lisbon = await node("Lisbon", "place");
	await edge(marta, atelier, "WORKS_AT", "Marta Coelho works at Atelier Barro");
	await edge(atelier, lisbon, "LOCATED_IN", "Atelier Barro is in Lisbon");

	const yusuf = await node("Yusuf Demir", "person");
	await slice(yusuf, "Yusuf Demir took over the container dwell-time model");
	const hanna = await node("Hanna Weiss", "person");
	const hamburg = await node("Hamburg", "place");
	await edge(yusuf, hanna, "REPORTS_TO", "Yusuf Demir reports to Hanna Weiss");
	await edge(hanna, hamburg, "BASED_IN", "Hanna Weiss is based in Hamburg");

	const amara = await node("Amara", "family");
	await slice(amara, "Amara is my sister");
	const porto = await node("Porto", "place");
	const tomas = await node("Tomas Nabais", "person");
	await edge(amara, porto, "LIVES_IN", "Amara lives in Porto");
	await edge(amara, tomas, "MARRIED_TO", "Amara is married to Tomas Nabais");

	const ceramics = await node("Ceramics Class", "interest");
	const teodor = await node("Teodor Vlahov", "person");
	await edge(teodor, ceramics, "TEACHES", "Teodor Vlahov teaches the ceramics class");
	await edge(teodor, marta, "MENTORS", "Teodor Vlahov mentors Marta Coelho's glaze work");

	const meridian = await node("Meridian Freight", "organization");
	const nils = await node("Nils Andersen", "person");
	await slice(nils, "Nils Andersen is my manager at Meridian Freight");
	const rotterdam = await node("Rotterdam", "place");
	await edge(nils, meridian, "WORKS_AT", "Nils Andersen works at Meridian Freight");
	await edge(nils, rotterdam, "BASED_IN", "Nils Andersen is based in Rotterdam");
});

const QUESTIONS = [
	{
		q: "Which city is the studio my partner works at in?",
		expects: ["Atelier Barro", "Lisbon"], // partner -> Marta -> hop1 studio -> hop2 city
	},
	{
		q: "Who does Yusuf Demir report to, and where is that person based?",
		expects: ["Hanna", "Hamburg"],
	},
	{
		q: "Where does my sister live and who is she married to?",
		expects: ["Porto", "Tomas"],
	},
	{
		q: "Who teaches my ceramics class and what else do they do for Marta?",
		expects: ["Teodor", "glaze"],
	},
	{
		q: "Who is my manager at the company I moved to, and which city is that role in?",
		expects: ["Nils", "Rotterdam"],
	},
];

describe("multi-hop fixtures (the five load-test failures)", () => {
	let results;
	it("answers at least 4 of 5", async () => {
		results = [];
		for (const { q, expects } of QUESTIONS) {
			const res = await recall(q);
			const ctx = String(res.context ?? "");
			const hit = expects.every((needle) => ctx.includes(needle));
			results.push({ q, hit, missing: expects.filter((n) => !ctx.includes(n)), graph: res.graph_expansion_used });
		}
		const score = results.filter((r) => r.hit).length;
		if (score < 5) console.log("fixture detail:", JSON.stringify(results, null, 1));
		expect(score).toBeGreaterThanOrEqual(4);
	}, 30000);

	for (const { q, expects } of QUESTIONS) {
		it(`chain: ${q}`, async () => {
			const res = await recall(q);
			const ctx = String(res.context ?? "");
			for (const needle of expects) expect(ctx).toContain(needle);
		}, 15000);
	}
});
