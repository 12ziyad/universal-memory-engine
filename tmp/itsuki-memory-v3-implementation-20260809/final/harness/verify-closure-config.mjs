import fs from "node:fs";
import path from "node:path";

import { CAMPAIGN, REPO, assert } from "./common.mjs";

const wrangler = fs.readFileSync(path.join(REPO, "wrangler.jsonc"), "utf8");
const cohort = JSON.parse(fs.readFileSync(path.join(CAMPAIGN, "e2", "cohort-manifest.json"), "utf8"));

function value(name) {
	const match = new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`).exec(wrangler);
	assert(match, `missing ${name}`);
	return match[1];
}

function ids(name) {
	return value(name).split(",").map((entry) => entry.trim()).filter(Boolean);
}

function sameSet(left, right) {
	return left.length === right.length && new Set(left).size === left.length
		&& left.every((entry) => right.includes(entry));
}

function assertOff(modeKey, usersKey) {
	assert(value(modeKey) === "off", `${modeKey} must be off`);
	assert(ids(usersKey).length === 0, `${usersKey} must be empty`);
}

const parent = ids("ITSUKI_MEMORY_V3_USERS");
const historical = parent.slice(0, 10);
const treatment = cohort.treatment_memory_user_ids;
const control = cohort.control_memory_user_ids;
const hybrid = ids("ITSUKI_MEMORY_V3_HYBRID_RETRIEVAL_USERS");

assert(value("ITSUKI_MEMORY_V3") === "allowlist" && parent.length === 30, "parent mismatch");
assert(new Set(parent).size === 30, "parent allowlist contains duplicates");
assert(treatment.every((id) => parent.includes(id)), "treatment outside parent");
assert(control.every((id) => parent.includes(id)), "control outside parent");
assert(value("ITSUKI_MEMORY_V3_EXTRACTION_B1") === "off", "rejected E2-B1 changed");

for (const [modeKey, usersKey] of [
	["ITSUKI_MEMORY_V3_ATOMIC_CAPTURE", "ITSUKI_MEMORY_V3_ATOMIC_CAPTURE_USERS"],
	["ITSUKI_MEMORY_V3_ATOMIC_PROJECTION", "ITSUKI_MEMORY_V3_ATOMIC_PROJECTION_USERS"],
	["ITSUKI_MEMORY_V3_ATOMIC_COALESCING", "ITSUKI_MEMORY_V3_ATOMIC_COALESCING_USERS"],
	["ITSUKI_MEMORY_V3_SOURCE_EXPANSION", "ITSUKI_MEMORY_V3_SOURCE_EXPANSION_USERS"],
	["ITSUKI_MEMORY_V3_EPISODE_FALLBACK", "ITSUKI_MEMORY_V3_EPISODE_FALLBACK_USERS"],
	["ITSUKI_MEMORY_V3_ADAPTIVE_CONTEXT", "ITSUKI_MEMORY_V3_ADAPTIVE_CONTEXT_USERS"],
]) assertOff(modeKey, usersKey);

assert(value("ITSUKI_MEMORY_V3_HYBRID_RETRIEVAL") === "allowlist", "hybrid mode mismatch");
assert(sameSet(hybrid, historical), "hybrid must select only the historical d04 cohort");
assert(treatment.every((id) => !hybrid.includes(id)), "hybrid bled into treatment cohort");
assert(control.every((id) => !hybrid.includes(id)), "hybrid bled into control cohort");
assert(hybrid.every((id) => parent.includes(id)), "hybrid outside parent V3");

const expected = {
	parent: ["allowlist", 30], capture: ["off", 0], projection: ["off", 0],
	coalescing: ["off", 0], hybrid: ["allowlist", 10], source: ["off", 0],
	fallback: ["off", 0], adaptive: ["off", 0],
};

async function verifyLive() {
	const snapshots = [];
	for (const domain of ["https://itsuki.app", "https://uml.gpmai.workers.dev"]) {
		const response = await fetch(`${domain}/health?v3-closure=${Date.now()}-${Math.random()}`, {
			headers: { "cache-control": "no-cache" },
			signal: AbortSignal.timeout(30_000),
		});
		assert(response.ok, `${domain}: health ${response.status}`);
		const status = (await response.json()).memory_v3;
		const check = (actual, pair, label) => assert(actual?.mode === pair[0]
			&& actual?.allowlistCount === pair[1], `${domain}: ${label} mismatch`);
		assert(status?.mode === expected.parent[0] && status?.allowlistCount === expected.parent[1],
			`${domain}: parent mismatch`);
		check(status.atomicCapture, expected.capture, "capture");
		check(status.atomicProjection, expected.projection, "projection");
		check(status.atomicCoalescing, expected.coalescing, "coalescing");
		check(status.hybridRetrieval, expected.hybrid, "hybrid");
		check(status.sourceExpansion, expected.source, "source expansion");
		check(status.episodeFallback, expected.fallback, "episode fallback");
		check(status.adaptiveContext, expected.adaptive, "adaptive context");
		snapshots.push({ domain, status });
	}
	assert(JSON.stringify(snapshots[0].status) === JSON.stringify(snapshots[1].status),
		"production domains disagree on V3 state");
	return snapshots;
}

const live = process.argv.includes("--live") ? await verifyLive() : null;
console.log(JSON.stringify({
	parent: parent.length,
	hybrid: hybrid.length,
	writeAndSourceLanes: "OFF",
	rejectedLanes: "OFF",
	normalUsersEnabled: false,
	live,
}, null, 2));
