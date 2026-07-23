/**
 * Retrieval evaluation harness — behavioural gate, not a unit test.
 *
 * Seeds the golden corpus into real D1 for one tenant, runs the real recall()
 * for every golden query, and reports Recall@5 / Recall@10 / MRR / wrong-identity
 * / duplicate rate / latency. The floors at the bottom are what a deploy is
 * gated on; the printed table is the "before/after" record.
 *
 * Runs with USE_VECTORS=false (vitest.config.js), so these numbers describe the
 * exact/alias + lexical half of retrieval on its own — the half that carries the
 * hot path today. Vector contribution is measured separately against the
 * deployed worker.
 */

import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";

import golden from "../eval/fixtures/retrieval_golden.json";
import { recall } from "../src/pipeline/recall.js";
import { getConfig } from "../src/config.js";

const userId = "u-eval-retrieval";

function percentile(sorted, p) {
	if (!sorted.length) return 0;
	const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
	return sorted[Math.max(0, index)];
}

async function seed() {
	const now = Date.now();
	const statements = [];
	for (const node of golden.corpus.nodes) {
		statements.push(
			env.DB.prepare(
				`INSERT INTO nodes (id, user_id, label, category, role, state, summary, aliases_json, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).bind(
				node.id, userId, node.label, node.category, null, node.state,
				node.summary ?? null, JSON.stringify(node.aliases ?? []), now, now,
			),
		);
		for (const slice of node.slices ?? []) {
			statements.push(
				env.DB.prepare(
					"INSERT INTO slices (id, user_id, node_id, text, kind, is_current, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				).bind(slice.id, userId, node.id, slice.text, slice.kind, slice.is_current, now),
			);
		}
		for (const event of node.events ?? []) {
			statements.push(
				env.DB.prepare(
					"INSERT INTO events (id, user_id, node_id, action, text, importance, happened_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				).bind(event.id, userId, node.id, event.action, event.text, event.importance, now, now),
			);
		}
	}
	for (const page of golden.corpus.pages) {
		statements.push(
			env.DB.prepare(
				`INSERT INTO memory_pages (id, user_id, node_id, node_kind, source_mode, title, canonical_title,
					topic_filter, short_summary, created_at, updated_at)
				 VALUES (?, ?, ?, 'memory_page', 'manual_collect', ?, ?, ?, ?, ?, ?)`,
			).bind(
				page.id, userId, page.node_id, page.title, page.title.toLowerCase(),
				page.topic_filter, page.short_summary, now, now,
			),
		);
	}
	await env.DB.batch(statements);
}

describe("retrieval evaluation (golden set)", () => {
	const metrics = {};

	beforeAll(async () => {
		await seed();

		const config = getConfig(env);
		const scored = [];
		const latencies = [];

		for (const q of golden.queries) {
			const started = Date.now();
			const result = await recall(env, config, userId, q.query);
			latencies.push(Date.now() - started);

			const returnedNodes = (result.nodes ?? []).map((n) => n.id);
			const returnedPages = (result.pages ?? []).map((p) => p.id);
			const returned = [...returnedNodes, ...returnedPages];
			const expected = [...(q.expect_nodes ?? []), ...(q.expect_pages ?? [])];

			// Rank of the first expected id, over the merged result ordering.
			let firstHit = -1;
			for (let i = 0; i < returned.length; i++) {
				if (expected.includes(returned[i])) { firstHit = i; break; }
			}

			scored.push({
				id: q.id,
				intent: q.intent,
				query: q.query,
				expected,
				returned,
				noRecall: result.recall_mode === "no_recall",
				expectNoRecall: Boolean(q.expect_no_recall),
				hit5: expected.length === 0 ? null : returned.slice(0, 5).some((id) => expected.includes(id)),
				hit10: expected.length === 0 ? null : returned.slice(0, 10).some((id) => expected.includes(id)),
				rr: firstHit === -1 ? 0 : 1 / (firstHit + 1),
				leaked: (q.forbid_nodes ?? []).filter((id) => returned.includes(id)),
				wrongIdentity: (q.forbid_nodes ?? []).some((id) => returned.includes(id)),
				duplicated: new Set(returned).size !== returned.length,
				overLimit: returned.length > 10,
			});
		}

		const answerable = scored.filter((s) => s.hit5 !== null);
		const sortedLatencies = [...latencies].sort((a, b) => a - b);

		metrics.total = scored.length;
		metrics.answerable = answerable.length;
		metrics.recallAt5 = answerable.filter((s) => s.hit5).length / answerable.length;
		metrics.recallAt10 = answerable.filter((s) => s.hit10).length / answerable.length;
		metrics.mrr = answerable.reduce((sum, s) => sum + s.rr, 0) / answerable.length;
		metrics.wrongIdentityRate = scored.filter((s) => s.wrongIdentity).length / scored.length;
		metrics.duplicateRate = scored.filter((s) => s.duplicated).length / scored.length;
		metrics.overLimitCount = scored.filter((s) => s.overLimit).length;
		metrics.p50 = percentile(sortedLatencies, 50);
		metrics.p95 = percentile(sortedLatencies, 95);
		metrics.misses = answerable.filter((s) => !s.hit5).map((s) => `${s.id} [${s.intent}] ${JSON.stringify(s.query)}`);
		metrics.byIntent = {};
		for (const s of answerable) {
			const bucket = (metrics.byIntent[s.intent] ??= { hit: 0, total: 0 });
			bucket.total++;
			if (s.hit5) bucket.hit++;
		}

		const pct = (v) => `${(v * 100).toFixed(1)}%`;
		console.log("\n=== RETRIEVAL EVAL (lexical/exact half, USE_VECTORS=false) ===");
		console.log(`queries=${metrics.total} answerable=${metrics.answerable}`);
		console.log(`Recall@5=${pct(metrics.recallAt5)}  Recall@10=${pct(metrics.recallAt10)}  MRR=${metrics.mrr.toFixed(3)}`);
		console.log(`wrong-identity=${pct(metrics.wrongIdentityRate)}  duplicates=${pct(metrics.duplicateRate)}  over-10-cards=${metrics.overLimitCount}`);
		console.log(`latency p50=${metrics.p50}ms p95=${metrics.p95}ms`);
		console.log("by intent:");
		for (const [intent, b] of Object.entries(metrics.byIntent).sort()) {
			console.log(`  ${intent.padEnd(32)} ${b.hit}/${b.total}`);
		}
		if (metrics.misses.length) {
			console.log("misses@5:");
			for (const m of metrics.misses) console.log(`  ${m}`);
		}
		const leaks = scored.filter((s) => s.wrongIdentity);
		if (leaks.length) {
			console.log("wrong-identity leaks:");
			for (const s of leaks) {
				console.log(`  ${s.id} ${JSON.stringify(s.query)} leaked=[${s.leaked}] returned=[${s.returned}]`);
			}
		}
		console.log("");
	});

	it("returns nothing for smalltalk", () => {
		expect(metrics.byIntent.smalltalk_must_not_recall).toBeUndefined();
	});

	it("never returns a forbidden identity", () => {
		expect(metrics.wrongIdentityRate).toBe(0);
	});

	it("never returns duplicate cards", () => {
		expect(metrics.duplicateRate).toBe(0);
	});

	it("never returns more than 10 cards", () => {
		expect(metrics.overLimitCount).toBe(0);
	});

	// Floors, not targets. Raise them as retrieval improves so a regression fails
	// the suite instead of quietly degrading recall quality.
	it("meets the Recall@5 floor", () => {
		expect(metrics.recallAt5).toBeGreaterThanOrEqual(0.6);
	});

	it("meets the MRR floor", () => {
		expect(metrics.mrr).toBeGreaterThanOrEqual(0.5);
	});
});
