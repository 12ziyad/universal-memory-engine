import path from "node:path";

import { STAGE_E, assert, d1Select, writeJsonExclusive } from "./common.mjs";

const PROOF = path.join(STAGE_E, "SCHEMA-PREFLIGHT.json");
const statements = [
	`SELECT rowid AS fts_rowid,id,user_id,memory_user_id,external_user_id,project_id,
	 source_packet_id,conversation_id,message_id,message_index,role,text,text_hash,
	 source_time,source_time_precision,observed_at FROM source_episodes WHERE 1=0`,
	`SELECT id,user_id,memory_user_id,external_user_id,project_id,capture_run_id,
	 extraction_run_id,source_episode_id,source_packet_id,chunk_key,source_message_id,
	 start_code_point,end_code_point,evidence_quote,evidence_hash,dedupe_key,atom_type,
	 entity_type,attribute,assertion,raw_temporal_phrase,source_time,source_time_precision,
	 extraction_model,schema_version,status FROM semantic_atom_candidates WHERE 1=0`,
	`SELECT id,source_packet_id,extraction_run_id,chunk_key,status,model,schema_version,
	 attempts,replay_count,proposed_count,accepted_count,stored_count,rejected_count,
	 duplicate_count,truncated,error_code FROM semantic_atom_capture_runs WHERE 1=0`,
	`SELECT p.candidate_id,p.user_id,p.project_id,p.source_episode_id,p.source_packet_id,
	 p.outcome,p.object_kind,p.object_id,p.schema_version,c.status AS candidate_status,
	 COALESCE(s.id,v.id,g.id) AS live_object_id,
	 COALESCE(s.user_id,v.user_id,g.user_id) AS object_user_id,
	 COALESCE(s.project_id,v.project_id,g.project_id) AS object_project_id,
	 COALESCE(s.source_snippet,v.source_snippet,g.source_snippet) AS object_source_snippet
	 FROM semantic_atom_projections p
	 JOIN semantic_atom_candidates c ON c.id=p.candidate_id AND c.user_id=p.user_id
	 LEFT JOIN slices s ON p.object_kind='slice' AND s.id=p.object_id AND s.deleted_at IS NULL
	 LEFT JOIN events v ON p.object_kind='event' AND v.id=p.object_id AND v.deleted_at IS NULL
	 LEFT JOIN edges g ON p.object_kind='edge' AND g.id=p.object_id AND g.deleted_at IS NULL
	 WHERE 1=0`,
	`SELECT id,source_packet_id,status,attempts,type,
	 json_extract(payload_json,'$.project_id') AS project_id FROM memory_jobs WHERE 1=0`,
	`SELECT id,source_packet_id,status,job_id,error,created_at,updated_at
	 FROM extraction_runs WHERE 1=0`,
	`SELECT id,source_packet_id,outcome,
	 json_extract(detail,'$.atomic_capture_enabled') AS atomic_enabled,
	 json_extract(detail,'$.atomic_capture_stored') AS atomic_stored,
	 json_extract(detail,'$.atomic_capture_truncated') AS atomic_truncated,
	 json_extract(detail,'$.atomic_projection_enabled') AS projection_enabled,
	 json_extract(detail,'$.atomic_projection_candidates') AS projection_candidates,
	 json_extract(detail,'$.atomic_projection_promoted') AS projection_promoted,
	 json_extract(detail,'$.atomic_projection_reinforced') AS projection_reinforced,
	 json_extract(detail,'$.atomic_projection_ignored') AS projection_ignored,
	 json_extract(detail,'$.atomic_capture_latency_ms') AS atomic_latency_ms,
	 json_extract(detail,'$.atomic_projection_latency_ms') AS projection_latency_ms
	 FROM receipts WHERE 1=0`,
	`SELECT rowid AS fts_rowid,object_id AS id FROM manual_search_profiles WHERE 1=0`,
	`SELECT rowid FROM source_episodes_fts WHERE 1=0`,
	`SELECT rowid FROM manual_search_fts WHERE 1=0`,
];
const results = await d1Select(statements);
assert(results.length === statements.length && results.every((result) => result.success === true
	&& result.meta?.served_by === "v3-prod" && result.meta?.served_by_primary === true),
"Stage E production-primary schema preflight failed");
writeJsonExclusive(PROOF, {
	schema: "itsuki.v3-stage-e-schema-preflight/v1",
	provedAt: new Date().toISOString(),
	statements: statements.length,
	servedBy: [...new Set(results.map((result) => result.meta.served_by))],
	servedByPrimary: results.every((result) => result.meta.served_by_primary === true),
	rowsReturned: results.reduce((sum, result) => sum + (result.results?.length ?? 0), 0),
	nonMutating: true,
	verdict: "PASS",
});
console.log(JSON.stringify({ verdict: "PASS", statements: statements.length,
	servedByPrimary: true, nonMutating: true }));
