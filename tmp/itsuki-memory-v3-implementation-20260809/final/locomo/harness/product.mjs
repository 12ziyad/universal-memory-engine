import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { scrubText } from "../../../../../src/pipeline/scrub.js";
import { AnswerModel } from "../../../e2/harness/llm.js";
import {
	ANSWER_BLOCK,
	ATOMIC_MODEL,
	GLOBAL_LOCK,
	INPUT,
	OUTPUT,
	PREREGISTRATION,
	PROJECT,
	READER_MODEL,
	assert,
	assertCleanCohort,
	appendJsonl,
	burnSnapshot,
	cohorts,
	d1Select,
	expectedHealthActive,
	integer,
	pool,
	productInputs,
	readJson,
	readJsonl,
	request,
	sealProduct,
	secret,
	sha,
	shaFile,
	sqlQuote,
	validateProductInputs,
	waitReady,
	writeJsonAtomic,
	writeJsonExclusive,
} from "./common.mjs";
import { classifySourceEpisodeAcknowledgement } from "./ingest-response.mjs";
import { overlayContainmentRebuild } from "./rebuild-ledger.mjs";
import { reconcileRetryAwareState } from "./state-accounting.mjs";

const require = createRequire(import.meta.url);
const { requireBenchmarkLockFromEnv } = require("../../../e2/harness/benchmark-lock.cjs");

const PROGRESS = path.join(OUTPUT, "product-progress.json");
const INGEST_LEDGER = path.join(OUTPUT, "product-ingest.jsonl");
const REBUILD_LEDGER = path.join(OUTPUT, "product-ingest-rebuild-conv-43-attempt-002.jsonl");
const CONTAINMENT = path.join(OUTPUT, "V3-D15-CONTAINMENT.json");
const ANSWER_LEDGER = path.join(OUTPUT, "product-answers.jsonl");
const PRODUCT = path.join(OUTPUT, "product.json");
const SEAL = path.join(OUTPUT, "product.seal.json");
const CLEANUP = path.join(OUTPUT, "cleanup.json");
const STATE_AUDIT = path.join(OUTPUT, "state-audit.json");
const REQUEST_TIMEOUT_MS = 300_000;
const SAMPLE_CONCURRENCY = 5;
const QUESTION_CONCURRENCY = 4;
const TERMINAL = new Set(["enriched", "failed", "completed"]);

function stageStart() {
	const value = Number(process.env.STAGE_E_START_SPENT);
	assert(Number.isInteger(value) && value >= 0, "STAGE_E_START_SPENT is required");
	return value;
}

function noSecret(value) {
	return Object.keys(scrubText(String(value ?? "")).redactions ?? {}).length === 0;
}

function cleanWouldDelete(value) {
	return value && typeof value === "object"
		&& Object.values(value).every((count) => integer(count) === 0);
}

async function eraseFinalCohort(token, slots) {
	// A complete Stage E tenant can take longer than the generic harness's
	// 90-second request window to erase. The confirmed delete is idempotent and
	// product-fenced; wait for that same operation rather than substituting a
	// schema repair or treating a client timeout as a failed remote delete.
	const rows = await pool(slots, 3, async (slot) => {
		const dry = await request(token, "DELETE", "/v1/memories", {
			query: { userId: slot.externalId },
		});
		const confirmed = await request(token, "DELETE", "/v1/memories", {
			query: { userId: slot.externalId, confirm: "true" },
			attempts: 1,
			timeoutMs: 300_000,
		});
		assert(dry.ok && confirmed.ok,
			`final erase(${slot.externalId}) failed ${dry.status}/${confirmed.status}`);
		const residue = await request(token, "DELETE", "/v1/memories", {
			query: { userId: slot.externalId },
		});
		const jobs = await request(token, "GET", "/v1/jobs", {
			query: { userId: slot.externalId, limit: 200 },
		});
		assert(residue.ok && jobs.ok, `final erase verification(${slot.externalId}) failed`);
		return {
			dry: dry.body?.would_delete ?? null,
			deleted: confirmed.body?.deleted ?? null,
			residue: residue.body?.would_delete ?? null,
			residueClean: cleanWouldDelete(residue.body?.would_delete ?? {}),
			nonTerminalJobs: (jobs.body?.jobs ?? []).filter((job) => !TERMINAL.has(job.status)).length,
		};
	});
	assert(rows.every((row) => row.residueClean && row.nonTerminalJobs === 0),
		"final API erasure did not converge");
	return { rows, clean: true };
}

function atomicEvidenceSnippet(value) {
	return Array.from(String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim())
		.slice(0, 240).join("").slice(0, 240);
}

function planBatches(session) {
	const batches = [];
	let current = [];
	let characters = 0;
	for (const message of session.messages) {
		const chars = [...message.content].length;
		assert(chars > 0 && chars <= 4_000, `message ${message.id} violates character bounds`);
		if (current.length >= 30 || (current.length > 0 && characters + chars > 120_000)) {
			batches.push(current);
			current = [];
			characters = 0;
		}
		current.push(message);
		characters += chars;
	}
	if (current.length) batches.push(current);
	assert(batches.length > 0 && batches.every((batch) => batch.length <= 30),
		`session ${session.index}: invalid deterministic wire plan`);
	assert(batches.flat().map((message) => message.id).join("\0")
		=== session.messages.map((message) => message.id).join("\0"),
	`session ${session.index}: deterministic coverage changed`);
	return batches;
}

function dryRun() {
	const frozen = validateProductInputs();
	const data = productInputs();
	let batches = 0;
	let messages = 0;
	let splitSessions = 0;
	for (const sample of data.samples) {
		for (const session of sample.sessions) {
			const plan = planBatches(session);
			batches += plan.length;
			messages += plan.flat().length;
			if (plan.length > 1) splitSessions += 1;
		}
	}
	assert(messages === 5_882 && batches >= 272, "dry-run accounting changed");
	return {
		schema: "itsuki.v3-stage-e-dry-run/v1",
		frozen,
		productInputSha256: shaFile(INPUT),
		preregistrationSha256: shaFile(PREREGISTRATION),
		sessions: 272,
		messages,
		batches,
		splitSessions,
		questions: 1_540,
		maxMessagesPerBatch: 30,
		maxCharactersPerBatch: 120_000,
		referenceBlind: true,
	};
}

function ingestKey(sampleId, sessionIndex) {
	return `${sampleId}:s${sessionIndex}`;
}

function assertIngestLedger(rows, data) {
	const expected = new Map();
	for (const sample of data.samples) {
		for (const session of sample.sessions) expected.set(ingestKey(sample.sampleId, session.index), { sample, session });
	}
	const seen = new Set();
	for (const row of rows) {
		const key = ingestKey(row.sampleId, row.sessionIndex);
		assert(expected.has(key) && !seen.has(key), `inconsistent ingest ledger row ${key}`);
		seen.add(key);
		const { session } = expected.get(key);
		const batches = planBatches(session);
		assert(row.inputSha256 === sha(JSON.stringify(session)) && row.batches?.length === batches.length,
			`${key}: ingest ledger input/plan mismatch`);
		assert(row.batches.every((batch, index) => batch.batchIndex === index
			&& batch.messageIds.join("\0") === batches[index].map((message) => message.id).join("\0")
			&& batch.sourcePacketId && batch.jobId && batch.accepted === true
			&& TERMINAL.has(batch.ready?.status) && batch.ready?.status !== "failed"),
		`${key}: ingest ledger outcome mismatch`);
	}
	for (const sample of data.samples) {
		const completed = new Set(rows.filter((row) => row.sampleId === sample.sampleId)
			.map((row) => row.sessionIndex));
		let gap = false;
		for (const session of sample.sessions) {
			if (!completed.has(session.index)) gap = true;
			else assert(!gap, `${sample.sampleId}: completed session appears after an ingest gap`);
		}
	}
	return { expected, seen };
}

function effectiveIngestLedger(data) {
	const historical = readJsonl(INGEST_LEDGER);
	assertIngestLedger(historical, data);
	const rebuildRequired = fs.existsSync(CONTAINMENT);
	const rebuild = readJsonl(REBUILD_LEDGER);
	const merged = overlayContainmentRebuild({
		historicalRows: historical,
		rebuildRows: rebuild,
		required: rebuildRequired,
	});
	const checked = assertIngestLedger(merged, data);
	assert(checked.seen.size === 272, `effective ingest ledger ${checked.seen.size}/272 sessions`);
	return merged;
}

async function ingestSession(token, sample, session, slot, start) {
	await burnSnapshot(`StageE:${sample.sampleId}:s${session.index}:ingest`, 7_500, start);
	const plan = planBatches(session);
	const accepted = [];
	for (const [batchIndex, messages] of plan.entries()) {
		const response = await request(token, "POST", "/v1/ingest", {
			body: {
				userId: slot.externalId,
				conversationId: `v3-final-locomo-${sample.sampleId}-session-${session.index}`,
				idempotencyKey: `itsuki-v3:final-locomo:${sample.sampleId}:s${session.index}:b${batchIndex}`,
				memoryScope: { ...PROJECT },
				flush: batchIndex === plan.length - 1,
				messages: messages.map((message) => ({ ...message })),
			},
			attempts: 3,
			timeoutMs: REQUEST_TIMEOUT_MS,
		});
		assert(response.ok && response.body?.ok === true,
			`ingest(${sample.sampleId}/s${session.index}/b${batchIndex}) -> ${response.status} ${response.body?.code ?? "not_ok"}`);
		assert(response.body.source_packet_id && response.body.job_id,
			`${sample.sampleId}/s${session.index}/b${batchIndex}: accepted response omitted packet/job`);
		const episodeAcknowledgement = classifySourceEpisodeAcknowledgement(response.body, messages.length);
		accepted.push({
			batchIndex,
			messageIds: messages.map((message) => message.id),
			messages: messages.length,
			flush: batchIndex === plan.length - 1,
			accepted: true,
			httpStatus: response.status,
			sourcePacketId: response.body.source_packet_id,
			jobId: response.body.job_id,
			fired: response.body.fired === true,
			held: integer(response.body.held),
			sourceEpisodesWritten: episodeAcknowledgement.reported,
			sourceEpisodeConservation: episodeAcknowledgement.mode,
			requestLatencyMs: response.elapsedMs,
		});
	}
	// The final flush owns chronology. Wait for it first, then prove every held
	// handoff from the same session also reached a non-failed terminal state.
	const finalReady = await waitReady(token, slot.externalId, accepted.at(-1).jobId);
	assert(finalReady.status !== "failed" && !finalReady.cancelledByDelete
		&& finalReady.projectId === PROJECT.projectId,
	`${sample.sampleId}/s${session.index}: final extraction invalid (${finalReady.error ?? "unknown"})`);
	for (const batch of accepted) {
		batch.ready = batch.jobId === accepted.at(-1).jobId
			? finalReady
			: await waitReady(token, slot.externalId, batch.jobId);
		assert(batch.ready.status !== "failed" && !batch.ready.cancelledByDelete
			&& batch.ready.projectId === PROJECT.projectId,
		`${sample.sampleId}/s${session.index}/b${batch.batchIndex}: extraction invalid`);
	}
	return {
		schema: "itsuki.v3-stage-e-ingest-session/v1",
		sampleId: sample.sampleId,
		sessionIndex: session.index,
		inputSha256: sha(JSON.stringify(session)),
		messages: session.messages.length,
		batches: accepted,
		completedAt: new Date().toISOString(),
	};
}

async function ingestAll(token, data, slots, start) {
	let ledger = readJsonl(INGEST_LEDGER);
	assertIngestLedger(ledger, data);
	const done = new Set(ledger.map((row) => ingestKey(row.sampleId, row.sessionIndex)));
	await pool(data.samples, SAMPLE_CONCURRENCY, async (sample, sampleIndex) => {
		for (const session of sample.sessions) {
			const key = ingestKey(sample.sampleId, session.index);
			if (done.has(key)) continue;
			const row = await ingestSession(token, sample, session, slots[sampleIndex], start);
			appendJsonl(INGEST_LEDGER, row);
			done.add(key);
			console.log(`INGEST ${done.size}/272 ${sample.sampleId} s${session.index} messages=${row.messages} batches=${row.batches.length}`);
		}
	});
	ledger = readJsonl(INGEST_LEDGER);
	const checked = assertIngestLedger(ledger, data);
	assert(checked.seen.size === 272, `ingest did not reconcile 272 sessions (${checked.seen.size})`);
	assert(ledger.reduce((sum, row) => sum + row.messages, 0) === 5_882,
		"ingest did not reconcile 5,882 messages");
	return effectiveIngestLedger(data);
}

function packetIdsFor(sampleId, ingests) {
	return ingests.filter((row) => row.sampleId === sampleId)
		.flatMap((row) => row.batches.map((batch) => batch.sourcePacketId));
}

function expectedEpisodes(sample, ingests) {
	const packets = new Map();
	for (const row of ingests.filter((entry) => entry.sampleId === sample.sampleId)) {
		for (const batch of row.batches) for (const id of batch.messageIds) packets.set(id, batch.sourcePacketId);
	}
	return new Map(sample.sessions.flatMap((session) => session.messages.map((message, index) => {
		const scrubbed = scrubText(message.content).text;
		return [message.id, {
			text: scrubbed,
			role: message.role,
			sourceTime: Date.parse(`${message.sourceTime}T00:00:00Z`),
			sourcePacketId: packets.get(message.id),
			sessionIndex: session.index,
			messageIndexWithinSession: index,
		}];
	})));
}

async function collectSampleState(sample, slot, ingests) {
	const user = sqlQuote(slot.memoryUserId);
	const project = sqlQuote(PROJECT.projectId);
	const packetIds = packetIdsFor(sample.sampleId, ingests);
	assert(packetIds.length > 0, `${sample.sampleId}: no accepted packets`);
	const packetList = packetIds.map(sqlQuote).join(",");
	const results = await d1Select([
		`SELECT rowid AS fts_rowid, id, user_id, memory_user_id, external_user_id,
		 project_id, source_packet_id, conversation_id, message_id, message_index,
		 role, text, text_hash, source_time, source_time_precision, observed_at
		 FROM source_episodes WHERE user_id=${user} AND project_id=${project}
		 ORDER BY source_time, source_packet_id, message_index, id`,
		`SELECT id, user_id, memory_user_id, external_user_id, project_id,
		 capture_run_id, extraction_run_id, source_episode_id, source_packet_id,
		 chunk_key, source_message_id, start_code_point, end_code_point,
		 evidence_quote, evidence_hash, dedupe_key, atom_type, entity_type,
		 attribute, assertion, raw_temporal_phrase, source_time,
		 source_time_precision, extraction_model, schema_version, status
		 FROM semantic_atom_candidates WHERE user_id=${user} AND project_id=${project}
		 ORDER BY capture_run_id, source_message_id, start_code_point, id`,
		`SELECT id, source_packet_id, extraction_run_id, chunk_key, status, model,
		 schema_version, attempts, replay_count, proposed_count, accepted_count,
		 stored_count, rejected_count, duplicate_count, truncated, error_code
		 FROM semantic_atom_capture_runs WHERE user_id=${user} AND project_id=${project}
		 ORDER BY source_packet_id, chunk_key, id`,
		`SELECT p.candidate_id, p.user_id, p.project_id, p.source_episode_id,
		 p.source_packet_id, p.outcome, p.object_kind, p.object_id, p.schema_version,
		 p.extraction_run_id AS projection_extraction_run_id,
		 c.status AS candidate_status,
		 COALESCE(s.id,v.id,g.id) AS live_object_id,
		 COALESCE(s.user_id,v.user_id,g.user_id) AS object_user_id,
		 COALESCE(s.project_id,v.project_id,g.project_id) AS object_project_id,
		 COALESCE(s.source_snippet,v.source_snippet,g.source_snippet) AS object_source_snippet
		 FROM semantic_atom_projections p
		 JOIN semantic_atom_candidates c ON c.id=p.candidate_id AND c.user_id=p.user_id
		 LEFT JOIN slices s ON p.object_kind='slice' AND s.id=p.object_id AND s.deleted_at IS NULL
		 LEFT JOIN events v ON p.object_kind='event' AND v.id=p.object_id AND v.deleted_at IS NULL
		 LEFT JOIN edges g ON p.object_kind='edge' AND g.id=p.object_id AND g.deleted_at IS NULL
		 WHERE p.user_id=${user} AND p.project_id=${project}
		 ORDER BY p.candidate_id`,
		`SELECT id, source_packet_id, status, attempts, type, receipt_id, error, extraction_run_id,
		 json_extract(payload_json,'$.project_id') AS project_id,
		 json_extract(payload_json,'$.repair_generation') AS repair_generation,
		 json_array_length(json_extract(payload_json,'$.remaining')) AS remaining
		 FROM memory_jobs WHERE user_id=${user} AND source_packet_id IN (${packetList})
		 ORDER BY source_packet_id, id`,
		`SELECT id, source_packet_id, status, job_id, receipt_id, error, created_at, updated_at
		 FROM extraction_runs WHERE user_id=${user} AND source_packet_id IN (${packetList})
		 ORDER BY source_packet_id, created_at, id`,
		`SELECT id, source_packet_id, outcome,
		 json_extract(detail,'$.atomic_capture_enabled') AS atomic_enabled,
		 json_extract(detail,'$.atomic_capture_complete') AS atomic_complete,
		 json_extract(detail,'$.atomic_capture_chunks') AS atomic_chunks,
		 json_extract(detail,'$.atomic_capture_stored') AS atomic_stored,
		 json_extract(detail,'$.atomic_capture_truncated') AS atomic_truncated,
		 json_extract(detail,'$.atomic_projection_enabled') AS projection_enabled,
		 json_extract(detail,'$.atomic_projection_candidates') AS projection_candidates,
		 json_extract(detail,'$.atomic_projection_promoted') AS projection_promoted,
		 json_extract(detail,'$.atomic_projection_reinforced') AS projection_reinforced,
		 json_extract(detail,'$.atomic_projection_ignored') AS projection_ignored,
		 json_extract(detail,'$.atomic_capture_latency_ms') AS atomic_latency_ms,
		 json_extract(detail,'$.atomic_projection_latency_ms') AS projection_latency_ms
		 FROM receipts WHERE user_id=${user} AND source_packet_id IN (${packetList})
		 ORDER BY source_packet_id, created_at, id`,
		`SELECT 'node' AS kind,id,state AS state_value FROM nodes
		 WHERE user_id=${user} AND project_id=${project} AND deleted_at IS NULL
		 UNION ALL SELECT 'slice',id,CAST(is_current AS TEXT) FROM slices
		 WHERE user_id=${user} AND project_id=${project} AND deleted_at IS NULL
		 UNION ALL SELECT 'event',id,CAST(happened_at AS TEXT) FROM events
		 WHERE user_id=${user} AND project_id=${project} AND deleted_at IS NULL
		 UNION ALL SELECT 'edge',id,coalesce(type,'') FROM edges
		 WHERE user_id=${user} AND project_id=${project} AND deleted_at IS NULL
		 UNION ALL SELECT 'page',id,coalesce(health_state,'') FROM memory_pages
		 WHERE user_id=${user} AND project_id=${project} AND deleted_at IS NULL
		 ORDER BY kind,id`,
		`SELECT rowid AS fts_rowid, object_id AS id FROM manual_search_profiles
		 WHERE user_id=${user} ORDER BY rowid`,
	]);
	const [episodes, candidates, runs, projections, jobs, extractionRuns, receipts, objects, profiles]
		= results.map((result) => result.results ?? []);
	const expected = expectedEpisodes(sample, ingests);
	assert(episodes.length === expected.size,
		`${sample.sampleId}: episode conservation ${episodes.length}/${expected.size}`);
	const episodesById = new Map();
	let episodeFailures = 0;
	for (const episode of episodes) {
		const wanted = expected.get(episode.message_id);
		const valid = wanted
			&& episode.user_id === slot.memoryUserId
			&& episode.memory_user_id === slot.memoryUserId
			&& episode.external_user_id === slot.externalId
			&& episode.project_id === PROJECT.projectId
			&& episode.source_packet_id === wanted.sourcePacketId
			&& episode.role === wanted.role
			&& episode.text === wanted.text
			&& integer(episode.source_time) === wanted.sourceTime
			&& episode.source_time_precision === "day"
			&& noSecret(episode.text);
		if (!valid) episodeFailures += 1;
		episodesById.set(episode.id, episode);
	}
	assert(episodeFailures === 0, `${sample.sampleId}: ${episodeFailures} source episode failure(s)`);
	const candidateIds = new Set();
	const byRun = new Map();
	let groundingFailures = 0;
	let scopeFailures = 0;
	let secretFailures = 0;
	for (const candidate of candidates) {
		const episode = episodesById.get(candidate.source_episode_id);
		const exact = Array.from(String(episode?.text ?? ""))
			.slice(integer(candidate.start_code_point), integer(candidate.end_code_point)).join("");
		if (!episode || episode.message_id !== candidate.source_message_id
			|| candidate.evidence_quote !== exact) groundingFailures += 1;
		if (candidate.user_id !== slot.memoryUserId || candidate.memory_user_id !== slot.memoryUserId
			|| candidate.external_user_id !== slot.externalId || candidate.project_id !== PROJECT.projectId
			|| candidate.source_packet_id !== episode?.source_packet_id) scopeFailures += 1;
		if (!noSecret([candidate.assertion, candidate.evidence_quote, candidate.raw_temporal_phrase].join(" ")))
			secretFailures += 1;
		assert(candidate.extraction_model === ATOMIC_MODEL,
			`${sample.sampleId}: atomic model identity changed`);
		assert(!candidateIds.has(candidate.id), `${sample.sampleId}: duplicate candidate id`);
		candidateIds.add(candidate.id);
		byRun.set(candidate.capture_run_id, (byRun.get(candidate.capture_run_id) ?? 0) + 1);
	}
	assert(groundingFailures === 0 && scopeFailures === 0 && secretFailures === 0,
		`${sample.sampleId}: candidate integrity failed ${JSON.stringify({ groundingFailures, scopeFailures, secretFailures })}`);
	let runAccountingFailures = 0;
	for (const run of runs) {
		const accepted = integer(run.accepted_count);
		const stored = integer(run.stored_count);
		const duplicates = integer(run.duplicate_count);
		const rejected = integer(run.rejected_count);
		const proposed = integer(run.proposed_count);
		const databaseDuplicates = accepted - stored;
		const localDuplicates = duplicates - databaseDuplicates;
		if (!['completed', 'empty'].includes(run.status) || stored !== (byRun.get(run.id) ?? 0)
			|| databaseDuplicates < 0 || localDuplicates < 0
			|| proposed !== accepted + rejected + localDuplicates) runAccountingFailures += 1;
	}
	assert(runAccountingFailures === 0, `${sample.sampleId}: capture-run accounting failed`);
	assert(projections.length === candidates.length,
		`${sample.sampleId}: projection/candidate mismatch ${projections.length}/${candidates.length}`);
	const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
	const episodeProvenanceSnippets = new Set(episodes.map((episode) => {
		const text = String(episode.text ?? "");
		return text.length > 240 ? `${text.slice(0, 239)}…` : text;
	}));
	let projectionFailures = 0;
	const projectionDiagnostics = [];
	const outcomes = { promoted: 0, reinforced: 0, ignored: 0 };
	const snippetsByObject = new Map();
	for (const projection of projections) {
		const candidate = candidatesById.get(projection.candidate_id);
		const validBase = candidate && projection.user_id === slot.memoryUserId
			&& projection.project_id === PROJECT.projectId
			&& projection.source_episode_id === candidate.source_episode_id
			&& projection.source_packet_id === candidate.source_packet_id
			&& Object.hasOwn(outcomes, projection.outcome);
		if (!validBase) {
			projectionFailures += 1;
			if (projectionDiagnostics.length < 20) projectionDiagnostics.push({
				type: "base", candidateId: projection.candidate_id,
				objectKind: projection.object_kind, objectId: projection.object_id,
				outcome: projection.outcome,
			});
			continue;
		}
		outcomes[projection.outcome] += 1;
		if (projection.outcome === "ignored") {
			if (projection.object_id != null || projection.object_kind != null
				|| projection.candidate_status !== "ignored") {
				projectionFailures += 1;
				if (projectionDiagnostics.length < 20) projectionDiagnostics.push({
					type: "ignored", candidateId: projection.candidate_id,
					objectKind: projection.object_kind, objectId: projection.object_id,
					outcome: projection.outcome,
				});
			}
		} else if (!projection.object_id || projection.live_object_id !== projection.object_id
			|| projection.object_user_id !== slot.memoryUserId
			|| projection.object_project_id !== PROJECT.projectId
			|| projection.candidate_status !== "promoted") {
			projectionFailures += 1;
			if (projectionDiagnostics.length < 20) projectionDiagnostics.push({
				type: "live_object", candidateId: projection.candidate_id,
				objectKind: projection.object_kind, objectId: projection.object_id,
				outcome: projection.outcome,
			});
		}
		else {
			const key = `${projection.object_kind}:${projection.object_id}`;
			const value = snippetsByObject.get(key)
				?? { key, snippet: projection.object_source_snippet, quotes: [] };
			value.quotes.push(candidate.evidence_quote);
			snippetsByObject.set(key, value);
		}
	}
	for (const value of snippetsByObject.values()) {
		// A newly promoted atomic object carries its exact evidence quote. A
		// reinforcement legitimately points at an existing legacy object, whose
		// immutable provenance is the scrubbed source message (bounded to the
		// legacy 240-character contract), not the later reinforcing quote.
		if (!value.quotes.includes(value.snippet)
			&& !value.quotes.some((quote) => atomicEvidenceSnippet(quote) === value.snippet)
			&& !episodeProvenanceSnippets.has(value.snippet)) {
			projectionFailures += 1;
			if (projectionDiagnostics.length < 20) projectionDiagnostics.push({
				type: "source_snippet", object: value.key,
				snippetChars: String(value.snippet ?? "").length,
				quoteChars: value.quotes.map((quote) => String(quote ?? "").length),
			});
		}
	}
	assert(projectionFailures === 0,
		`${sample.sampleId}: projection integrity failed ${JSON.stringify(projectionDiagnostics)}`);
	const jobDiagnostics = {
		packets: packetIds.length,
		jobs: jobs.length,
		statuses: Object.fromEntries([...new Set(jobs.map((job) => job.status))]
			.map((status) => [status, jobs.filter((job) => job.status === status).length])),
		types: Object.fromEntries([...new Set(jobs.map((job) => job.type))]
			.map((type) => [type, jobs.filter((job) => job.type === type).length])),
		badScope: jobs.filter((job) => job.project_id !== PROJECT.projectId).length,
		missingPacketJobs: packetIds.filter((packetId) => !jobs.some((job) => job.source_packet_id === packetId)).length,
		duplicatePacketJobs: packetIds.filter((packetId) => jobs.filter((job) => job.source_packet_id === packetId).length > 1).length,
	};
	const extractJobs = jobs.filter((job) => job.type === "extract");
	const pass2Jobs = jobs.filter((job) => job.type === "pass2_rollup");
	assert(extractJobs.length === packetIds.length
		&& extractJobs.every((job) => job.status === "enriched" && job.project_id === PROJECT.projectId)
		&& pass2Jobs.every((job) => ["completed", "skipped"].includes(job.status)
			&& job.project_id === PROJECT.projectId)
		&& extractJobs.length + pass2Jobs.length === jobs.length,
	`${sample.sampleId}: job terminal/scope accounting failed ${JSON.stringify(jobDiagnostics)}`);
	const { canonicalReceipts, retryHistory, receiptAccounting } = reconcileRetryAwareState({
		sampleId: sample.sampleId,
		packetIds,
		expectedProjectId: PROJECT.projectId,
		jobs,
		extractionRuns,
		receipts,
		captureRuns: runs,
		candidates,
		projections,
	});
	assert(canonicalReceipts.reduce((sum, receipt) => sum + integer(receipt.atomic_stored), 0)
		=== candidates.length,
		`${sample.sampleId}: atomic receipt conservation failed`);
	const counts = objects.reduce((out, row) => {
		out[`${row.kind}s`] = (out[`${row.kind}s`] ?? 0) + 1;
		return out;
	}, { nodes: 0, slices: 0, events: 0, edges: 0, pages: 0 });
	const fingerprintRows = {
		episodes: episodes.map((row) => [row.id, row.text_hash, row.source_time]),
		candidates: candidates.map((row) => [row.id, row.status, row.evidence_hash]),
		projections: projections.map((row) => [row.candidate_id, row.outcome, row.object_kind, row.object_id]),
		objects: objects.map((row) => [row.kind, row.id, row.state_value]),
	};
	return {
		sampleId: sample.sampleId,
		externalId: slot.externalId,
		memoryUserId: slot.memoryUserId,
		packetIds,
		episodes,
		candidates,
		runs,
		projections,
		jobs,
		extractionRuns,
		receipts,
		canonicalReceipts,
		objects,
		profiles,
		fingerprintSha256: sha(JSON.stringify(fingerprintRows)),
		corpora: {
			source: episodes.map((row) => row.text).join("\n"),
			candidates: candidates.map((row) => `${row.assertion ?? ""}\n${row.evidence_quote ?? ""}`).join("\n"),
		},
		integrity: {
			episodeFailures,
			groundingFailures,
			scopeFailures,
			secretFailures,
			runAccountingFailures,
			projectionFailures,
			captureRuns: runs.length,
			candidates: candidates.length,
			projections: projections.length,
			truncations: runs.reduce((sum, run) => sum + integer(run.truncated), 0),
			extractionRetries: jobs.reduce((sum, job) => sum + Math.max(0, integer(job.attempts) - 1), 0)
				+ retryHistory.repairGenerations,
			retryHistory,
			receiptAccounting,
			outcomes,
			counts: { episodes: episodes.length, candidates: candidates.length,
				projections: projections.length, ...counts, profiles: profiles.length },
		},
	};
}

async function collectState(data, slots, ingests) {
	const rows = [];
	for (const [index, sample] of data.samples.entries()) {
		rows.push(await collectSampleState(sample, slots[index], ingests));
		console.log(`STATE ${index + 1}/10 ${sample.sampleId} episodes=${rows.at(-1).episodes.length} candidates=${rows.at(-1).candidates.length}`);
	}
	assert(rows.reduce((sum, row) => sum + row.episodes.length, 0) === 5_882,
		"state episode total changed");
	return rows;
}

async function auditProductState() {
	assert(!fs.existsSync(PRODUCT) && !fs.existsSync(SEAL),
		"state audit is only valid before the product/reference boundary");
	assert(readJsonl(ANSWER_LEDGER).length === 0, "state audit found answer rows");
	const frozen = validateProductInputs();
	const data = productInputs();
	const slots = cohorts().control;
	const ingests = effectiveIngestLedger(data);
	const checked = assertIngestLedger(ingests, data);
	assert(checked.seen.size === 272, "state audit requires all 272 accepted sessions");
	const state = await collectState(data, slots, ingests);
	const artifact = {
		schema: "itsuki.v3-stage-e-state-audit/v1",
		createdAt: new Date().toISOString(),
		referenceBlind: true,
		referenceFilesOpened: 0,
		productInputSha256: frozen.productInputSha256,
		sessions: ingests.length,
		messages: state.reduce((sum, row) => sum + row.episodes.length, 0),
		packets: state.reduce((sum, row) => sum + row.packetIds.length, 0),
		candidates: state.reduce((sum, row) => sum + row.candidates.length, 0),
		projections: state.reduce((sum, row) => sum + row.projections.length, 0),
		captureRuns: state.reduce((sum, row) => sum + row.runs.length, 0),
		retryHistory: state.reduce((out, row) => {
			for (const [key, value] of Object.entries(row.integrity.retryHistory)) {
				out[key] = (out[key] ?? 0) + integer(value);
			}
			return out;
		}, {}),
		receiptAccounting: state.reduce((out, row) => {
			for (const [key, value] of Object.entries(row.integrity.receiptAccounting)) {
				out[key] = (out[key] ?? 0) + integer(value);
			}
			return out;
		}, {}),
		stateFingerprintSha256: sha(JSON.stringify(state.map((row) => row.fingerprintSha256))),
		samples: state.map((row) => ({
			sampleId: row.sampleId,
			packets: row.packetIds.length,
			episodes: row.episodes.length,
			candidates: row.candidates.length,
			projections: row.projections.length,
			captureRuns: row.runs.length,
			retryHistory: row.integrity.retryHistory,
			receiptAccounting: row.integrity.receiptAccounting,
			fingerprintSha256: row.fingerprintSha256,
		})),
	};
	writeJsonAtomic(STATE_AUDIT, artifact);
	console.log(`STAGE E STATE AUDIT PASS packets=${artifact.packets} candidates=${artifact.candidates} repairs=${artifact.retryHistory.repairedPackets}`);
}

async function collectFingerprints(state) {
	const rows = [];
	for (const sample of state) {
		const user = sqlQuote(sample.memoryUserId);
		const project = sqlQuote(PROJECT.projectId);
		const results = await d1Select([
			`SELECT id,text_hash,source_time FROM source_episodes
			 WHERE user_id=${user} AND project_id=${project} ORDER BY source_time,source_packet_id,message_index,id`,
			`SELECT id,status,evidence_hash FROM semantic_atom_candidates
			 WHERE user_id=${user} AND project_id=${project} ORDER BY capture_run_id,source_message_id,start_code_point,id`,
			`SELECT candidate_id,outcome,object_kind,object_id FROM semantic_atom_projections
			 WHERE user_id=${user} AND project_id=${project} ORDER BY candidate_id`,
			`SELECT 'node' AS kind,id,state AS state_value FROM nodes
			 WHERE user_id=${user} AND project_id=${project} AND deleted_at IS NULL
			 UNION ALL SELECT 'slice',id,CAST(is_current AS TEXT) FROM slices
			 WHERE user_id=${user} AND project_id=${project} AND deleted_at IS NULL
			 UNION ALL SELECT 'event',id,CAST(happened_at AS TEXT) FROM events
			 WHERE user_id=${user} AND project_id=${project} AND deleted_at IS NULL
			 UNION ALL SELECT 'edge',id,coalesce(type,'') FROM edges
			 WHERE user_id=${user} AND project_id=${project} AND deleted_at IS NULL
			 UNION ALL SELECT 'page',id,coalesce(health_state,'') FROM memory_pages
			 WHERE user_id=${user} AND project_id=${project} AND deleted_at IS NULL ORDER BY kind,id`,
		]);
		const fingerprintRows = {
			episodes: (results[0].results ?? []).map((row) => [row.id, row.text_hash, row.source_time]),
			candidates: (results[1].results ?? []).map((row) => [row.id, row.status, row.evidence_hash]),
			projections: (results[2].results ?? []).map((row) => [row.candidate_id, row.outcome, row.object_kind, row.object_id]),
			objects: (results[3].results ?? []).map((row) => [row.kind, row.id, row.state_value]),
		};
		rows.push({ sampleId: sample.sampleId, sha256: sha(JSON.stringify(fingerprintRows)) });
	}
	return rows;
}

function boundedTelemetry(body) {
	return {
		present: Object.hasOwn(body, "bounded_recall_corpus_used"),
		used: body.bounded_recall_corpus_used === true,
		failures: integer(body.bounded_recall_failures),
		queryTerms: body.bounded_recall_query_terms ?? [],
		laneCounts: body.bounded_recall_lane_counts ?? {},
		corpusCounts: body.bounded_recall_corpus_counts ?? {},
	};
}

function verifyBounded(questionId, bounded) {
	assert(bounded.present && bounded.used && bounded.failures === 0,
		`${questionId}: D13 bounded recall inactive/failed`);
	assert(Object.values(bounded.laneCounts).every((value) => integer(value) <= 200),
		`${questionId}: bounded lane exceeded 200`);
	const counts = bounded.corpusCounts;
	assert(integer(counts.nodes) <= 600 && integer(counts.pages) <= 200
		&& integer(counts.slices) <= 2_400 && integer(counts.events) <= 4_000
		&& integer(counts.edges) <= 600, `${questionId}: bounded corpus cap failed`);
}

async function answerOne(token, model, sample, slot, question) {
	const response = await request(token, "POST", "/v1/recall", {
		body: {
			userId: slot.externalId,
			query: question.question,
			limit: 200,
			recallScope: "project_only",
			memoryScope: { ...PROJECT },
		},
	});
	assert(response.ok && response.body?.ok === true,
		`recall(${question.questionId}) -> ${response.status}`);
	const body = response.body;
	const context = String(body.context ?? "");
	const sourceExpansion = {
		present: Object.hasOwn(body, "source_expansion_used"),
		used: body.source_expansion_used === true,
		assertions: integer(body.source_expansion_assertions),
		linkedAssertions: integer(body.source_expansion_linked_assertions),
		episodes: integer(body.source_expansion_episodes),
		chars: integer(body.source_expansion_chars),
		latencyMs: Number(body.source_expansion_ms ?? 0),
		failed: body.source_expansion_failed === true,
	};
	assert(body.hybrid_retrieval_used === true, `${question.questionId}: E7 inactive`);
	assert(sourceExpansion.present && sourceExpansion.used && !sourceExpansion.failed,
		`${question.questionId}: E9A inactive/failed`);
	assert(context.split("\n").filter((line) => line.startsWith("Source evidence [")).length
		=== sourceExpansion.episodes, `${question.questionId}: source rendering/accounting mismatch`);
	const bounded = boundedTelemetry(body);
	verifyBounded(question.questionId, bounded);
	const itemCount = integer(body.count ?? body.items?.length);
	assert(itemCount <= 200 && context.length <= 24_000,
		`${question.questionId}: final evidence/context bound failed`);
	assert(body.rerank_used !== true, `${question.questionId}: rejected reranker active`);
	assert(body.episode_fallback_used !== true, `${question.questionId}: rejected E9B active`);
	assert(!Object.hasOwn(body, "adaptive_context_used"), `${question.questionId}: rejected E10 active`);
	assert((body.items ?? []).every((item) => !item.project_id || item.project_id === PROJECT.projectId),
		`${question.questionId}: result item crossed project scope`);
	const generated = await model.answer({
		sampleId: sample.sampleId,
		speakerA: sample.speakerA,
		speakerB: sample.speakerB,
		question: { question: question.question, category: question.category, reference: "" },
		context,
	});
	assert(!generated.error, `${question.questionId}: reader error ${generated.error}`);
	return {
		schema: "itsuki.v3-stage-e-answer/v1",
		sampleId: sample.sampleId,
		questionId: question.questionId,
		questionIndex: question.questionIndex,
		category: question.category,
		categoryName: question.categoryName,
		question: question.question,
		retrieval: {
			context,
			semanticContext: context.split("\n").filter((line) => !line.startsWith("Source evidence [")).join("\n"),
			items: body.items ?? [],
			nodes: body.nodes ?? [],
			pages: body.pages ?? [],
			itemCount,
			contextLines: context ? context.split("\n").length : 0,
			contextChars: context.length,
			contextTokensApprox: Math.ceil(context.length / 4),
			serverLatencyMs: Number(body.recall_latency_ms ?? 0),
			clientLatencyMs: response.elapsedMs,
			hybridAssertionCandidates: integer(body.hybrid_assertion_candidates),
			hybridParentCandidates: integer(body.hybrid_parent_candidates),
			hybridLaneCounts: body.hybrid_lane_counts ?? {},
			sourceExpansion,
			bounded,
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
		completedAt: new Date().toISOString(),
	};
}

function expectedQuestions(data) {
	return data.samples.flatMap((sample, sampleIndex) => sample.questions.map((question) => ({
		sample,
		sampleIndex,
		question,
	})));
}

function assertAnswerLedger(rows, data) {
	const expected = new Map(expectedQuestions(data).map((entry) => [entry.question.questionId, entry]));
	const seen = new Set();
	for (const row of rows) {
		const wanted = expected.get(row.questionId);
		assert(wanted && !seen.has(row.questionId), `inconsistent answer ledger row ${row.questionId}`);
		seen.add(row.questionId);
		assert(row.sampleId === wanted.sample.sampleId
			&& row.question === wanted.question.question
			&& row.category === wanted.question.category
			&& row.answer?.model === READER_MODEL
			&& row.answer?.temperature === 0
			&& row.answer?.maxTokens === 1_024,
		`${row.questionId}: answer protocol mismatch`);
	}
	return { expected, seen };
}

async function answerAll(token, data, slots, start) {
	let ledger = readJsonl(ANSWER_LEDGER);
	let checked = assertAnswerLedger(ledger, data);
	const all = expectedQuestions(data);
	let todo = all.filter((entry) => !checked.seen.has(entry.question.questionId));
	const evalKey = secret("API_KEY");
	console.log("eval-door key: LOADED");
	const model = new AnswerModel({ apiKey: evalKey, model: READER_MODEL });
	assert(model.maxTokens === 1_024 && model.temperature === 0, "reader protocol changed");
	while (todo.length) {
		const block = todo.slice(0, ANSWER_BLOCK);
		await burnSnapshot(`StageE:answers:${checked.seen.size + 1}-${checked.seen.size + block.length}`,
			20_000, start);
		await pool(block, QUESTION_CONCURRENCY, async ({ sample, sampleIndex, question }) => {
			const row = await answerOne(token, model, sample, slots[sampleIndex], question);
			appendJsonl(ANSWER_LEDGER, row);
			checked.seen.add(row.questionId);
		});
		console.log(`ANSWER ${checked.seen.size}/1540`);
		ledger = readJsonl(ANSWER_LEDGER);
		checked = assertAnswerLedger(ledger, data);
		todo = all.filter((entry) => !checked.seen.has(entry.question.questionId));
	}
	assert(ledger.length === 1_540 && checked.seen.size === 1_540,
		`answer accounting failed ${ledger.length}/${checked.seen.size}`);
	const order = new Map(all.map((entry, index) => [entry.question.questionId, index]));
	return ledger.sort((a, b) => order.get(a.questionId) - order.get(b.questionId));
}

async function runProduct() {
	assert(!fs.existsSync(PRODUCT) && !fs.existsSync(SEAL), "final product/seal already exists");
	fs.mkdirSync(OUTPUT, { recursive: true });
	const frozen = validateProductInputs();
	const data = productInputs();
	const slots = cohorts().control;
	const start = stageStart();
	const token = secret("ITSUKI_API_KEY");
	console.log("ITSUKI_API_KEY: LOADED");
	let progress;
	if (fs.existsSync(PROGRESS)) {
		progress = readJson(PROGRESS);
		assert(progress.schema === "itsuki.v3-stage-e-product-progress/v1"
			&& progress.status === "running" && progress.stageStartSpent === start,
		"product progress is not safely resumable");
	} else {
		assert(!fs.existsSync(INGEST_LEDGER) && !fs.existsSync(ANSWER_LEDGER),
			"product ledgers exist without progress; STOP");
		const health = await expectedHealthActive();
		const clean = await assertCleanCohort(slots);
		const burnBefore = await burnSnapshot("StageE:product-start", 15_000, start);
		assert(burnBefore.spent === start,
			`Stage E settled burn changed before product start (${burnBefore.spent}/${start})`);
		progress = {
			schema: "itsuki.v3-stage-e-product-progress/v1",
			status: "running",
			startedAt: new Date().toISOString(),
			stageStartSpent: start,
			frozen,
			health,
			clean,
			burnBefore,
		};
		writeJsonAtomic(PROGRESS, progress);
	}
	const ingests = await ingestAll(token, data, slots, start);
	progress.ingestCompleteAt = progress.ingestCompleteAt ?? new Date().toISOString();
	progress.sessionsIngested = ingests.length;
	writeJsonAtomic(PROGRESS, progress);
	const state = await collectState(data, slots, ingests);
	progress.stateCollectedAt = new Date().toISOString();
	progress.stateFingerprintSha256 = sha(JSON.stringify(state.map((row) => row.fingerprintSha256)));
	writeJsonAtomic(PROGRESS, progress);
	const answers = await answerAll(token, data, slots, start);
	const afterRead = await collectFingerprints(state);
	assert(afterRead.every((row, index) => row.sha256 === state[index].fingerprintSha256),
		"read path mutated durable memory state");
	const burnAfter = await burnSnapshot("StageE:product-sealed-boundary", 2_000, start);
	const artifact = {
		schema: "itsuki.v3-stage-e-product/v1",
		createdAt: new Date().toISOString(),
		frozen,
		fixed: {
			cohort: "control",
			project: PROJECT,
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
			answerTemperature: 0,
			answerMaxTokens: 1_024,
			provider: "direct_first_party_workers_ai_binding",
		},
		health: progress.health,
		preflightClean: progress.clean,
		containmentRecovery: {
			historicalLedgerPreserved: true,
			rebuiltSampleId: "conv-43",
			rebuildLedger: path.basename(REBUILD_LEDGER),
			rebuildLedgerSha256: shaFile(REBUILD_LEDGER),
		},
		ingests,
		state,
		afterRead,
		answers,
		burnBefore: progress.burnBefore,
		burnAfter,
		neuronDeltaObserved: burnAfter.spent - start,
	};
	writeJsonExclusive(PRODUCT, artifact);
	sealProduct(PRODUCT, SEAL, [PRODUCT, INGEST_LEDGER, REBUILD_LEDGER, ANSWER_LEDGER, INPUT, PREREGISTRATION], {
		questions: answers.length,
		sessions: ingests.length,
		messages: state.reduce((sum, row) => sum + row.episodes.length, 0),
		stateFingerprintSha256: progress.stateFingerprintSha256,
		stageStartSpent: start,
	});
	progress.status = "sealed";
	progress.sealedAt = new Date().toISOString();
	progress.productSha256 = shaFile(PRODUCT);
	writeJsonAtomic(PROGRESS, progress);
	console.log(`STAGE E PRODUCT SEALED questions=${answers.length} neurons=${artifact.neuronDeltaObserved}`);
}

function chunks(values, size) {
	const output = [];
	for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
	return output;
}

async function ftsResidue(state) {
	let episodeFts = 0;
	let semanticFts = 0;
	for (const sample of state) {
		for (const ids of chunks(sample.episodes.map((row) => integer(row.fts_rowid)).filter(Boolean), 500)) {
			if (!ids.length) continue;
			const [result] = await d1Select([`SELECT COUNT(*) AS n FROM source_episodes_fts WHERE rowid IN (${ids.join(",")})`]);
			episodeFts += integer(result.results?.[0]?.n);
		}
		for (const ids of chunks(sample.profiles.map((row) => integer(row.fts_rowid)).filter(Boolean), 500)) {
			if (!ids.length) continue;
			const [result] = await d1Select([`SELECT COUNT(*) AS n FROM manual_search_fts WHERE rowid IN (${ids.join(",")})`]);
			semanticFts += integer(result.results?.[0]?.n);
		}
	}
	return { episodeFts, semanticFts };
}

async function cleanupProduct() {
	assert(!fs.existsSync(CLEANUP), "cleanup artifact already exists");
	assert(fs.existsSync(PRODUCT) && fs.existsSync(SEAL), "sealed product is required for cleanup");
	const product = readJson(PRODUCT);
	const seal = readJson(SEAL);
	assert(product.schema === "itsuki.v3-stage-e-product/v1" && product.answers.length === 1_540,
		"product is inconsistent");
	assert(seal.productSha256 === shaFile(PRODUCT) && seal.questions === 1_540,
		"product seal is inconsistent");
	const token = secret("ITSUKI_API_KEY");
	console.log("ITSUKI_API_KEY: LOADED");
	const slots = cohorts().control;
	const erased = await eraseFinalCohort(token, slots);
	const preVerificationClean = await assertCleanCohort(slots);
	const fts = await ftsResidue(product.state);
	assert(fts.episodeFts === 0 && fts.semanticFts === 0,
		`FTS cleanup did not converge: ${JSON.stringify(fts)}`);
	await burnSnapshot("StageE:cleanup-recall-proof", 5_000, stageStart());
	const recall = await pool(product.state, 3, async (sample, index) => {
		const query = sample.episodes[0]?.text?.slice(0, 300) ?? `stage-e-cleanup-${index}`;
		const response = await request(token, "POST", "/v1/recall", {
			body: { userId: slots[index].externalId, query, limit: 200,
				recallScope: "project_only", memoryScope: { ...PROJECT } },
		});
		assert(response.ok && response.body?.ok === true, `cleanup recall ${index + 1} failed`);
		assert(integer(response.body.count) === 0 && !(response.body.context ?? "").trim()
			&& (response.body.items ?? []).length === 0,
		`cleanup recall ${index + 1} returned erased state`);
		return { sampleId: sample.sampleId, count: 0, contextChars: 0 };
	});
	const exports = await pool(slots, 3, async (slot, index) => {
		const response = await request(token, "GET", "/v1/export", { query: { userId: slot.externalId } });
		assert(response.ok && response.body?.user_id === slot.memoryUserId,
			`cleanup export ${index + 1} failed`);
		const names = ["nodes", "slices", "events", "edges", "memory_pages", "candidates"];
		const counts = Object.fromEntries(names.map((name) => [name,
			Array.isArray(response.body[name]) ? response.body[name].length : 0]));
		assert(Object.values(counts).every((count) => count === 0),
			`cleanup export ${index + 1} retained live state: ${JSON.stringify(counts)}`);
		return { sampleId: product.state[index].sampleId, counts };
	});
	// Recall is intentionally audited as a governed query source packet even
	// when it returns no memory. Remove the cleanup proof's own ten query packets
	// after the proof, then require every live/derived/source store to be zero.
	const verificationErase = await eraseFinalCohort(token, slots);
	const clean = await assertCleanCohort(slots);
	const packets = clean.packets;
	const burnAfter = await burnSnapshot("StageE:cleanup-complete", 1_000, stageStart());
	writeJsonExclusive(CLEANUP, {
		schema: "itsuki.v3-stage-e-cleanup/v1",
		cleanedAt: new Date().toISOString(),
		productSha256: shaFile(PRODUCT),
		erased,
		preVerificationClean,
		verificationErase,
		clean,
		fts,
		recall,
		exports,
		packets,
		burnAfter,
		dirty: 0,
	});
	console.log("STAGE E CLEANUP ZERO");
}

async function main() {
	const command = process.argv[2];
	if (command === "dry-run") {
		console.log(JSON.stringify(dryRun(), null, 2));
		return;
	}
	requireBenchmarkLockFromEnv();
	assert(process.env.BENCHMARK_LOCK_DIR === GLOBAL_LOCK, "wrong benchmark lock path");
	if (command === "audit-state") return auditProductState();
	if (command === "run") return runProduct();
	if (command === "cleanup") return cleanupProduct();
	throw new Error("usage: product.mjs <dry-run|audit-state|run|cleanup>");
}

main().catch((error) => {
	console.error(`STAGE E PRODUCT STOPPED: ${error.stack ?? error}`);
	process.exit(1);
});
