import path from "node:path";
import { createRequire } from "node:module";

import {
	EVIDENCE,
	GLOBAL_LOCK,
	assert,
	cohorts,
	d1Select,
	eraseCohort,
	integer,
	memoryCountsAreZero,
	secret,
	sqlQuote,
	stateCounts,
	validateInputs,
	writeJsonExclusive,
} from "./common.mjs";

const require = createRequire(import.meta.url);
const { EXIT_LOCK_HELD, BenchmarkLockHeldError, acquireBenchmarkLock } = require("../../e2/harness/benchmark-lock.cjs");
const RESULT = path.join(EVIDENCE, "stage-b-h13-invalid-cleanup.json");

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function queryMarkerAudit(slots) {
	const ids = slots.map((slot) => sqlQuote(slot.memoryUserId)).join(",");
	const [result] = await d1Select([`SELECT
		SUM(CASE WHEN source_type='query' AND source_mode='recall' THEN 1 ELSE 0 END) AS query_recall_rows,
		SUM(CASE WHEN NOT (source_type='query' AND source_mode='recall') THEN 1 ELSE 0 END) AS non_query_rows
	 FROM source_packets WHERE user_id IN (${ids})
	 AND instr(lower(coalesce(content_preview,'') || ' ' || coalesce(raw_meta_json,'')),'marigoldorbit')>0`]);
	return result.results?.[0] ?? {};
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

async function run() {
	validateInputs();
	const slots = cohorts().treatment;
	const token = secret("ITSUKI_API_KEY");
	console.log("ITSUKI_API_KEY: LOADED");
	const classified = await queryMarkerAudit(slots);
	assert(integer(classified.query_recall_rows) === 10 && integer(classified.non_query_rows) === 0,
		`H13 classification changed: ${JSON.stringify(classified)}`);
	await eraseCohort(token, slots);
	await sleep(30_000);
	const counts = await stateCounts(slots);
	const packets = await packetPrivacyAudit(slots);
	assert(memoryCountsAreZero(counts), `H13 cleanup live residue: ${JSON.stringify(counts)}`);
	assert(integer(packets.content_rows) === 0 && integer(packets.minimized) === integer(packets.packets),
		`H13 cleanup packet residue: ${JSON.stringify(packets)}`);
	writeJsonExclusive(RESULT, {
		schema: "itsuki.v3-final-stage-b-h13-invalid-cleanup/v1", at: new Date().toISOString(), pass: true,
		classified: Object.fromEntries(Object.entries(classified).map(([key, value]) => [key, integer(value)])),
		counts, packets: Object.fromEntries(Object.entries(packets).map(([key, value]) => [key, integer(value)])),
	});
	console.log("V3-H13 invalid-run cleanup: PASS");
}

let lock;
try {
	lock = acquireBenchmarkLock(GLOBAL_LOCK, { experiment: "FINAL-B-H13-CLEANUP" });
	await run();
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
