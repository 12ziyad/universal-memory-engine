import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

import {
	GLOBAL_LOCK,
	GUARD_URL,
	HERE,
	OUTPUT,
	REPO,
	READER_MODEL,
	RESULTS,
	STAGE_CAP,
	assert,
	assertBillingPreflight,
	assertCleanCohort,
	burnSnapshot,
	cohorts,
	readJson,
	shaFile,
	validateFrozenInputs,
	writeJsonAtomic,
} from "./common.mjs";

const require = createRequire(import.meta.url);
const { EXIT_LOCK_HELD, BenchmarkLockHeldError, acquireBenchmarkLock }
	= require("../../../e2/harness/benchmark-lock.cjs");

const MANIFEST = path.join(OUTPUT, "run-manifest.json");
const LOG = path.join(OUTPUT, "run.log");
const EVALUATOR_LOG = path.join(OUTPUT, "evaluator.log");
const PRODUCT = path.join(OUTPUT, "product.json");
const SEAL = path.join(OUTPUT, "product.seal.json");
const SCORES = path.join(OUTPUT, "scores.json");
const CLEANUP = path.join(OUTPUT, "cleanup.json");

function runChild(name, args, env, log) {
	return new Promise((resolve, reject) => {
		log.write(`\n=== ${new Date().toISOString()} ${name} ===\n`);
		const child = spawn(process.execPath, args, { cwd: REPO, env, windowsHide: true });
		const tee = (chunk, stream) => { stream.write(chunk); log.write(chunk); };
		child.stdout.on("data", (chunk) => tee(chunk, process.stdout));
		child.stderr.on("data", (chunk) => tee(chunk, process.stderr));
		child.once("error", reject);
		child.once("exit", (code, signal) => code === 0 && !signal
			? resolve()
			: reject(new Error(`${name} exited code=${code} signal=${signal ?? "none"}`)));
	});
}

async function waitEvaluator(child) {
	for (let attempt = 0; attempt < 120; attempt += 1) {
		if (child.exitCode !== null) throw new Error(`evaluator exited early with code ${child.exitCode}`);
		try {
			const response = await fetch("http://127.0.0.1:8799/health");
			if (response.ok) return;
		} catch { /* not ready */ }
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error("local evaluator did not become healthy within 60 seconds");
}

async function startEvaluator(resume) {
	try {
		const response = await fetch("http://127.0.0.1:8799/health");
		if (response.ok) throw new Error("port 8799 already has a healthy process; ownership is ambiguous");
	} catch (error) {
		if (/ownership is ambiguous/.test(String(error?.message))) throw error;
	}
	const stream = fs.createWriteStream(EVALUATOR_LOG, { flags: resume ? "a" : "wx" });
	const child = spawn(process.execPath, [
		path.join(REPO, "node_modules", "wrangler", "bin", "wrangler.js"),
		"dev", "--port", "8799", "--var", "EVAL_MODE:1",
	], { cwd: REPO, env: process.env, windowsHide: true });
	child.stdout.pipe(stream);
	child.stderr.pipe(stream);
	await waitEvaluator(child);
	return { child, stream };
}

async function stopEvaluator(evaluator) {
	if (!evaluator) return;
	const { child, stream } = evaluator;
	if (child.exitCode === null) child.kill("SIGTERM");
	await Promise.race([
		new Promise((resolve) => child.once("exit", resolve)),
		new Promise((resolve) => setTimeout(resolve, 5_000)),
	]);
	if (child.exitCode === null) {
		spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"],
			{ windowsHide: true, stdio: "ignore" });
	}
	stream.end();
}

function validateProduct() {
	assert(fs.existsSync(PRODUCT) && fs.existsSync(SEAL), "Stage E sealed product is missing");
	const product = readJson(PRODUCT);
	const seal = readJson(SEAL);
	assert(product.schema === "itsuki.v3-stage-e-product/v1"
		&& product.answers.length === 1_540 && product.ingests.length === 272,
	"Stage E product is inconsistent");
	assert(seal.productSha256 === shaFile(PRODUCT) && seal.questions === 1_540
		&& seal.sessions === 272 && seal.messages === 5_882,
	"Stage E product seal is inconsistent");
	return { productSha256: seal.productSha256, neuronDeltaObserved: product.neuronDeltaObserved };
}

function validateScores() {
	assert(fs.existsSync(SCORES), "Stage E score artifact is missing");
	const score = readJson(SCORES);
	assert(score.schema === "itsuki.v3-stage-e-scores/v1" && score.accounting.reconciles
		&& score.accounting.productAnswers === 1_540 && score.accounting.officialScores === 1_540
		&& score.accounting.judgeVerdicts === 1_540,
	"Stage E score accounting is inconsistent");
	return score;
}

function validateCleanup() {
	assert(fs.existsSync(CLEANUP), "Stage E cleanup artifact is missing");
	const cleanup = readJson(CLEANUP);
	assert(cleanup.schema === "itsuki.v3-stage-e-cleanup/v1" && cleanup.dirty === 0
		&& cleanup.fts.episodeFts === 0 && cleanup.fts.semanticFts === 0,
	"Stage E cleanup is inconsistent");
	return cleanup;
}

async function main() {
	let lock;
	try {
		lock = acquireBenchmarkLock(GLOBAL_LOCK, { experiment: "final-stage-e-complete-locomo" });
	} catch (error) {
		if (error instanceof BenchmarkLockHeldError) {
			console.error(`LOCK_HELD: ${error.message}`);
			process.exitCode = EXIT_LOCK_HELD;
			return;
		}
		throw error;
	}
	let evaluator = null;
	let log = null;
	try {
		const proofIndex = process.argv.indexOf("--lock-proof-hold-ms");
		if (proofIndex >= 0) {
			const ms = Number(process.argv[proofIndex + 1] ?? 5_000);
			assert(Number.isFinite(ms) && ms > 0 && ms <= 30_000, "invalid lock-proof duration");
			await new Promise((resolve) => setTimeout(resolve, ms));
			return;
		}
		fs.mkdirSync(OUTPUT, { recursive: true });
		fs.mkdirSync(RESULTS, { recursive: true });
		const frozen = validateFrozenInputs();
		await assertBillingPreflight();
		const guard = await import(GUARD_URL);
		assert(guard.preflight() === true, "Workers AI billing-path preflight failed");
		let manifest;
		let resume = false;
		if (fs.existsSync(MANIFEST)) {
			assert(fs.existsSync(LOG) && fs.existsSync(EVALUATOR_LOG),
				"Stage E manifest/log set is inconsistent");
			manifest = readJson(MANIFEST);
			assert(manifest.schema === "itsuki.v3-stage-e-run/v1" && manifest.status === "running",
				"existing Stage E manifest is not resumable");
			assert(manifest.stageCap === STAGE_CAP && Number.isInteger(manifest.stageStartSpent),
				"Stage E resume manifest changed");
			resume = true;
			log = fs.createWriteStream(LOG, { flags: "a" });
			manifest.resumeEvents = [...(manifest.resumeEvents ?? []), {
				at: new Date().toISOString(),
				burn: await burnSnapshot("StageE:resume", 20_000, manifest.stageStartSpent),
			}];
			writeJsonAtomic(MANIFEST, manifest);
		} else {
			assert(!fs.existsSync(LOG) && !fs.existsSync(EVALUATOR_LOG),
				"Stage E log exists without manifest");
			assert(!fs.existsSync(PRODUCT) && !fs.existsSync(SEAL) && !fs.existsSync(SCORES)
				&& !fs.existsSync(CLEANUP), "Stage E final artifact exists without manifest");
			const clean = await assertCleanCohort(cohorts().control);
			const preflight = await burnSnapshot("StageE:preflight", STAGE_CAP, null);
			manifest = {
				schema: "itsuki.v3-stage-e-run/v1",
				status: "running",
				startedAt: new Date().toISOString(),
				frozen,
				clean,
				stageCap: STAGE_CAP,
				stageStartSpent: preflight.spent,
				preflight,
				steps: { product: "pending", score: "pending", cleanup: "pending" },
			};
			writeJsonAtomic(MANIFEST, manifest);
			log = fs.createWriteStream(LOG, { flags: "wx" });
		}
		evaluator = await startEvaluator(resume);
		const env = {
			...process.env,
			ANSWER_MODEL: READER_MODEL,
			ANSWER_MAX_TOKENS: "1024",
			JUDGE_MODEL: READER_MODEL,
			BENCHMARK_LOCK_DIR: GLOBAL_LOCK,
			BENCHMARK_LOCK_TOKEN: lock.token,
			STAGE_E_START_SPENT: String(manifest.stageStartSpent),
		};
		lock.assertHeld();
		if (!(fs.existsSync(PRODUCT) && fs.existsSync(SEAL))) {
			manifest.steps.product = "running";
			writeJsonAtomic(MANIFEST, manifest);
			await runChild("Stage E reference-blind product", [path.join(HERE, "product.mjs"), "run"], env, log);
		}
		manifest.product = validateProduct();
		manifest.steps.product = "complete";
		writeJsonAtomic(MANIFEST, manifest);
		lock.assertHeld();
		if (!fs.existsSync(SCORES)) {
			manifest.steps.score = "running";
			writeJsonAtomic(MANIFEST, manifest);
			await runChild("Stage E post-seal score", [path.join(HERE, "score.mjs")], env, log);
		}
		manifest.summary = validateScores();
		manifest.steps.score = "complete";
		writeJsonAtomic(MANIFEST, manifest);
		lock.assertHeld();
		if (!fs.existsSync(CLEANUP)) {
			manifest.steps.cleanup = "running";
			writeJsonAtomic(MANIFEST, manifest);
			await runChild("Stage E cleanup", [path.join(HERE, "product.mjs"), "cleanup"], env, log);
		}
		manifest.cleanup = validateCleanup();
		manifest.steps.cleanup = "complete";
		manifest.finalBurn = manifest.cleanup.burnAfter;
		manifest.status = "complete";
		manifest.completedAt = new Date().toISOString();
		writeJsonAtomic(MANIFEST, manifest);
		console.log(`STAGE E COMPLETE judge=${(manifest.summary.overall.judgeAccuracy * 100).toFixed(2)}% tokenF1=${(manifest.summary.overall.tokenF1 * 100).toFixed(2)}%`);
	} finally {
		await stopEvaluator(evaluator);
		if (log) log.end();
		lock.release();
	}
}

main().catch((error) => {
	console.error(`STAGE E DRIVER STOPPED: ${error.stack ?? error}`);
	process.exitCode = process.exitCode || 1;
});
