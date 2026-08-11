import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
	auditExtractionRetryHistory,
	auditExportSecrets,
	cohorts,
	readJson,
	secret,
	shaFile,
	sqlQuote,
} from "../../../e4/harness/product-confirmation-common.mjs";
import {
	d1Select,
	eraseCohort,
	integer,
	pool,
	ratio,
	request,
	waitReady,
	writeJsonAtomic,
	writeJsonExclusive,
} from "../../../e9b/harness/common.mjs";

export {
	auditExtractionRetryHistory,
	auditExportSecrets,
	cohorts,
	d1Select,
	eraseCohort,
	integer,
	pool,
	ratio,
	readJson,
	request,
	secret,
	shaFile,
	sqlQuote,
	waitReady,
	writeJsonAtomic,
	writeJsonExclusive,
};

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const STAGE_D = path.dirname(HERE);
export const FINAL = path.dirname(STAGE_D);
export const CAMPAIGN = path.dirname(FINAL);
export const REPO = path.dirname(path.dirname(CAMPAIGN));
export const HOLDOUT = path.join(CAMPAIGN, "holdout");
export const QUESTIONS = path.join(CAMPAIGN, "e2", "holdout-questions.json");
export const COHORT_FILE = path.join(CAMPAIGN, "e2", "cohort-manifest.json");
export const OUTPUT = path.join(STAGE_D, "evidence");
export const RESULTS = path.join(STAGE_D, "results");
export const GLOBAL_LOCK = path.join(CAMPAIGN, "phase3-d04", "evidence", ".benchmark-driver.lock");
export const GUARD_URL = pathToFileURL(path.join(CAMPAIGN, "harness", "billing-guard.mjs")).href;
export const EVAL_BASE = process.env.EVAL_BASE || "http://127.0.0.1:8799";
export const PROJECT = Object.freeze({
	projectId: "v3-final-holdout",
	projectName: "V3 Final General Holdout",
});
export const ATOMIC_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
export const READER_MODEL = "@cf/openai/gpt-oss-120b";
export const SINCE = "2026-08-09";
export const STAGE_START_SPENT = 1_914_249;
export const STAGE_CAP = 90_000;
export const GLOBAL_CEILING = 3_000_000;
export const FINAL_RESERVE = 500_000;
export const CALL_RESERVE = 1_000;
export const EXPECTED = Object.freeze({
	holdoutManifest: "598ba1bb35bbcee1784dce506ee743d1965398c5fca453ac82008b5f649654a6",
	holdoutDigestLedger: "259f22f29659b2ad46761483a6ac20162b24dc1441b8eaedb00e3f80fe17a97f",
	questions: "588fc4b5f3e6a74a7d7f8dc1f8b3bbcb795f79362930c67fefc6c075f5f7d73c",
	cohort: "555b01b4f5204a4cf3638801a1b0a3b1ca6e6cb1d1d71bbddb4e47fd44c04930",
	acceptedPathSummary: "110d3416a61ca155db706381e16397387e9be87a5bd05fb1179b3514a1abf9ab",
	finalPreregistration: "ecf58be85195c0c0d89bd88b46246dd22c0a424f1589de7d0a895b3d82d4d142",
});
export const ACCEPTED_PATH_SUMMARY = path.join(CAMPAIGN, "e9", "results", "summary.json");

export function assert(condition, message) {
	if (!condition) throw new Error(message);
}

export function sha(value) {
	return crypto.createHash("sha256").update(value).digest("hex");
}

export function percentile(values, fraction) {
	const ordered = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
	if (!ordered.length) return null;
	return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * fraction) - 1))];
}

export function validateFrozenInputs() {
	assert(shaFile(path.join(HOLDOUT, "manifest.json")) === EXPECTED.holdoutManifest,
		"frozen holdout manifest hash changed");
	assert(shaFile(path.join(HOLDOUT, "holdout.sha256")) === EXPECTED.holdoutDigestLedger,
		"frozen holdout digest ledger hash changed");
	assert(shaFile(QUESTIONS) === EXPECTED.questions, "frozen holdout question hash changed");
	assert(shaFile(COHORT_FILE) === EXPECTED.cohort, "frozen cohort manifest hash changed");
	assert(shaFile(ACCEPTED_PATH_SUMMARY) === EXPECTED.acceptedPathSummary,
		"accepted-path comparison summary hash changed");
	assert(shaFile(path.join(FINAL, "FINAL-VALIDATION-PREREGISTRATION.md")) === EXPECTED.finalPreregistration,
		"final validation preregistration hash changed");
	const questionRaw = fs.readFileSync(QUESTIONS, "utf8");
	assert(!/"answer"\s*:|"atoms"\s*:|mustCapture/.test(questionRaw),
		"reference fields leaked into product question file");
	const lines = fs.readFileSync(path.join(HOLDOUT, "holdout.sha256"), "utf8")
		.split(/\r?\n/).filter(Boolean);
	for (const line of lines) {
		const match = /^([a-f0-9]{64})\s+(.+)$/.exec(line);
		assert(match, `invalid holdout digest line: ${line}`);
		assert(shaFile(path.join(HOLDOUT, match[2])) === match[1], `frozen holdout file changed: ${match[2]}`);
	}
	const questions = readJson(QUESTIONS);
	assert(questions.scenarios.length === 10
		&& questions.scenarios.reduce((sum, row) => sum + row.questions.length, 0) === 42,
	"holdout question accounting changed");
	return { hashes: { ...EXPECTED }, digestEntries: lines.length, questions: 42, scenarios: 10 };
}

export function scenarios() {
	validateFrozenInputs();
	const questions = readJson(QUESTIONS);
	return questions.scenarios.map((entry, index) => {
		const inputFile = path.join(HOLDOUT, "inputs", `${entry.id}.json`);
		return {
			id: entry.id,
			index,
			questions: entry.questions,
			inputSha256: shaFile(inputFile),
			input: readJson(inputFile),
		};
	});
}

export async function assertBillingPreflight() {
	const guard = await import(GUARD_URL);
	assert(guard.preflight() === true, "Workers AI billing-path preflight failed");
}

export async function burnSnapshot(label, reserve = CALL_RESERVE) {
	const guard = await import(GUARD_URL);
	const usage = guard.neuronsSince(SINCE);
	const ledger = readJson(path.join(CAMPAIGN, "cost-ledger.json"));
	const spent = Math.max(0, usage.total - Number(ledger.campaign_baseline_neurons ?? 0));
	const ceiling = Number(ledger.V3_NEURON_CEILING);
	const requestedReserve = Number(reserve);
	const unexpected = Object.keys(usage.byModel).filter((model) => !guard.PERMITTED_MODELS.includes(model));
	assert(unexpected.length === 0, `${label}: unpermitted billed model(s): ${unexpected.join(", ")}`);
	assert(ceiling === GLOBAL_CEILING, `${label}: campaign ceiling changed (${ceiling})`);
	assert(Number.isFinite(requestedReserve) && requestedReserve > 0, `${label}: invalid inference reserve`);
	assert(spent + requestedReserve <= ceiling - FINAL_RESERVE,
		`${label}: next block could consume the protected final LoCoMo reserve`);
	assert(spent - STAGE_START_SPENT + requestedReserve <= STAGE_CAP,
		`${label}: next block could exceed the Stage D cap`);
	return {
		label,
		at: new Date().toISOString(),
		spent,
		ceiling,
		remaining: ceiling - spent,
		stageSpent: spent - STAGE_START_SPENT,
		stageRemaining: STAGE_CAP - (spent - STAGE_START_SPENT),
		reservedForNextBlock: requestedReserve,
		calls: usage.calls,
		byModel: usage.byModel,
	};
}

async function fingerprintRows(slots) {
	const ids = slots.map((slot) => sqlQuote(slot.memoryUserId)).join(", ");
	const project = sqlQuote(PROJECT.projectId);
	return d1Select([
		`SELECT id, user_id, project_id, source_packet_id, message_id, message_index, role,
			text_hash, source_time, source_time_precision, observed_at
		 FROM source_episodes WHERE user_id IN (${ids}) AND project_id = ${project}
		 ORDER BY user_id, id`,
		`SELECT id, user_id, project_id, source_episode_id, source_packet_id, source_message_id,
			evidence_hash, dedupe_key, atom_type, entity_type, attribute, cardinality, status
		 FROM semantic_atom_candidates WHERE user_id IN (${ids}) AND project_id = ${project}
		 ORDER BY user_id, id`,
		`SELECT candidate_id, user_id, project_id, source_episode_id, source_packet_id,
			outcome, object_kind, object_id, schema_version
		 FROM semantic_atom_projections WHERE user_id IN (${ids}) AND project_id = ${project}
		 ORDER BY user_id, candidate_id`,
		`SELECT id, user_id, project_id, label, category, state, deleted_at, archived_at, suppressed_at
		 FROM nodes WHERE user_id IN (${ids}) AND project_id = ${project}
		   AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL
		 ORDER BY user_id, id`,
		`SELECT id, user_id, project_id, node_id, kind, is_current, deleted_at,
			semantic_attribute, semantic_cardinality, valid_from, valid_to
		 FROM slices WHERE user_id IN (${ids}) AND project_id = ${project} AND deleted_at IS NULL
		 ORDER BY user_id, id`,
		`SELECT id, user_id, project_id, node_id, action, happened_at, happened_at_source,
			deleted_at, semantic_attribute, semantic_cardinality, event_time_end,
			event_time_precision, event_time_relation
		 FROM events WHERE user_id IN (${ids}) AND project_id = ${project} AND deleted_at IS NULL
		 ORDER BY user_id, id`,
		`SELECT id, user_id, project_id, from_node, to_node, type, valid_at, invalid_at, deleted_at
		 FROM edges WHERE user_id IN (${ids}) AND project_id = ${project} AND deleted_at IS NULL
		 ORDER BY user_id, id`,
		`SELECT id, user_id, project_id, title, health_state, deleted_at, archived_at, suppressed_at
		 FROM memory_pages WHERE user_id IN (${ids}) AND project_id = ${project}
		   AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL
		 ORDER BY user_id, id`,
		`SELECT id, user_id, type, status, source_packet_id, attempts
		 FROM memory_jobs WHERE user_id IN (${ids}) AND status NOT IN ('enriched', 'failed', 'completed')
		 ORDER BY user_id, id`,
	]);
}

export async function semanticFingerprint(slots = cohorts().treatment) {
	const results = await fingerprintRows(slots);
	const rows = results.map((result) => result.results ?? []);
	const labels = ["episodes", "candidates", "projections", "nodes", "slices", "events", "edges", "pages", "nonTerminalJobs"];
	const counts = Object.fromEntries(labels.map((label, index) => [label, rows[index].length]));
	assert(counts.nonTerminalJobs === 0, `non-terminal jobs remain: ${counts.nonTerminalJobs}`);
	return {
		schema: "itsuki.v3-final-holdout-state-fingerprint/v1",
		sha256: sha(JSON.stringify(rows)),
		counts,
	};
}

export async function expectedHealth() {
	const domains = ["https://itsuki.app", "https://uml.gpmai.workers.dev"];
	const snapshots = [];
	for (const domain of domains) {
		const response = await fetch(`${domain}/health?stage-d=${Date.now()}-${Math.random()}`,
			{ headers: { "cache-control": "no-cache" } });
		assert(response.ok, `${domain}: health ${response.status}`);
		const status = (await response.json()).memory_v3;
		assert(status?.mode === "allowlist" && status?.allowlistCount === 30, `${domain}: parent V3 mismatch`);
		assert(status.extractionB1?.mode === "off" && status.extractionB1?.allowlistCount === 0,
			`${domain}: rejected E2-B1 enabled`);
		assert(status.atomicCapture?.mode === "allowlist" && status.atomicCapture?.allowlistCount === 10,
			`${domain}: accepted capture cohort mismatch`);
		assert(status.atomicProjection?.mode === "allowlist" && status.atomicProjection?.allowlistCount === 10,
			`${domain}: accepted projection cohort mismatch`);
		assert(status.atomicCoalescing?.mode === "off" && status.atomicCoalescing?.allowlistCount === 0,
			`${domain}: rejected coalescing enabled`);
		assert(status.hybridRetrieval?.mode === "allowlist" && status.hybridRetrieval?.allowlistCount === 20,
			`${domain}: accepted E7 cohort mismatch`);
		assert(status.sourceExpansion?.mode === "allowlist" && status.sourceExpansion?.allowlistCount === 10,
			`${domain}: accepted E9A cohort mismatch`);
		assert(status.episodeFallback?.mode === "off" && status.episodeFallback?.allowlistCount === 0,
			`${domain}: rejected E9B enabled`);
		assert(status.adaptiveContext?.mode === "off" && status.adaptiveContext?.allowlistCount === 0,
			`${domain}: rejected E10 enabled`);
		snapshots.push({ domain, status });
	}
	return snapshots;
}

export function sealProduct(productFile, sealFile, extra = {}) {
	writeJsonExclusive(sealFile, {
		schema: "itsuki.v3-final-holdout-product-seal/v1",
		productFile: path.basename(productFile),
		productSha256: shaFile(productFile),
		sealedAt: new Date().toISOString(),
		...extra,
	});
}
