/**
 * E6 governed projection.
 *
 * Source-grounded candidates are not truth. This module turns them into the
 * same proposal vocabulary used by legacy extraction, then the established
 * gates decide what may enter semantic state. Candidate identity and exact
 * evidence stay out-of-band in a WeakMap so model output cannot forge the
 * trusted projection metadata.
 */

import { ACTIONS } from "../config.js";
import { normalizeProjectScope } from "../lib/project_scope.js";
import { normalizeLabel } from "../lib/text.js";

export const ATOMIC_PROJECTION_SCHEMA = "itsuki.semantic-atom-projection/v1";
export const ATOMIC_PROJECTION_MAX_CANDIDATES = 512;

const ACTION_PATTERNS = [
	["passed_away", /\b(?:passed away|died|death)\b/i],
	["broke_up", /\b(?:broke up|separated|breakup)\b/i],
	["changed_plan", /\b(?:changed plan|change of plan)\b/i],
	["diagnosed", /\b(?:diagnosed|diagnosis)\b/i],
	["recovered", /\b(?:recovered|recovery)\b/i],
	["completed", /\b(?:completed|finished|done|discharged)\b/i],
	["started", /\b(?:started|began|begin|start)\b/i],
	["stopped", /\b(?:stopped|quit|ceased|sold)\b/i],
	["paused", /\b(?:paused|pause)\b/i],
	["resumed", /\b(?:resumed|back on|restarted)\b/i],
	["launched", /\b(?:launched|launch)\b/i],
	["fixed", /\b(?:fixed|repaired|resolved)\b/i],
	["removed", /\b(?:removed|deleted)\b/i],
	["decided", /\b(?:decided|decision)\b/i],
	["married", /\b(?:married|wedding)\b/i],
	["born", /\b(?:born|birth)\b/i],
	["moved", /\b(?:moved|relocated)\b/i],
	["injured", /\b(?:injured|injury)\b/i],
	["achieved", /\b(?:achieved|attained)\b/i],
	["joined", /\b(?:joined|enrolled)\b/i],
	["left", /\b(?:left|departed)\b/i],
	["practiced", /\b(?:practiced|practised|trained)\b/i],
];

function clean(value, max = 800) {
	const text = String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
	return Array.from(text).slice(0, max).join("");
}

function entityKey(value) {
	const normalized = normalizeLabel(value);
	return normalized || clean(value, 160).toLocaleLowerCase();
}

function actionFor(row) {
	const attribute = clean(row?.attribute, 96)
		.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
	if (ACTIONS.includes(attribute)) return attribute;
	const corpus = `${row?.attribute ?? ""} ${row?.value ?? ""} ${row?.assertion ?? ""}`;
	return ACTION_PATTERNS.find(([, pattern]) => pattern.test(corpus))?.[0] ?? "other";
}

function sliceKindFor(row) {
	switch (row?.atom_type) {
		case "decision": return "decision";
		case "preference": return "preference";
		case "goal":
		case "plan":
		case "state": return "progress";
		case "procedure": return /\b(?:fix|repair|resolution)\b/i.test(`${row?.attribute} ${row?.assertion}`)
			? "fix"
			: "technical_detail";
		case "fact": return ["project", "system", "tool"].includes(row?.entity_type)
			? "technical_detail"
			: "other";
		default: return "other";
	}
}

function dayDate(row) {
	if (row?.event_time_precision !== "day") return null;
	const at = Number(row?.event_time);
	if (!Number.isFinite(at) || at <= 0) return null;
	try { return new Date(at).toISOString().slice(0, 10); } catch { return null; }
}

function metadataForRows(rows) {
	const candidateIds = [...new Set(rows.map((row) => String(row.id)).filter(Boolean))];
	const first = rows[0] ?? {};
	const attribute = normalizeLabel(first.attribute) || clean(first.attribute, 96).toLocaleLowerCase();
	return {
		candidateIds,
		evidenceQuote: clean(first.evidence_quote, 240),
		attribute: clean(attribute, 96),
		cardinality: ["single", "multi", "unknown"].includes(first.cardinality) ? first.cardinality : "unknown",
		eventTime: Number.isFinite(Number(first.event_time)) ? Number(first.event_time) : null,
		eventTimeEnd: Number.isFinite(Number(first.event_time_end)) ? Number(first.event_time_end) : null,
		eventTimePrecision: first.event_time_precision ?? null,
		eventTimeRelation: first.event_time_relation ?? null,
		rawTemporalPhrase: clean(first.raw_temporal_phrase, 160) || null,
	};
}

/** Pure, deterministic candidate -> established proposal conversion. */
export function buildAtomicProjection(candidateRows = []) {
	const rows = [...candidateRows]
		.filter((row) => row && row.status === "candidate" && row.id && row.entity && row.assertion)
		.sort((a, b) => Number(a.created_at ?? 0) - Number(b.created_at ?? 0) || String(a.id).localeCompare(String(b.id)));
	if (rows.length > ATOMIC_PROJECTION_MAX_CANDIDATES) {
		throw new Error(`atomic_projection_candidate_overflow:${rows.length}`);
	}
	const metadata = new WeakMap();
	const objects = [];
	const nodeGroups = new Map();
	const factGroups = new Map();

	for (const row of rows) {
		const key = entityKey(row.entity);
		if (!key) continue;
		if (!nodeGroups.has(key)) nodeGroups.set(key, []);
		nodeGroups.get(key).push(row);
		const factKey = JSON.stringify([
			key,
			row.atom_type === "event" ? "event" : "slice",
			normalizeLabel(row.assertion) || clean(row.assertion).toLocaleLowerCase(),
		]);
		if (!factGroups.has(factKey)) factGroups.set(factKey, []);
		factGroups.get(factKey).push(row);
	}

	for (const rowsForEntity of nodeGroups.values()) {
		const best = [...rowsForEntity].sort((a, b) => Number(b.confidence ?? 0) - Number(a.confidence ?? 0))[0];
		const object = {
			kind: "node",
			label: clean(best.entity, 120),
			category: clean(best.entity_type, 64) || "other",
			confidence: Math.max(...rowsForEntity.map((row) => Number(row.confidence ?? 0))),
		};
		objects.push(object);
		// Entity scaffolds are not candidate admission outcomes. Candidate ids
		// belong only to their assertion proposal below; otherwise a low-confidence
		// node's durable-signal fallback could incorrectly mark every assertion on
		// that entity as promoted by one synthetic fact.
	}

	for (const rowsForFact of factGroups.values()) {
		const best = [...rowsForFact].sort((a, b) => Number(b.confidence ?? 0) - Number(a.confidence ?? 0))[0];
		const base = {
			on: clean(best.entity, 120),
			text: clean(best.assertion, 800),
			confidence: Number(best.confidence ?? 0),
		};
		const object = best.atom_type === "event"
			? {
				...base,
				kind: "event",
				action: actionFor(best),
				importance: "ordinary",
				...(dayDate(best) ? { date: dayDate(best) } : {}),
			}
			: { ...base, kind: "slice", kind_detail: sliceKindFor(best) };
		objects.push(object);
		metadata.set(object, metadataForRows(rowsForFact));
	}

	return {
		schema: ATOMIC_PROJECTION_SCHEMA,
		objects,
		metadata,
		candidateIds: rows.map((row) => String(row.id)),
	};
}

/** Scope-bound load; the source episode join is a mandatory provenance check. */
export async function loadAtomicProjectionCandidates(env, {
	userId,
	projectId = null,
	captureRunIds = [],
} = {}) {
	if (typeof userId !== "string" || !userId || !Array.isArray(captureRunIds)) return [];
	const ids = [...new Set(captureRunIds.map(String).filter(Boolean))];
	if (!ids.length) return [];
	if (ids.length > 100) throw new Error(`atomic_projection_run_overflow:${ids.length}`);
	const project = normalizeProjectScope({ projectId });
	const marks = ids.map(() => "?").join(", ");
	const { results } = await env.DB.prepare(
		`SELECT c.*
		 FROM semantic_atom_candidates c
		 JOIN source_episodes e
		   ON e.id = c.source_episode_id AND e.user_id = c.user_id
		  AND e.source_packet_id = c.source_packet_id
		  AND e.message_id = c.source_message_id AND e.project_id IS c.project_id
		 WHERE c.user_id = ? AND c.project_id IS ? AND c.status = 'candidate'
		   AND c.capture_run_id IN (${marks})
		 ORDER BY c.created_at ASC, c.id ASC LIMIT ?`,
	).bind(userId, project.projectId, ...ids, ATOMIC_PROJECTION_MAX_CANDIDATES + 1).all();
	if ((results ?? []).length > ATOMIC_PROJECTION_MAX_CANDIDATES) {
		throw new Error(`atomic_projection_candidate_overflow:${results.length}`);
	}
	return results ?? [];
}

function candidateIds(item) {
	return Array.isArray(item?._atomic_candidate_ids)
		? item._atomic_candidate_ids.map(String).filter(Boolean)
		: Array.isArray(item?.atomic_candidate_ids)
			? item.atomic_candidate_ids.map(String).filter(Boolean)
			: [];
}

/** Convert gate effects into one terminal, auditable decision per candidate. */
export function deriveAtomicProjectionDecisions(plan = {}, candidates = []) {
	const effects = new Map();
	const record = (items, outcome, objectKind = null) => {
		for (const item of items ?? []) {
			for (const id of candidateIds(item)) {
				const priority = outcome === "promoted" ? 3 : outcome === "reinforced" ? 2 : 1;
				if ((effects.get(id)?.priority ?? 0) >= priority) continue;
				effects.set(id, {
					priority,
					outcome,
					reason: outcome === "ignored" ? String(item.reason ?? "gate_rejected").slice(0, 96) : null,
					objectKind,
					objectId: objectKind ? String(item.id ?? "") || null : null,
				});
			}
		}
	};
	record(plan.newSlices, "promoted", "slice");
	record(plan.newEvents, "promoted", "event");
	record(plan.newEdges, "promoted", "edge");
	record(plan.sliceTouches, "reinforced", "slice");
	record(plan.eventTouches, "reinforced", "event");
	record(plan.edgeTouches, "reinforced", "edge");
	record(plan.rejected, "ignored", null);

	return candidates.map((candidate) => {
		const effect = effects.get(String(candidate.id)) ?? {
			outcome: "ignored",
			reason: "no_semantic_effect",
			objectKind: null,
			objectId: null,
		};
		return {
			candidateId: String(candidate.id),
			userId: String(candidate.user_id),
			projectId: candidate.project_id ?? null,
			sourceEpisodeId: String(candidate.source_episode_id),
			sourcePacketId: String(candidate.source_packet_id),
			outcome: effect.outcome,
			reason: effect.reason ?? null,
			objectKind: effect.objectKind ?? null,
			objectId: effect.objectId ?? null,
			schemaVersion: ATOMIC_PROJECTION_SCHEMA,
		};
	});
}
