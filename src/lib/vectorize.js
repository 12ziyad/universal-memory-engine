/**
 * Vectorize helpers for node embeddings, partitioned per user via namespace.
 * All operations are best-effort and never throw into the pipeline: Vectorize is
 * an optimization for the shortlist, not a source of truth.
 */

import { recordSecurityEvent } from "./security_events.js";


/* ---------------------------------------------------------------------------
 * Revision-qualified vector ids.
 *
 * Vectorize writes are asynchronous, so a delayed writer must not be able to
 * clobber a newer revision. Revision N of an object is stored under
 * `<objectId>#r<N>`: a late writer can only ever touch its own revision's id.
 * Recall drops any hit whose revision is not the object's current head, so a
 * stale vector can never outrank or resurrect stale content. Ids written
 * before this scheme are bare object ids and are treated as head — which is
 * exactly what they were under the previous one-vector-per-node design.
 */

const VECTOR_ID_SEPARATOR = "#r";
const VECTOR_ID_MAX = 64;

export function vectorIdFor(objectId, revision) {
	const id = `${objectId}${VECTOR_ID_SEPARATOR}${revision}`;
	if (id.length <= VECTOR_ID_MAX) return id;
	const room = VECTOR_ID_MAX - String(revision).length - VECTOR_ID_SEPARATOR.length;
	return `${objectId.slice(0, room)}${VECTOR_ID_SEPARATOR}${revision}`;
}

export function parseVectorId(vectorId) {
	const raw = String(vectorId ?? "");
	const at = raw.lastIndexOf(VECTOR_ID_SEPARATOR);
	if (at <= 0) return { objectId: raw, revision: null, legacy: true };
	const revision = Number(raw.slice(at + VECTOR_ID_SEPARATOR.length));
	if (!Number.isSafeInteger(revision) || revision < 1) return { objectId: raw, revision: null, legacy: true };
	return { objectId: raw.slice(0, at), revision, legacy: false };
}

export function isHeadVectorId(vectorId, objectId, headRevision) {
	const parsed = parseVectorId(vectorId);
	if (parsed.objectId !== objectId) return false;
	if (parsed.legacy) return true;
	return parsed.revision === Number(headRevision);
}

/**
 * Upsert one node's embedding, namespaced by user.
 *
 * `vectorId` carries the revision this embedding was computed from (see
 * lib/memory_versions.js); callers that do not version pass none and keep the
 * historical bare-node-id behaviour.
 *
 * Returns an explicit outcome instead of swallowing failures: Vectorize is an
 * optimization for the shortlist, but a caller that records projection state
 * must be able to tell "provider refused" from "provider accepted". Accepted
 * means the mutation was queued — NOT that the vector is queryable yet.
 */
export async function upsertNodeVector(env, config, { userId, nodeId, vectorId, revision = null, values, label, category }) {
	if (!config.useVectors || !env.VECTORIZE) return { ok: false, skipped: true, reason: "vectors_disabled" };
	if (!values) return { ok: false, skipped: true, reason: "no_embedding" };
	try {
		const mutation = await env.VECTORIZE.upsert([
			{
				id: vectorId ?? nodeId,
				values,
				namespace: userId,
				metadata: {
					user_id: userId, label, category,
					object_id: nodeId,
					...(revision == null ? {} : { revision }),
				},
			},
		]);
		return { ok: true, mutationId: mutation?.mutationId ?? null };
	} catch (err) {
		console.warn("vectorize upsert failed:", err?.message ?? err);
		return { ok: false, skipped: false, reason: "provider_error", error: err?.message ?? String(err) };
	}
}

/**
 * Nearest node ids for a query vector, within this user's namespace.
 *
 * Returned ids are OBJECT ids, never raw vector ids, so callers keep working
 * unchanged. Any hit whose revision is not the object's current head is
 * dropped: an asynchronous provider may still hold vectors for superseded
 * revisions, and those must never outrank or resurface stale content. The
 * canonical row is the authority for what is current.
 */
export async function queryNodeVectors(env, config, { userId, values, topK }) {
	if (!config.useVectors || !env.VECTORIZE || !values) return [];
	let matches = [];
	try {
		const res = await env.VECTORIZE.query(values, {
			topK: topK ?? config.shortlistSize,
			namespace: userId,
			returnMetadata: "none",
		});
		matches = res?.matches ?? [];
	} catch (err) {
		console.warn("vectorize query failed:", err?.message ?? err);
		return [];
	}
	if (!matches.length) return [];

	const parsed = matches.map((m) => ({ ...parseVectorId(m.id), score: m.score }));
	const objectIds = [...new Set(parsed.map((entry) => entry.objectId))].slice(0, 200);
	if (!objectIds.length) return [];

	// One indexed lookup decides which revisions are current.
	let heads = new Map();
	try {
		const marks = objectIds.map(() => "?").join(",");
		const { results } = await env.DB.prepare(
			`SELECT id, COALESCE(revision, 1) AS revision FROM nodes
			  WHERE user_id = ? AND id IN (${marks}) AND deleted_at IS NULL`,
		).bind(userId, ...objectIds).all();
		heads = new Map((results ?? []).map((row) => [row.id, Number(row.revision)]));
	} catch (err) {
		console.warn("vectorize head resolution failed:", err?.message ?? err);
		return [];
	}

	const best = new Map();
	const droppedIds = new Set();
	for (const entry of parsed) {
		const head = heads.get(entry.objectId);
		if (head === undefined) { droppedIds.add(entry.objectId); continue; } // deleted or foreign
		if (!entry.legacy && entry.revision !== head) continue; // superseded vector
		const existing = best.get(entry.objectId);
		if (!existing || (entry.score ?? 0) > (existing.score ?? 0)) {
			best.set(entry.objectId, { id: entry.objectId, score: entry.score });
		}
	}
	// The silent drop above is the isolation working — but silence is also how
	// a namespace-confusion bug would hide. Classify before alarming: a
	// soft-deleted node whose vector has not been cleaned up yet is ROUTINE
	// deletion lag (low — visible, collapsed, never emailed), while an id with
	// no row for this user at all is another tenant's vector or content that
	// should not exist — the actual namespace-confusion signal (medium).
	// Without the split, ordinary post-delete residue would storm the owner
	// with false high-severity alerts and bury the one that matters.
	if (droppedIds.size) {
		let ownedEver = new Set();
		try {
			const ids = [...droppedIds].slice(0, 200);
			const marks = ids.map(() => "?").join(",");
			const { results } = await env.DB.prepare(
				`SELECT id FROM nodes WHERE user_id = ? AND id IN (${marks})`,
			).bind(userId, ...ids).all();
			ownedEver = new Set((results ?? []).map((row) => row.id));
		} catch {
			ownedEver = new Set(droppedIds); // classification is best-effort; default to residue
		}
		const foreign = [...droppedIds].filter((id) => !ownedEver.has(id)).length;
		const residue = droppedIds.size - foreign;
		if (foreign) {
			await recordSecurityEvent(env, {
				kind: "vector_scope_drop",
				severity: "medium",
				groupKey: `vector_scope_drop:${userId}`,
				details: { memory_user_id: userId, dropped: foreign },
			});
		}
		if (residue) {
			await recordSecurityEvent(env, {
				kind: "vector_deleted_residue",
				severity: "low",
				groupKey: `vector_deleted_residue:${userId}`,
				details: { memory_user_id: userId, dropped: residue },
			});
		}
	}
	return [...best.values()];
}

/** Best-effort cleanup for stale node vectors after soft deletion. */
export async function deleteNodeVectors(env, config, ids) {
	if (!config.useVectors || !env.VECTORIZE || !ids?.length) return;
	try {
		await env.VECTORIZE.deleteByIds(ids);
	} catch (err) {
		console.warn("vectorize delete failed:", err?.message ?? err);
	}
}
