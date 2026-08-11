import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { GLOBAL_LOCK, HERE, OUTPUT, RESULTS, STAGE_E, assert, writeJsonExclusive } from "./common.mjs";

const RUNNER = path.join(HERE, "run.mjs");
const PROOF = path.join(STAGE_E, "LOCK-PROOF.json");

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function sha(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }

function snapshot() {
	const rows = [];
	for (const root of [OUTPUT, RESULTS]) {
		if (!fs.existsSync(root)) continue;
		for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
			if (!entry.isFile()) continue;
			const file = path.join(root, entry.name);
			rows.push({ file: path.relative(STAGE_E, file), bytes: fs.statSync(file).size, sha256: sha(file) });
		}
	}
	return rows.sort((a, b) => a.file.localeCompare(b.file));
}

async function main() {
	assert(!fs.existsSync(GLOBAL_LOCK), `pre-existing benchmark lock: ${GLOBAL_LOCK}`);
	assert(!fs.existsSync(PROOF), `lock proof already exists: ${PROOF}`);
	const first = spawn(process.execPath, [RUNNER, "--lock-proof-hold-ms", "6000"], {
		cwd: HERE, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
	});
	let firstOutput = "";
	first.stdout.on("data", (chunk) => { firstOutput += chunk; });
	first.stderr.on("data", (chunk) => { firstOutput += chunk; });
	for (let attempt = 0; attempt < 100 && !fs.existsSync(path.join(GLOBAL_LOCK, "owner.json")); attempt += 1)
		await sleep(50);
	assert(fs.existsSync(path.join(GLOBAL_LOCK, "owner.json")), "first driver never acquired lock");
	const before = snapshot();
	const second = spawnSync(process.execPath, [RUNNER, "--lock-proof-hold-ms", "1000"], {
		cwd: HERE, windowsHide: true, encoding: "utf8",
	});
	const after = snapshot();
	assert(second.status === 73, `second driver exited ${second.status}, expected 73`);
	assert(JSON.stringify(before) === JSON.stringify(after), "lock contender changed Stage E artifacts");
	const firstExit = await new Promise((resolve) => first.once("exit", (code, signal) => resolve({ code, signal })));
	assert(firstExit.code === 0 && !firstExit.signal,
		`lock owner failed ${JSON.stringify(firstExit)} ${firstOutput}`);
	assert(!fs.existsSync(GLOBAL_LOCK), "lock owner exited but lock remains");
	writeJsonExclusive(PROOF, {
		schema: "itsuki.v3-stage-e-lock-proof/v1",
		provedAt: new Date().toISOString(),
		firstDriverExit: firstExit.code,
		secondDriverExit: second.status,
		expectedContenderExit: 73,
		artifactsBeforeContender: before,
		artifactsAfterContender: after,
		artifactMutationsByContender: 0,
		lockReleasedByOwner: true,
		verdict: "PASS",
	});
	console.log(JSON.stringify({ verdict: "PASS", secondDriverExit: second.status,
		artifactMutationsByContender: 0, lockReleasedByOwner: true }));
}

main().catch((error) => { console.error(error.stack ?? error); process.exit(1); });
