import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
	assert,
	cohorts,
	d1Select,
	eraseCohort,
	integer,
	memoryCountsAreZero,
	pool,
	ratio,
	readJson,
	request,
	secret,
	shaFile,
	sqlQuote,
	stateCounts,
	waitReady,
	writeJsonAtomic,
	writeJsonExclusive,
} from "../../harness/common.mjs";

export {
	assert,
	cohorts,
	d1Select,
	eraseCohort,
	integer,
	memoryCountsAreZero,
	pool,
	ratio,
	readJson,
	request,
	secret,
	shaFile,
	sqlQuote,
	stateCounts,
	waitReady,
	writeJsonAtomic,
	writeJsonExclusive,
};

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const STAGE_E = path.dirname(HERE);
export const FINAL = path.dirname(STAGE_E);
export const CAMPAIGN = path.dirname(FINAL);
export const REPO = path.dirname(path.dirname(CAMPAIGN));
export const INPUT = path.join(STAGE_E, "frozen", "product-inputs.json");
export const PREREGISTRATION = path.join(STAGE_E, "STAGE-E-LOCOMO-PREREGISTRATION.md");
export const OUTPUT = path.join(STAGE_E, "evidence");
export const RESULTS = path.join(STAGE_E, "results");
export const DATASET = path.join(CAMPAIGN, "phase3-d04", "vendor", "locomo10.json");
export const OFFICIAL_SCORER = path.join(CAMPAIGN, "phase3-d04", "harness", "score.py");
export const PYTHON = path.join(CAMPAIGN, "phase3-d04", ".venv", "Scripts", "python.exe");
export const GLOBAL_LOCK = path.join(CAMPAIGN, "phase3-d04", "evidence", ".benchmark-driver.lock");
export const GUARD_URL = pathToFileURL(path.join(CAMPAIGN, "harness", "billing-guard.mjs")).href;
export const PROJECT = Object.freeze({ projectId: "v3-final-locomo", projectName: "V3 Final LoCoMo" });
export const ATOMIC_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
export const READER_MODEL = "@cf/openai/gpt-oss-120b";
export const SINCE = "2026-08-09";
export const GLOBAL_CEILING = 3_000_000;
export const STAGE_CAP = 500_000;
export const ANSWER_BLOCK = 20;
export const JUDGE_BLOCK = 20;
export const EXPECTED = Object.freeze({
	productInputs: "e9818f2070e6b5a4860e3a7e0cbd706433a0c95c00049980f405fe34cccf10dd",
	preregistration: "7b8fbfe936c0967e449f07223c024aab85ee441da5241735f7a38d13a06d9f18",
	dataset: "553cd5a15e25f2ceccc6ed185221eba645080c93e5b91087560a91aa5961f365",
	cohort: "555b01b4f5204a4cf3638801a1b0a3b1ca6e6cb1d1d71bbddb4e47fd44c04930",
	protocol: "c5289004f721f8c17cc3fd298a396e1ea12368ace8ca9965af4fe04d62867101",
	officialSource: "8e3be5d57ff2ff9ec5cd05939592f468c5f3f1fd95d13e431932bdf6bf0fd6fd",
	scorer: "636a1d018ae4a8ae73c5c64563dc69ad69c54843ecca377ce84015a4758a0b93",
	readerClient: "e1acd15497e555c3ab078c26ab1b0d1f4d47c8acfa25cb7a465568c6a79a448d",
	judgeClient: "6562a91f32abf404b12012e53f447b2031b2c8871573cd3f68069399dbaea165",
});

export function sha(value) {
	return crypto.createHash("sha256").update(value).digest("hex");
}

export function percentile(values, fraction) {
	const ordered = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
	if (!ordered.length) return null;
	return ordered[Math.min(ordered.length - 1,
		Math.max(0, Math.ceil(ordered.length * fraction) - 1))];
}

export function readJsonl(file) {
	if (!fs.existsSync(file)) return [];
	return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line, index) => {
		try { return JSON.parse(line); } catch { throw new Error(`${file}:${index + 1}: invalid JSONL`); }
	});
}

export function appendJsonl(file, value) {
	fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

export function validateProductInputs() {
	const files = {
		productInputs: INPUT,
		preregistration: PREREGISTRATION,
		cohort: path.join(CAMPAIGN, "e2", "cohort-manifest.json"),
		readerClient: path.join(CAMPAIGN, "e2", "harness", "llm.js"),
	};
	for (const [name, file] of Object.entries(files)) {
		assert(shaFile(file) === EXPECTED[name], `${name} frozen hash changed`);
	}
	const raw = fs.readFileSync(INPUT, "utf8");
	for (const forbidden of ["reference", "answer", "adversarial_answer", "evidence", "judgment", "score"]) {
		assert(!new RegExp(`\\"${forbidden}\\"\\s*:`).test(raw),
			`product input contains forbidden reference/scoring field: ${forbidden}`);
	}
	const input = JSON.parse(raw);
	assert(input.schema === "itsuki.v3-stage-e-product-inputs/v1", "product input schema changed");
	assert(input.totals.samples === 10 && input.totals.sessions === 272
		&& input.totals.messages === 5_882 && input.totals.questions === 1_540,
	"product input accounting changed");
	const slots = cohorts().control;
	assert(slots.length === 10 && new Set(slots.map((slot) => slot.memoryUserId)).size === 10,
		"Stage E cohort changed");
	return {
		hashes: Object.fromEntries(Object.keys(files).map((name) => [name, EXPECTED[name]])),
		totals: input.totals,
		slots: slots.length,
		referenceFilesOpened: 0,
	};
}

export function validateFrozenInputs() {
	const product = validateProductInputs();
	const files = {
		dataset: DATASET,
		protocol: path.join(CAMPAIGN, "phase3-d04", "results", "mem0-protocol.json"),
		officialSource: path.join(CAMPAIGN, "phase3-d04", "vendor", "snap_research_locomo_evaluation.py"),
		scorer: OFFICIAL_SCORER,
		judgeClient: path.join(CAMPAIGN, "phase3-d04", "judge", "judge-client.js"),
	};
	for (const [name, file] of Object.entries(files)) {
		assert(shaFile(file) === EXPECTED[name], `${name} frozen hash changed`);
	}
	return { ...product, hashes: { ...EXPECTED } };
}

export function productInputs() {
	validateProductInputs();
	return readJson(INPUT);
}

export async function assertBillingPreflight() {
	const guard = await import(GUARD_URL);
	assert(guard.preflight() === true, "Workers AI billing-path preflight failed");
}

export async function burnSnapshot(label, reserve = 1_000, stageStart = null) {
	const guard = await import(GUARD_URL);
	const usage = guard.neuronsSince(SINCE);
	const ledger = readJson(path.join(CAMPAIGN, "cost-ledger.json"));
	const spent = Math.max(0, usage.total - Number(ledger.campaign_baseline_neurons ?? 0));
	const ceiling = Number(ledger.V3_NEURON_CEILING);
	const requested = Number(reserve);
	const unexpected = Object.keys(usage.byModel).filter((model) => !guard.PERMITTED_MODELS.includes(model));
	assert(unexpected.length === 0, `${label}: unpermitted billed model(s): ${unexpected.join(", ")}`);
	assert(ceiling === GLOBAL_CEILING, `${label}: campaign ceiling changed (${ceiling})`);
	assert(Number.isFinite(requested) && requested > 0, `${label}: invalid reserve`);
	assert(spent + requested <= ceiling, `${label}: next block could exceed the campaign ceiling`);
	if (stageStart !== null) {
		assert(Number.isInteger(Number(stageStart)) && Number(stageStart) >= 0, `${label}: invalid Stage E start`);
		assert(spent - Number(stageStart) + requested <= STAGE_CAP,
			`${label}: next block could exceed the Stage E cap`);
	}
	return {
		label,
		at: new Date().toISOString(),
		spent,
		ceiling,
		remaining: ceiling - spent,
		stageStart: stageStart === null ? null : Number(stageStart),
		stageSpent: stageStart === null ? null : spent - Number(stageStart),
		stageRemaining: stageStart === null ? null : STAGE_CAP - (spent - Number(stageStart)),
		reservedForNextBlock: requested,
		threshold: spent >= 2_700_000 ? "90%_completion_only"
			: spent >= 2_250_000 ? "75%_decisive_only"
				: spent >= 1_500_000 ? "50%_reviewed" : "below_50%",
		calls: usage.calls,
		byModel: usage.byModel,
	};
}

export async function expectedHealthActive() {
	const expected = {
		parent: ["allowlist", 30], capture: ["allowlist", 10], projection: ["allowlist", 10],
		coalescing: ["off", 0], hybrid: ["allowlist", 20], source: ["allowlist", 10],
		fallback: ["off", 0], adaptive: ["off", 0],
	};
	const snapshots = [];
	for (const domain of ["https://itsuki.app", "https://uml.gpmai.workers.dev"]) {
		const response = await fetch(`${domain}/health?stage-e=${Date.now()}-${Math.random()}`, {
			headers: { "cache-control": "no-cache" }, signal: AbortSignal.timeout(30_000),
		});
		assert(response.ok, `${domain}: health ${response.status}`);
		const status = (await response.json()).memory_v3;
		const check = (actual, pair, name) => assert(actual?.mode === pair[0]
			&& actual?.allowlistCount === pair[1], `${domain}: ${name} mismatch`);
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

export async function packetCounts(slots = cohorts().control) {
	const ids = slots.map((slot) => sqlQuote(slot.memoryUserId)).join(",");
	const [result] = await d1Select([`SELECT COUNT(*) AS packets,
		SUM(CASE WHEN content_hash='itsuki-erased-source/v1' THEN 1 ELSE 0 END) AS minimized,
		SUM(CASE WHEN length(trim(coalesce(content_preview,'')))>0
			OR trim(coalesce(raw_meta_json,'{}')) NOT IN ('','{}')
			OR coalesce(message_count,0)<>0 THEN 1 ELSE 0 END) AS content_rows
		FROM source_packets WHERE user_id IN (${ids})`]);
	return Object.fromEntries(Object.entries(result.results?.[0] ?? {})
		.map(([key, value]) => [key, integer(value)]));
}

export async function assertCleanCohort(slots = cohorts().control) {
	const counts = await stateCounts(slots);
	const packets = await packetCounts(slots);
	const ids = slots.map((slot) => sqlQuote(slot.memoryUserId)).join(",");
	const [derivedResult] = await d1Select([`SELECT
		(SELECT COUNT(*) FROM manual_search_profiles WHERE user_id IN (${ids})) AS profiles,
		(SELECT COUNT(*) FROM manual_search_fts f JOIN manual_search_profiles p ON p.rowid=f.rowid
		 WHERE p.user_id IN (${ids})) AS semantic_fts,
		(SELECT COUNT(*) FROM source_episodes_fts f JOIN source_episodes e ON e.rowid=f.rowid
		 WHERE e.user_id IN (${ids})) AS episode_fts`]);
	const derived = Object.fromEntries(Object.entries(derivedResult.results?.[0] ?? {})
		.map(([key, value]) => [key, integer(value)]));
	assert(memoryCountsAreZero(counts), `Stage E cohort has live state: ${JSON.stringify(counts)}`);
	assert(Object.values(derived).every((value) => value === 0),
		`Stage E cohort has derived-index state: ${JSON.stringify(derived)}`);
	assert(packets.content_rows === 0 && packets.packets === packets.minimized,
		`Stage E cohort has source packet content: ${JSON.stringify(packets)}`);
	return { counts, derived, packets };
}

export function sealProduct(productFile, sealFile, files, extra = {}) {
	const hashed = Object.fromEntries(files.map((file) => [path.basename(file), {
		bytes: fs.statSync(file).size,
		sha256: shaFile(file),
	}]));
	writeJsonExclusive(sealFile, {
		schema: "itsuki.v3-stage-e-product-seal/v1",
		productFile: path.basename(productFile),
		productSha256: shaFile(productFile),
		files: hashed,
		sealedAt: new Date().toISOString(),
		...extra,
	});
}
