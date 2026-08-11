import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import {
	GLOBAL_LOCK,
	HERE,
	REPO,
	STAGE_D,
	assert,
	sha,
	writeJsonExclusive,
} from "./common.mjs";

const PROOF = path.join(STAGE_D, "LOCK-PROOF.json");

function run(args) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, args, { cwd: REPO, windowsHide: true });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.once("error", reject);
		child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
	});
}

function inventory(dir) {
	if (!fs.existsSync(dir)) return [];
	const rows = [];
	const walk = (current) => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) walk(full);
			else rows.push({
				path: path.relative(dir, full).replaceAll("\\", "/"),
				bytes: fs.statSync(full).size,
				sha256: sha(fs.readFileSync(full)),
			});
		}
	};
	walk(dir);
	return rows.sort((a, b) => a.path.localeCompare(b.path));
}

async function waitForLock() {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (fs.existsSync(GLOBAL_LOCK)) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("holder did not acquire the global benchmark lock");
}

async function main() {
	assert(!fs.existsSync(PROOF), "Stage D lock proof already exists");
	assert(!fs.existsSync(GLOBAL_LOCK), "global benchmark lock was already held");
	const driver = path.join(HERE, "run.mjs");
	const holderPromise = run([driver, "--lock-proof-hold-ms", "4000"]);
	await waitForLock();
	const before = inventory(STAGE_D);
	const contender = await run([driver, "--lock-proof-hold-ms", "1000"]);
	const after = inventory(STAGE_D);
	assert(contender.code === 73 && contender.signal == null, `contender exit ${contender.code}/${contender.signal}`);
	assert(/LOCK_HELD:/.test(contender.stderr), "contender did not report LOCK_HELD");
	assert(JSON.stringify(after) === JSON.stringify(before), "contender wrote or changed an artifact before exit");
	const holder = await holderPromise;
	assert(holder.code === 0 && holder.signal == null, `holder exit ${holder.code}/${holder.signal}`);
	assert(!fs.existsSync(GLOBAL_LOCK), "holder did not release the global benchmark lock");
	writeJsonExclusive(PROOF, {
		schema: "itsuki.v3-final-holdout-lock-proof/v1",
		provedAt: new Date().toISOString(),
		globalLock: path.relative(REPO, GLOBAL_LOCK).replaceAll("\\", "/"),
		holderExit: holder.code,
		contenderExit: contender.code,
		contenderReportedLockHeld: true,
		artifactInventoryUnchanged: true,
		artifactsBefore: before.length,
		artifactsAfter: after.length,
		lockReleased: true,
	});
	console.log("Stage D benchmark lock proof PASS");
}

main().catch((error) => {
	console.error(`STAGE D LOCK PROOF STOPPED: ${error.stack ?? error}`);
	process.exit(1);
});
