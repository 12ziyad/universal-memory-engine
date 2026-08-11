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
	waitReady,
	writeJsonExclusive,
} from "./common.mjs";

const require = createRequire(import.meta.url);
const { EXIT_LOCK_HELD, BenchmarkLockHeldError, acquireBenchmarkLock } = require("../../e2/harness/benchmark-lock.cjs");
const RESULT = path.join(EVIDENCE, "v3-d11-production-reattack.json");
const PRECLEAN = path.join(EVIDENCE, "stage-b-d11-invalid-cleanup.json");
const TERMINAL = new Set(["enriched", "completed"]);
const RECALL_QUERY = "What is my immediate-read security codename?";

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function recallBody(slot) {
	return {
		userId: slot.externalId,
		query: RECALL_QUERY,
		limit: 200,
		recallScope: "project_only",
		memoryScope: { ...PROJECT_ALPHA },
	};
}

async function packetPrivacyAudit(slots) {
	const ids = slots.map((slot) => sqlQuote(slot.memoryUserId)).join(",");
	const [result] = await d1Select([`SELECT
		COUNT(*) AS packets,
		SUM(CASE WHEN content_hash='itsuki-erased-source/v1' THEN 1 ELSE 0 END) AS minimized,
		SUM(CASE WHEN length(trim(coalesce(content_preview,'')))>0
			OR trim(coalesce(raw_meta_json,'{}')) NOT IN ('','{}')
			OR coalesce(message_count,0)<>0 THEN 1 ELSE 0 END) AS content_rows
	 FROM source_packets WHERE user_id IN (${ids})`]);
	return result.results?.[0] ?? {};
}

async function queryPacketAudit(slot, packetId) {
	const user = sqlQuote(slot.memoryUserId);
	const packet = sqlQuote(packetId);
	const query = sqlQuote(RECALL_QUERY);
	const [result] = await d1Select([`SELECT COUNT(*) AS packet_rows,
		SUM(CASE WHEN source_type='query' AND source_mode='recall' THEN 1 ELSE 0 END) AS query_rows,
		SUM(CASE WHEN content_hash<>'itsuki-erased-source/v1' THEN 1 ELSE 0 END) AS live_hash_rows,
		SUM(CASE WHEN instr(coalesce(content_preview,''),${query})>0 THEN 1 ELSE 0 END) AS query_content_rows
	 FROM source_packets WHERE user_id=${user} AND id=${packet}`]);
	return result.results?.[0] ?? {};
}

async function cleanInvalidRun() {
	validateInputs();
	const slots = cohorts().treatment;
	const token = secret("ITSUKI_API_KEY");
	console.log("ITSUKI_API_KEY: LOADED");
	await eraseCohort(token, slots);
	await sleep(30_000);
	const counts = await stateCounts(slots);
	const packets = await packetPrivacyAudit(slots);
	assert(memoryCountsAreZero(counts), `D11 preclean live residue: ${JSON.stringify(counts)}`);
	assert(integer(packets.content_rows) === 0 && integer(packets.minimized) === integer(packets.packets),
		`D11 preclean packet residue: ${JSON.stringify(packets)}`);
	writeJsonExclusive(PRECLEAN, {
		schema: "itsuki.v3-final-stage-b-d11-invalid-cleanup/v1",
		at: new Date().toISOString(), pass: true, counts,
		packets: Object.fromEntries(Object.entries(packets).map(([key, value]) => [key, integer(value)])),
	});
	console.log("V3-D11 invalid-run cleanup: PASS");
}

async function reattack() {
	validateInputs();
	const slots = cohorts().treatment;
	const slot = slots[6];
	const token = secret("ITSUKI_API_KEY");
	console.log("ITSUKI_API_KEY: LOADED");
	const health = await expectedHealthActive();
	await assertBillingPreflight();
	const burnBefore = await burnSnapshot("FINAL-B:D11-start", 5_000);
	const rulesBefore = await rulesDigest(token, slot.externalId);

	// The invalid Stage B run and its API cleanup deliberately left this exact
	// query's content-free packet fence in place. A fixed Worker must renew the
	// read instead of returning the pre-fix permanent 409.
	const firstRead = await request(token, "POST", "/v1/recall", {
		body: recallBody(slot), attempts: 1, timeoutMs: 120_000,
	});
	assert(firstRead.ok && firstRead.body?.ok === true,
		`D11 identical post-erasure read failed ${firstRead.status}/${firstRead.body?.code}`);
	assert(firstRead.body.source_packet_id, "D11 read omitted source packet id");
	const renewed = await queryPacketAudit(slot, firstRead.body.source_packet_id);
	assert(integer(renewed.packet_rows) === 1 && integer(renewed.query_rows) === 1
		&& integer(renewed.live_hash_rows) === 1 && integer(renewed.query_content_rows) === 1,
		`D11 renewed query audit failed: ${JSON.stringify(renewed)}`);

	const suffix = String(Math.trunc(Date.now() / 1000) % 1_000_000);
	const marker = `d11writewillow${suffix}`;
	const writeBody = {
		userId: slot.externalId,
		conversationId: `final-d11-${suffix}`,
		idempotencyKey: `itsuki-v3:final-d11:${suffix}`,
		memoryScope: { ...PROJECT_ALPHA },
		flush: true,
		messages: [{
			id: "d11-write", role: "user",
			content: `My D11 write-fence codename is ${marker}.`,
			sourceTime: "2026-08-11T12:00:00+05:30",
		}],
	};
	const accepted = await request(token, "POST", "/v1/ingest", {
		body: writeBody, attempts: 1, timeoutMs: 300_000,
	});
	assert(accepted.ok && accepted.body?.ok === true, `D11 write failed ${accepted.status}/${accepted.body?.code}`);
	const ready = await waitReady(token, slot.externalId, accepted.body.job_id);
	assert(TERMINAL.has(ready.status), `D11 write did not settle: ${ready.status}`);

	const erased = await eraseCohort(token, [slot]);
	const writeReplay = await request(token, "POST", "/v1/ingest", {
		body: writeBody, attempts: 1, timeoutMs: 60_000,
	});
	assert(writeReplay.status === 409 && writeReplay.body?.code === "source_write_erased"
		&& writeReplay.body?.retryable === false,
		`D11 write replay fence regressed: ${writeReplay.status}/${writeReplay.body?.code}`);

	const secondRead = await request(token, "POST", "/v1/recall", {
		body: recallBody(slot), attempts: 1, timeoutMs: 120_000,
	});
	assert(secondRead.ok && secondRead.body?.ok === true,
		`D11 second post-erasure read failed ${secondRead.status}/${secondRead.body?.code}`);
	assert(secondRead.body.source_packet_id === firstRead.body.source_packet_id,
		"D11 renewed query changed deterministic packet identity");

	await eraseCohort(token, slots);
	await sleep(30_000);
	const counts = await stateCounts(slots);
	const packets = await packetPrivacyAudit(slots);
	assert(memoryCountsAreZero(counts), `D11 final live residue: ${JSON.stringify(counts)}`);
	assert(integer(packets.content_rows) === 0 && integer(packets.minimized) === integer(packets.packets),
		`D11 final packet residue: ${JSON.stringify(packets)}`);
	assert(await rulesDigest(token, slot.externalId) === rulesBefore, "D11 changed account rules");
	const burnAfter = await burnSnapshot("FINAL-B:D11-complete", 1_000);

	writeJsonExclusive(RESULT, {
		schema: "itsuki.v3-final-d11-production-reattack/v1",
		at: new Date().toISOString(), pass: true,
		health: health.map(({ domain, status }) => ({ domain, memoryV3: status })),
		queryDigest: contentDigest(RECALL_QUERY), markerDigest: contentDigest(marker),
		firstPostEraseRead: { status: firstRead.status, packetId: firstRead.body.source_packet_id,
			renewed: Object.fromEntries(Object.entries(renewed).map(([key, value]) => [key, integer(value)])) },
		write: { status: accepted.status, packetId: accepted.body.source_packet_id,
			jobId: accepted.body.job_id, jobStatus: ready.status },
		erasure: { apiClean: erased.clean },
		writeReplay: { status: writeReplay.status, code: writeReplay.body.code, retryable: writeReplay.body.retryable },
		secondPostEraseRead: { status: secondRead.status, samePacketIdentity: true },
		finalCleanup: { counts, packets: Object.fromEntries(Object.entries(packets)
			.map(([key, value]) => [key, integer(value)])) },
		rulesUnchanged: true, burnBefore, burnAfter,
		neuronDeltaObserved: burnAfter.spent - burnBefore.spent,
	});
	console.log("V3-D11 production reattack: PASS");
}

const command = process.argv[2];
let lock;
try {
	lock = acquireBenchmarkLock(GLOBAL_LOCK, { experiment: `FINAL-B-D11-${command ?? "missing"}` });
	if (command === "cleanup") await cleanInvalidRun();
	else if (command === "reattack") await reattack();
	else throw new Error("usage: d11-reattack.mjs <cleanup|reattack>");
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
