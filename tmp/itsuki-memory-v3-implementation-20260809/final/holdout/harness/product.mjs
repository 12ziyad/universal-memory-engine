import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { scrubText } from "../../../../../src/pipeline/scrub.js";
import { AnswerModel } from "../../../e2/harness/llm.js";
import {
	ATOMIC_MODEL,
	EVAL_BASE,
	GLOBAL_LOCK,
	OUTPUT,
	PROJECT,
	READER_MODEL,
	assert,
	auditExportSecrets,
	auditExtractionRetryHistory,
	burnSnapshot,
	cohorts,
	d1Select,
	eraseCohort,
	expectedHealth,
	integer,
	request,
	scenarios,
	sealProduct,
	secret,
	semanticFingerprint,
	sha,
	sqlQuote,
	validateFrozenInputs,
	waitReady,
	writeJsonExclusive,
} from "./common.mjs";

const require = createRequire(import.meta.url);
const { requireBenchmarkLockFromEnv } = require("../../../e2/harness/benchmark-lock.cjs");
const REQUEST_TIMEOUT_MS = 300_000;

function sourceMessages(scenario) {
	return scenario.input.messages.map((message, index) => ({
		id: `${scenario.id}:m${index + 1}`,
		role: message.role,
		content: message.content,
		sourceTime: message.sourceTime,
	}));
}

function ingestBody(scenario, seed) {
	return {
		userId: null,
		conversationId: `v3-final-holdout-seed${seed}-${scenario.id}`,
		idempotencyKey: `itsuki-v3:final-holdout:seed${seed}:${scenario.id}`,
		memoryScope: { ...PROJECT },
		flush: true,
		messages: sourceMessages(scenario),
	};
}

async function scenarioDiagnostics(memoryUserId, sourcePacketId) {
	const user = sqlQuote(memoryUserId);
	const packet = sqlQuote(sourcePacketId);
	const project = sqlQuote(PROJECT.projectId);
	const results = await d1Select([
		`SELECT c.id, c.user_id, c.memory_user_id, c.owner_user_id, c.external_user_id,
		 c.project_id, c.project_name, c.capture_run_id, c.extraction_run_id,
		 c.source_episode_id, c.source_packet_id, c.chunk_key, c.source_message_id,
		 c.start_code_point, c.end_code_point, c.evidence_quote, c.evidence_hash,
		 c.dedupe_key, c.atom_type, c.entity, c.entity_type, c.attribute, c.value,
		 c.assertion, c.raw_temporal_phrase, c.cardinality, c.confidence,
		 c.source_time, c.source_time_offset_minutes, c.source_time_precision,
		 c.observed_at, c.extraction_model, c.schema_version, c.status, c.created_at,
		 e.user_id AS episode_user_id, e.memory_user_id AS episode_memory_user_id,
		 e.owner_user_id AS episode_owner_user_id, e.external_user_id AS episode_external_user_id,
		 e.project_id AS episode_project_id, e.source_packet_id AS episode_source_packet_id,
		 e.message_id AS episode_message_id, e.message_index AS episode_message_index,
		 e.role AS episode_role, e.text AS episode_text, e.source_time AS episode_source_time
		 FROM semantic_atom_candidates c
		 JOIN source_episodes e ON e.id = c.source_episode_id AND e.user_id = c.user_id
		 WHERE c.user_id = ${user} AND c.source_packet_id = ${packet} AND c.project_id = ${project}
		 ORDER BY c.capture_run_id, c.source_message_id, c.start_code_point, c.id`,
		`SELECT id, user_id, project_id, source_packet_id, extraction_run_id, chunk_key,
		 status, model, schema_version, attempts, replay_count, proposed_count,
		 accepted_count, stored_count, rejected_count, duplicate_count, truncated,
		 rejected_reasons_json, error_code, created_at, updated_at, completed_at
		 FROM semantic_atom_capture_runs
		 WHERE user_id = ${user} AND source_packet_id = ${packet} AND project_id = ${project}
		 ORDER BY chunk_key`,
		`SELECT id, user_id, memory_user_id, owner_user_id, external_user_id,
		 project_id, project_name, source_packet_id, conversation_id, message_id,
		 message_index, role, text, text_hash, source_time, source_time_offset_minutes,
		 source_time_precision, observed_at, created_at
		 FROM source_episodes
		 WHERE user_id = ${user} AND source_packet_id = ${packet} AND project_id = ${project}
		 ORDER BY message_index`,
		`SELECT r.id, r.user_id, r.status, r.source_packet_id, r.idempotency_key, r.scope_json,
		 r.job_id, r.created_at, r.updated_at,
		 j.user_id AS linked_job_user_id, j.source_packet_id AS linked_job_source_packet_id,
		 j.type AS linked_job_type
		 FROM extraction_runs r
		 LEFT JOIN memory_jobs j ON j.id = r.job_id AND j.user_id = r.user_id
		 WHERE r.user_id = ${user} AND r.source_packet_id = ${packet} ORDER BY r.created_at, r.id`,
		`SELECT p.*, c.status AS candidate_status,
		 c.source_episode_id AS candidate_source_episode_id,
		 c.source_packet_id AS candidate_source_packet_id,
		 c.evidence_quote,
		 COALESCE(s.id, v.id, g.id) AS live_object_id,
		 COALESCE(s.user_id, v.user_id, g.user_id) AS object_user_id,
		 COALESCE(s.project_id, v.project_id, g.project_id) AS object_project_id,
		 COALESCE(s.source_snippet, v.source_snippet, g.source_snippet) AS object_source_snippet
		 FROM semantic_atom_projections p
		 JOIN semantic_atom_candidates c ON c.id = p.candidate_id AND c.user_id = p.user_id
		 LEFT JOIN slices s ON p.object_kind = 'slice' AND s.id = p.object_id AND s.deleted_at IS NULL
		 LEFT JOIN events v ON p.object_kind = 'event' AND v.id = p.object_id AND v.deleted_at IS NULL
		 LEFT JOIN edges g ON p.object_kind = 'edge' AND g.id = p.object_id AND g.deleted_at IS NULL
		 WHERE p.user_id = ${user} AND p.source_packet_id = ${packet} AND p.project_id = ${project}
		 ORDER BY p.candidate_id`,
		`SELECT id, extraction_run_id, outcome, latency_ms,
		 json_extract(detail, '$.atomic_capture_enabled') AS atomic_enabled,
		 json_extract(detail, '$.atomic_capture_outcome') AS atomic_outcome,
		 json_extract(detail, '$.atomic_capture_complete') AS atomic_complete,
		 json_extract(detail, '$.atomic_capture_chunks') AS atomic_chunks,
		 json_extract(detail, '$.atomic_capture_proposed') AS atomic_proposed,
		 json_extract(detail, '$.atomic_capture_accepted') AS atomic_accepted,
		 json_extract(detail, '$.atomic_capture_stored') AS atomic_stored,
		 json_extract(detail, '$.atomic_capture_rejected') AS atomic_rejected,
		 json_extract(detail, '$.atomic_capture_duplicates') AS atomic_duplicates,
		 json_extract(detail, '$.atomic_capture_truncated') AS atomic_truncated,
		 json_extract(detail, '$.atomic_capture_replayed') AS atomic_replayed,
		 json_extract(detail, '$.atomic_capture_latency_ms') AS atomic_latency_ms,
		 json_extract(detail, '$.atomic_projection_enabled') AS projection_enabled,
		 json_extract(detail, '$.atomic_projection_outcome') AS projection_outcome,
		 json_extract(detail, '$.atomic_projection_candidates') AS projection_candidates,
		 json_extract(detail, '$.atomic_projection_promoted') AS projection_promoted,
		 json_extract(detail, '$.atomic_projection_reinforced') AS projection_reinforced,
		 json_extract(detail, '$.atomic_projection_ignored') AS projection_ignored,
		 json_extract(detail, '$.atomic_projection_latency_ms') AS projection_latency_ms
		 FROM receipts WHERE user_id = ${user} AND source_packet_id = ${packet}
		 ORDER BY created_at DESC LIMIT 1`,
	]);
	return {
		candidates: results[0].results ?? [],
		runs: results[1].results ?? [],
		episodes: results[2].results ?? [],
		extractionRuns: results[3].results ?? [],
		projections: results[4].results ?? [],
		receipts: results[5].results ?? [],
		d1Meta: results.map((result) => result.meta),
	};
}

function noSecret(value) {
	return Object.keys(scrubText(String(value ?? "")).redactions ?? {}).length === 0;
}

function expectedEpisode(scenario, index) {
	const message = scenario.input.messages[index];
	return {
		id: `${scenario.id}:m${index + 1}`,
		role: String(message.role).toLowerCase(),
		text: scrubText(String(message.content).trim()).text,
		sourceTime: Date.parse(message.sourceTime),
	};
}

function verifyDiagnostics(scenario, slot, sourcePacketId, diagnostic, ready) {
	const expected = scenario.input.messages.map((_, index) => expectedEpisode(scenario, index));
	assert(diagnostic.episodes.length === expected.length,
		`${scenario.id}: episode conservation ${diagnostic.episodes.length}/${expected.length}`);
	const source = new Map();
	let episodeFailures = 0;
	let acceptedGroundingFailures = 0;
	let acceptedScopeFailures = 0;
	let acceptedSecretFailures = 0;
	for (const [index, episode] of diagnostic.episodes.entries()) {
		const wanted = expected[index];
		const valid = episode.user_id === slot.memoryUserId
			&& episode.memory_user_id === slot.memoryUserId
			&& episode.external_user_id === slot.externalId
			&& episode.project_id === PROJECT.projectId
			&& episode.source_packet_id === sourcePacketId
			&& episode.message_id === wanted.id
			&& integer(episode.message_index) === index
			&& episode.role === wanted.role
			&& episode.text === wanted.text
			&& integer(episode.source_time) === wanted.sourceTime
			&& noSecret(episode.text);
		if (!valid) episodeFailures += 1;
		source.set(episode.message_id, episode);
	}
	assert(episodeFailures === 0, `${scenario.id}: ${episodeFailures} episode provenance/privacy failure(s)`);
	const runIds = new Set(diagnostic.runs.map((run) => run.id));
	for (const candidate of diagnostic.candidates) {
		const episode = source.get(candidate.source_message_id);
		const exact = Array.from(String(episode?.text ?? ""))
			.slice(integer(candidate.start_code_point), integer(candidate.end_code_point)).join("");
		if (!episode || episode.role !== "user" || candidate.evidence_quote !== exact
			|| candidate.source_episode_id !== episode.id || candidate.episode_message_id !== candidate.source_message_id) {
			acceptedGroundingFailures += 1;
		}
		if (candidate.user_id !== slot.memoryUserId || candidate.memory_user_id !== slot.memoryUserId
			|| candidate.external_user_id !== slot.externalId || candidate.project_id !== PROJECT.projectId
			|| candidate.source_packet_id !== sourcePacketId || candidate.episode_user_id !== slot.memoryUserId
			|| candidate.episode_project_id !== PROJECT.projectId || !runIds.has(candidate.capture_run_id)) {
			acceptedScopeFailures += 1;
		}
		const semantic = [candidate.entity, candidate.attribute, candidate.value, candidate.assertion,
			candidate.evidence_quote, candidate.raw_temporal_phrase].filter(Boolean).join(" ");
		if (!noSecret(semantic)) acceptedSecretFailures += 1;
		assert(candidate.extraction_model === ATOMIC_MODEL, `${scenario.id}: atomic model identity changed`);
	}
	assert(acceptedGroundingFailures === 0, `${scenario.id}: accepted candidate lost exact provenance`);
	assert(acceptedScopeFailures === 0, `${scenario.id}: accepted candidate crossed scope`);
	assert(acceptedSecretFailures === 0, `${scenario.id}: secret survived in accepted candidate`);
	let accountingFailures = 0;
	for (const run of diagnostic.runs) {
		const candidateCount = diagnostic.candidates.filter((candidate) => candidate.capture_run_id === run.id).length;
		const accepted = integer(run.accepted_count);
		const stored = integer(run.stored_count);
		const duplicates = integer(run.duplicate_count);
		const rejected = integer(run.rejected_count);
		const proposed = integer(run.proposed_count);
		const databaseDuplicates = accepted - stored;
		const localDuplicates = duplicates - databaseDuplicates;
		if (stored !== candidateCount || databaseDuplicates < 0 || localDuplicates < 0
			|| proposed !== accepted + rejected + localDuplicates) accountingFailures += 1;
	}
	assert(accountingFailures === 0, `${scenario.id}: atomic accounting conservation failed`);
	assert(new Set(diagnostic.candidates.map((row) => row.id)).size === diagnostic.candidates.length,
		`${scenario.id}: duplicate candidate ids`);
	const extractionHistory = auditExtractionRetryHistory(diagnostic.extractionRuns, {
		userId: slot.memoryUserId,
		sourcePacketId,
		jobAttempts: ready?.attempts,
	});
	assert(extractionHistory.pass, `${scenario.id}: invalid bounded extraction retry history`);
	assert(diagnostic.receipts.length === 1, `${scenario.id}: extraction receipt missing`);
	const receipt = diagnostic.receipts[0];
	const sums = diagnostic.runs.reduce((value, run) => ({
		chunks: value.chunks + 1,
		proposed: value.proposed + integer(run.proposed_count),
		accepted: value.accepted + integer(run.accepted_count),
		stored: value.stored + integer(run.stored_count),
		rejected: value.rejected + integer(run.rejected_count),
		duplicates: value.duplicates + integer(run.duplicate_count),
		truncated: value.truncated + integer(run.truncated),
	}), { chunks: 0, proposed: 0, accepted: 0, stored: 0, rejected: 0, duplicates: 0, truncated: 0 });
	const receiptConserved = integer(receipt.atomic_enabled) === 1
		&& integer(receipt.atomic_chunks) === sums.chunks
		&& integer(receipt.atomic_proposed) === sums.proposed
		&& integer(receipt.atomic_accepted) === sums.accepted
		&& integer(receipt.atomic_stored) === sums.stored
		&& integer(receipt.atomic_rejected) === sums.rejected
		&& integer(receipt.atomic_duplicates) === sums.duplicates
		&& integer(receipt.atomic_truncated) === sums.truncated;
	assert(receiptConserved, `${scenario.id}: receipt/run accounting mismatch`);
	assert(diagnostic.projections.length === diagnostic.candidates.length,
		`${scenario.id}: projection/candidate count mismatch`);
	const candidates = new Map(diagnostic.candidates.map((candidate) => [candidate.id, candidate]));
	const snippetsByObject = new Map();
	const outcomes = { promoted: 0, reinforced: 0, ignored: 0 };
	for (const projection of diagnostic.projections) {
		const candidate = candidates.get(projection.candidate_id);
		assert(candidate && projection.user_id === slot.memoryUserId && projection.project_id === PROJECT.projectId
			&& projection.source_episode_id === candidate.source_episode_id
			&& projection.source_packet_id === candidate.source_packet_id
			&& projection.candidate_source_episode_id === candidate.source_episode_id
			&& projection.candidate_source_packet_id === candidate.source_packet_id
			&& ["promoted", "reinforced", "ignored"].includes(projection.outcome),
		`${scenario.id}: projection ledger provenance failed`);
		const expectedStatus = projection.outcome === "ignored" ? "ignored" : "promoted";
		assert(projection.candidate_status === expectedStatus, `${scenario.id}: candidate terminal status mismatch`);
		outcomes[projection.outcome] += 1;
		if (projection.outcome === "ignored") {
			assert(projection.object_kind == null && projection.object_id == null,
				`${scenario.id}: ignored projection carries semantic object`);
		} else {
			assert(projection.object_id && projection.live_object_id === projection.object_id
				&& projection.object_user_id === slot.memoryUserId
				&& projection.object_project_id === PROJECT.projectId,
			`${scenario.id}: projection semantic object missing/cross-scope`);
			const key = `${projection.object_kind}:${projection.object_id}`;
			const value = snippetsByObject.get(key) ?? { snippet: projection.object_source_snippet, quotes: [] };
			value.quotes.push(candidate.evidence_quote);
			snippetsByObject.set(key, value);
		}
	}
	for (const [object, value] of snippetsByObject) {
		assert(value.quotes.includes(value.snippet), `${scenario.id}: ${object} source snippet is not candidate-grounded`);
	}
	const projectionConserved = integer(receipt.projection_enabled) === 1
		&& integer(receipt.projection_candidates) === diagnostic.projections.length
		&& integer(receipt.projection_promoted) === outcomes.promoted
		&& integer(receipt.projection_reinforced) === outcomes.reinforced
		&& integer(receipt.projection_ignored) === outcomes.ignored;
	assert(projectionConserved, `${scenario.id}: projection receipt accounting mismatch`);
	return {
		episodeFailures,
		acceptedGroundingFailures,
		acceptedScopeFailures,
		acceptedSecretFailures,
		accountingFailures,
		extractionRunCount: extractionHistory.runCount,
		extractionRunFailures: extractionHistory.failureCount,
		extractionRetryRecovered: extractionHistory.recovered,
		extractionRunIdentityValid: extractionHistory.pass,
		receiptConserved,
		projectionConserved,
		provenanceConserved: true,
		sums,
		outcomes,
		atomicLatencyMs: Number(receipt.atomic_latency_ms ?? 0),
		projectionLatencyMs: Number(receipt.projection_latency_ms ?? 0),
		runValidity: diagnostic.runs.length > 0
			&& diagnostic.runs.every((run) => ["completed", "empty"].includes(run.status)),
	};
}

async function ingestOne(token, scenario, slot, seed) {
	await burnSnapshot(`StageD:seed${seed}:${scenario.id}:before-ingest`, 2_000);
	const body = ingestBody(scenario, seed);
	body.userId = slot.externalId;
	const response = await request(token, "POST", "/v1/ingest", {
		body, attempts: 3, timeoutMs: REQUEST_TIMEOUT_MS,
	});
	assert(response.ok && response.body?.ok === true,
		`ingest(seed${seed}/${scenario.id}) -> ${response.status} ${response.body?.code ?? "not_ok"}`);
	const sourcePacketId = response.body.source_packet_id;
	const jobId = response.body.job_id;
	assert(sourcePacketId && jobId, `${scenario.id}: accepted response omitted packet/job id`);
	assert(integer(response.body.source_episodes_written) === scenario.input.messages.length,
		`${scenario.id}: accepted episode write mismatch`);
	const ready = await waitReady(token, slot.externalId, jobId);
	assert(ready.status !== "failed" && !ready.cancelledByDelete && ready.projectId === PROJECT.projectId,
		`${scenario.id}: primary extraction job invalid (${ready.error ?? "unknown"})`);
	const diagnostic = await scenarioDiagnostics(slot.memoryUserId, sourcePacketId);
	const integrity = verifyDiagnostics(scenario, slot, sourcePacketId, diagnostic, ready);
	return {
		scenarioId: scenario.id,
		inputSha256: scenario.inputSha256,
		tenantSlot: scenario.index + 1,
		externalId: slot.externalId,
		memoryUserId: slot.memoryUserId,
		sourcePacketId,
		jobId,
		requestLatencyMs: response.elapsedMs,
		ready,
		...diagnostic,
		integrity,
	};
}

function replayIdentity(diagnostic) {
	return {
		candidateIds: diagnostic.candidates.map((row) => row.id),
		captureRunIds: diagnostic.runs.map((row) => row.id),
		extractionRunIds: diagnostic.extractionRuns.map((row) => row.id),
		episodeIds: diagnostic.episodes.map((row) => row.id),
		projections: diagnostic.projections.map((row) => [row.candidate_id, row.outcome, row.object_kind, row.object_id]),
		accounting: diagnostic.runs.map((row) => [row.id, row.proposed_count, row.accepted_count,
			row.stored_count, row.rejected_count, row.duplicate_count, row.status]),
	};
}

async function proveReplay(token, scenario, slot, seed, original) {
	const before = await scenarioDiagnostics(slot.memoryUserId, original.sourcePacketId);
	const body = ingestBody(scenario, seed);
	body.userId = slot.externalId;
	const response = await request(token, "POST", "/v1/ingest", {
		body, attempts: 2, timeoutMs: REQUEST_TIMEOUT_MS,
	});
	assert(response.ok && response.body?.ok === true, `replay(seed${seed}/${scenario.id}) failed ${response.status}`);
	assert(response.body.source_packet_id === original.sourcePacketId, "replay changed source packet identity");
	assert(response.body.job_id === original.jobId, "replay changed durable job identity");
	const after = await scenarioDiagnostics(slot.memoryUserId, original.sourcePacketId);
	assert(JSON.stringify(replayIdentity(before)) === JSON.stringify(replayIdentity(after)),
		"replay changed durable atomic/projection/source identity");
	return {
		httpStatus: response.status,
		sourcePacketStable: true,
		jobStable: true,
		candidateRowsAdded: 0,
		captureRunsAdded: 0,
		extractionRunsAdded: 0,
		episodeRowsAdded: 0,
		projectionRowsAdded: 0,
		identitySha256: sha(JSON.stringify(replayIdentity(after))),
		requestLatencyMs: response.elapsedMs,
	};
}

async function exportOne(token, scenario, slot) {
	const response = await request(token, "GET", "/v1/export", { query: { userId: slot.externalId } });
	assert(response.ok && response.body, `export(${scenario.id}) -> ${response.status}`);
	const secretAudit = auditExportSecrets(response.body);
	assert(secretAudit.pass, `${scenario.id}: secret survived export`);
	assert(response.body.user_id === slot.memoryUserId, `${scenario.id}: export tenant mismatch`);
	return {
		scenarioId: scenario.id,
		payload: response.body,
		secretAudit,
		serializedBytes: Buffer.byteLength(JSON.stringify(response.body), "utf8"),
	};
}

function boundedTelemetry(body) {
	return {
		present: Object.prototype.hasOwnProperty.call(body, "bounded_recall_corpus_used"),
		used: body.bounded_recall_corpus_used === true,
		failures: integer(body.bounded_recall_failures),
		queryTerms: body.bounded_recall_query_terms ?? [],
		laneCounts: body.bounded_recall_lane_counts ?? {},
		corpusCounts: body.bounded_recall_corpus_counts ?? {},
	};
}

function verifyBoundedRecall(questionId, bounded) {
	assert(bounded.present && bounded.used && bounded.failures === 0,
		`${questionId}: D13 bounded recall inactive/failed`);
	assert(Object.values(bounded.laneCounts).every((value) => integer(value) <= 200),
		`${questionId}: bounded lane exceeded 200`);
	const c = bounded.corpusCounts;
	assert(integer(c.nodes) <= 600 && integer(c.pages) <= 200 && integer(c.slices) <= 2400
		&& integer(c.events) <= 4000 && integer(c.edges) <= 600,
	`${questionId}: bounded corpus cap failed`);
}

async function recallOne(token, slot, questionId, question) {
	const response = await request(token, "POST", "/v1/recall", {
		body: {
			userId: slot.externalId,
			query: question,
			limit: 200,
			recallScope: "project_only",
			memoryScope: { ...PROJECT },
		},
	});
	assert(response.ok && response.body?.ok === true, `recall(${questionId}) -> ${response.status}`);
	const body = response.body;
	const sourceExpansion = {
		present: Object.prototype.hasOwnProperty.call(body, "source_expansion_used"),
		used: body.source_expansion_used === true,
		assertions: integer(body.source_expansion_assertions),
		linkedAssertions: integer(body.source_expansion_linked_assertions),
		episodes: integer(body.source_expansion_episodes),
		chars: integer(body.source_expansion_chars),
		latencyMs: Number(body.source_expansion_ms ?? 0),
		failed: body.source_expansion_failed === true,
	};
	assert(sourceExpansion.present && sourceExpansion.used && !sourceExpansion.failed,
		`${questionId}: accepted E9A source expansion inactive/failed`);
	const context = String(body.context ?? "");
	const sourceRendered = context.split("\n").filter((line) => line.startsWith("Source evidence [")).length;
	assert(sourceRendered === sourceExpansion.episodes, `${questionId}: source rendering/accounting mismatch`);
	const bounded = boundedTelemetry(body);
	verifyBoundedRecall(questionId, bounded);
	const itemCount = integer(body.count ?? body.items?.length);
	assert(itemCount <= 200 && context.length <= 24_000, `${questionId}: final evidence/context bound failed`);
	assert(body.rerank_used !== true, `${questionId}: rejected reranker became active`);
	assert(!Object.prototype.hasOwnProperty.call(body, "adaptive_context_used"),
		`${questionId}: rejected adaptive context became active`);
	return {
		context,
		items: body.items ?? [],
		itemCount,
		serverLatencyMs: Number(body.recall_latency_ms ?? 0),
		clientLatencyMs: response.elapsedMs,
		sourceExpansion,
		bounded,
	};
}

async function runSeed(seed) {
	validateFrozenInputs();
	const productFile = path.join(OUTPUT, `seed${seed}.product.json`);
	const sealFile = path.join(OUTPUT, `seed${seed}.product.seal.json`);
	const exportFile = path.join(OUTPUT, `seed${seed}.exports.json`);
	assert(!fs.existsSync(productFile) && !fs.existsSync(sealFile) && !fs.existsSync(exportFile),
		`seed${seed}: product artifact already exists`);
	const health = await expectedHealth();
	const burnBefore = await burnSnapshot(`StageD:seed${seed}:start`, 3_000);
	const token = secret("ITSUKI_API_KEY");
	const evalKey = secret("API_KEY");
	console.log("ITSUKI_API_KEY: LOADED");
	console.log("eval-door key: LOADED");
	const model = new AnswerModel({ apiKey: evalKey, model: READER_MODEL });
	assert(model.maxTokens === 1024 && model.temperature === 0, "reader protocol changed");
	const data = scenarios();
	const slots = cohorts().treatment;
	const preclean = await eraseCohort(token, slots);
	const ingests = [];
	for (const scenario of data) {
		ingests.push(await ingestOne(token, scenario, slots[scenario.index], seed));
		console.log(`seed${seed}/${scenario.id}: candidates=${ingests.at(-1).candidates.length} projections=${ingests.at(-1).projections.length}`);
	}
	const replay = await proveReplay(token, data[0], slots[0], seed, ingests[0]);
	const exports = [];
	for (const scenario of data) exports.push(await exportOne(token, scenario, slots[scenario.index]));
	writeJsonExclusive(exportFile, {
		schema: "itsuki.v3-final-holdout-exports/v1",
		seed,
		scenarios: exports,
	});
	const fingerprint = await semanticFingerprint(slots);
	const expectedEpisodes = data.reduce((sum, scenario) => sum + scenario.input.messages.length, 0);
	const expectedCandidates = ingests.reduce((sum, row) => sum + row.candidates.length, 0);
	assert(fingerprint.counts.episodes === expectedEpisodes, `seed${seed}: episode fingerprint mismatch`);
	assert(fingerprint.counts.candidates === expectedCandidates
		&& fingerprint.counts.projections === expectedCandidates,
	`seed${seed}: candidate/projection fingerprint mismatch`);
	const answers = [];
	for (const scenario of data) {
		const slot = slots[scenario.index];
		for (const question of scenario.questions) {
			const questionId = `${scenario.id}#${question.id}`;
			const recall = await recallOne(token, slot, questionId, question.q);
			await burnSnapshot(`StageD:seed${seed}:${questionId}:reader`, 1_500);
			const generated = await model.answer({
				sampleId: scenario.id,
				speakerA: "the user",
				speakerB: "the assistant",
				question: { question: question.q, category: question.category === "temporal" ? 2 : 4, reference: "" },
				context: recall.context,
			});
			assert(!generated.error, `seed${seed}/${questionId}: reader error ${generated.error}`);
			answers.push({
				scenarioId: scenario.id,
				questionId,
				question: question.q,
				category: question.category,
				retrieval: {
					context: recall.context,
					items: recall.items,
					itemCount: recall.itemCount,
					contextLines: recall.context ? recall.context.split("\n").length : 0,
					contextChars: recall.context.length,
					contextTokensApprox: Math.ceil(recall.context.length / 4),
					serverLatencyMs: recall.serverLatencyMs,
					clientLatencyMs: recall.clientLatencyMs,
					sourceExpansion: recall.sourceExpansion,
					bounded: recall.bounded,
				},
				answer: {
					text: generated.answer,
					raw: generated.rawAnswer,
					model: model.model,
					temperature: model.temperature,
					maxTokens: model.maxTokens,
					promptChars: generated.promptChars,
					latencyMs: generated.latencyMs,
				},
			});
		}
		console.log(`seed${seed}/${scenario.id}: ${scenario.questions.length} answers`);
	}
	const afterRead = await semanticFingerprint(slots);
	assert(afterRead.sha256 === fingerprint.sha256, `seed${seed}: read path mutated semantic state`);
	const burnAfter = await burnSnapshot(`StageD:seed${seed}:sealed-boundary`, 1_000);
	const artifact = {
		schema: "itsuki.v3-final-holdout-product/v1",
		seed,
		createdAt: new Date().toISOString(),
		frozen: validateFrozenInputs(),
		fixed: {
			atomicModel: ATOMIC_MODEL,
			projection: true,
			coalescing: false,
			recallLimit: 200,
			hybridRetrieval: true,
			sourceExpansion: true,
			reranker: false,
			episodeFallback: false,
			adaptiveContext: false,
			reader: READER_MODEL,
			answerMaxTokens: 1024,
			project: PROJECT,
			provider: "direct_first_party_workers_ai_binding",
		},
		health,
		preclean,
		ingests,
		replay,
		exportsSha256: sha(fs.readFileSync(exportFile)),
		stateFingerprint: fingerprint,
		afterReadFingerprint: afterRead,
		answers,
		burnBefore,
		burnAfter,
		neuronDeltaObserved: burnAfter.spent - burnBefore.spent,
	};
	writeJsonExclusive(productFile, artifact);
	sealProduct(productFile, sealFile, { seed, answers: answers.length, scenarios: ingests.length,
		stateSha256: fingerprint.sha256 });
	console.log(`Stage D seed${seed}: PRODUCT SEALED answers=${answers.length}`);
}

async function cleanupSeed(seed) {
	const file = path.join(OUTPUT, `seed${seed}.cleanup.json`);
	assert(!fs.existsSync(file), `seed${seed}: cleanup artifact already exists`);
	const token = secret("ITSUKI_API_KEY");
	console.log("ITSUKI_API_KEY: LOADED");
	const result = await eraseCohort(token, cohorts().treatment);
	const fingerprint = await semanticFingerprint(cohorts().treatment);
	assert(Object.entries(fingerprint.counts).every(([key, value]) => key === "nonTerminalJobs" || value === 0),
		`seed${seed}: cleanup fingerprint not empty: ${JSON.stringify(fingerprint.counts)}`);
	writeJsonExclusive(file, {
		schema: "itsuki.v3-final-holdout-cleanup/v1",
		seed,
		cleanedAt: new Date().toISOString(),
		result,
		fingerprint,
		dirty: 0,
	});
	console.log(`Stage D seed${seed}: cleanup zero across 10 slots`);
}

async function main() {
	requireBenchmarkLockFromEnv();
	assert(process.env.BENCHMARK_LOCK_DIR === GLOBAL_LOCK, "wrong benchmark lock path");
	fs.mkdirSync(OUTPUT, { recursive: true });
	const command = process.argv[2];
	const seed = Number(process.argv[3]);
	assert([1, 2, 3].includes(seed), "seed must be 1, 2, or 3");
	if (command === "run") return runSeed(seed);
	if (command === "cleanup") return cleanupSeed(seed);
	throw new Error("usage: product.mjs <run|cleanup> <seed>");
}

main().catch((error) => {
	console.error(`STAGE D PRODUCT STOPPED: ${error.stack ?? error}`);
	process.exit(1);
});
