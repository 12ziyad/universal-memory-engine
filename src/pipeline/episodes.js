/**
 * Source episodes — the recoverability layer.
 *
 * The measured problem: 64.6% of judge-scored misses are facts that were never
 * stored. Extraction declined them, and after that there was nothing left to
 * find. A conservative model pass should not be able to make allowed evidence
 * permanently unrecoverable, so source preservation is now a separate concern
 * from semantic promotion:
 *
 *   PRESERVATION  every permitted accepted message is written here, at accept
 *                 time, before the model is consulted at all.
 *   PROMOTION     extraction decides what becomes a node, slice, event or edge.
 *                 It is allowed to decline; declining no longer erases.
 *
 * Four properties this file is responsible for, in order of how badly they
 * would hurt if broken:
 *
 *   1. NOT AN UNSCRUBBED ARCHIVE. Secrets are already gone — `scrubMessages`
 *      runs in ingest.js before anything durable sees the text. On top of that
 *      the account's exclude rules are enforced here, and if the rules cannot
 *      be loaded NOTHING is written. Failing closed costs recoverability;
 *      failing open would keep content the user asked us never to keep.
 *   2. SCOPE-BOUND. Every read binds user_id, and scoped reads bind project_id.
 *      There is no query in this file that can reach another account.
 *   3. ERASABLE. Rows are hard-deleted, and the FTS triggers drop their tokens
 *      in the same statement. A soft-deleted episode would be retained text
 *      with a flag on it.
 *   4. BOUNDED. Writes are capped per accepted batch; reads are capped per
 *      query. Neither the caller nor the corpus size can make this unbounded.
 */

import { newId } from "../lib/ids.js";
import { normalizeProjectScope } from "../lib/project_scope.js";
import { resolveAdmissionRules } from "./admission.js";
import { rulesAllowText } from "./rules.js";
import { hashText } from "./source.js";

/** Per-message cap. Long enough to hold the evidence, short enough to bound a row. */
export const EPISODE_TEXT_CAP = 4000;
/** Per accepted batch. The wire contract already caps a batch at 30 messages. */
export const EPISODE_MAX_ROWS_PER_WRITE = 40;
/** Per query. The evidence budget decides how many of these actually get used. */
export const EPISODE_SEARCH_MAX = 50;

/** Roles whose text is preserved. Tool and system output are machinery, not memory. */
const PRESERVED_ROLES = new Set(["user", "assistant"]);

/**
 * Write the permitted source text of one accepted write.
 *
 * Best-effort in the same sense as read-your-writes staging: an episode failure
 * must never fail an accepted write, because the semantic path is still going
 * to run. It returns what it did so a receipt can say so.
 */
export async function writeSourceEpisodes(env, userId, {
	sourcePacketId = null,
	conversationId = null,
	threadId = null,
	sessionId = null,
	messages = [],
	projectId = null,
	projectName = null,
	rules,
	acceptedAt = null,
	required = false,
}) {
	// Fail closed. An episode is durable, searchable, permitted text; writing it
	// without knowing the account's exclude rules is exactly the hidden archive
	// this layer must not become.
	let effectiveRules;
	try {
		effectiveRules = await resolveAdmissionRules(env, userId, rules);
	} catch (error) {
		console.warn("episode rules load failed:", error?.message ?? error);
		return {
			ok: false,
			outcome: "rules_unavailable",
			written: 0,
			ruleFiltered: 0,
			rulesUnavailable: true,
		};
	}

	const eligible = [];
	(messages ?? []).forEach((message, index) => {
		const role = String(message?.role ?? "user").toLowerCase();
		if (!PRESERVED_ROLES.has(role)) return;
		const text = String(message?.content ?? "").trim();
		if (!text) return;
		eligible.push({ index, role, text, id: message?.id ?? null, sourceTime: message?.source_time ?? null });
	});

	const allowed = eligible.filter((row) => rulesAllowText(effectiveRules, row.text));
	const ruleFiltered = eligible.length - allowed.length;
	const rows = allowed.slice(0, EPISODE_MAX_ROWS_PER_WRITE);
	if (!rows.length) {
		return {
			ok: true,
			outcome: "no_permitted_source",
			written: 0,
			expected: 0,
			eligible: eligible.length,
			ruleFiltered,
		};
	}
	if (required && !sourcePacketId) {
		return {
			ok: false,
			outcome: "invalid_provenance",
			written: 0,
			expected: rows.length,
			eligible: eligible.length,
			ruleFiltered,
		};
	}

	const now = Date.now();
	const packetAcceptedAt = Number(acceptedAt);
	const acceptanceTime = Number.isFinite(packetAcceptedAt) && packetAcceptedAt > 0
		? packetAcceptedAt
		: now;
	const project = normalizeProjectScope({ projectId, projectName });
	try {
		const prepared = await Promise.all(rows.map(async (row) => {
			const text = [...row.text].slice(0, EPISODE_TEXT_CAP).join("");
			const textHash = await hashText(text);
			const statement = env.DB.prepare(
				`INSERT INTO source_episodes
					(id, user_id, memory_user_id, owner_user_id, external_user_id,
					 project_id, project_name, source_packet_id, conversation_id, thread_id,
					 session_id, message_id, message_index, role, text, text_hash,
					 source_time, source_time_offset_minutes, source_time_precision,
					 observed_at, created_at)
				 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
				 WHERE NOT EXISTS (
					SELECT 1 FROM deletion_barriers
					 WHERE user_id = ? AND barrier_at >= ?
				 )
				 ON CONFLICT(user_id, source_packet_id, message_id) DO NOTHING`,
			).bind(
				newId("episode"),
				userId,
				userId,
				userId,
				userId,
				project.projectId,
				project.projectName,
				sourcePacketId,
				conversationId,
				threadId,
				sessionId,
				row.id,
				row.index,
				row.role,
				text,
				textHash,
				row.sourceTime?.epoch_ms ?? null,
				row.sourceTime?.offset_minutes ?? null,
				row.sourceTime?.precision ?? null,
				Number(messages?.[row.index]?.ts) || now,
				now,
				userId,
				acceptanceTime,
			);
			return { statement, messageId: row.id, textHash };
		}));
		await env.DB.batch(prepared.map((row) => row.statement));

		// A batch that executed without throwing can still have inserted zero rows:
		// the erasure barrier deliberately turns a pre-delete retry into a no-op,
		// and an idempotent replay deliberately conflicts. Verify the durable rows
		// instead of equating "SQL returned" with source conservation.
		const ids = [...new Set(prepared.map((row) => row.messageId).filter(Boolean))];
		if (ids.length !== prepared.length) {
			return {
				ok: false,
				outcome: "invalid_provenance",
				written: 0,
				expected: prepared.length,
				eligible: eligible.length,
				ruleFiltered,
			};
		}
		const marks = ids.map(() => "?").join(", ");
		const { results } = await env.DB.prepare(
			`SELECT message_id, text_hash FROM source_episodes
			 WHERE user_id = ? AND source_packet_id = ? AND message_id IN (${marks})`,
		).bind(userId, sourcePacketId, ...ids).all();
		const durable = new Map((results ?? []).map((row) => [row.message_id, row.text_hash]));
		const barrier = await env.DB.prepare(
			"SELECT barrier_at FROM deletion_barriers WHERE user_id = ? AND barrier_at >= ? LIMIT 1",
		).bind(userId, acceptanceTime).first();
		if (barrier) {
			return {
				ok: false,
				outcome: "blocked_by_erasure",
				written: 0,
				expected: prepared.length,
				eligible: eligible.length,
				ruleFiltered,
			};
		}
		const complete = prepared.every((row) => durable.get(row.messageId) === row.textHash);
		if (!complete) {
			return {
				ok: false,
				outcome: "verification_failed",
				written: durable.size,
				expected: prepared.length,
				eligible: eligible.length,
				ruleFiltered,
			};
		}
		return {
			ok: true,
			outcome: "stored",
			written: durable.size,
			expected: prepared.length,
			eligible: eligible.length,
			ruleFiltered,
		};
	} catch (error) {
		console.warn("episode write failed:", error?.message ?? error);
		return {
			ok: false,
			outcome: "write_failed",
			written: 0,
			expected: rows.length,
			eligible: eligible.length,
			ruleFiltered,
			...(required ? {} : { error: String(error?.message ?? error) }),
		};
	}
}

function episodeProjectFilter(recallScope, projectId) {
	const scope = String(recallScope ?? "global").trim().toLowerCase();
	if (scope === "project_only") {
		return projectId
			? { sql: " AND e.project_id = ?", bindings: [projectId] }
			: { sql: " AND 1 = 0", bindings: [] };
	}
	if (scope === "project_then_global") {
		return projectId
			? { sql: " AND (e.project_id = ? OR e.project_id IS NULL)", bindings: [projectId] }
			: { sql: " AND e.project_id IS NULL", bindings: [] };
	}
	return { sql: "", bindings: [] };
}

/**
 * Search the permitted source text. FTS5/BM25, bounded, scope-filtered in SQL
 * rather than after the fact — a post-filter lets another project's rows fill
 * the LIMIT before the requested one is ever seen.
 */
export async function findSourceEpisodes(env, userId, queryTokens = [], {
	limit = 8,
	recallScope = "global",
	projectId = null,
} = {}) {
	const terms = [...new Set((queryTokens ?? [])
		.map((token) => String(token ?? "").trim())
		.filter((token) => token.length > 1))].slice(0, 12);
	if (!terms.length || !userId) return [];
	const bounded = Math.max(1, Math.min(EPISODE_SEARCH_MAX, Number(limit) || 8));
	const project = episodeProjectFilter(recallScope, normalizeProjectScope({ projectId }).projectId);
	try {
		const match = terms.map((term) => `"${term.replace(/"/g, "")}"`).join(" OR ");
		const { results } = await env.DB.prepare(
			`SELECT e.id, e.text, e.role, e.message_id, e.message_index, e.source_packet_id,
				e.conversation_id, e.session_id, e.project_id, e.project_name,
				e.source_time, e.source_time_offset_minutes, e.source_time_precision,
				e.observed_at, e.created_at
			 FROM source_episodes_fts f
			 JOIN source_episodes e ON e.rowid = f.rowid
			 WHERE source_episodes_fts MATCH ? AND e.user_id = ?${project.sql}
			 ORDER BY bm25(source_episodes_fts) LIMIT ?`,
		).bind(match, userId, ...project.bindings, bounded).all();
		return results ?? [];
	} catch (error) {
		// A search failure is a degraded read, never a failed one: the semantic
		// path already answered, and this layer is additional evidence.
		console.warn("episode search failed:", error?.message ?? error);
		return [];
	}
}

/**
 * The episodes belonging to one accepted write, in order. This is what source
 * expansion reads: a semantic hit says "Alice left banking", and the message
 * behind it says when she said so and in what words.
 */
export async function episodesForPacket(env, userId, sourcePacketId, {
	limit = 30,
	recallScope = "global",
	projectId = null,
} = {}) {
	if (!userId || !sourcePacketId) return [];
	const bounded = Math.max(1, Math.min(EPISODE_SEARCH_MAX, Number(limit) || 30));
	const project = episodeProjectFilter(recallScope, normalizeProjectScope({ projectId }).projectId);
	try {
		const { results } = await env.DB.prepare(
			`SELECT e.id, e.text, e.role, e.message_id, e.message_index, e.source_packet_id,
				e.source_time, e.source_time_offset_minutes, e.source_time_precision, e.observed_at
			 FROM source_episodes e
			 WHERE e.user_id = ? AND e.source_packet_id = ?${project.sql}
			 ORDER BY e.message_index ASC LIMIT ?`,
		).bind(userId, sourcePacketId, ...project.bindings, bounded).all();
		return results ?? [];
	} catch (error) {
		console.warn("episode packet lookup failed:", error?.message ?? error);
		return [];
	}
}

/**
 * Erase episodes. Hard delete: this is the user's own text, and a tombstoned
 * copy is retained text with a flag on it. The FTS triggers drop the tokens in
 * the same statement, so the search index cannot outlive the row.
 */
export async function deleteSourceEpisodes(env, userId, { projectId = null, sourcePacketIds = null } = {}) {
	if (!userId) return { deleted: 0 };
	try {
		// Count before and after rather than trusting the driver's changed-row
		// number: the FTS triggers modify the index tables in the same statement,
		// so `meta.changes` reports index churn alongside the rows we removed. A
		// delete that claims to have erased six of two things is a report nobody
		// can act on.
		const before = await countSourceEpisodes(env, userId, { projectId });
		if (Array.isArray(sourcePacketIds)) {
			const ids = sourcePacketIds.filter(Boolean);
			for (let offset = 0; offset < ids.length; offset += 50) {
				const chunk = ids.slice(offset, offset + 50);
				const marks = chunk.map(() => "?").join(", ");
				await env.DB.prepare(
					`DELETE FROM source_episodes WHERE user_id = ? AND source_packet_id IN (${marks})`,
				).bind(userId, ...chunk).run();
			}
		} else if (projectId) {
			await env.DB.prepare("DELETE FROM source_episodes WHERE user_id = ? AND project_id = ?")
				.bind(userId, projectId).run();
		} else {
			await env.DB.prepare("DELETE FROM source_episodes WHERE user_id = ?").bind(userId).run();
		}
		const after = await countSourceEpisodes(env, userId, { projectId });
		return { deleted: Math.max(0, before - after) };
	} catch (error) {
		console.warn("episode delete failed:", error?.message ?? error);
		return { deleted: 0, error: String(error?.message ?? error) };
	}
}

/** How many episodes are still live for this account — the erasure convergence check. */
export async function countSourceEpisodes(env, userId, { projectId = null } = {}) {
	if (!userId) return 0;
	try {
		const row = projectId
			? await env.DB.prepare("SELECT COUNT(*) AS n FROM source_episodes WHERE user_id = ? AND project_id = ?")
				.bind(userId, projectId).first()
			: await env.DB.prepare("SELECT COUNT(*) AS n FROM source_episodes WHERE user_id = ?").bind(userId).first();
		return Number(row?.n ?? 0);
	} catch {
		return 0;
	}
}
