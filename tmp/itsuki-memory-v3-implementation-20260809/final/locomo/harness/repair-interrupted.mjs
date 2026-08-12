import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import {
	GLOBAL_LOCK,
	OUTPUT,
	PROJECT,
	assert,
	assertBillingPreflight,
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
	sqlQuote,
	validateProductInputs,
	waitReady,
	writeJsonExclusive,
} from "./common.mjs";

const require = createRequire(import.meta.url);
const { acquireBenchmarkLock } = require("../../../e2/harness/benchmark-lock.cjs");

const STAGE_START = 1_933_582;
const PROGRESS = path.join(OUTPUT, "product-progress.json");
const INGEST_LEDGER = path.join(OUTPUT, "product-ingest.jsonl");
const ANSWER_LEDGER = path.join(OUTPUT, "product-answers.jsonl");
const PRODUCT = path.join(OUTPUT, "product.json");
const SEAL = path.join(OUTPUT, "product.seal.json");
const ARTIFACT = path.join(OUTPUT, "V3-D04-PRODUCTION-REATTACK.json");

const TARGETS = Object.freeze([
	Object.freeze({
		sampleId: "conv-26",
		sessionIndex: 16,
		packetId: "src_3bd5ea47-675f-418e-9e93-95f116ea9eb8",
		jobId: "job_0e7eea20-3437-475b-808b-f5897a99349d",
		originalCompletedStored: 11,
		expectedEpisodes: 20,
	}),
	Object.freeze({
		sampleId: "conv-41",
		sessionIndex: 17,
		packetId: "src_8e206a03-1996-4f5e-aba8-69a159a15150",
		jobId: "job_253cc9ac-88ec-424c-96f5-33d90e86d956",
		originalCompletedStored: 8,
		expectedEpisodes: 16,
	}),
]);

function targetInput(data, slots, target) {
	const sampleIndex = data.samples.findIndex((sample) => sample.sampleId === target.sampleId);
	assert(sampleIndex >= 0, `${target.sampleId}: frozen sample missing`);
	const sample = data.samples[sampleIndex];
	const session = sample.sessions.find((candidate) => candidate.index === target.sessionIndex);
	assert(session, `${target.sampleId}/s${target.sessionIndex}: frozen session missing`);
	assert(session.messages.length === target.expectedEpisodes, `${target.packetId}: frozen message count changed`);
	return { sample, session, slot: slots[sampleIndex] };
}

function assertReferenceBlindBoundary() {
	const progress = readJson(PROGRESS);
	assert(progress.schema === "itsuki.v3-stage-e-product-progress/v1"
		&& progress.status === "running" && progress.sessionsIngested === 272,
	"Stage E product progress is not the paused resumable write boundary");
	assert(!fs.existsSync(PRODUCT) && !fs.existsSync(SEAL), "Stage E product/reference boundary was already crossed");
	assert(readJsonl(ANSWER_LEDGER).length === 0, "Stage E answer ledger is not empty");
	assert(!fs.existsSync(ARTIFACT), "V3-D04 production reattack artifact already exists");
}

async function auditTarget(target, memoryUserId) {
	const user = sqlQuote(memoryUserId);
	const packet = sqlQuote(target.packetId);
	const job = sqlQuote(target.jobId);
	const project = sqlQuote(PROJECT.projectId);
	const [
		jobsResult,
		runsResult,
		atomicResult,
		episodesResult,
		nonterminalResult,
		candidatesResult,
		projectionsResult,
	] = await d1Select([
		`SELECT j.id,j.status,j.attempts,j.source_packet_id,j.receipt_id,j.error,
		 json_extract(j.payload_json,'$.repair_generation') AS repair_generation,
		 json_array_length(json_extract(j.payload_json,'$.remaining')) AS remaining,
		 json_extract(j.payload_json,'$.project_id') AS project_id,
		 json_extract(r.detail,'$.atomic_capture_complete') AS atomic_complete,
		 json_extract(r.detail,'$.atomic_capture_chunks') AS atomic_chunks,
		 json_extract(r.detail,'$.atomic_capture_stored') AS atomic_stored,
		 json_extract(r.detail,'$.atomic_projection_candidates') AS projection_candidates,
		 json_extract(r.detail,'$.atomic_projection_promoted') AS projection_promoted,
		 json_extract(r.detail,'$.atomic_projection_reinforced') AS projection_reinforced,
		 json_extract(r.detail,'$.atomic_projection_ignored') AS projection_ignored
		 FROM memory_jobs j LEFT JOIN receipts r ON r.id=j.receipt_id AND r.user_id=j.user_id
		 WHERE j.user_id=${user} AND j.id=${job} AND j.source_packet_id=${packet}`,
		`SELECT id,status,source_packet_id,job_id,error,created_at,updated_at
		 FROM extraction_runs WHERE user_id=${user} AND source_packet_id=${packet}
		 ORDER BY created_at,id`,
		`SELECT r.id,r.status,r.attempts,r.replay_count,r.stored_count,r.error_code,
		 (SELECT COUNT(*) FROM semantic_atom_candidates c
		   WHERE c.user_id=r.user_id AND c.capture_run_id=r.id) AS candidate_rows,
		 (SELECT COUNT(*) FROM semantic_atom_projections p
		   JOIN semantic_atom_candidates c ON c.id=p.candidate_id AND c.user_id=p.user_id
		   WHERE c.user_id=r.user_id AND c.capture_run_id=r.id) AS projection_rows
		 FROM semantic_atom_capture_runs r
		 WHERE r.user_id=${user} AND r.project_id=${project} AND r.source_packet_id=${packet}
		 ORDER BY r.chunk_key,r.id`,
		`SELECT COUNT(*) AS n FROM source_episodes WHERE user_id=${user} AND project_id=${project}
		 AND source_packet_id=${packet}`,
		`SELECT COUNT(*) AS n FROM memory_jobs WHERE user_id=${user} AND id=${job}
		 AND status IN ('awaiting_source','queued','staged','processing')`,
		`SELECT COUNT(*) AS n FROM semantic_atom_candidates WHERE user_id=${user}
		 AND project_id=${project} AND source_packet_id=${packet}`,
		`SELECT COUNT(*) AS n FROM semantic_atom_projections p
		 JOIN semantic_atom_candidates c ON c.id=p.candidate_id AND c.user_id=p.user_id
		 WHERE c.user_id=${user} AND c.project_id=${project} AND c.source_packet_id=${packet}`,
	]);
	const jobs = jobsResult.results ?? [];
	const extractionRuns = runsResult.results ?? [];
	const atomicRuns = atomicResult.results ?? [];
	const counts = {
		episodes: integer(episodesResult.results?.[0]?.n),
		nonterminal_jobs: integer(nonterminalResult.results?.[0]?.n),
		candidates: integer(candidatesResult.results?.[0]?.n),
		projections: integer(projectionsResult.results?.[0]?.n),
	};
	const complete = jobs.length === 1
		&& jobs[0].status === "enriched"
		&& integer(jobs[0].attempts) === 1
		&& integer(jobs[0].repair_generation) === 1
		&& integer(jobs[0].remaining) === 0
		&& jobs[0].project_id === PROJECT.projectId
		&& extractionRuns.filter((row) => row.status === "wrote").length === 1
		&& extractionRuns.filter((row) => row.status === "failed"
			&& String(row.error ?? "").startsWith("inference_outcome_unknown")).length === 1
		&& atomicRuns.length >= 2
		&& atomicRuns.every((row) => ["completed", "empty"].includes(row.status))
		&& atomicRuns.every((row) => integer(row.candidate_rows) === integer(row.stored_count))
		&& atomicRuns.some((row) => integer(row.attempts) === 1
			&& integer(row.stored_count) === target.originalCompletedStored)
		&& atomicRuns.some((row) => integer(row.attempts) === 2)
		&& integer(counts.episodes) === target.expectedEpisodes
		&& integer(counts.nonterminal_jobs) === 0
		&& integer(counts.candidates) === atomicRuns.reduce((sum, row) => sum + integer(row.stored_count), 0)
		&& integer(counts.projections) === integer(counts.candidates)
		&& integer(jobs[0].atomic_complete) === 1
		&& integer(jobs[0].atomic_chunks) === atomicRuns.length
		&& integer(jobs[0].atomic_stored) === integer(counts.candidates)
		&& integer(jobs[0].projection_candidates) === integer(counts.candidates)
		&& integer(jobs[0].projection_promoted) + integer(jobs[0].projection_reinforced)
			+ integer(jobs[0].projection_ignored) === integer(counts.candidates);
	return {
		complete,
		job: jobs[0] ?? null,
		extractionRuns,
		atomicRuns,
		counts: Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, integer(value)])),
	};
}

async function replayTarget(token, data, slots, ingests, target) {
	const { session, slot } = targetInput(data, slots, target);
	const ledger = ingests.find((row) => row.sampleId === target.sampleId
		&& row.sessionIndex === target.sessionIndex);
	assert(ledger?.inputSha256 === sha(JSON.stringify(session)) && ledger.batches?.length === 1,
		`${target.packetId}: frozen ingest ledger changed`);
	assert(ledger.batches[0].sourcePacketId === target.packetId
		&& ledger.batches[0].jobId === target.jobId,
	`${target.packetId}: packet/job identity changed`);

	const before = await auditTarget(target, slot.memoryUserId);
	if (before.complete) return { target, skippedAlreadyComplete: true, before, after: before };
	assert(before.job?.status === "enriched" && integer(before.job?.attempts) === 0,
		`${target.packetId}: pre-repair job state changed`);
	assert(before.atomicRuns.length === 2
		&& before.atomicRuns.filter((row) => row.status === "completed").length === 1
		&& before.atomicRuns.filter((row) => row.status === "running").length === 1,
	`${target.packetId}: pre-repair atomic state changed`);

	await burnSnapshot(`StageE:V3-D04:${target.packetId}`, 15_000, STAGE_START);
	const response = await request(token, "POST", "/v1/ingest", {
		body: {
			userId: slot.externalId,
			conversationId: `v3-final-locomo-${target.sampleId}-session-${target.sessionIndex}`,
			idempotencyKey: `itsuki-v3:final-locomo:${target.sampleId}:s${target.sessionIndex}:b0`,
			memoryScope: { ...PROJECT },
			flush: true,
			messages: session.messages.map((message) => ({ ...message })),
		},
		attempts: 3,
		timeoutMs: 300_000,
	});
	assert(response.ok && response.body?.ok === true, `${target.packetId}: exact replay failed (${response.status})`);
	assert(response.body.source_packet_id === target.packetId && response.body.job_id === target.jobId,
		`${target.packetId}: replay changed durable identity`);
	assert(response.body.duplicate !== true && response.body.terminal_replay !== true,
		`${target.packetId}: replay did not enter repair generation`);
	const ready = await waitReady(token, slot.externalId, target.jobId);
	assert(ready.status === "enriched" && integer(ready.attempts) === 1
		&& ready.projectId === PROJECT.projectId && !ready.cancelledByDelete,
	`${target.packetId}: repaired job did not reach enriched generation 1`);
	const after = await auditTarget(target, slot.memoryUserId);
	assert(after.complete, `${target.packetId}: production-primary repair accounting failed`);
	return {
		target,
		skippedAlreadyComplete: false,
		response: {
			status: response.status,
			elapsedMs: response.elapsedMs,
			fired: response.body.fired === true,
			held: integer(response.body.held),
		},
		ready,
		before,
		after,
	};
}

async function main() {
	const lock = acquireBenchmarkLock(GLOBAL_LOCK, { experiment: "final-stage-e-v3-d04-exact-repair" });
	try {
		assertReferenceBlindBoundary();
		validateProductInputs();
		await assertBillingPreflight();
		await expectedHealthActive();
		const burnBefore = await burnSnapshot("StageE:V3-D04:before", 30_000, STAGE_START);
		const data = productInputs();
		const slots = cohorts().control;
		const ingests = readJsonl(INGEST_LEDGER);
		assert(ingests.length === 272, "Stage E ingest ledger changed");
		const preflight = [];
		const auditOnly = process.argv.includes("--audit-only");
		for (const target of TARGETS) {
			const { slot } = targetInput(data, slots, target);
			const state = await auditTarget(target, slot.memoryUserId);
			if (!auditOnly) {
				const pristine = state.job?.status === "enriched" && integer(state.job?.attempts) === 0
					&& state.atomicRuns.length === 2
					&& state.atomicRuns.filter((row) => row.status === "completed").length === 1
					&& state.atomicRuns.filter((row) => row.status === "running").length === 1;
				assert(pristine || state.complete, `${target.packetId}: preflight state is neither pristine nor complete`);
			}
			preflight.push({ target, state });
		}
		if (process.argv.includes("--preflight-only") || auditOnly) {
			console.log(JSON.stringify({ verdict: "PASS", referenceBlind: true, burnBefore, preflight }, null, 2));
			return;
		}
		const token = secret("ITSUKI_API_KEY");
		console.log("ITSUKI_API_KEY: LOADED");
		const repairs = [];
		for (const target of TARGETS) {
			lock.assertHeld();
			repairs.push(await replayTarget(token, data, slots, ingests, target));
		}
		const burnAfter = await burnSnapshot("StageE:V3-D04:after", 30_000, STAGE_START);
		writeJsonExclusive(ARTIFACT, {
			schema: "itsuki.v3-stage-e-v3-d04-production-reattack/v1",
			createdAt: new Date().toISOString(),
			deploymentId: "6d38a27a-972e-47f5-8bd6-9d7a6ac2df1d",
			workerVersion: "29bed9a0-78cb-44ee-a6b4-59cd4f8d7f3c",
			commit: "5b7ffec8fed8b2481340393b7615069ac9859306",
			referenceBlind: true,
			referenceFilesOpened: 0,
			productInputSha256: "e9818f2070e6b5a4860e3a7e0cbd706433a0c95c00049980f405fe34cccf10dd",
			burnBefore,
			burnAfter,
			neuronDeltaObserved: burnAfter.spent - burnBefore.spent,
			repairs,
			verdict: "PASS",
		});
		console.log(`V3-D04 PRODUCTION REATTACK PASS repairs=${repairs.length}`);
	} finally {
		lock.release();
	}
}

await main();
