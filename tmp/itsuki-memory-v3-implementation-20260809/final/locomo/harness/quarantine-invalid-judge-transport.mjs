import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import {
	AUTHORIZED_JUDGE_PREFIX,
	GLOBAL_LOCK,
	OUTPUT,
	PRIOR_TERMINAL_SHA256,
	RESULTS,
	assert,
	readJson,
	readJsonl,
	sha,
	shaFile,
	writeJsonAtomic,
	writeJsonExclusive,
} from "./common.mjs";

const require = createRequire(import.meta.url);
const { acquireBenchmarkLock } = require("../../../e2/harness/benchmark-lock.cjs");

const JUDGE = path.join(OUTPUT, "judge.jsonl");
const PROGRESS = path.join(OUTPUT, "score-progress.json");
const TERMINAL = path.join(RESULTS, "stage-e-terminal-summary.json");
const BACKUP = path.join(OUTPUT, "judge-tail-invalid-transport-attempt-001.full.jsonl");
const EVIDENCE = path.join(OUTPUT, "judge-tail-invalid-transport-attempt-001.json");
const TEMP = `${JUDGE}.transport-repair.tmp`;
const ORIGINAL_PREFIX_SHA256 = "1b01cf0573d84e5d0866dff5f8a163f94b43f9a48c009784235f1a643790a2b6";

function lines(rows) {
	return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

function main() {
	assert(!fs.existsSync(BACKUP) && !fs.existsSync(EVIDENCE) && !fs.existsSync(TEMP),
		"transport quarantine artifact already exists");
	assert(fs.existsSync(TERMINAL) && shaFile(TERMINAL) === PRIOR_TERMINAL_SHA256,
		"prior terminal boundary changed");
	const lock = acquireBenchmarkLock(GLOBAL_LOCK, {
		experiment: "final-stage-e-quarantine-invalid-judge-transport",
	});
	try {
		const rows = readJsonl(JUDGE);
		assert(rows.length > AUTHORIZED_JUDGE_PREFIX && rows.length < 1_540,
			`unexpected interrupted judge size ${rows.length}`);
		const prefixText = lines(rows.slice(0, AUTHORIZED_JUDGE_PREFIX));
		assert(sha(prefixText) === ORIGINAL_PREFIX_SHA256,
			"sealed 960-row judge prefix changed");
		const invalid = rows.filter((row, index) => index >= AUTHORIZED_JUDGE_PREFIX
			&& row.judge_error === "fetch failed");
		assert(invalid.length > 0 && invalid.every((row) => row.judgment === "WRONG"
			&& row.score === 0 && row.judge_retries === 5),
		"transport-invalid row classification changed");
		const invalidIds = new Set(invalid.map((row) => row.question_id));
		assert(invalidIds.size === invalid.length, "duplicate transport-invalid identity");
		const retained = rows.filter((row) => !invalidIds.has(row.question_id));
		assert(retained.length === rows.length - invalid.length
			&& retained.slice(0, AUTHORIZED_JUDGE_PREFIX).every((row, index) => row === rows[index]),
		"judge transport quarantine would alter the sealed prefix");

		fs.writeFileSync(TEMP, lines(retained), { flag: "wx" });
		fs.renameSync(JUDGE, BACKUP);
		fs.renameSync(TEMP, JUDGE);
		const progress = readJson(PROGRESS);
		assert(progress.status === "running_authorized_tail", "score progress is not resumable");
		progress.invalidAttempts = [...(progress.invalidAttempts ?? []), {
			id: "V3-H24",
			classification: "HARNESS_TRANSPORT_INVALID",
			at: new Date().toISOString(),
			rowsBefore: rows.length,
			validRowsRetained: retained.length,
			invalidRowsQuarantined: invalid.length,
			invalidIdsSha256: sha([...invalidIds].sort().join("\n")),
			fullAttemptSha256: shaFile(BACKUP),
			activeLedgerSha256: shaFile(JUDGE),
			cause: "local Wrangler evaluator exited after internal loopback errors; no model verdict existed for fetch-failed rows",
		}];
		writeJsonAtomic(PROGRESS, progress);
		writeJsonExclusive(EVIDENCE, {
			schema: "itsuki.v3-stage-e-invalid-judge-transport/v1",
			defect: "V3-H24",
			status: "QUARANTINED_NOT_SCORED",
			rowsBefore: rows.length,
			validRowsRetained: retained.length,
			invalidRowsQuarantined: invalid.length,
			sealedPrefixRows: AUTHORIZED_JUDGE_PREFIX,
			sealedPrefixSha256: ORIGINAL_PREFIX_SHA256,
			fullAttemptSha256: shaFile(BACKUP),
			activeLedgerSha256: shaFile(JUDGE),
			invalidIdsSha256: sha([...invalidIds].sort().join("\n")),
			cleanup: "full invalid attempt retained privately; active ledger contains only actual model verdicts",
		});
		console.log(`V3-H24 QUARANTINED invalid=${invalid.length} retained=${retained.length}`);
	} finally {
		lock.release();
	}
}

main();
