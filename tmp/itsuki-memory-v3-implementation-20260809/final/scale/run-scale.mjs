import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..", "..", "..");
const campaign = path.resolve(here, "..", "..");
const evidenceDir = path.join(campaign, "final", "scale", "evidence");
const outputArg = process.argv.indexOf("--output");
const outputName = outputArg >= 0 ? process.argv[outputArg + 1] : "stage-c-scale.json";
if (!outputName || path.basename(outputName) !== outputName || !outputName.endsWith(".json")) {
	throw new Error("--output must be a JSON basename");
}

const marker = "@@ITSUKI_STAGE_C_RESULT@@";
const vitest = path.join(repo, "node_modules", "vitest", "vitest.mjs");
const config = path.join(here, "vitest.config.mjs");

async function runOne(size) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [vitest, "run", "--config", config], {
			cwd: repo,
			env: { ...process.env, ITSUKI_FINAL_SCALE_SIZE: String(size) },
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		const consume = (chunk, stream) => {
			const text = chunk.toString();
			output += text;
			stream.write(text);
		};
		child.stdout.on("data", (chunk) => consume(chunk, process.stdout));
		child.stderr.on("data", (chunk) => consume(chunk, process.stderr));
		child.on("error", (error) => resolve({ size, exitCode: null, error: String(error), result: null }));
		child.on("close", (code) => {
			const line = output.split(/\r?\n/).find((entry) => entry.startsWith(marker));
			let result = null;
			let parseError = null;
			if (line) {
				try { result = JSON.parse(line.slice(marker.length)); }
				catch (error) { parseError = String(error); }
			}
			resolve({ size, exitCode: code, parseError, result });
		});
	});
}

const startedAt = new Date().toISOString();
const runs = [];
for (const size of [1_000, 10_000, 100_000]) {
	console.log(`STAGE-C scale ${size}: starting`);
	const run = await runOne(size);
	runs.push(run);
	console.log(`STAGE-C scale ${size}: process=${run.exitCode} artifact=${Boolean(run.result)}`);
}

const validResults = runs.map((run) => run.result).filter(Boolean);
const gates = {
	allArtifactsPresent: validResults.length === 3,
	allProcessesPassed: runs.every((run) => run.exitCode === 0),
	scopeSafe: validResults.every((run) => run.gates.scopeSafe),
	finalResultsBounded: validResults.every((run) => run.gates.finalResultsBounded),
	finalContextBounded: validResults.every((run) => run.gates.finalContextBounded),
	rawCandidateLoadsBounded: validResults.every((run) => run.gates.rawCandidateLoadsBounded),
	productDeleteConverged: validResults.every((run) => run.gates.productDeleteConverged),
	ftsDeleteConverged: validResults.every((run) => run.gates.ftsDeleteConverged),
};
const pass = Object.values(gates).every(Boolean);
const artifact = {
	schema: "itsuki.v3-final-stage-c-scale/v1",
	startedAt,
	completedAt: new Date().toISOString(),
	pass,
	localOnly: true,
	inferenceCalls: 0,
	sizes: [1_000, 10_000, 100_000],
	gates,
	runs,
};
fs.mkdirSync(evidenceDir, { recursive: true });
const output = path.join(evidenceDir, outputName);
fs.writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
console.log(`STAGE-C artifact: ${output}`);
console.log(`STAGE-C verdict: ${pass ? "PASS" : "FAIL"}`);
if (!pass) process.exitCode = 1;
