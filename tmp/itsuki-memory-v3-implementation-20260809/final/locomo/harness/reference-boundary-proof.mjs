import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { HERE, INPUT, STAGE_E, assert, shaFile, writeJsonExclusive } from "./common.mjs";

const PRODUCT = path.join(HERE, "product.mjs");
const PROOF = path.join(STAGE_E, "REFERENCE-BOUNDARY-PROOF.json");
const source = fs.readFileSync(PRODUCT, "utf8");
const raw = fs.readFileSync(INPUT, "utf8");
const input = JSON.parse(raw);

for (const forbidden of ["DATASET", "OFFICIAL_SCORER", "referenceRows", "judge-client",
	"reference_answer", "qa.answer", "qa.evidence", "adversarial_answer"]) {
	assert(!source.includes(forbidden), `product harness contains forbidden scoring/reference access: ${forbidden}`);
}
assert(source.includes("validateProductInputs") && !source.includes("validateFrozenInputs"),
	"product harness does not use the reference-blind validator exclusively");
for (const forbidden of ["reference", "answer", "adversarial_answer", "evidence", "judgment", "score"]) {
	assert(!new RegExp(`\\"${forbidden}\\"\\s*:`).test(raw),
		`product input contains forbidden field: ${forbidden}`);
}
assert(input.totals.questions === 1_540 && input.totals.messages === 5_882,
	"product input accounting changed");
const dry = spawnSync(process.execPath, [PRODUCT, "dry-run"], {
	cwd: HERE, windowsHide: true, encoding: "utf8",
});
assert(dry.status === 0, `reference-blind dry run failed: ${dry.stderr}`);
const dryResult = JSON.parse(dry.stdout);
assert(dryResult.referenceBlind === true && dryResult.frozen.referenceFilesOpened === 0,
	"dry run did not prove a zero-reference product boundary");
writeJsonExclusive(PROOF, {
	schema: "itsuki.v3-stage-e-reference-boundary-proof/v1",
	provedAt: new Date().toISOString(),
	productHarnessSha256: shaFile(PRODUCT),
	productInputSha256: shaFile(INPUT),
	productInputQuestions: input.totals.questions,
	productInputMessages: input.totals.messages,
	forbiddenProductImportsOrReads: 0,
	forbiddenProductInputFields: 0,
	referenceFilesOpenedByDryRun: 0,
	dryRun: dryResult,
	verdict: "PASS",
});
console.log(JSON.stringify({ verdict: "PASS", referenceFilesOpened: 0,
	questions: input.totals.questions, messages: input.totals.messages }));
