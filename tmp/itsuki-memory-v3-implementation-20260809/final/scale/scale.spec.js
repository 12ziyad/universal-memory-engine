import { expect, test } from "vitest";
import { env } from "cloudflare:test";

import { getConfig } from "../../../../src/config.js";
import { deleteAllMemories } from "../../../../src/pipeline/cleanup.js";
import { findSourceEpisodesDetailed } from "../../../../src/pipeline/episodes.js";
import { recall } from "../../../../src/pipeline/recall.js";

const MARKER = "@@ITSUKI_STAGE_C_RESULT@@";
const CONTEXT_HARD_MAX = 24_000;
const CANDIDATE_HARD_MAX = 200;
const EVENT_HARD_MAX = 4_000;

function quote(value) {
	return `'${String(value).replaceAll("'", "''")}'`;
}

function projectCase() {
	return "CASE WHEN i % 10 = 0 THEN NULL WHEN i % 5 = 0 THEN 'beta' ELSE 'alpha' END";
}

async function timed(label, operation) {
	const started = performance.now();
	const value = await operation();
	const ms = performance.now() - started;
	console.log(`STAGE-C ${label}: ${ms.toFixed(2)} ms`);
	return { value, ms };
}

async function insertFixture(size, userId) {
	const prefix = `s${size}`;
	const user = quote(userId);
	const pfx = quote(prefix);
	const project = projectCase();
	const base = 1_704_067_200_000;
	const statements = [
		["episodes", `WITH RECURSIVE seq(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM seq WHERE i < ${size})
		 INSERT INTO source_episodes
		 (id,user_id,memory_user_id,owner_user_id,external_user_id,project_id,project_name,
		  source_packet_id,conversation_id,message_id,message_index,role,text,text_hash,
		  source_time,source_time_precision,observed_at,created_at)
		 SELECT 'ep_'||${pfx}||'_'||i,${user},${user},${user},${user},${project},
		  CASE WHEN i%10=0 THEN NULL WHEN i%5=0 THEN 'Beta' ELSE 'Alpha' END,
		  'pkt_'||${pfx}||'_'||i,'conv_'||${pfx},'msg_'||${pfx}||'_'||i,i-1,'user',
		  CASE WHEN i=1 THEN 'quartzanchor decisive launch window is 2031-04-17'
		       WHEN i%10=0 THEN 'globalcanary account memory row '||i
		       WHEN i%5=0 THEN 'betacanary sibling project memory row '||i
		       ELSE 'alpha memory project routine row '||i END,
		  'fixture_hash_'||${pfx}||'_'||i,${base}+(i*1000),'time',${base}+(i*1000),${base}+(i*1000)
		 FROM seq`],
		["nodes", `WITH RECURSIVE seq(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM seq WHERE i < ${size})
		 INSERT INTO nodes
		 (id,user_id,label,category,state,summary,created_at,updated_at,canonical_label,aliases_json,
		  mention_count,session_count,last_seen_at,heat_score,project_id,project_name)
		 SELECT 'node_'||${pfx}||'_'||i,${user},
		  CASE WHEN i=1 THEN 'Quartzanchor launch'
		       WHEN i%10=0 THEN 'Global canary entity '||i
		       WHEN i%5=0 THEN 'Beta canary entity '||i
		       ELSE 'Memory project entity '||i END,
		  'project','active','deterministic scale fixture',${base}+i,${base}+i,
		  'scale_'||i,'[]',1,1,${base}+i,1,${project},
		  CASE WHEN i%10=0 THEN NULL WHEN i%5=0 THEN 'Beta' ELSE 'Alpha' END
		 FROM seq`],
		["slices", `WITH RECURSIVE seq(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM seq WHERE i < ${size})
		 INSERT INTO slices
		 (id,user_id,node_id,text,kind,is_current,created_at,project_id,project_name,
		  semantic_attribute,semantic_cardinality)
		 SELECT 'slice_'||${pfx}||'_'||i,${user},'node_'||${pfx}||'_'||i,
		  CASE WHEN i=1 THEN 'quartzanchor launch window is 2031-04-17'
		       WHEN i%10=0 THEN 'globalcanary memory assertion '||i
		       WHEN i%5=0 THEN 'betacanary memory assertion '||i
		       ELSE 'alpha memory project assertion '||i END,
		  'fact',1,${base}+i,${project},
		  CASE WHEN i%10=0 THEN NULL WHEN i%5=0 THEN 'Beta' ELSE 'Alpha' END,
		  'scale_attribute','single'
		 FROM seq`],
		["events", `WITH RECURSIVE seq(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM seq WHERE i < ${size})
		 INSERT INTO events
		 (id,user_id,node_id,action,text,importance,happened_at,created_at,happened_at_source,
		  project_id,project_name,event_time_precision,event_time_relation)
		 SELECT 'event_'||${pfx}||'_'||i,${user},'node_'||${pfx}||'_'||i,'recorded',
		  CASE WHEN i=1 THEN 'quartzanchor launch scheduled'
		       WHEN i%5=0 THEN 'sibling event '||i ELSE 'routine scale event '||i END,
		  'ordinary',${base}+(i*1000),${base}+i,'phrase',${project},
		  CASE WHEN i%10=0 THEN NULL WHEN i%5=0 THEN 'Beta' ELSE 'Alpha' END,'day','at'
		 FROM seq`],
		["edges", `WITH RECURSIVE seq(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM seq WHERE i < ${size})
		 INSERT INTO edges
		 (id,user_id,from_node,to_node,type,created_at,reinforcement_count,weight,fact,valid_at,
		  project_id,project_name)
		 SELECT 'edge_'||${pfx}||'_'||i,${user},
		  CASE WHEN i%10=0 THEN 'node_'||${pfx}||'_10'
		       WHEN i%5=0 THEN 'node_'||${pfx}||'_5' ELSE 'node_'||${pfx}||'_1' END,
		  'node_'||${pfx}||'_'||i,'RELATED_TO',${base}+i,0,1,
		  CASE WHEN i%10=0 THEN 'global relation '||i
		       WHEN i%5=0 THEN 'beta relation '||i ELSE 'alpha relation '||i END,
		  ${base},${project},CASE WHEN i%10=0 THEN NULL WHEN i%5=0 THEN 'Beta' ELSE 'Alpha' END
		 FROM seq`],
		["profiles", `WITH RECURSIVE seq(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM seq WHERE i < ${size})
		 INSERT INTO manual_search_profiles
		 (user_id,object_kind,object_id,identity_text,semantic_text,context_text,profile_hash,
		  source_updated_at,created_at,updated_at)
		 SELECT ${user},'node','node_'||${pfx}||'_'||i,
		  CASE WHEN i=1 THEN 'quartzanchor launch' ELSE 'memory project entity '||i END,
		  CASE WHEN i=1 THEN 'quartzanchor 2031-04-17' ELSE 'routine memory assertion '||i END,
		  'project scale','profile_'||${pfx}||'_'||i,${base}+i,${base}+i,${base}+i
		 FROM seq`],
	];
	const timings = {};
	for (const [label, sql] of statements) {
		const result = await timed(`${size} insert ${label}`, () => env.DB.prepare(sql).run());
		timings[label] = result.ms;
	}
	await env.DB.batch([
		env.DB.prepare(`INSERT INTO semantic_atom_capture_runs
			(id,user_id,project_id,project_name,source_packet_id,extraction_run_id,chunk_key,status,
			 model,schema_version,accepted_at,attempts,proposed_count,accepted_count,stored_count,
			 created_at,updated_at,completed_at)
			 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
			`run_${prefix}`, userId, "alpha", "Alpha", `pkt_${prefix}_1`, `extract_${prefix}`,
			`chunk_${prefix}`, "completed", "deterministic-fixture/no-inference", "scale/v1",
			base, 1, 1, 1, 1, base, base, base,
		),
		env.DB.prepare(`INSERT INTO semantic_atom_candidates
			(id,user_id,memory_user_id,owner_user_id,external_user_id,project_id,project_name,
			 capture_run_id,extraction_run_id,source_episode_id,source_packet_id,chunk_key,
			 source_message_id,start_code_point,end_code_point,evidence_quote,evidence_hash,dedupe_key,
			 atom_type,entity,entity_type,attribute,value,assertion,cardinality,confidence,
			 source_time,source_time_precision,observed_at,extraction_model,schema_version,status,created_at)
			 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
			`candidate_${prefix}`, userId, userId, userId, userId, "alpha", "Alpha",
			`run_${prefix}`, `extract_${prefix}`, `ep_${prefix}_1`, `pkt_${prefix}_1`, `chunk_${prefix}`,
			`msg_${prefix}_1`, 0, 51, "quartzanchor decisive launch window is 2031-04-17",
			`evidence_${prefix}`, `dedupe_${prefix}`, "event", "Quartzanchor launch", "project",
			"launch_window", "2031-04-17", "Quartzanchor launch window is 2031-04-17", "single", 1,
			base + 1000, "time", base + 1000, "deterministic-fixture/no-inference", "scale/v1",
			"promoted", base,
		),
		env.DB.prepare(`INSERT INTO semantic_atom_projections
			(candidate_id,user_id,project_id,source_episode_id,source_packet_id,extraction_run_id,
			 outcome,object_kind,object_id,schema_version,created_at)
			 VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(
			`candidate_${prefix}`, userId, "alpha", `ep_${prefix}_1`, `pkt_${prefix}_1`,
			`extract_${prefix}`, "promoted", "slice", `slice_${prefix}_1`, "projection/v1", base,
		),
	]);
	return timings;
}

function sqlTag(sql) {
	if (/FROM nodes n/i.test(sql)) return "nodes";
	if (/FROM memory_pages p/i.test(sql)) return "pages";
	if (/FROM slices s/i.test(sql)) return "slices";
	if (/FROM events e/i.test(sql)) return "events";
	if (/FROM edges e/i.test(sql)) return "edges";
	if (/FROM memory_profiles/i.test(sql)) return "profile";
	if (/WITH exact_source/i.test(sql)) return "source_expansion";
	if (/FROM staged_memories/i.test(sql)) return "staged";
	return "other";
}

function tracingDb(db) {
	const trace = [];
	const native = Symbol("native");
	const sqlText = Symbol("sql");
	const wrap = (statement, sql) => ({
		[native]: statement,
		[sqlText]: sql,
		bind(...values) { return wrap(statement.bind(...values), sql); },
		async all() {
			const result = await statement.all();
			trace.push({ operation: "all", tag: sqlTag(sql), rows: result?.results?.length ?? 0 });
			return result;
		},
		first(...args) { return statement.first(...args); },
		run() { return statement.run(); },
		raw(...args) { return statement.raw(...args); },
	});
	return {
		trace,
		prepare(sql) { return wrap(db.prepare(sql), sql); },
		async batch(statements) {
			const result = await db.batch(statements.map((statement) => statement[native]));
			result.forEach((row, index) => trace.push({
				operation: "batch",
				tag: sqlTag(statements[index][sqlText]),
				rows: row?.results?.length ?? 0,
			}));
			return result;
		},
	};
}

function scaleEnv(userId, db = env.DB) {
	return {
		...env,
		DB: db,
		USE_VECTORS: "false",
		ITSUKI_MEMORY_V3: "allowlist",
		ITSUKI_MEMORY_V3_USERS: userId,
		ITSUKI_MEMORY_V3_HYBRID_RETRIEVAL: "allowlist",
		ITSUKI_MEMORY_V3_HYBRID_RETRIEVAL_USERS: userId,
		ITSUKI_MEMORY_V3_SOURCE_EXPANSION: "allowlist",
		ITSUKI_MEMORY_V3_SOURCE_EXPANSION_USERS: userId,
		ITSUKI_MEMORY_V3_ATOMIC_CAPTURE: "off",
		ITSUKI_MEMORY_V3_ATOMIC_CAPTURE_USERS: "",
		ITSUKI_MEMORY_V3_ATOMIC_PROJECTION: "off",
		ITSUKI_MEMORY_V3_ATOMIC_PROJECTION_USERS: "",
		ITSUKI_MEMORY_V3_EPISODE_FALLBACK: "off",
		ITSUKI_MEMORY_V3_EPISODE_FALLBACK_USERS: "",
		ITSUKI_MEMORY_V3_ADAPTIVE_CONTEXT: "off",
		ITSUKI_MEMORY_V3_ADAPTIVE_CONTEXT_USERS: "",
	};
}

async function plan(sql, bindings = []) {
	const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...bindings).all();
	return (results ?? []).map((row) => String(row.detail ?? ""));
}

async function counts(userId) {
	const [row, episodeFts, manualFts] = await env.DB.batch([
		env.DB.prepare(`SELECT
			(SELECT COUNT(*) FROM source_episodes WHERE user_id=?) episodes,
			(SELECT COUNT(*) FROM nodes WHERE user_id=?) nodes,
			(SELECT COUNT(*) FROM slices WHERE user_id=?) slices,
			(SELECT COUNT(*) FROM events WHERE user_id=?) events,
			(SELECT COUNT(*) FROM edges WHERE user_id=?) edges,
			(SELECT COUNT(*) FROM manual_search_profiles WHERE user_id=?) profiles,
			(SELECT COUNT(*) FROM semantic_atom_candidates WHERE user_id=?) candidates,
			(SELECT COUNT(*) FROM semantic_atom_projections WHERE user_id=?) projections,
			(SELECT COUNT(*) FROM semantic_atom_capture_runs WHERE user_id=?) runs`).bind(
			userId, userId, userId, userId, userId, userId, userId, userId, userId,
		),
		env.DB.prepare("SELECT COUNT(*) AS n FROM source_episodes_fts WHERE source_episodes_fts MATCH 'quartzanchor'"),
		env.DB.prepare("SELECT COUNT(*) AS n FROM manual_search_fts WHERE manual_search_fts MATCH 'quartzanchor'"),
	]);
	return {
		...(row.results?.[0] ?? {}),
		episodeFtsTarget: Number(episodeFts.results?.[0]?.n ?? 0),
		manualFtsTarget: Number(manualFts.results?.[0]?.n ?? 0),
	};
}

async function directFixtureCleanup(userId) {
	for (const table of [
		"semantic_atom_projections", "semantic_atom_candidates", "semantic_atom_capture_runs",
		"source_episodes", "manual_search_profiles", "edges", "events", "slices", "nodes",
	]) await env.DB.prepare(`DELETE FROM ${table} WHERE user_id = ?`).bind(userId).run();
}

test("measures the preregistered production-schema scale cell", async () => {
	const size = Number(env.FINAL_SCALE_SIZE);
	expect([1_000, 10_000, 100_000]).toContain(size);
	const userId = `v3_final_scale_${size}`;
	const startedAt = new Date().toISOString();
	const result = {
		schema: "itsuki.v3-final-stage-c-scale-cell/v1",
		size,
		userIdHashLabel: `deterministic-local-${size}`,
		startedAt,
		localOnly: true,
		inferenceCalls: 0,
	};
	let productDeleteConverged = false;
	try {
		result.insertMs = await insertFixture(size, userId);
		result.before = await counts(userId);
		const expectedAlpha = size - Math.floor(size / 5);
		result.expectedProjectRows = { alpha: expectedAlpha, beta: Math.floor(size / 10), global: Math.floor(size / 10) };

		const episodeEnv = scaleEnv(userId);
		const ftsOwn = await timed(`${size} episode FTS own`, () => findSourceEpisodesDetailed(
			episodeEnv, userId, ["quartzanchor"], { limit: 50, recallScope: "project_only", projectId: "alpha" },
		));
		const ftsCross = await timed(`${size} episode FTS cross`, () => findSourceEpisodesDetailed(
			episodeEnv, userId, ["betacanary"], { limit: 50, recallScope: "project_only", projectId: "alpha" },
		));
		const ftsWide = await timed(`${size} episode FTS common`, () => findSourceEpisodesDetailed(
			episodeEnv, userId, ["memory"], { limit: 50, recallScope: "project_only", projectId: "alpha" },
		));
		result.episodeFts = {
			ownMs: ftsOwn.ms, ownRows: ftsOwn.value.rows.length, ownFailed: ftsOwn.value.failed,
			crossMs: ftsCross.ms, crossRows: ftsCross.value.rows.length, crossFailed: ftsCross.value.failed,
			commonMs: ftsWide.ms, commonRows: ftsWide.value.rows.length, commonFailed: ftsWide.value.failed,
		};

		const runRecall = async (label, query) => {
			const traced = tracingDb(env.DB);
			const localEnv = scaleEnv(userId, traced);
			const measured = await timed(`${size} recall ${label}`, () => recall(
				localEnv, getConfig(localEnv), userId, query, {
					limit: 200,
					limitMode: "depth",
					recallScope: "project_only",
					memoryScope: { projectId: "alpha", projectName: "Alpha" },
					internalTrace: true,
				},
			));
			return {
				ms: measured.ms,
				count: measured.value.count,
				items: measured.value.items?.length ?? 0,
				contextChars: measured.value.context.length,
				contextBytes: new TextEncoder().encode(measured.value.context).byteLength,
				hybridCandidates: measured.value.hybrid_assertion_candidates,
				hybridParents: measured.value.hybrid_parent_candidates,
				sourceExpansionEpisodes: measured.value.source_expansion_episodes ?? 0,
				sourceExpansionFailed: measured.value.source_expansion_failed ?? false,
				containsTarget: /quartzanchor/i.test(measured.value.context),
				containsBetaCanary: /betacanary/i.test(measured.value.context),
				trace: traced.trace,
			};
		};
		result.targetRecall = await runRecall("target", "When is the quartzanchor launch window?");
		result.broadRecall = await runRecall("broad", "What do you know about my memory project?");

		result.queryPlans = {
			episodeFts: await plan(`SELECT e.id FROM source_episodes_fts f
				JOIN source_episodes e ON e.rowid=f.rowid
				WHERE source_episodes_fts MATCH ? AND e.user_id=? AND e.project_id=? LIMIT 50`,
				["\"quartzanchor\"", userId, "alpha"]),
			nodes: await plan("SELECT id FROM nodes WHERE user_id=? AND project_id=? AND deleted_at IS NULL", [userId, "alpha"]),
			slices: await plan("SELECT id FROM slices WHERE user_id=? AND project_id=? AND is_current=1 AND deleted_at IS NULL", [userId, "alpha"]),
			edges: await plan("SELECT id FROM edges WHERE user_id=? AND project_id=? AND deleted_at IS NULL", [userId, "alpha"]),
			deleteEpisodes: await plan("DELETE FROM source_episodes WHERE user_id=?", [userId]),
		};

		const deletion = await timed(`${size} product delete`, () => deleteAllMemories(scaleEnv(userId), userId, "DELETE ALL"));
		result.productDelete = { ms: deletion.ms, deleted: deletion.value.deleted, nodes: deletion.value.nodes };
		result.after = await counts(userId);
		productDeleteConverged = Object.values(result.after).every((value) => Number(value) === 0);
	} catch (error) {
		result.error = { name: String(error?.name ?? "Error"), message: String(error?.message ?? error).slice(0, 500) };
	} finally {
		if (!productDeleteConverged) {
			try { await directFixtureCleanup(userId); }
			catch (error) { result.fallbackCleanupError = String(error?.message ?? error).slice(0, 500); }
		}
		result.final = await counts(userId);
		result.completedAt = new Date().toISOString();
	}

	const loadRows = (recallResult, tag) => Math.max(0, ...(recallResult?.trace ?? [])
		.filter((row) => row.tag === tag).map((row) => Number(row.rows) || 0));
	const rawMax = Math.max(
		loadRows(result.targetRecall, "nodes"), loadRows(result.targetRecall, "slices"),
		loadRows(result.targetRecall, "edges"), loadRows(result.broadRecall, "nodes"),
		loadRows(result.broadRecall, "slices"), loadRows(result.broadRecall, "edges"),
	);
	const eventMax = Math.max(loadRows(result.targetRecall, "events"), loadRows(result.broadRecall, "events"));
	result.rawLoads = { maxNodeSliceEdgeRows: rawMax, maxEventRows: eventMax };
	result.gates = {
		scopeSafe: result.episodeFts?.crossRows === 0
			&& result.targetRecall?.containsBetaCanary === false
			&& result.broadRecall?.containsBetaCanary === false,
		finalResultsBounded: [result.targetRecall, result.broadRecall].every((row) => row
			&& row.items <= CANDIDATE_HARD_MAX && row.hybridCandidates <= CANDIDATE_HARD_MAX),
		finalContextBounded: [result.targetRecall, result.broadRecall].every((row) => row
			&& row.contextChars <= CONTEXT_HARD_MAX),
		rawCandidateLoadsBounded: rawMax <= CANDIDATE_HARD_MAX && eventMax <= EVENT_HARD_MAX,
		productDeleteConverged,
		ftsDeleteConverged: Number(result.final?.episodeFtsTarget ?? -1) === 0
			&& Number(result.final?.manualFtsTarget ?? -1) === 0,
	};
	console.log(`${MARKER}${JSON.stringify(result)}`);

	expect(result.gates.scopeSafe).toBe(true);
	expect(result.gates.finalResultsBounded).toBe(true);
	expect(result.gates.finalContextBounded).toBe(true);
	expect(result.gates.productDeleteConverged).toBe(true);
	expect(result.gates.ftsDeleteConverged).toBe(true);
	expect(result.gates.rawCandidateLoadsBounded).toBe(true);
});
