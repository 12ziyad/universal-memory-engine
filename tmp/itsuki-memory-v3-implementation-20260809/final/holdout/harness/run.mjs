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
	RESULTS,
	STAGE_CAP,
	assert,
	burnSnapshot,
	readJson,
	shaFile,
	validateFrozenInputs,
	writeJsonAtomic,
} from "./common.mjs";

const require = createRequire(import.meta.url);
const { EXIT_LOCK_HELD, BenchmarkLockHeldError, acquireBenchmarkLock } = require("../../../e2/harness/benchmark-lock.cjs");

const MANIFEST = path.join(OUTPUT, "run-manifest.json");
const LOG = path.join(OUTPUT, "run.log");
const EVALUATOR_LOG = path.join(OUTPUT, "evaluator.log");

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
		spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
	}
	stream.end();
}

function productArtifactState(seed) {
	const files = [
		path.join(OUTPUT, `seed${seed}.product.json`),
		path.join(OUTPUT, `seed${seed}.product.seal.json`),
		path.join(OUTPUT, `seed${seed}.exports.json`),
	];
	const present = files.filter(fs.existsSync);
	if (present.length !== 0 && present.length !== files.length) {
		throw new Error(`seed${seed}: partial product artifact set ${present.length}/${files.length}; STOP, do not salvage`);
	}
	return { complete: present.length === files.length, files };
}

function validateProducts(seed) {
	const state = productArtifactState(seed);
	assert(state.complete, `seed${seed}: product artifacts missing`);
	const productFile = path.join(OUTPUT, `seed${seed}.product.json`);
	const product = readJson(productFile);
	const seal = readJson(path.join(OUTPUT, `seed${seed}.product.seal.json`));
	const exports = readJson(path.join(OUTPUT, `seed${seed}.exports.json`));
	assert(product.schema === "itsuki.v3-final-holdout-product/v1" && product.seed === seed
		&& product.answers.length === 42 && product.ingests.length === 10,
	`seed${seed}: product inconsistent`);
	assert(seal.seed === seed && seal.answers === 42 && seal.scenarios === 10
		&& seal.productSha256 === shaFile(productFile), `seed${seed}: seal inconsistent`);
	assert(exports.seed === seed && exports.scenarios.length === 10, `seed${seed}: exports inconsistent`);
}

function validateSeed(seed) {
	validateProducts(seed);
	const score = readJson(path.join(OUTPUT, `seed${seed}.scores.json`));
	assert(score.seed === seed && score.metrics.questions === 42, `seed${seed}: score inconsistent`);
	const cleanup = readJson(path.join(OUTPUT, `seed${seed}.cleanup.json`));
	assert(cleanup.seed === seed && cleanup.dirty === 0, `seed${seed}: cleanup inconsistent`);
}

async function main() {
	let lock;
	try {
		lock = acquireBenchmarkLock(GLOBAL_LOCK, { experiment: "final-stage-d-three-seed-holdout" });
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
		const guard = await import(GUARD_URL);
		assert(guard.preflight() === true, "Workers AI billing-path preflight failed");
		let manifest;
		let resume = false;
		if (fs.existsSync(MANIFEST)) {
			assert(fs.existsSync(LOG) && fs.existsSync(EVALUATOR_LOG), "Stage D manifest/log set is inconsistent");
			manifest = readJson(MANIFEST);
			assert(manifest.schema === "itsuki.v3-final-holdout-run/v1" && manifest.status === "running",
				"existing Stage D manifest is not resumable");
			assert(manifest.stageCap === STAGE_CAP && manifest.seeds?.length === 3, "Stage D resume manifest changed");
			resume = true;
			log = fs.createWriteStream(LOG, { flags: "a" });
			manifest.resumeEvents = [...(manifest.resumeEvents ?? []), {
				at: new Date().toISOString(),
				burn: await burnSnapshot("StageD:resume", 2_000),
			}];
			writeJsonAtomic(MANIFEST, manifest);
		} else {
			assert(!fs.existsSync(LOG) && !fs.existsSync(EVALUATOR_LOG), "Stage D log exists without manifest");
			const preflight = await burnSnapshot("StageD:preflight", 3_000);
			assert(preflight.stageSpent === 0,
				`Stage D inference burn changed before experiment (${preflight.stageSpent}); STOP`);
			manifest = {
				schema: "itsuki.v3-final-holdout-run/v1",
				status: "running",
				startedAt: new Date().toISOString(),
				frozen,
				stageCap: STAGE_CAP,
				preflight,
				seeds: [1, 2, 3].map((seed) => ({ seed, status: "pending" })),
			};
			writeJsonAtomic(MANIFEST, manifest);
			log = fs.createWriteStream(LOG, { flags: "wx" });
		}
		evaluator = await startEvaluator(resume);
		const env = {
			...process.env,
			ANSWER_MODEL: "@cf/openai/gpt-oss-120b",
			ANSWER_MAX_TOKENS: "1024",
			JUDGE_MODEL: "@cf/openai/gpt-oss-120b",
			BENCHMARK_LOCK_DIR: GLOBAL_LOCK,
			BENCHMARK_LOCK_TOKEN: lock.token,
		};
		for (const seed of [1, 2, 3]) {
			lock.assertHeld();
			const state = manifest.seeds[seed - 1];
			if (state.status === "complete") { validateSeed(seed); continue; }
			assert(["pending", "running"].includes(state.status), `seed${seed}: invalid state ${state.status}`);
			if (state.status === "pending") {
				state.status = "running";
				state.burnBefore = await burnSnapshot(`StageD:seed${seed}:before`, 3_000);
			} else {
				state.resumeEvents = [...(state.resumeEvents ?? []), {
					at: new Date().toISOString(),
					burn: await burnSnapshot(`StageD:seed${seed}:resume`, 3_000),
				}];
			}
			writeJsonAtomic(MANIFEST, manifest);
			const products = productArtifactState(seed);
			if (!products.complete) {
				await runChild(`Stage D seed ${seed} product`, [path.join(HERE, "product.mjs"), "run", String(seed)], env, log);
			}
			validateProducts(seed);
			if (!fs.existsSync(path.join(OUTPUT, `seed${seed}.scores.json`))) {
				await runChild(`Stage D seed ${seed} score`, [path.join(HERE, "score.mjs"), String(seed)], env, log);
			}
			if (!fs.existsSync(path.join(OUTPUT, `seed${seed}.cleanup.json`))) {
				await runChild(`Stage D seed ${seed} cleanup`, [path.join(HERE, "product.mjs"), "cleanup", String(seed)], env, log);
			}
			validateSeed(seed);
			state.burnAfter = await burnSnapshot(`StageD:seed${seed}:after`, 2_000);
			state.neuronDelta = state.burnAfter.spent - state.burnBefore.spent;
			state.status = "complete";
			state.completedAt = new Date().toISOString();
			writeJsonAtomic(MANIFEST, manifest);
		}
		await runChild("Stage D aggregate", [path.join(HERE, "aggregate.mjs")], env, log);
		manifest.summary = readJson(path.join(RESULTS, "summary.json"));
		manifest.finalBurn = await burnSnapshot("StageD:complete", 2_000);
		manifest.status = "complete";
		manifest.completedAt = new Date().toISOString();
		writeJsonAtomic(MANIFEST, manifest);
		console.log(`STAGE D COMPLETE: ${manifest.summary.verdict}`);
	} finally {
		await stopEvaluator(evaluator);
		if (log) log.end();
		lock.release();
	}
}

main().catch((error) => {
	console.error(`STAGE D DRIVER STOPPED: ${error.stack ?? error}`);
	process.exitCode = process.exitCode || 1;
});
