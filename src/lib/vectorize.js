/**
 * Vectorize helpers for node embeddings, partitioned per user via namespace.
 * All operations are best-effort and never throw into the pipeline: Vectorize is
 * an optimization for the shortlist, not a source of truth.
 */

/** Upsert one node's embedding. Keyed by node id, namespaced by user. */
export async function upsertNodeVector(env, config, { userId, nodeId, values, label, category }) {
	if (!config.useVectors || !env.VECTORIZE || !values) return;
	try {
		await env.VECTORIZE.upsert([
			{
				id: nodeId,
				values,
				namespace: userId,
				metadata: { user_id: userId, label, category },
			},
		]);
	} catch (err) {
		console.warn("vectorize upsert failed:", err?.message ?? err);
	}
}

/** Nearest node ids for a query vector, within this user's namespace. */
export async function queryNodeVectors(env, config, { userId, values, topK }) {
	if (!config.useVectors || !env.VECTORIZE || !values) return [];
	try {
		const res = await env.VECTORIZE.query(values, {
			topK: topK ?? config.shortlistSize,
			namespace: userId,
			returnMetadata: "none",
		});
		return (res?.matches ?? []).map((m) => ({ id: m.id, score: m.score }));
	} catch (err) {
		console.warn("vectorize query failed:", err?.message ?? err);
		return [];
	}
}
