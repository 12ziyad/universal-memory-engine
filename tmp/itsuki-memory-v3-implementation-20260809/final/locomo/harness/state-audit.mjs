import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

import { GLOBAL_LOCK, HERE, REPO } from "./common.mjs";

const require = createRequire(import.meta.url);
const { EXIT_LOCK_HELD, BenchmarkLockHeldError, acquireBenchmarkLock }
	= require("../../../e2/harness/benchmark-lock.cjs");

async function main() {
	let lock;
	try {
		lock = acquireBenchmarkLock(GLOBAL_LOCK, { experiment: "final-stage-e-reference-blind-state-audit" });
	} catch (error) {
		if (error instanceof BenchmarkLockHeldError) {
			console.error(`LOCK_HELD: ${error.message}`);
			process.exitCode = EXIT_LOCK_HELD;
			return;
		}
		throw error;
	}
	try {
		const child = spawn(process.execPath, [path.join(HERE, "product.mjs"), "audit-state"], {
			cwd: REPO,
			env: {
				...process.env,
				BENCHMARK_LOCK_DIR: GLOBAL_LOCK,
				BENCHMARK_LOCK_TOKEN: lock.token,
			},
			stdio: "inherit",
			windowsHide: true,
		});
		const result = await new Promise((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", (code, signal) => resolve({ code, signal }));
		});
		if (result.code !== 0 || result.signal) {
			throw new Error(`state audit exited code=${result.code} signal=${result.signal ?? "none"}`);
		}
	} finally {
		lock.release();
	}
}

main().catch((error) => {
	console.error(`STAGE E STATE AUDIT STOPPED: ${error.stack ?? error}`);
	process.exitCode = process.exitCode || 1;
});
