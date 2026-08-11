import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")));
const MANIFEST = path.join(ROOT, "V3_HASH_MANIFEST.sha256");
const additions = [
	"harness/update-v3-hash-manifest.mjs",
	"e9/E9A-SOURCE-EXPANSION-PREREGISTRATION.md",
	"e9/E9A-METER-BOUNDARY-ADDENDUM.md",
	"e9/E9A-SOURCE-EXPANSION-RESULT.md",
	"e9/E9A-IMPLEMENTATION-GATES.md",
	"e9/FAILING-FIRST.md",
	"e9/LOCK-PROOF.json",
	"e9/harness/common.mjs",
	"e9/harness/driver.mjs",
	"e9/harness/prove-lock.mjs",
	"e9/harness/verify-config.mjs",
	"e9/evidence/state.exports.json",
	"e9/evidence/state.json",
	"e9/evidence/control.product.json",
	"e9/evidence/control.product.seal.json",
	"e9/evidence/treatment.product.json",
	"e9/evidence/treatment.product.seal.json",
	"e9/evidence/control.evaluator.log",
	"e9/evidence/treatment.evaluator.log",
	"e9/evidence/score.evaluator.log",
	"e9/evidence/cleanup.json",
	"e9/results/detailed.json",
	"e9/results/summary.json",
	"e9b/E9B-EPISODE-FALLBACK-PREREGISTRATION.md",
	"e9b/E9B-IMPLEMENTATION-GATES.md",
	"e9b/E9B-DEPLOYMENT-OFF-PROOF.md",
	"e9b/E9B-EPISODE-FALLBACK-RESULT.md",
	"e9b/FAILING-FIRST.md",
	"e9b/INVALID-CONTROL-PREFLIGHT-01.md",
	"e9b/INVALID-TREATMENT-PREFLIGHT-01.md",
	"e9b/LOCK-PROOF.json",
	"e9b/harness/common.mjs",
	"e9b/harness/driver.mjs",
	"e9b/harness/prove-lock.mjs",
	"e9b/harness/verify-config.mjs",
	"e9b/evidence/state.exports.json",
	"e9b/evidence/state.json",
	"e9b/evidence/control.product.json",
	"e9b/evidence/control.product.seal.json",
	"e9b/evidence/treatment.product.json",
	"e9b/evidence/treatment.product.seal.json",
	"e9b/evidence/control.evaluator.log",
	"e9b/evidence/treatment.evaluator.log",
	"e9b/evidence/score.evaluator.log",
	"e9b/evidence/cleanup.json",
	"e9b/results/detailed.json",
	"e9b/results/summary.json",
	"e10/E10-ADAPTIVE-CONTEXT-PREREGISTRATION.md",
	"e10/E10-IMPLEMENTATION-GATES.md",
	"e10/E10-DEPLOYMENT-OFF-PROOF.md",
	"e10/E10-ADAPTIVE-CONTEXT-RESULT.md",
	"e10/FAILING-FIRST.md",
	"e10/LOCK-PROOF.json",
	"e10/harness/common.mjs",
	"e10/harness/driver.mjs",
	"e10/harness/lock-proof.mjs",
	"e10/evidence/state.exports.json",
	"e10/evidence/state.json",
	"e10/evidence/control.product.json",
	"e10/evidence/control.product.seal.json",
	"e10/evidence/treatment.product.json",
	"e10/evidence/treatment.product.seal.json",
	"e10/evidence/control.evaluator.log",
	"e10/evidence/treatment.evaluator.log",
	"e10/evidence/score.evaluator.log",
	"e10/evidence/cleanup.json",
	"e10/results/detailed.json",
	"e10/results/summary.json",
	"final/holdout/LOCK-PROOF.json",
	"final/holdout/STAGE-D-HOLDOUT-PREREGISTRATION.md",
	"final/holdout/STAGE-D-ACTIVATION.md",
	"final/holdout/STAGE-D-FINAL.md",
	"final/holdout/harness-manifest.json",
	"final/holdout/harness/common.mjs",
	"final/holdout/harness/product.mjs",
	"final/holdout/harness/score.mjs",
	"final/holdout/harness/aggregate.mjs",
	"final/holdout/harness/run.mjs",
	"final/holdout/harness/lock-proof.mjs",
	"final/holdout/harness/verify-config.mjs",
	"final/holdout/evidence/run.log",
	"final/holdout/evidence/evaluator.log",
	"final/holdout/evidence/run-manifest.json",
	"final/holdout/evidence/seed1.product.json",
	"final/holdout/evidence/seed1.product.seal.json",
	"final/holdout/evidence/seed1.scores.json",
	"final/holdout/evidence/seed1.cleanup.json",
	"final/holdout/evidence/seed2.product.json",
	"final/holdout/evidence/seed2.product.seal.json",
	"final/holdout/evidence/seed2.scores.json",
	"final/holdout/evidence/seed2.cleanup.json",
	"final/holdout/evidence/seed3.product.json",
	"final/holdout/evidence/seed3.product.seal.json",
	"final/holdout/evidence/seed3.scores.json",
	"final/holdout/evidence/seed3.cleanup.json",
	"final/holdout/results/summary.json",
];

const existing = fs.readFileSync(MANIFEST, "utf8")
	.split(/\r?\n/)
	.filter(Boolean)
	.map((line) => line.slice(66))
	.filter((relative) => relative && relative !== "V3_HASH_MANIFEST.sha256");
const files = [...new Set([...existing, ...additions])].sort();
const lines = files.map((relative) => {
	const full = path.join(ROOT, ...relative.split("/"));
	if (!fs.statSync(full).isFile()) throw new Error(`not a file: ${relative}`);
	const digest = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
	return `${digest}  ${relative}`;
}).sort();
fs.writeFileSync(MANIFEST, `${lines.join("\n")}\n`);
console.log(`${lines.length} selected V3 artifacts hashed`);
