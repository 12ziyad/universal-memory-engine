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

const parent = ids("ITSUKI_MEMORY_V3_USERS");
const treatment = cohort.treatment_memory_user_ids;
const control = cohort.control_memory_user_ids;
const historical = parent.slice(0, 10);
const capture = ids("ITSUKI_MEMORY_V3_ATOMIC_CAPTURE_USERS");
const projection = ids("ITSUKI_MEMORY_V3_ATOMIC_PROJECTION_USERS");
const hybrid = ids("ITSUKI_MEMORY_V3_HYBRID_RETRIEVAL_USERS");
const source = ids("ITSUKI_MEMORY_V3_SOURCE_EXPANSION_USERS");

assert(value("ITSUKI_MEMORY_V3") === "allowlist" && parent.length === 30, "parent mismatch");
assert(treatment.every((id) => parent.includes(id)), "treatment outside parent");
assert(value("ITSUKI_MEMORY_V3_EXTRACTION_B1") === "off", "rejected E2-B1 changed");
assert(value("ITSUKI_MEMORY_V3_ATOMIC_CAPTURE") === "allowlist" && sameSet(capture, treatment), "capture mismatch");
assert(value("ITSUKI_MEMORY_V3_ATOMIC_PROJECTION") === "allowlist" && sameSet(projection, treatment), "projection mismatch");
assert(value("ITSUKI_MEMORY_V3_ATOMIC_COALESCING") === "off"
	&& ids("ITSUKI_MEMORY_V3_ATOMIC_COALESCING_USERS").length === 0, "coalescing mismatch");
assert(value("ITSUKI_MEMORY_V3_HYBRID_RETRIEVAL") === "allowlist"
	&& sameSet(hybrid, [...historical, ...treatment]), "hybrid mismatch");
assert(control.every((id) => !hybrid.includes(id)), "hybrid bled into frozen control cohort");
assert(value("ITSUKI_MEMORY_V3_SOURCE_EXPANSION") === "allowlist" && sameSet(source, treatment), "source mismatch");
for (const [modeKey, usersKey] of [
	["ITSUKI_MEMORY_V3_EPISODE_FALLBACK", "ITSUKI_MEMORY_V3_EPISODE_FALLBACK_USERS"],
	["ITSUKI_MEMORY_V3_ADAPTIVE_CONTEXT", "ITSUKI_MEMORY_V3_ADAPTIVE_CONTEXT_USERS"],
]) {
	assert(value(modeKey) === "off" && ids(usersKey).length === 0, `${modeKey} mismatch`);
}
for (const nested of [...capture, ...projection, ...hybrid, ...source]) {
	assert(parent.includes(nested), "nested flag outside parent V3");
}

console.log(JSON.stringify({
	parent: parent.length,
	capture: capture.length,
	projection: projection.length,
	hybrid: hybrid.length,
	sourceExpansion: source.length,
	rejectedLanes: "OFF",
	normalUsersEnabled: false,
}, null, 2));
