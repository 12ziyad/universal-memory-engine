import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { getConfig } from "../src/config.js";
import { recall } from "../src/pipeline/recall.js";

const NOW = Date.now();

async function seed(userId) {
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO nodes (id, user_id, label, category, state, summary, created_at, updated_at, heat_score)
			 VALUES ('trace-node-a', ?, 'Atlas gateway', 'project', 'active', 'Migrated from Express to Hono', ?, ?, 1)`,
		).bind(userId, NOW, NOW),
		env.DB.prepare(
			`INSERT INTO nodes (id, user_id, label, category, state, summary, created_at, updated_at, heat_score)
			 VALUES ('trace-node-b', ?, 'Biscuit', 'possession', 'active', 'A rescue greyhound', ?, ?, 1)`,
		).bind(userId, NOW, NOW),
		env.DB.prepare(
			`INSERT INTO slices (id, user_id, node_id, text, kind, is_current, created_at)
			 VALUES ('trace-slice-a', ?, 'trace-node-a', 'The Atlas gateway moved from Express to Hono', 'decision', 1, ?)`,
		).bind(userId, NOW),
	]);
}

describe("E2 behavior-neutral read tracing", () => {
	it("preserves candidates, selections, rendered bytes, and the reader request", async () => {
		const userId = `e2-read-trace-${crypto.randomUUID()}`;
		const question = "What framework does the Atlas gateway use?";
		await seed(userId);

		const control = await recall(env, getConfig(env), userId, question);
		const traced = await recall(env, getConfig(env), userId, question, { internalTrace: true });
		const controlReaderRequest = JSON.stringify({
			model: "@cf/openai/gpt-oss-120b",
			temperature: 0,
			question,
			context: control.context,
		});
		const tracedReaderRequest = JSON.stringify({
			model: "@cf/openai/gpt-oss-120b",
			temperature: 0,
			question,
			context: traced.context,
		});

		expect(traced.items).toEqual(control.items);
		expect(traced.nodes).toEqual(control.nodes);
		expect(traced.context).toBe(control.context);
		expect(tracedReaderRequest).toBe(controlReaderRequest);
		expect(traced.internal_trace.selected_ids).toEqual(
			control.items.map((item) => `${item.type}:${item.id}`),
		);
		expect(traced.internal_trace.candidate_ids).toEqual(
			expect.arrayContaining(traced.internal_trace.selected_ids),
		);
		expect(traced.internal_trace.context_bytes).toBe(new TextEncoder().encode(control.context).byteLength);
		expect(traced.internal_trace.context_sha256).toMatch(/^[a-f0-9]{64}$/);
	});
});
