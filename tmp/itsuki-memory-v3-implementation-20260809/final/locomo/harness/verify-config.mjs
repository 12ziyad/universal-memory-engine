import fs from "node:fs";
import path from "node:path";

import { REPO, assert, cohorts, validateFrozenInputs } from "./common.mjs";

const wrangler = fs.readFileSync(path.join(REPO, "wrangler.jsonc"), "utf8");

function value(name) {
	const match = new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`).exec(wrangler);
	assert(match, `missing ${name}`);
	return match[1];
}

function ids(name) {
	return value(name).split(",").map((entry) => entry.trim()).filter(Boolean);
}

function sameSet(left, right) {
	return left.length === right.length && left.every((value) => right.includes(value));
}

const mode = process.argv[2] ?? "active";
assert(["active", "safe"].includes(mode), "usage: verify-config.mjs <active|safe>");
const frozen = validateFrozenInputs();
const cohort = cohorts();
const parent = ids("ITSUKI_MEMORY_V3_USERS");
const historical = parent.slice(0, 10);
const control = cohort.control.map((slot) => slot.memoryUserId);
const treatment = cohort.treatment.map((slot) => slot.memoryUserId);
const capture = ids("ITSUKI_MEMORY_V3_ATOMIC_CAPTURE_USERS");
const projection = ids("ITSUKI_MEMORY_V3_ATOMIC_PROJECTION_USERS");
const hybrid = ids("ITSUKI_MEMORY_V3_HYBRID_RETRIEVAL_USERS");
const source = ids("ITSUKI_MEMORY_V3_SOURCE_EXPANSION_USERS");

assert(value("ITSUKI_MEMORY_V3") === "allowlist" && parent.length === 30,
	"parent V3 allowlist mismatch");
assert(sameSet(parent.slice(10, 20), control) && sameSet(parent.slice(20, 30), treatment),
	"parent cohort ordering/membership changed");
assert(value("ITSUKI_MEMORY_V3_EXTRACTION_B1") === "off", "rejected E2-B1 enabled");
assert(value("ITSUKI_MEMORY_V3_ATOMIC_COALESCING") === "off"
	&& ids("ITSUKI_MEMORY_V3_ATOMIC_COALESCING_USERS").length === 0,
"rejected coalescing enabled");
assert(value("ITSUKI_MEMORY_V3_EPISODE_FALLBACK") === "off"
	&& ids("ITSUKI_MEMORY_V3_EPISODE_FALLBACK_USERS").length === 0,
"rejected E9B enabled");
assert(value("ITSUKI_MEMORY_V3_ADAPTIVE_CONTEXT") === "off"
	&& ids("ITSUKI_MEMORY_V3_ADAPTIVE_CONTEXT_USERS").length === 0,
"rejected E10 enabled");
assert(value("ITSUKI_MEMORY_V3_HYBRID_RETRIEVAL") === "allowlist", "E7 mode changed");

if (mode === "active") {
	assert(value("ITSUKI_MEMORY_V3_ATOMIC_CAPTURE") === "allowlist" && sameSet(capture, control),
		"Stage E capture cohort mismatch");
	assert(value("ITSUKI_MEMORY_V3_ATOMIC_PROJECTION") === "allowlist" && sameSet(projection, control),
		"Stage E projection cohort mismatch");
	assert(value("ITSUKI_MEMORY_V3_SOURCE_EXPANSION") === "allowlist" && sameSet(source, control),
		"Stage E source-expansion cohort mismatch");
	assert(hybrid.length === 20 && sameSet(hybrid, [...historical, ...control]),
		"Stage E E7 cohort mismatch");
} else {
	assert(value("ITSUKI_MEMORY_V3_ATOMIC_CAPTURE") === "off" && capture.length === 0,
		"safe capture state mismatch");
	assert(value("ITSUKI_MEMORY_V3_ATOMIC_PROJECTION") === "off" && projection.length === 0,
		"safe projection state mismatch");
	assert(value("ITSUKI_MEMORY_V3_SOURCE_EXPANSION") === "off" && source.length === 0,
		"safe source-expansion state mismatch");
	assert(hybrid.length === 10 && sameSet(hybrid, historical), "safe E7 state mismatch");
}

for (const rejected of treatment) {
	assert(!capture.includes(rejected) && !projection.includes(rejected) && !source.includes(rejected),
		`treatment tenant entered an accepted Stage E write/source lane: ${rejected}`);
}
console.log(JSON.stringify({
	verdict: "PASS",
	mode,
	frozen,
	parent: parent.length,
	capture: { mode: value("ITSUKI_MEMORY_V3_ATOMIC_CAPTURE"), count: capture.length },
	projection: { mode: value("ITSUKI_MEMORY_V3_ATOMIC_PROJECTION"), count: projection.length },
	hybrid: { mode: value("ITSUKI_MEMORY_V3_HYBRID_RETRIEVAL"), count: hybrid.length },
	sourceExpansion: { mode: value("ITSUKI_MEMORY_V3_SOURCE_EXPANSION"), count: source.length },
	rejectedLanesOff: true,
	normalUsersEnabled: false,
}, null, 2));
