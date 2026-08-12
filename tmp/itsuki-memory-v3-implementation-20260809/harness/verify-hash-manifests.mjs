import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")));
const WINDOWS_READ_ALIASES = new Map([
	["e3/evidence-attempt-004/rescore-v2-manifest.json", "e3/EVIDEN~3/RESCOR~1.JSO"],
	["e3/evidence-attempt-004/rescore-v2.log", "e3/EVIDEN~3/RESCOR~1.LOG"],
	["e3/evidence-attempt-004/seed1.scores-v2.json", "e3/EVIDEN~3/SEED1S~2.JSO"],
	["e3/evidence-attempt-004/seed2.scores-v2.json", "e3/EVIDEN~3/SEED2S~2.JSO"],
	["e3/evidence-attempt-004/seed3.scores-v2.json", "e3/EVIDEN~3/SEED3S~2.JSO"],
	["e3/results-attempt-004/summary-v2.json", "e3/RESULT~3/SUMMAR~2.JSO"],
]);

function readablePath(relative) {
	const alias = process.platform === "win32" ? WINDOWS_READ_ALIASES.get(relative) : null;
	return path.join(ROOT, ...(alias ?? relative).split("/"));
}

for (const manifest of ["V3_HASH_MANIFEST.sha256", "hashes.sha256"]) {
	const rows = fs.readFileSync(path.join(ROOT, manifest), "utf8")
		.split(/\r?\n/).filter(Boolean);
	for (const [index, row] of rows.entries()) {
		const match = /^([0-9a-f]{64})  (.+)$/.exec(row);
		if (!match) throw new Error(`${manifest}:${index + 1}: invalid row`);
		const file = readablePath(match[2]);
		if (!fs.statSync(file).isFile()) throw new Error(`${manifest}:${index + 1}: missing ${match[2]}`);
		const actual = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
		if (actual !== match[1]) throw new Error(`${manifest}:${index + 1}: hash mismatch ${match[2]}`);
	}
	console.log(`${manifest}: PASS ${rows.length}`);
}
