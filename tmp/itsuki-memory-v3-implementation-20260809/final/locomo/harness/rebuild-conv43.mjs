import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import {
	GLOBAL_LOCK,
	OUTPUT,
	PROJECT,
	assert,
	assertBillingPreflight,
	assertCleanCohort,
	appendJsonl,
	burnSnapshot,
	cohorts,
	d1Select,
	expectedHealthActive,
	integer,
	productInputs,
	readJson,
	readJsonl,
	request,
	secret,
	sha,
	shaFile,
	sqlQuote,
	stateCounts,
	validateProductInputs,
	waitReady,
	writeJsonAtomic,
	writeJsonExclusive,
} from "./common.mjs";
import { classifySourceEpisodeAcknowledgement } from "./ingest-response.mjs";
import {
	CONTAINMENT_REBUILD_SAMPLE,
	CONTAINMENT_REBUILD_SESSIONS,
	overlayContainmentRebuild,
} from "./rebuild-ledger.mjs";

const require = createRequire(import.meta.url);
const { EXIT_LOCK_HELD, BenchmarkLockHeldError, acquireBenchmarkLock }
	= require("../../../e2/harness/benchmark-lock.cjs");

const HISTORICAL_LEDGER = path.join(OUTPUT, "product-ingest.jsonl");
const REBUILD_LEDGER = path.join(OUTPUT, "product-ingest-rebuild-conv-43-attempt-002.jsonl");
const REBUILD_PROGRESS = path.join(OUTPUT, "product-ingest-rebuild-conv-43-attempt-002.progress.json");
const REBUILD_RESULT = path.join(OUTPUT, "V3-D15-CONV-43-REBUILD.json");
const PRODUCT_PROGRESS = path.join(OUTPUT, "product-progress.json");
const ANSWER_LEDGER = path.join(OUTPUT, "product-answers.jsonl");
const PRODUCT = path.join(OUTPUT, "product.json");
const PRODUCT_SEAL = path.join(OUTPUT, "product.seal.json");
const STAGE_E_START = 1_933_582;
const REQUEST_TIMEOUT_MS = 300_000;
const TERMINAL = new Set(["enriched", "failed", "completed"]);

class UnsafeLineageError extends Error {
	constructor(message) {
		super(message);
		this.name = "UnsafeLineageError";
	}
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizedCounts(value) {
	return Object.fromEntries(Object.entries(value ?? {}).map(([key, count]) => [key, integer(count)]));
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

function sampleAndSlot() {
	const data = productInputs();
	const sampleIndex = data.samples.findIndex((sample) => sample.sampleId === CONTAINMENT_REBUILD_SAMPLE);
	assert(sampleIndex === 4, `containment sample index changed (${sampleIndex})`);
	const sample = data.samples[sampleIndex];
	const slot = cohorts().control[sampleIndex];
	assert(sample.sessions.length === CONTAINMENT_REBUILD_SESSIONS
		&& sample.sessions.reduce((sum, session) => sum + session.messages.length, 0) === 680,
	"conv-43 frozen product accounting changed");
	return { data, sample, sampleIndex, slot };
}

function validateRebuildRows(rows, sample) {
	const seen = new Set();
	for (const row of rows) {
		assert(row.schema === "itsuki.v3-stage-e-containment-rebuild-session/v1"
			&& row.sampleId === sample.sampleId, "invalid containment rebuild row");
		assert(!seen.has(row.sessionIndex), `duplicate containment rebuild session ${row.sessionIndex}`);
		const session = sample.sessions.find((entry) => entry.index === row.sessionIndex);
		assert(session && row.inputSha256 === sha(JSON.stringify(session)),
			`session ${row.sessionIndex}: containment input hash mismatch`);
		const plan = planBatches(session);
		assert(row.batches?.length === plan.length && row.messages === session.messages.length,
			`session ${row.sessionIndex}: containment plan mismatch`);
		assert(row.batches.every((batch, index) => batch.batchIndex === index
			&& batch.messageIds.join("\0") === plan[index].map((message) => message.id).join("\0")
			&& batch.idempotencyKey === `itsuki-v3:final-locomo:containment-rebuild-v2:${sample.sampleId}:s${session.index}:b${index}`
			&& batch.sourcePacketId && batch.jobId && batch.accepted === true
			&& TERMINAL.has(batch.ready?.status) && batch.ready?.status !== "failed"),
		`session ${row.sessionIndex}: containment outcome mismatch`);
		seen.add(row.sessionIndex);
	}
	for (let index = 0; index < rows.length; index += 1) {
		assert(rows[index].sessionIndex === sample.sessions[index].index,
			`containment ledger gap before session ${sample.sessions[index].index}`);
	}
	return seen;
}

function dryRun() {
	const frozen = validateProductInputs();
	const { sample } = sampleAndSlot();
	const historical = readJsonl(HISTORICAL_LEDGER);
	assert(historical.length === 272, "historical Stage E ledger changed");
	const historicalSample = historical.filter((row) => row.sampleId === sample.sampleId);
	assert(historicalSample.length === 29, "historical conv-43 ledger changed");
	const batches = sample.sessions.reduce((sum, session) => sum + planBatches(session).length, 0);
	assert(batches === 35, `conv-43 wire plan changed (${batches})`);
	return {
		schema: "itsuki.v3-stage-e-containment-rebuild-dry-run/v1",
		frozen,
		sampleId: sample.sampleId,
		sessions: sample.sessions.length,
		messages: 680,
		batches,
		historicalLedgerSha256: shaFile(HISTORICAL_LEDGER),
		referenceBlind: true,
		referenceFilesOpened: 0,
	};
}

async function lineageAudit(slot) {
	const user = sqlQuote(slot.memoryUserId);
	const project = sqlQuote(PROJECT.projectId);
	const [summary, perPacket] = await d1Select([
		`SELECT
		 (SELECT COUNT(*) FROM extraction_runs WHERE user_id=${user}) AS audit_runs,
		 (SELECT COUNT(*) FROM extraction_runs WHERE user_id=${user}
		  AND status IN ('deleted','cancelled_by_delete')) AS retired_runs,
		 (SELECT COUNT(*) FROM extraction_runs WHERE user_id=${user}
		  AND status NOT IN ('deleted','cancelled_by_delete')) AS extraction_runs,
		 (SELECT COUNT(*) FROM extraction_runs WHERE user_id=${user}
		  AND status IN ('running','committing')) AS nonterminal_runs,
		 (SELECT COUNT(*) FROM memory_jobs WHERE user_id=${user}
		  AND status NOT IN ('enriched','failed','completed')) AS nonterminal_jobs,
		 (SELECT COUNT(*) FROM source_episodes WHERE user_id=${user} AND project_id=${project}) AS episodes,
		 (SELECT COUNT(DISTINCT source_packet_id) FROM source_episodes
		  WHERE user_id=${user} AND project_id=${project}) AS episode_packets,
		 (SELECT COUNT(*) FROM semantic_atom_capture_runs WHERE user_id=${user} AND project_id=${project}) AS atomic_runs,
		 (SELECT COUNT(*) FROM semantic_atom_capture_runs WHERE user_id=${user} AND project_id=${project}
		  AND status NOT IN ('completed','empty')) AS nonterminal_atomic_runs,
		 (SELECT COUNT(*) FROM semantic_atom_candidates WHERE user_id=${user} AND project_id=${project}) AS candidates,
		 (SELECT COUNT(*) FROM semantic_atom_projections WHERE user_id=${user} AND project_id=${project}) AS projections`,
		`SELECT source_packet_id,COUNT(*) AS runs,
		 SUM(CASE WHEN status IN ('running','committing') THEN 1 ELSE 0 END) AS nonterminal
		 FROM extraction_runs WHERE user_id=${user}
		  AND status NOT IN ('deleted','cancelled_by_delete')
		 GROUP BY source_packet_id ORDER BY source_packet_id`,
	]);
	const counts = normalizedCounts(summary.results?.[0]);
	const packets = (perPacket.results ?? []).map((row) => ({
		sourcePacketId: row.source_packet_id,
		runs: integer(row.runs),
		nonterminal: integer(row.nonterminal),
	}));
	const unsafe = packets.filter((row) => row.runs > 4 || row.nonterminal > 0);
	if (unsafe.length || counts.extraction_runs > Math.max(4, counts.episode_packets * 4)) {
		throw new UnsafeLineageError(`bounded lineage violated: ${JSON.stringify({ counts, unsafe: unsafe.slice(0, 10) })}`);
	}
	return { counts, packets, maxRunsPerPacket: Math.max(0, ...packets.map((row) => row.runs)) };
}

async function waitStableAudit(slot, expectedMessages, expectedPackets, timeoutMs = 180_000) {
	const started = Date.now();
	let previous = null;
	while (Date.now() - started < timeoutMs) {
		const current = await lineageAudit(slot);
		const counts = current.counts;
		const terminal = counts.nonterminal_runs === 0 && counts.nonterminal_jobs === 0
			&& counts.nonterminal_atomic_runs === 0 && counts.candidates === counts.projections
			&& counts.episodes === expectedMessages && counts.episode_packets === expectedPackets;
		const signature = JSON.stringify(current);
		if (terminal && previous === signature) return { ...current, stableForMs: 5_000 };
		previous = terminal ? signature : null;
		await sleep(5_000);
	}
	throw new Error(`containment rebuild state did not stabilize for ${expectedMessages} messages/${expectedPackets} packets`);
}

async function ingestSession(token, sample, session, slot) {
	const plan = planBatches(session);
	const accepted = [];
	for (const [batchIndex, messages] of plan.entries()) {
		const idempotencyKey = `itsuki-v3:final-locomo:containment-rebuild-v2:${sample.sampleId}:s${session.index}:b${batchIndex}`;
		const response = await request(token, "POST", "/v1/ingest", {
			body: {
				userId: slot.externalId,
				conversationId: `v3-final-locomo-containment-rebuild-v2-${sample.sampleId}-session-${session.index}`,
				idempotencyKey,
				memoryScope: { ...PROJECT },
				flush: batchIndex === plan.length - 1,
				messages: messages.map((message) => ({ ...message })),
			},
			attempts: 3,
			timeoutMs: REQUEST_TIMEOUT_MS,
		});
		assert(response.ok && response.body?.ok === true,
			`rebuild(${sample.sampleId}/s${session.index}/b${batchIndex}) -> ${response.status}/${response.body?.code ?? "not_ok"}`);
		assert(response.body.source_packet_id && response.body.job_id,
			`rebuild(${sample.sampleId}/s${session.index}/b${batchIndex}) omitted packet/job`);
		const episodeAcknowledgement = classifySourceEpisodeAcknowledgement(response.body, messages.length);
		accepted.push({
			batchIndex,
			idempotencyKey,
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
	const finalReady = await waitReady(token, slot.externalId, accepted.at(-1).jobId);
	assert(finalReady.status !== "failed" && !finalReady.cancelledByDelete
		&& finalReady.projectId === PROJECT.projectId,
	`rebuild(${sample.sampleId}/s${session.index}) final extraction invalid`);
	for (const batch of accepted) {
		batch.ready = batch.jobId === accepted.at(-1).jobId
			? finalReady
			: await waitReady(token, slot.externalId, batch.jobId);
		assert(batch.ready.status !== "failed" && !batch.ready.cancelledByDelete
			&& batch.ready.projectId === PROJECT.projectId,
		`rebuild(${sample.sampleId}/s${session.index}/b${batch.batchIndex}) extraction invalid`);
	}
	return {
		schema: "itsuki.v3-stage-e-containment-rebuild-session/v1",
		sampleId: sample.sampleId,
		sessionIndex: session.index,
		inputSha256: sha(JSON.stringify(session)),
		messages: session.messages.length,
		batches: accepted,
		completedAt: new Date().toISOString(),
	};
}

async function run() {
	assert(!fs.existsSync(PRODUCT) && !fs.existsSync(PRODUCT_SEAL),
		"containment rebuild is only valid before the product/reference boundary");
	assert(readJsonl(ANSWER_LEDGER).length === 0, "containment rebuild found answer rows");
	assert(!fs.existsSync(REBUILD_RESULT), "containment rebuild result already exists");
	const dry = dryRun();
	const { sample, slot, sampleIndex } = sampleAndSlot();
	const slots = cohorts().control;
	const untouched = slots.filter((_, index) => index !== sampleIndex);
	const token = secret("ITSUKI_API_KEY");
	console.log("ITSUKI_API_KEY: LOADED");

	let progress;
	if (fs.existsSync(REBUILD_PROGRESS)) {
		progress = readJson(REBUILD_PROGRESS);
		assert(progress.schema === "itsuki.v3-stage-e-containment-rebuild-progress/v1"
			&& progress.status === "running" && progress.sampleId === sample.sampleId
			&& progress.historicalLedgerSha256 === shaFile(HISTORICAL_LEDGER),
		"containment rebuild progress is not safely resumable");
	} else {
		assert(!fs.existsSync(REBUILD_LEDGER), "containment rebuild ledger exists without progress");
		const health = await expectedHealthActive();
		await assertBillingPreflight();
		const burnBefore = await burnSnapshot("StageE:conv-43-rebuild-start", 20_000, STAGE_E_START);
		const clean = await assertCleanCohort([slot]);
		const untouchedBefore = normalizedCounts(await stateCounts(untouched));
		progress = {
			schema: "itsuki.v3-stage-e-containment-rebuild-progress/v1",
			status: "running",
			sampleId: sample.sampleId,
			startedAt: new Date().toISOString(),
			historicalLedgerSha256: shaFile(HISTORICAL_LEDGER),
			dry,
			health,
			burnBefore,
			clean,
			untouchedBefore,
			referenceBlind: true,
			referenceFilesOpened: 0,
		};
		writeJsonAtomic(REBUILD_PROGRESS, progress);
	}

	let rows = readJsonl(REBUILD_LEDGER);
	validateRebuildRows(rows, sample);
	const done = new Set(rows.map((row) => row.sessionIndex));
	let expectedMessages = rows.reduce((sum, row) => sum + row.messages, 0);
	let expectedPackets = rows.reduce((sum, row) => sum + row.batches.length, 0);
	for (const session of sample.sessions) {
		if (done.has(session.index)) continue;
		await burnSnapshot(`StageE:conv-43-rebuild:s${session.index}`, 7_500, STAGE_E_START);
		const row = await ingestSession(token, sample, session, slot);
		appendJsonl(REBUILD_LEDGER, row);
		rows.push(row);
		done.add(session.index);
		expectedMessages += row.messages;
		expectedPackets += row.batches.length;
		const stable = await waitStableAudit(slot, expectedMessages, expectedPackets);
		progress.sessionsCompleted = rows.length;
		progress.messagesCompleted = expectedMessages;
		progress.packetsCompleted = expectedPackets;
		progress.lastLineageAudit = stable;
		progress.updatedAt = new Date().toISOString();
		writeJsonAtomic(REBUILD_PROGRESS, progress);
		console.log(`REBUILD ${rows.length}/29 ${sample.sampleId} s${session.index} messages=${expectedMessages}/680 packets=${expectedPackets}/35 runs=${stable.counts.extraction_runs}`);
	}

	validateRebuildRows(rows, sample);
	overlayContainmentRebuild({ historicalRows: readJsonl(HISTORICAL_LEDGER), rebuildRows: rows });
	assert(rows.length === 29 && expectedMessages === 680 && expectedPackets === 35,
		"containment rebuild final accounting changed");
	const finalState = await waitStableAudit(slot, 680, 35);
	assert(finalState.counts.candidates === finalState.counts.projections,
		"containment rebuild candidate/projection conservation failed");
	const untouchedAfter = normalizedCounts(await stateCounts(untouched));
	assert(JSON.stringify(untouchedAfter) === JSON.stringify(progress.untouchedBefore),
		"containment rebuild changed an untouched frozen tenant count");
	assert(shaFile(HISTORICAL_LEDGER) === progress.historicalLedgerSha256,
		"historical ingest ledger changed during containment rebuild");
	await sleep(20_000);
	const burnAfter = await burnSnapshot("StageE:conv-43-rebuild-complete", 2_000, STAGE_E_START);

	writeJsonExclusive(REBUILD_RESULT, {
		schema: "itsuki.v3-stage-e-containment-rebuild/v1",
		createdAt: new Date().toISOString(),
		pass: true,
		referenceBlind: true,
		referenceFilesOpened: 0,
		answers: 0,
		judgeRows: 0,
		scores: 0,
		sampleId: sample.sampleId,
		slotIndex: sampleIndex,
		sessions: rows.length,
		messages: expectedMessages,
		packets: expectedPackets,
		historicalLedgerPreserved: true,
		historicalLedgerSha256: progress.historicalLedgerSha256,
		rebuildLedgerSha256: shaFile(REBUILD_LEDGER),
		finalState,
		untouchedBefore: progress.untouchedBefore,
		untouchedAfter,
		burnBefore: progress.burnBefore,
		burnAfter,
		neuronDeltaObserved: burnAfter.spent - progress.burnBefore.spent,
	});

	progress.status = "complete";
	progress.completedAt = new Date().toISOString();
	progress.sessionsCompleted = rows.length;
	progress.messagesCompleted = expectedMessages;
	progress.packetsCompleted = expectedPackets;
	progress.rebuildLedgerSha256 = shaFile(REBUILD_LEDGER);
	progress.resultSha256 = shaFile(REBUILD_RESULT);
	progress.burnAfter = burnAfter;
	writeJsonAtomic(REBUILD_PROGRESS, progress);

	const productProgress = readJson(PRODUCT_PROGRESS);
	assert(productProgress.schema === "itsuki.v3-stage-e-product-progress/v1"
		&& productProgress.status === "running", "Stage E product progress is not resumable");
	productProgress.containmentRebuild = {
		sampleId: sample.sampleId,
		completedAt: progress.completedAt,
		sessions: rows.length,
		messages: expectedMessages,
		packets: expectedPackets,
		rebuildLedgerSha256: progress.rebuildLedgerSha256,
		resultSha256: progress.resultSha256,
	};
	writeJsonAtomic(PRODUCT_PROGRESS, productProgress);
	console.log(`CONTAINMENT REBUILD PASS ${sample.sampleId} sessions=29 messages=680 packets=35 neurons=${burnAfter.spent - progress.burnBefore.spent}`);
}

const command = process.argv[2];
if (command === "dry-run") {
	console.log(JSON.stringify(dryRun(), null, 2));
} else {
	let lock;
	try {
		assert(command === "run", "usage: rebuild-conv43.mjs <dry-run|run>");
		lock = acquireBenchmarkLock(GLOBAL_LOCK, { experiment: "StageE-conv-43-containment-rebuild" });
		await run();
		lock.assertHeld();
	} catch (error) {
		if (error instanceof BenchmarkLockHeldError) {
			console.error(`LOCK_HELD: ${error.message}`);
			process.exitCode = EXIT_LOCK_HELD;
		} else {
			console.error(`CONTAINMENT REBUILD STOPPED: ${error?.stack ?? error}`);
			process.exitCode = process.exitCode || 1;
		}
	} finally {
		lock?.release();
	}
}
