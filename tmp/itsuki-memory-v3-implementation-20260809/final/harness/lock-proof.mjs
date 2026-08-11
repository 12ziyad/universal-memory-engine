import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { EVIDENCE, FINAL, GLOBAL_LOCK, REPO, assert } from "./common.mjs";

const DRIVER = path.join(path.dirname(new URL(import.meta.url).pathname.slice(1)), "live-reattack.mjs");
const PROOF = path.join(FINAL, "FINAL-LOCK-PROOF.json");

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitFor(predicate, timeoutMs, message) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await sleep(25);
	}
	throw new Error(message);
}

function snapshot() {
	const rows = [];
	function walk(directory) {
		if (!fs.existsSync(directory)) return;
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const target = path.join(directory, entry.name);
			if (entry.isDirectory()) walk(target);
			else if (entry.isFile()) {
				const stat = fs.statSync(target);
				rows.push({ path: target, bytes: stat.size, modifiedMs: stat.mtimeMs });
			}
		}
	}
	walk(EVIDENCE);
	return rows.sort((left, right) => left.path.localeCompare(right.path));
}

async function main() {
	assert(!fs.existsSync(GLOBAL_LOCK), "pre-existing benchmark lock");
	assert(!fs.existsSync(PROOF), "final lock proof already exists");
	const holder = spawn(process.execPath, [DRIVER, "lock-proof", "8000"], {
		cwd: REPO, stdio: "ignore", windowsHide: true,
	});
	const done = new Promise((resolve) => holder.once("exit", (code, signal) => resolve({ code, signal })));
	await waitFor(() => fs.existsSync(path.join(GLOBAL_LOCK, "owner.json")), 3_000, "holder did not acquire lock");
	const owner = JSON.parse(fs.readFileSync(path.join(GLOBAL_LOCK, "owner.json"), "utf8"));
	assert(owner.pid === holder.pid, "lock owner pid mismatch");
	const before = snapshot();
	const contender = spawnSync(process.execPath, [DRIVER, "lock-proof", "1000"], {
		cwd: REPO, encoding: "utf8", timeout: 5_000, windowsHide: true,
	});
	const after = snapshot();
	const holderResult = await done;
	assert(contender.error == null, `contender error: ${contender.error?.message}`);
	assert(contender.status === 73, `contender exit ${contender.status}; expected 73`);
	assert(JSON.stringify(before) === JSON.stringify(after), "contender changed final artifacts");
	assert(holderResult.code === 0 && holderResult.signal == null, "holder failed");
	assert(!fs.existsSync(GLOBAL_LOCK), "holder did not release lock");
	const proof = {
		schema: "itsuki.v3-final-lock-proof/v1", provedAt: new Date().toISOString(),
		lockPath: GLOBAL_LOCK,
		holder: { pid: owner.pid, experiment: owner.experiment, exit: holderResult.code },
		contender: { exit: contender.status, expectedExit: 73, stderr: String(contender.stderr ?? "").trim() },
		artifactSnapshot: { beforeCount: before.length, afterCount: after.length, unchanged: true },
		lockReleased: true,
	};
	fs.writeFileSync(PROOF, `${JSON.stringify(proof, null, 2)}\n`, { flag: "wx" });
	console.log(JSON.stringify(proof, null, 2));
}

main().catch((error) => { console.error(error.stack ?? error); process.exit(1); });
