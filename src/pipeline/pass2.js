/**
 * Pass 2 — background, separate, cheap. Runs AFTER Pass-1 structural writes have
 * committed. It refreshes affected nodes' `summary` (a short rollup) and rolls up
 * slices when a node exceeds the threshold (preserving state changes, milestones
 * and decisions by keeping non-superseded slices current).
 *
 * A Pass-2 failure must NEVER affect Pass-1 writes: the whole thing is wrapped in
 * try/catch and only ever runs once Pass 1 is already durable.
 */

import { getCurrentSlices, getNodeEvents } from "../lib/db.js";

async function summarizeNode(env, config, node, slices, events) {
	if (!env.AI) return null;
	const facts = [
		`Label: ${node.label} (category: ${node.category}, state: ${node.state})`,
		...slices.slice(0, 12).map((s) => `- ${s.kind}: ${s.text}`),
		...events.slice(0, 6).map((e) => `- ${e.action}: ${e.text}`),
	].join("\n");
	const res = await env.AI.run(
		config.llm.summaryModel,
		{
			messages: [
				{
					role: "system",
					content:
						"Write a single concise sentence (max 25 words) summarizing this memory node. No preamble, no quotes.",
				},
				{ role: "user", content: facts },
			],
			temperature: 0,
			max_tokens: config.llm.summaryMaxTokens,
		},
		config.llm.gatewayId ? { gateway: { id: config.llm.gatewayId } } : undefined,
	);
	const text = (res?.response ?? "").trim();
	return text || null;
}

export async function runPass2(env, config, userId, affectedNodeIds) {
	if (!config.enablePass2 || !env.AI) return { ran: false };
	let refreshed = 0;
	for (const nodeId of affectedNodeIds) {
		try {
			const node = await env.DB.prepare(
				"SELECT id, label, category, state, summary FROM nodes WHERE id = ? AND user_id = ?",
			)
				.bind(nodeId, userId)
				.first();
			if (!node) continue;

			const slices = await getCurrentSlices(env, userId, nodeId);
			const events = await getNodeEvents(env, userId, nodeId);

			// Refresh summary.
			const summary = await summarizeNode(env, config, node, slices, events);
			if (summary) {
				await env.DB.prepare("UPDATE nodes SET summary = ? WHERE id = ? AND user_id = ?")
					.bind(summary, nodeId, userId)
					.run();
				refreshed++;
			}

			// Roll up slices if the node has too many current ones. Conservative for
			// now: keep the most recent N current, demote the oldest extras. State
			// changes live in events, so they are never lost by this.
			if (slices.length > config.sliceRollupThreshold) {
				const sorted = [...slices].sort((a, b) => a.created_at - b.created_at);
				const demote = sorted.slice(0, slices.length - config.sliceRollupThreshold);
				for (const s of demote) {
					await env.DB.prepare("UPDATE slices SET is_current = 0 WHERE id = ? AND user_id = ?")
						.bind(s.id, userId)
						.run();
				}
			}
		} catch (err) {
			// Never let a Pass-2 problem bubble up into Pass 1.
			console.warn(`pass2 node ${nodeId} failed:`, err?.message ?? err);
		}
	}
	return { ran: true, refreshed };
}
