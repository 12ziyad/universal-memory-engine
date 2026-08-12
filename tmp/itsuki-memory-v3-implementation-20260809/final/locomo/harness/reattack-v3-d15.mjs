import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { classifyMessage } from "../../../../../src/pipeline/trigger.js";

import {
	GLOBAL_LOCK,
	OUTPUT,
	assert,
	assertBillingPreflight,
	assertCleanCohort,
	burnSnapshot,
	cohorts,
	d1Select,
	eraseCohort,
	expectedHealthActive,
	integer,
	request,
	secret,
	sha,
	sqlQuote,
	stateCounts,
	validateProductInputs,
	waitReady,
	writeJsonExclusive,
} from "./common.mjs";

const require = createRequire(import.meta.url);
const { EXIT_LOCK_HELD, BenchmarkLockHeldError, acquireBenchmarkLock }
	= require("../../../e2/harness/benchmark-lock.cjs");

const RESULT = path.join(OUTPUT, "V3-D15-PRODUCTION-REATTACK-ATTEMPT-002.json");
const STAGE_E_START = 1_933_582;
const PROJECT_A = Object.freeze({ projectId: "v3-d15-reattack-alpha", projectName: "V3 D15 Reattack Alpha" });
const PROJECT_B = Object.freeze({ projectId: "v3-d15-reattack-beta", projectName: "V3 D15 Reattack Beta" });
const TERMINAL = new Set(["enriched", "failed", "completed"]);
const STABILITY_GRACE_MS = 45_000;

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizedCounts(value) {
	return Object.fromEntries(Object.entries(value ?? {}).map(([key, count]) => [key, integer(count)]));
}

function publicHealth(snapshots) {
	return snapshots.map(({ domain, status }) => ({ domain, memoryV3: status }));
}

async function packetState(slot, packetId) {
	const user = sqlQuote(slot.memoryUserId);
	const packet = sqlQuote(packetId);
	const [runs, receipts, jobs] = await d1Select([
		`SELECT id,status,receipt_id FROM extraction_runs
		 WHERE user_id=${user} AND source_packet_id=${packet} ORDER BY created_at,id`,
		`SELECT id,outcome,saved_total FROM receipts
		 WHERE user_id=${user} AND source_packet_id=${packet} ORDER BY created_at,id`,
		`SELECT id,status,receipt_id FROM memory_jobs
		 WHERE user_id=${user} AND source_packet_id=${packet} ORDER BY created_at,id`,
	]);
	return {
		packetId,
		runs: runs.results ?? [],
		receipts: receipts.results ?? [],
		jobs: jobs.results ?? [],
	};
}

function noWriteCount(snapshot) {
	return snapshot.receipts.filter((row) => row.outcome === "meaningful_no_write").length;
}

function terminalJobs(snapshot) {
	return snapshot.jobs.length > 0 && snapshot.jobs.every((row) => TERMINAL.has(row.status));
}

function assertNoWriteSnapshot(snapshot, expectedRuns, label) {
	assert(snapshot.runs.length === expectedRuns,
		`${label}: expected ${expectedRuns} extraction runs, found ${snapshot.runs.length}`);
	assert(snapshot.runs.every((row) => row.status === "skipped"),
		`${label}: non-skipped extraction outcome`);
	assert(noWriteCount(snapshot) === expectedRuns,
		`${label}: meaningful_no_write receipt count ${noWriteCount(snapshot)}/${expectedRuns}`);
	assert(snapshot.receipts.every((row) => row.outcome === "accepted" || row.outcome === "meaningful_no_write"),
		`${label}: unexpected receipt outcome`);
	assert(snapshot.receipts.filter((row) => row.outcome === "meaningful_no_write")
		.every((row) => integer(row.saved_total) === 0), `${label}: no-write receipt saved state`);
	assert(terminalJobs(snapshot), `${label}: owning job is not terminal`);
}

async function waitForPacketRuns(slot, packetId, minimum, timeoutMs = 180_000) {
	const started = Date.now();
	let snapshot = null;
	while (Date.now() - started < timeoutMs) {
		snapshot = await packetState(slot, packetId);
		if (snapshot.runs.length >= minimum && terminalJobs(snapshot)) return snapshot;
		await sleep(2_500);
	}
	throw new Error(`packet ${packetId} did not reach ${minimum} terminal extraction runs`);
}

function sourceMessage(id, content) {
	return {
		id,
		role: "user",
		content,
		sourceTime: "2026-08-12T12:00:00+05:30",
	};
}

async function ingestQuestion(token, slot, suffix, lane, project, content) {
	assert(["signal", "meaningful"].includes(classifyMessage(content)),
		`${lane}: local trigger precondition is not meaningful`);
	const body = {
		userId: slot.externalId,
		conversationId: `v3-d15-reattack-${lane}-${suffix}`,
		idempotencyKey: `itsuki-v3:final-d15-reattack:${suffix}:${lane}`,
		memoryScope: { ...project },
		flush: true,
		messages: [sourceMessage(`v3-d15-${lane}-${suffix}`, content)],
	};
	const response = await request(token, "POST", "/v1/ingest", {
		body,
		attempts: 3,
		timeoutMs: 300_000,
	});
	assert(response.ok && response.body?.ok === true,
		`${lane}: ingest failed ${response.status}/${response.body?.code ?? "not_ok"}`);
	assert(response.body?.source_packet_id && response.body?.job_id,
		`${lane}: accepted response omitted packet/job`);
	assert(integer(response.body?.source_episodes_written) === 1,
		`${lane}: source episode conservation failed`);
	assert(response.body?.fired === true, `${lane}: meaningful trigger did not fire`);
	const ready = await waitReady(token, slot.externalId, response.body.job_id);
	assert(ready.status !== "failed" && !ready.cancelledByDelete && ready.projectId === project.projectId,
		`${lane}: extraction did not settle safely`);
	return {
		packetId: response.body.source_packet_id,
		jobId: response.body.job_id,
		status: response.status,
		projectId: project.projectId,
		questionSha256: sha(content),
		ready,
	};
}

async function run() {
	assert(!fs.existsSync(RESULT), "V3-D15 production reattack artifact already exists");
	const frozen = validateProductInputs();
	const slots = cohorts().control;
	const slot = slots[4];
	const untouched = slots.filter((_, index) => index !== 4);
	const token = secret("ITSUKI_API_KEY");
	console.log("ITSUKI_API_KEY: LOADED");

	let pass = false;
	let failure = null;
	let health = null;
	let burnBefore = null;
	let burnAfter = null;
	let untouchedBefore = null;
	let untouchedAfter = null;
	let preclean = null;
	let initialClean = null;
	let alpha = null;
	let beta = null;
	let alphaInitial = null;
	let alphaFinal = null;
	let betaFinal = null;
	let stability = null;
	let cleanup = null;
	let finalClean = null;

	try {
		health = await expectedHealthActive();
		await assertBillingPreflight();
		burnBefore = await burnSnapshot("StageE:V3-D15-reattack-start", 3_000, STAGE_E_START);
		untouchedBefore = normalizedCounts(await stateCounts(untouched));
		preclean = await eraseCohort(token, [slot]);
		initialClean = await assertCleanCohort([slot]);

		const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
		alpha = await ingestQuestion(token, slot, suffix, "alpha", PROJECT_A,
			"I wonder what characteristics make information worth remembering for future conversations?");
		alphaInitial = await waitForPacketRuns(slot, alpha.packetId, 1);
		assertNoWriteSnapshot(alphaInitial, 1, "alpha initial no-write");

		beta = await ingestQuestion(token, slot, suffix, "beta", PROJECT_B,
			"I wonder how a general memory system should decide that conversational information is not durable?");
		alphaFinal = await waitForPacketRuns(slot, alpha.packetId, 2);
		betaFinal = await waitForPacketRuns(slot, beta.packetId, 1);
		assertNoWriteSnapshot(alphaFinal, 2, "alpha bounded reconsideration");
		assertNoWriteSnapshot(betaFinal, 1, "beta initial no-write");

		const beforeGrace = {
			alpha: await packetState(slot, alpha.packetId),
			beta: await packetState(slot, beta.packetId),
		};
		await sleep(STABILITY_GRACE_MS);
		const afterGrace = {
			alpha: await packetState(slot, alpha.packetId),
			beta: await packetState(slot, beta.packetId),
		};
		assertNoWriteSnapshot(afterGrace.alpha, 2, "alpha post-grace");
		assertNoWriteSnapshot(afterGrace.beta, 1, "beta post-grace");
		assert(JSON.stringify(beforeGrace) === JSON.stringify(afterGrace),
			"V3-D15 extraction lineage changed during stability grace");
		stability = { graceMs: STABILITY_GRACE_MS, stable: true, totalRuns: 3 };
		pass = true;
	} catch (error) {
		failure = String(error?.message ?? error).slice(0, 500);
	} finally {
		try {
			cleanup = await eraseCohort(token, [slot]);
			finalClean = await assertCleanCohort([slot]);
			untouchedAfter = normalizedCounts(await stateCounts(untouched));
			assert(JSON.stringify(untouchedAfter) === JSON.stringify(untouchedBefore),
				"V3-D15 reattack changed an untouched frozen tenant count");
			await sleep(20_000);
			burnAfter = await burnSnapshot("StageE:V3-D15-reattack-complete", 1_000, STAGE_E_START);
		} catch (cleanupError) {
			pass = false;
			failure = `${failure ? `${failure}; ` : ""}cleanup: ${String(cleanupError?.message ?? cleanupError)}`.slice(0, 500);
		}
	}

	writeJsonExclusive(RESULT, {
		schema: "itsuki.v3-stage-e-v3-d15-production-reattack/v1",
		createdAt: new Date().toISOString(),
		pass,
		failure,
		referenceBlind: true,
		referenceFilesOpened: 0,
		answers: 0,
		judgeRows: 0,
		scores: 0,
		frozen,
		health: health ? publicHealth(health) : null,
		preconditions: {
			controlSlotIndex: 4,
			onlyErasedControlTenantUsed: true,
			untouchedTenantCount: untouched.length,
			preclean,
			initialClean,
			untouchedBefore,
		},
		inputs: {
			alpha: alpha ? { ...alpha, ready: alpha.ready } : null,
			beta: beta ? { ...beta, ready: beta.ready } : null,
			rawContentPersistedInArtifact: false,
		},
		observed: {
			alphaInitial,
			alphaFinal,
			betaFinal,
			stability,
		},
		cleanup: { cleanup, finalClean, untouchedAfter },
		burnBefore,
		burnAfter,
		neuronDeltaObserved: burnBefore && burnAfter ? burnAfter.spent - burnBefore.spent : null,
	});
	assert(pass, `V3-D15 production reattack failed: ${failure ?? "unknown"}`);
	console.log("V3-D15 production reattack: PASS; 3 runs stable; cleanup zero");
}

let lock;
try {
	lock = acquireBenchmarkLock(GLOBAL_LOCK, { experiment: "StageE-V3-D15-production-reattack" });
	await run();
	lock.assertHeld();
} catch (error) {
	if (error instanceof BenchmarkLockHeldError) {
		console.error(`LOCK_HELD: ${error.message}`);
		process.exitCode = EXIT_LOCK_HELD;
	} else {
		console.error(`V3-D15 PRODUCTION REATTACK STOPPED: ${error?.stack ?? error}`);
		process.exitCode = process.exitCode || 1;
	}
} finally {
	lock?.release();
}
