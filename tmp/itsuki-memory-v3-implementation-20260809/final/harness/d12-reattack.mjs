import path from "node:path";
import { createRequire } from "node:module";

import {
	EVIDENCE,
	GLOBAL_LOCK,
	PROJECT_ALPHA,
	assert,
	assertBillingPreflight,
	burnSnapshot,
	cohorts,
	contentDigest,
	d1Select,
	eraseCohort,
	expectedHealthActive,
	integer,
	memoryCountsAreZero,
	request,
	rulesDigest,
	secret,
	sqlQuote,
	stateCounts,
	validateInputs,
	writeJsonExclusive,
} from "./common.mjs";

const require = createRequire(import.meta.url);
const { EXIT_LOCK_HELD, BenchmarkLockHeldError, acquireBenchmarkLock } = require("../../e2/harness/benchmark-lock.cjs");
const PRECLEAN = path.join(EVIDENCE, "stage-b-d12-invalid-cleanup.json");
const RESULT = path.join(EVIDENCE, "v3-d12-production-reattack.json");

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function sourceMessage(id, content) {
	return { id, role: "user", content, sourceTime: "2026-08-11T12:00:00+05:30" };
}

async function packetPrivacyAudit(slots) {
	const ids = slots.map((slot) => sqlQuote(slot.memoryUserId)).join(",");
	const [result] = await d1Select([`SELECT COUNT(*) AS packets,
		SUM(CASE WHEN content_hash='itsuki-erased-source/v1' THEN 1 ELSE 0 END) AS minimized,
		SUM(CASE WHEN length(trim(coalesce(content_preview,'')))>0
			OR trim(coalesce(raw_meta_json,'{}')) NOT IN ('','{}')
			OR coalesce(message_count,0)<>0 THEN 1 ELSE 0 END) AS content_rows
	 FROM source_packets WHERE user_id IN (${ids})`]);
	return result.results?.[0] ?? {};
}

async function captureAudit(slot) {
	const user = sqlQuote(slot.memoryUserId);
	const [result] = await d1Select([`SELECT COUNT(*) AS runs,
		SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS running,
		SUM(CASE WHEN status='cancelled_by_delete' THEN 1 ELSE 0 END) AS cancelled,
		SUM(COALESCE(proposed_count,0)) AS proposed,
		SUM(COALESCE(accepted_count,0)) AS accepted,
		SUM(COALESCE(stored_count,0)) AS stored
	 FROM semantic_atom_capture_runs WHERE user_id=${user}`]);
	return result.results?.[0] ?? {};
}

async function waitForZero(slots, timeoutMs = 180_000) {
	const started = Date.now();
	let counts = await stateCounts(slots);
	while (!memoryCountsAreZero(counts) && Date.now() - started < timeoutMs) {
		await sleep(2_000);
		counts = await stateCounts(slots);
	}
	return { counts, elapsedMs: Date.now() - started, drained: memoryCountsAreZero(counts) };
}

async function cleanupInvalid() {
	validateInputs();
	const slots = cohorts().treatment;
	const slot = slots[3];
	const token = secret("ITSUKI_API_KEY");
	console.log("ITSUKI_API_KEY: LOADED");
	const before = await stateCounts([slot]);
	const captureBefore = await captureAudit(slot);
	await eraseCohort(token, slots);
	await sleep(30_000);
	const after = await stateCounts(slots);
	const packets = await packetPrivacyAudit(slots);
	assert(memoryCountsAreZero(after), `D12 invalid cleanup residue: ${JSON.stringify(after)}`);
	assert(integer(packets.content_rows) === 0 && integer(packets.minimized) === integer(packets.packets),
		`D12 invalid cleanup packet residue: ${JSON.stringify(packets)}`);
	writeJsonExclusive(PRECLEAN, {
		schema: "itsuki.v3-final-stage-b-d12-invalid-cleanup/v1", at: new Date().toISOString(), pass: true,
		before, captureBefore: Object.fromEntries(Object.entries(captureBefore).map(([key, value]) => [key, integer(value)])),
		after, packets: Object.fromEntries(Object.entries(packets).map(([key, value]) => [key, integer(value)])),
	});
	console.log("V3-D12 invalid-run cleanup: PASS");
}

async function reattack() {
	validateInputs();
	const slots = cohorts().treatment;
	const slot = slots[3];
	const token = secret("ITSUKI_API_KEY");
	console.log("ITSUKI_API_KEY: LOADED");
	const health = await expectedHealthActive();
	await assertBillingPreflight();
	const burnBefore = await burnSnapshot("FINAL-B:D12-start", 8_000);
	const rulesBefore = await rulesDigest(token, slot.externalId);
	await eraseCohort(token, slots);

	const suffix = String(Math.trunc(Date.now() / 1000) % 1_000_000);
	const marker = `d12racewillow${suffix}`;
	const body = {
		userId: slot.externalId,
		conversationId: `final-d12-${suffix}`,
		idempotencyKey: `itsuki-v3:final-d12:${suffix}`,
		memoryScope: { ...PROJECT_ALPHA },
		flush: true,
		messages: Array.from({ length: 20 }, (_, index) => sourceMessage(`d12-${index}`,
			index === 0 ? `My D12 pre-erasure codename is ${marker}.`
				: `D12 workload detail ${index} records a durable procedure checkpoint.`)),
	};
	const accepted = await request(token, "POST", "/v1/ingest", { body, attempts: 1, timeoutMs: 300_000 });
	assert(accepted.ok && accepted.body?.ok === true && integer(accepted.body.source_episodes_written) === 20,
		`D12 ingest failed ${accepted.status}/${accepted.body?.code}`);
	const deleted = await request(token, "DELETE", "/v1/memories", {
		query: { userId: slot.externalId, confirm: "true" }, attempts: 3, timeoutMs: 120_000,
	});
	assert(deleted.ok && deleted.body?.ok === true, `D12 delete failed ${deleted.status}`);
	const replay = await request(token, "POST", "/v1/ingest", { body, attempts: 1, timeoutMs: 60_000 });
	assert(replay.status === 409 && replay.body?.code === "source_write_erased" && replay.body?.retryable === false,
		`D12 replay fence failed ${replay.status}/${replay.body?.code}`);
	const drain = await waitForZero([slot]);
	assert(drain.drained, `D12 delete race did not converge: ${JSON.stringify(drain.counts)}`);
	const captureAfter = await captureAudit(slot);
	assert(integer(captureAfter.runs) === 0, `D12 late atomic run survived: ${JSON.stringify(captureAfter)}`);
	const recalled = await request(token, "POST", "/v1/recall", { body: {
		userId: slot.externalId,
		query: "What was my D12 pre-erasure codename?",
		limit: 200,
		recallScope: "project_only",
		memoryScope: { ...PROJECT_ALPHA },
	}, attempts: 1, timeoutMs: 120_000 });
	assert(recalled.ok && !String(recalled.body?.context ?? "").includes(marker), "D12 erased marker returned");

	await eraseCohort(token, slots);
	await sleep(30_000);
	const finalCounts = await stateCounts(slots);
	const packets = await packetPrivacyAudit(slots);
	assert(memoryCountsAreZero(finalCounts), `D12 final residue: ${JSON.stringify(finalCounts)}`);
	assert(integer(packets.content_rows) === 0 && integer(packets.minimized) === integer(packets.packets),
		`D12 final packet residue: ${JSON.stringify(packets)}`);
	assert(await rulesDigest(token, slot.externalId) === rulesBefore, "D12 changed account rules");
	const burnAfter = await burnSnapshot("FINAL-B:D12-complete", 1_000);

	writeJsonExclusive(RESULT, {
		schema: "itsuki.v3-final-d12-production-reattack/v1", at: new Date().toISOString(), pass: true,
		health: health.map(({ domain, status }) => ({ domain, memoryV3: status })), markerDigest: contentDigest(marker),
		accepted: { status: accepted.status, packetId: accepted.body.source_packet_id, jobId: accepted.body.job_id,
			episodesWritten: integer(accepted.body.source_episodes_written) },
		delete: { status: deleted.status, pendingJobs: integer(deleted.body.pending_jobs) },
		replay: { status: replay.status, code: replay.body.code, retryable: replay.body.retryable },
		drain, captureAfter: Object.fromEntries(Object.entries(captureAfter).map(([key, value]) => [key, integer(value)])),
		recall: { status: recalled.status, erasedMarkerAbsent: true },
		finalCleanup: { counts: finalCounts, packets: Object.fromEntries(Object.entries(packets)
			.map(([key, value]) => [key, integer(value)])) },
		rulesUnchanged: true, burnBefore, burnAfter,
		neuronDeltaObserved: burnAfter.spent - burnBefore.spent,
	});
	console.log("V3-D12 production reattack: PASS");
}

const command = process.argv[2];
let lock;
try {
	lock = acquireBenchmarkLock(GLOBAL_LOCK, { experiment: `FINAL-B-D12-${command ?? "missing"}` });
	if (command === "cleanup") await cleanupInvalid();
	else if (command === "reattack") await reattack();
	else throw new Error("usage: d12-reattack.mjs <cleanup|reattack>");
	lock.assertHeld();
} catch (error) {
	if (error instanceof BenchmarkLockHeldError) {
		console.error(error.message);
		process.exitCode = EXIT_LOCK_HELD;
	} else {
		console.error(error?.stack ?? error);
		process.exitCode = 1;
	}
} finally {
	lock?.release();
}
