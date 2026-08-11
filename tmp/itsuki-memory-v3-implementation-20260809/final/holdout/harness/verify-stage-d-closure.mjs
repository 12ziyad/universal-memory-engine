import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
	CAMPAIGN,
	GLOBAL_LOCK,
	REPO,
	assert,
	cohorts,
	d1Select,
	integer,
	memoryCountsAreZero,
	sqlQuote,
	stateCounts,
	writeJsonExclusive,
} from "../../harness/common.mjs";

const EVIDENCE = path.join(CAMPAIGN, "final", "holdout", "evidence");
const RESULT = path.join(EVIDENCE, "stage-d-closure.json");
const EXPECTED_COMMIT = "2484f772a79889dba0297f83b575d2c6fb2e99d9";
const EXPECTED_VERSION = "c85c7844-9e2e-426e-8f87-ee468296b572";
const EXPECTED_DEPLOYMENT = "cef8320d-afd0-4c9f-a4a5-690a2d149f68";
const wrangler = fs.readFileSync(path.join(REPO, "wrangler.jsonc"), "utf8");

function value(name) {
	const match = new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`).exec(wrangler);
	assert(match, `missing ${name}`);
	return match[1];
}

function ids(name) {
	return value(name).split(",").map((entry) => entry.trim()).filter(Boolean);
}

function assertOff(mode, users) {
	assert(value(mode) === "off", `${mode} is not off`);
	assert(ids(users).length === 0, `${users} is not empty`);
}

const parent = ids("ITSUKI_MEMORY_V3_USERS");
const historical = parent.slice(0, 10);
const hybrid = ids("ITSUKI_MEMORY_V3_HYBRID_RETRIEVAL_USERS");
const cohort = cohorts();
assert(value("ITSUKI_MEMORY_V3") === "allowlist" && parent.length === 30,
	"parent V3 closure mismatch");
assert(value("ITSUKI_MEMORY_V3_EXTRACTION_B1") === "off", "E2-B1 changed");
for (const [mode, users] of [
	["ITSUKI_MEMORY_V3_ATOMIC_CAPTURE", "ITSUKI_MEMORY_V3_ATOMIC_CAPTURE_USERS"],
	["ITSUKI_MEMORY_V3_ATOMIC_PROJECTION", "ITSUKI_MEMORY_V3_ATOMIC_PROJECTION_USERS"],
	["ITSUKI_MEMORY_V3_ATOMIC_COALESCING", "ITSUKI_MEMORY_V3_ATOMIC_COALESCING_USERS"],
	["ITSUKI_MEMORY_V3_SOURCE_EXPANSION", "ITSUKI_MEMORY_V3_SOURCE_EXPANSION_USERS"],
	["ITSUKI_MEMORY_V3_EPISODE_FALLBACK", "ITSUKI_MEMORY_V3_EPISODE_FALLBACK_USERS"],
	["ITSUKI_MEMORY_V3_ADAPTIVE_CONTEXT", "ITSUKI_MEMORY_V3_ADAPTIVE_CONTEXT_USERS"],
]) assertOff(mode, users);
assert(value("ITSUKI_MEMORY_V3_HYBRID_RETRIEVAL") === "allowlist", "E7 mode changed");
assert(hybrid.length === 10 && hybrid.every((id) => historical.includes(id)),
	"E7 is not restricted to historical d04 ten");
assert(cohort.control.every((slot) => !hybrid.includes(slot.memoryUserId)), "E7 bled into control");
assert(cohort.treatment.every((slot) => !hybrid.includes(slot.memoryUserId)), "E7 bled into treatment");
assert(!fs.existsSync(GLOBAL_LOCK), "benchmark lock remains held");

const expected = Object.freeze({
	parent: ["allowlist", 30], capture: ["off", 0], projection: ["off", 0],
	coalescing: ["off", 0], hybrid: ["allowlist", 10], source: ["off", 0],
	fallback: ["off", 0], adaptive: ["off", 0],
});
const propagation = [];
for (const domain of ["https://itsuki.app", "https://uml.gpmai.workers.dev"]) {
	for (let attempt = 1; attempt <= 10; attempt += 1) {
		const response = await fetch(`${domain}/health?stage-d-closure=${Date.now()}-${attempt}`,
			{ headers: { "cache-control": "no-cache" }, signal: AbortSignal.timeout(30_000) });
		assert(response.ok, `${domain} health ${response.status}`);
		const status = (await response.json()).memory_v3;
		const check = (actual, pair, label) => assert(actual?.mode === pair[0]
			&& actual?.allowlistCount === pair[1], `${domain} ${label} mismatch`);
		assert(status?.mode === expected.parent[0] && status?.allowlistCount === expected.parent[1],
			`${domain} parent mismatch`);
		check(status.atomicCapture, expected.capture, "capture");
		check(status.atomicProjection, expected.projection, "projection");
		check(status.atomicCoalescing, expected.coalescing, "coalescing");
		check(status.hybridRetrieval, expected.hybrid, "hybrid");
		check(status.sourceExpansion, expected.source, "source");
		check(status.episodeFallback, expected.fallback, "fallback");
		check(status.adaptiveContext, expected.adaptive, "adaptive");
		propagation.push({ domain, attempt, status });
	}
}

const treatmentCounts = await stateCounts(cohort.treatment);
const controlCounts = await stateCounts(cohort.control);
assert(memoryCountsAreZero(treatmentCounts), `treatment residue: ${JSON.stringify(treatmentCounts)}`);
assert(memoryCountsAreZero(controlCounts), `control residue: ${JSON.stringify(controlCounts)}`);
const allSlots = [...cohort.control, ...cohort.treatment];
const quoted = allSlots.map((slot) => sqlQuote(slot.memoryUserId)).join(",");
const [packetResult] = await d1Select([`SELECT COUNT(*) AS packets,
	SUM(CASE WHEN content_hash='itsuki-erased-source/v1' THEN 1 ELSE 0 END) AS minimized,
	SUM(CASE WHEN length(trim(coalesce(content_preview,'')))>0
		OR trim(coalesce(raw_meta_json,'{}')) NOT IN ('','{}')
		OR coalesce(message_count,0)<>0 THEN 1 ELSE 0 END) AS content_rows
	FROM source_packets WHERE user_id IN (${quoted})`]);
const packets = Object.fromEntries(Object.entries(packetResult.results?.[0] ?? {})
	.map(([key, value]) => [key, integer(value)]));
assert(packets.content_rows === 0, `packet content residue: ${JSON.stringify(packets)}`);
assert(packets.packets === packets.minimized, `packet fences not minimized: ${JSON.stringify(packets)}`);

const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
const origin = execFileSync("git", ["rev-parse", "origin/master"], { cwd: REPO, encoding: "utf8" }).trim();
assert(head === EXPECTED_COMMIT && origin === EXPECTED_COMMIT, "repo/origin closure mismatch");

const evidence = {
	schema: "itsuki.v3-final-stage-d-closure/v1",
	at: new Date().toISOString(),
	pass: true,
	commit: head,
	workerVersion: EXPECTED_VERSION,
	deploymentId: EXPECTED_DEPLOYMENT,
	propagationPassed: propagation.length,
	propagationChecked: 20,
	productionDomains: 2,
	parentAllowlist: 30,
	hybridHistoricalOnly: 10,
	writeSourceRejectedLanesOff: true,
	normalUsersEnabled: false,
	treatmentCounts,
	controlCounts,
	packets,
	globalLockHeld: false,
};
writeJsonExclusive(RESULT, evidence);
console.log(JSON.stringify(evidence, null, 2));
