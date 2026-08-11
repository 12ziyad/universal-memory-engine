import fs from "node:fs";
import path from "node:path";

import {
	COHORT_FILE,
	REPO,
	assert,
	readJson,
} from "./common.mjs";

const phase = process.argv[2];
assert(["active", "restored"].includes(phase), "phase must be active or restored");
const wrangler = fs.readFileSync(path.join(REPO, "wrangler.jsonc"), "utf8");
const cohort = readJson(COHORT_FILE);

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

const treatment = cohort.treatment_memory_user_ids;
const control = cohort.control_memory_user_ids;
const parent = ids("ITSUKI_MEMORY_V3_USERS");
const capture = ids("ITSUKI_MEMORY_V3_ATOMIC_CAPTURE_USERS");
const projection = ids("ITSUKI_MEMORY_V3_ATOMIC_PROJECTION_USERS");
const coalescing = ids("ITSUKI_MEMORY_V3_ATOMIC_COALESCING_USERS");
const hybrid = ids("ITSUKI_MEMORY_V3_HYBRID_RETRIEVAL_USERS");
const source = ids("ITSUKI_MEMORY_V3_SOURCE_EXPANSION_USERS");
const fallback = ids("ITSUKI_MEMORY_V3_EPISODE_FALLBACK_USERS");
const adaptive = ids("ITSUKI_MEMORY_V3_ADAPTIVE_CONTEXT_USERS");
const active = phase === "active";

assert(value("ITSUKI_MEMORY_V3") === "allowlist" && parent.length === 30, "parent V3 mismatch");
assert(treatment.every((id) => parent.includes(id)), "treatment is outside parent V3");
assert(control.every((id) => parent.includes(id)), "control is outside parent V3");
assert(value("ITSUKI_MEMORY_V3_EXTRACTION_B1") === "off", "rejected E2-B1 changed");
assert(value("ITSUKI_MEMORY_V3_ATOMIC_CAPTURE") === (active ? "allowlist" : "off"), "capture mode mismatch");
assert(value("ITSUKI_MEMORY_V3_ATOMIC_PROJECTION") === (active ? "allowlist" : "off"), "projection mode mismatch");
assert(active ? sameSet(capture, treatment) : capture.length === 0, "capture cohort mismatch");
assert(active ? sameSet(projection, treatment) : projection.length === 0, "projection cohort mismatch");
assert(value("ITSUKI_MEMORY_V3_ATOMIC_COALESCING") === "off" && coalescing.length === 0,
	"rejected coalescing changed");
assert(value("ITSUKI_MEMORY_V3_HYBRID_RETRIEVAL") === "allowlist", "E7 mode mismatch");
assert(hybrid.length === (active ? 20 : 10), "E7 cohort count mismatch");
assert(active ? treatment.every((id) => hybrid.includes(id)) : treatment.every((id) => !hybrid.includes(id)),
	"E7 treatment routing mismatch");
assert(control.every((id) => !hybrid.includes(id)), "E7 bled into frozen control cohort");
assert(value("ITSUKI_MEMORY_V3_SOURCE_EXPANSION") === (active ? "allowlist" : "off"), "E9A mode mismatch");
assert(active ? sameSet(source, treatment) : source.length === 0, "E9A cohort mismatch");
assert(value("ITSUKI_MEMORY_V3_EPISODE_FALLBACK") === "off" && fallback.length === 0,
	"rejected E9B changed");
assert(value("ITSUKI_MEMORY_V3_ADAPTIVE_CONTEXT") === "off" && adaptive.length === 0,
	"rejected E10 changed");
for (const nested of [...capture, ...projection, ...hybrid, ...source]) {
	assert(parent.includes(nested), "nested flag contains account outside parent V3");
}
assert(!/^\s*"EVAL_MODE"\s*:/m.test(wrangler), "EVAL_MODE must not enter production config");
assert(!/^\s*"AI_GATEWAY_ID"\s*:/m.test(wrangler), "AI Gateway must remain absent");

console.log(JSON.stringify({
	phase,
	parent: parent.length,
	capture: { mode: value("ITSUKI_MEMORY_V3_ATOMIC_CAPTURE"), count: capture.length },
	projection: { mode: value("ITSUKI_MEMORY_V3_ATOMIC_PROJECTION"), count: projection.length },
	hybrid: { mode: value("ITSUKI_MEMORY_V3_HYBRID_RETRIEVAL"), count: hybrid.length },
	sourceExpansion: { mode: value("ITSUKI_MEMORY_V3_SOURCE_EXPANSION"), count: source.length },
	rejectedLanesOff: true,
	normalUsersEnabled: false,
}, null, 2));
