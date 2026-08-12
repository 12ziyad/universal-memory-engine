import path from "node:path";
import { createRequire } from "node:module";

import {
	GLOBAL_LOCK,
	OUTPUT,
	assert,
	assertCleanCohort,
	burnSnapshot,
	cohorts,
	d1Select,
	integer,
	secret,
	sqlQuote,
	writeJsonExclusive,
} from "./common.mjs";

const require = createRequire(import.meta.url);
const { acquireBenchmarkLock } = require("../../../e2/harness/benchmark-lock.cjs");
const RESULT = path.join(OUTPUT, "V3-H20-CONTAINMENT-CHECK.json");
const STAGE_E_START = 1_933_582;

async function snapshot(slot) {
	const user = sqlQuote(slot.memoryUserId);
	const [result] = await d1Select([`SELECT
	 (SELECT COUNT(*) FROM extraction_runs WHERE user_id=${user}) AS audit_runs,
	 (SELECT COUNT(*) FROM extraction_runs WHERE user_id=${user}
	  AND status IN ('deleted','cancelled_by_delete')) AS retired_runs,
	 (SELECT COUNT(*) FROM extraction_runs WHERE user_id=${user}
	  AND status NOT IN ('deleted','cancelled_by_delete')) AS extraction_runs,
	 (SELECT COUNT(*) FROM nodes WHERE user_id=${user} AND deleted_at IS NULL) AS nodes,
	 (SELECT COUNT(*) FROM slices WHERE user_id=${user} AND deleted_at IS NULL) AS slices,
	 (SELECT COUNT(*) FROM events WHERE user_id=${user} AND deleted_at IS NULL) AS events,
	 (SELECT COUNT(*) FROM edges WHERE user_id=${user} AND deleted_at IS NULL) AS edges,
	 (SELECT COUNT(*) FROM source_episodes WHERE user_id=${user}) AS episodes,
	 (SELECT COUNT(*) FROM semantic_atom_candidates WHERE user_id=${user}) AS candidates,
	 (SELECT COUNT(*) FROM memory_jobs WHERE user_id=${user}
	  AND status NOT IN ('enriched','failed','completed')) AS nonterminal_jobs`]);
	return Object.fromEntries(Object.entries(result.results?.[0] ?? {})
		.map(([key, value]) => [key, integer(value)]));
}

const lock = acquireBenchmarkLock(GLOBAL_LOCK, { experiment: "StageE-V3-D16-emergency-containment" });
try {
	const slot = cohorts().control[4];
	const token = secret("ITSUKI_API_KEY");
	console.log("ITSUKI_API_KEY: LOADED");
	const before = await snapshot(slot);
	const burnBefore = await burnSnapshot("StageE:V3-H20-containment-check-start", 1_000, STAGE_E_START);
	const clean = await assertCleanCohort([slot]);
	const after = await snapshot(slot);
	assert(after.extraction_runs === 0 && after.nonterminal_jobs === 0
		&& after.nodes === 0 && after.slices === 0 && after.events === 0
		&& after.edges === 0 && after.episodes === 0 && after.candidates === 0,
		`V3-H20 live containment residue: ${JSON.stringify(after)}`);
	assert(after.audit_runs === after.retired_runs,
		`V3-H20 extraction audit rows are not fully retired: ${JSON.stringify(after)}`);
	const burnAfter = await burnSnapshot("StageE:V3-H20-containment-check-complete", 1_000, STAGE_E_START);
	writeJsonExclusive(RESULT, {
		schema: "itsuki.v3-stage-e-v3-h20-containment-check/v1",
		createdAt: new Date().toISOString(),
		pass: true,
		referenceBlind: true,
		referenceFilesOpened: 0,
		answers: 0,
		judgeRows: 0,
		scores: 0,
		classification: "HARNESS_FALSE_POSITIVE",
		affectedSampleId: "conv-43",
		confirmedDeletionAlreadyCompleted: true,
		before,
		clean,
		after,
		burnBefore,
		burnAfter,
		neuronDeltaObserved: burnAfter.spent - burnBefore.spent,
	});
	console.log(`V3-H20 CHECK PASS active=0 retired=${after.retired_runs}`);
} finally {
	lock.release();
}
