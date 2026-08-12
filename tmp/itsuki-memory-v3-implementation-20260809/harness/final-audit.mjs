import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

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
	"final/locomo/evidence/scores.json",
	"final/locomo/evidence/judge-tail-invalid-transport-attempt-001.json",
	"final/locomo/evidence/terminal-production-closure.json",
	"final/locomo/results/official-scorer-output.json",
	"final/locomo/results/stage-e-terminal-summary.json",
]) JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));

const summary = JSON.parse(fs.readFileSync(
	path.join(ROOT, "final/locomo/results/stage-e-terminal-summary.json"), "utf8"));
if (summary.officialTokenF1.questions !== 1_540
	|| Math.abs(summary.officialTokenF1.overall - 0.3608481959616888) > 1e-15
	|| summary.evidence.available !== 1_136
	|| summary.judge.completedRows !== 1_540
	|| summary.judge.correct !== 931
	|| Math.abs(summary.judge.accuracy - 0.6045454545454545) > 1e-15
	|| summary.judge.conditionalCorrect !== 808
	|| Math.abs(summary.judge.conditionalAccuracy - 0.7112676056338029) > 1e-15
	|| summary.judge.absentEvidenceCorrect !== 123
	|| Math.abs(summary.judge.absentEvidenceAccuracy - 0.30445544554455445) > 1e-15
	|| summary.judge.partialAccuracyWithheld
	|| summary.judge.judgeErrorsCountedWrong !== 0
	|| summary.inference.campaignSpent !== 2_444_870
	|| summary.inference.campaignCeiling !== 3_000_000
	|| summary.inference.stageSpent !== 511_288
	|| summary.inference.stageCap !== 550_000
	|| summary.cleanup.status !== "PASS_ZERO") throw new Error("terminal metrics invariant failed");

const scores = JSON.parse(fs.readFileSync(
	path.join(ROOT, "final/locomo/evidence/scores.json"), "utf8"));
if (!scores.accounting.reconciles || scores.accounting.productAnswers !== 1_540
	|| scores.accounting.officialScores !== 1_540 || scores.accounting.judgeVerdicts !== 1_540
	|| scores.overall.judgeCorrect !== 931 || scores.overall.evidenceAvailable !== 1_136
	|| scores.overall.judgeErrorsCountedWrong !== 0 || !scores.inference.settled)
	throw new Error("complete score accounting invariant failed");

const progress = JSON.parse(fs.readFileSync(
	path.join(ROOT, "final/locomo/evidence/score-progress.json"), "utf8"));
if (progress.status !== "complete" || progress.judgeRows !== 1_540
	|| progress.finalBurn?.stageSpent !== 511_288 || progress.finalBurn?.stageRemaining !== 38_712
	|| progress.priorSpendStop?.judgeRows !== 960
	|| progress.priorSpendStop?.terminalSummarySha256 !== "944a5dc87d3b0418372b588b1b3c767d413f77a85db7ee193e762fe59428ff4e")
	throw new Error("score progress/completed-tail invariant failed");

const judgePath = path.join(ROOT, "final/locomo/evidence/judge.jsonl");
const judgeRaw = fs.readFileSync(judgePath, "utf8");
const judgeLines = judgeRaw.trimEnd().split(/\r?\n/);
const judgeRows = judgeLines.map((line) => JSON.parse(line));
const judgeIdentities = new Set(judgeRows.map((row) => `${row.sample_id}::${row.question_id}`));
const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
if (judgeRows.length !== 1_540 || judgeIdentities.size !== 1_540
	|| judgeRows.some((row) => row.judge_error)
	|| digest(judgeRaw) !== "411ff6161ee533c29b41872917e59f868a36f217bc8174c2be524a4a15c5f39b"
	|| digest(`${judgeLines.slice(0, 960).join("\n")}\n`) !== "1b01cf0573d84e5d0866dff5f8a163f94b43f9a48c009784235f1a643790a2b6")
	throw new Error("judge identity/prefix invariant failed");

const invalidTransport = JSON.parse(fs.readFileSync(
	path.join(ROOT, "final/locomo/evidence/judge-tail-invalid-transport-attempt-001.json"), "utf8"));
if (invalidTransport.status !== "QUARANTINED_NOT_SCORED"
	|| invalidTransport.invalidRowsQuarantined !== 40 || invalidTransport.validRowsRetained !== 1_220)
	throw new Error("V3-H24 quarantine invariant failed");

const closure = JSON.parse(fs.readFileSync(
	path.join(ROOT, "final/locomo/evidence/terminal-production-closure.json"), "utf8"));
if (closure.propagationPassed !== 20 || closure.writeAndSourceLanes !== "OFF"
	|| closure.normalUsersEnabled !== false) throw new Error("production closure invariant failed");
if (fs.existsSync(path.join(ROOT, "phase3-d04/evidence/.benchmark-driver.lock")))
	throw new Error("benchmark lock remains");

console.log("FINAL_DELIVERABLE_AUDIT PASS 18/18");
console.log("TERMINAL_METRICS_AUDIT PASS");
console.log("COMPLETE_SCORE_ACCOUNTING_AUDIT PASS 1540/1540");
console.log("JUDGE_IDENTITY_AUDIT PASS 1540/1540; SEALED_PREFIX PASS 960/960");
console.log("V3_H24_QUARANTINE_AUDIT PASS 40/40");
console.log("PRODUCTION_CLOSURE_AUDIT PASS 20/20");
console.log("BENCHMARK_LOCK_AUDIT PASS");
