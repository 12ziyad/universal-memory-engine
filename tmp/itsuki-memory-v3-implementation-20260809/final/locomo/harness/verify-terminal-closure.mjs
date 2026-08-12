import fs from "node:fs";
import path from "node:path";

import { OUTPUT, REPO, assert, writeJsonExclusive } from "./common.mjs";

const VERSION = "a38142b9-842a-4c4c-83bf-41f68d5e205d";
const DEPLOYMENT = "dc96a1df-0b65-497b-a674-f8ac9f90b5f6";
const RESULT = path.join(OUTPUT, "terminal-production-closure.json");
const DOMAINS = ["https://itsuki.app", "https://uml.gpmai.workers.dev"];
const expected = Object.freeze({
	parent: ["allowlist", 30],
	atomicCapture: ["off", 0],
	atomicProjection: ["off", 0],
	atomicCoalescing: ["off", 0],
	hybridRetrieval: ["allowlist", 10],
	sourceExpansion: ["off", 0],
	episodeFallback: ["off", 0],
	adaptiveContext: ["off", 0],
});

function value(config, name) {
	const match = new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`).exec(config);
	assert(match, `missing ${name}`);
	return match[1];
}

function count(config, name) {
	return value(config, name).split(",").map((entry) => entry.trim()).filter(Boolean).length;
}

function assertStatus(status, source) {
	assert(status?.mode === expected.parent[0]
		&& status?.allowlistCount === expected.parent[1], `${source}: parent mismatch`);
	for (const [key, [mode, allowlistCount]] of Object.entries(expected)) {
		if (key === "parent") continue;
		assert(status[key]?.mode === mode && status[key]?.allowlistCount === allowlistCount,
			`${source}: ${key} mismatch`);
	}
}

assert(!fs.existsSync(RESULT), "terminal production closure artifact already exists");
const config = fs.readFileSync(path.join(REPO, "wrangler.jsonc"), "utf8");
assert(value(config, "ITSUKI_MEMORY_V3") === "allowlist"
	&& count(config, "ITSUKI_MEMORY_V3_USERS") === 30, "local parent config mismatch");
for (const [modeKey, usersKey] of [
	["ITSUKI_MEMORY_V3_ATOMIC_CAPTURE", "ITSUKI_MEMORY_V3_ATOMIC_CAPTURE_USERS"],
	["ITSUKI_MEMORY_V3_ATOMIC_PROJECTION", "ITSUKI_MEMORY_V3_ATOMIC_PROJECTION_USERS"],
	["ITSUKI_MEMORY_V3_ATOMIC_COALESCING", "ITSUKI_MEMORY_V3_ATOMIC_COALESCING_USERS"],
	["ITSUKI_MEMORY_V3_SOURCE_EXPANSION", "ITSUKI_MEMORY_V3_SOURCE_EXPANSION_USERS"],
	["ITSUKI_MEMORY_V3_EPISODE_FALLBACK", "ITSUKI_MEMORY_V3_EPISODE_FALLBACK_USERS"],
	["ITSUKI_MEMORY_V3_ADAPTIVE_CONTEXT", "ITSUKI_MEMORY_V3_ADAPTIVE_CONTEXT_USERS"],
]) assert(value(config, modeKey) === "off" && count(config, usersKey) === 0,
	`${modeKey}: local terminal config mismatch`);
assert(value(config, "ITSUKI_MEMORY_V3_HYBRID_RETRIEVAL") === "allowlist"
	&& count(config, "ITSUKI_MEMORY_V3_HYBRID_RETRIEVAL_USERS") === 10,
"local E7 terminal config mismatch");

const checks = [];
for (const domain of DOMAINS) {
	for (let attempt = 1; attempt <= 10; attempt += 1) {
		const response = await fetch(`${domain}/health?v3-terminal=${Date.now()}-${attempt}-${Math.random()}`, {
			headers: { "cache-control": "no-cache" },
			signal: AbortSignal.timeout(30_000),
		});
		assert(response.ok, `${domain} attempt ${attempt}: health ${response.status}`);
		const status = (await response.json()).memory_v3;
		assertStatus(status, `${domain} attempt ${attempt}`);
		checks.push({ domain, attempt, status });
	}
}
assert(checks.length === 20, "propagation accounting mismatch");
const canonical = JSON.stringify(checks[0].status);
assert(checks.every((row) => JSON.stringify(row.status) === canonical),
	"production propagation snapshots disagree");

writeJsonExclusive(RESULT, {
	schema: "itsuki.v3-stage-e-terminal-production-closure/v1",
	verifiedAt: new Date().toISOString(),
	commit: "2816395",
	workerVersion: VERSION,
	deploymentId: DEPLOYMENT,
	trafficPercent: 100,
	localConfig: "PASS_SAFE",
	propagationPassed: checks.length,
	propagationChecked: 20,
	normalUsersEnabled: false,
	writeAndSourceLanes: "OFF",
	rejectedLanes: "OFF",
	hybridHistoricalAllowlistCount: 10,
	checks,
});
console.log(`STAGE E TERMINAL PRODUCTION CLOSURE PASS ${checks.length}/20`);
