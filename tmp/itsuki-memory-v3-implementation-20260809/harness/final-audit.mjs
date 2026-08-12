import fs from "node:fs";
import path from "node:path";

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")));
const required = [
	"V3_FINAL_REPORT.md", "V3_ARCHITECTURE.md", "V3_DECISION_LOG.md", "V3_DEFECTS.md",
	"V3_WORK_LEDGER.json", "V3_ABLATIONS.md", "V3_SECURITY_REPORT.md",
	"V3_CONCURRENCY_REPORT.md", "V3_SOAK_REPORT.md", "V3_BENCHMARK_REPORT.md",
	"V3_HOLDOUT_REPORT.md", "V3_MODEL_BAKEOFF.md", "V3_LICENSE_ATTRIBUTION.md",
	"V3_MIGRATION_LEDGER.md", "V3_COST_LEDGER.json", "V3_CLEANUP_LEDGER.md",
	"V3_HASH_MANIFEST.sha256", "checkpoint.md",
];
for (const file of required) {
	if (!fs.statSync(path.join(ROOT, file)).isFile()) throw new Error(`missing ${file}`);
}
for (const file of [
	"V3_WORK_LEDGER.json", "work-ledger.json", "V3_COST_LEDGER.json", "cost-ledger.json",
	"benchmark-ledger.json", "final/locomo/evidence/cleanup.json",
	"final/locomo/evidence/product.seal.json", "final/locomo/evidence/score-progress.json",
	"final/locomo/evidence/terminal-production-closure.json",
	"final/locomo/results/official-scorer-output.json",
	"final/locomo/results/stage-e-terminal-summary.json",
]) JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));

const summary = JSON.parse(fs.readFileSync(
	path.join(ROOT, "final/locomo/results/stage-e-terminal-summary.json"), "utf8"));
if (summary.officialTokenF1.questions !== 1_540
	|| Math.abs(summary.officialTokenF1.overall - 0.3608481959616888) > 1e-15
	|| summary.evidence.available !== 1_136
	|| summary.judge.completedRows !== 960
	|| summary.judge.accuracy !== null
	|| !summary.judge.partialAccuracyWithheld
	|| summary.cleanup.status !== "PASS_ZERO") throw new Error("terminal metrics invariant failed");

const closure = JSON.parse(fs.readFileSync(
	path.join(ROOT, "final/locomo/evidence/terminal-production-closure.json"), "utf8"));
if (closure.propagationPassed !== 20 || closure.writeAndSourceLanes !== "OFF"
	|| closure.normalUsersEnabled !== false) throw new Error("production closure invariant failed");
if (fs.existsSync(path.join(ROOT, "phase3-d04/evidence/.benchmark-driver.lock")))
	throw new Error("benchmark lock remains");

console.log("FINAL_DELIVERABLE_AUDIT PASS 18/18");
console.log("TERMINAL_METRICS_AUDIT PASS");
console.log("PRODUCTION_CLOSURE_AUDIT PASS 20/20");
console.log("BENCHMARK_LOCK_AUDIT PASS");
