import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
	assertBillingPreflight,
	cohorts,
	d1Select,
	readJson,
	request,
	secret,
	sha,
	shaFile,
	sqlQuote,
} from "../../e9b/harness/common.mjs";
import {
	assert,
	auditExportSecrets,
	eraseCohort,
	integer,
	pool,
	ratio,
	waitReady,
	writeJsonAtomic,
	writeJsonExclusive,
} from "../../e6/harness/common.mjs";

export {
	assert,
	assertBillingPreflight,
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
	sha,
	shaFile,
	sqlQuote,
	waitReady,
	writeJsonAtomic,
	writeJsonExclusive,
};

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FINAL = path.dirname(HERE);
export const CAMPAIGN = path.dirname(FINAL);
export const REPO = path.dirname(path.dirname(CAMPAIGN));
export const LIVE = path.join(FINAL, "live");
export const EVIDENCE = path.join(LIVE, "evidence");
export const GLOBAL_LOCK = path.join(CAMPAIGN, "phase3-d04", "evidence", ".benchmark-driver.lock");
export const GUARD_URL = pathToFileURL(path.join(CAMPAIGN, "harness", "billing-guard.mjs")).href;
export const BASE = process.env.ITSUKI_BASE || "https://itsuki.app";
export const PROJECT_ALPHA = Object.freeze({ projectId: "v3-final-security-alpha", projectName: "V3 Final Security Alpha" });
export const PROJECT_BETA = Object.freeze({ projectId: "v3-final-security-beta", projectName: "V3 Final Security Beta" });
export const SINCE = "2026-08-09";
export const FINAL_VALIDATION_START_SPENT = 1_904_127;
export const STAGE_B_CAP = 40_000;
export const GLOBAL_CEILING = 3_000_000;
export const FINAL_RESERVE = 500_000;
export const CALL_RESERVE = 1_000;
export const EXPECTED = Object.freeze({
	cohort: "555b01b4f5204a4cf3638801a1b0a3b1ca6e6cb1d1d71bbddb4e47fd44c04930",
	holdoutQuestions: "588fc4b5f3e6a74a7d7f8dc1f8b3bbcb795f79362930c67fefc6c075f5f7d73c",
	frozen399: "500959da6c7e030248d85669ce49cf85ed62551fba0d0690d7a70bca0337ea6d",
});

export function validateInputs() {
	const cohortFile = path.join(CAMPAIGN, "e2", "cohort-manifest.json");
	const questions = path.join(CAMPAIGN, "e2", "holdout-questions.json");
	const frozen399 = path.join(CAMPAIGN, "dev-subset-400.json");
	assert(shaFile(cohortFile) === EXPECTED.cohort, "frozen cohort manifest changed");
	assert(shaFile(questions) === EXPECTED.holdoutQuestions, "frozen holdout questions changed");
	assert(shaFile(frozen399) === EXPECTED.frozen399, "frozen399 changed");
	const slots = cohorts().treatment;
	assert(slots.length === 10 && new Set(slots.map((slot) => slot.memoryUserId)).size === 10,
		"treatment cohort is inconsistent");
	return { hashes: { ...EXPECTED }, slots: slots.length };
}

export async function burnSnapshot(label, reserve = CALL_RESERVE) {
	const guard = await import(GUARD_URL);
	const usage = guard.neuronsSince(SINCE);
	const ledger = readJson(path.join(CAMPAIGN, "cost-ledger.json"));
	const spent = Math.max(0, usage.total - Number(ledger.campaign_baseline_neurons ?? 0));
	const ceiling = Number(ledger.V3_NEURON_CEILING);
	const unexpected = Object.keys(usage.byModel).filter((model) => !guard.PERMITTED_MODELS.includes(model));
	assert(unexpected.length === 0, `${label}: unpermitted billed model(s): ${unexpected.join(", ")}`);
	assert(ceiling === GLOBAL_CEILING, `${label}: campaign ceiling changed (${ceiling})`);
	assert(Number.isFinite(Number(reserve)) && Number(reserve) > 0, `${label}: invalid reserve`);
	assert(spent + Number(reserve) <= ceiling - FINAL_RESERVE,
		`${label}: next block could consume protected final reserve`);
	assert(spent - FINAL_VALIDATION_START_SPENT + Number(reserve) <= STAGE_B_CAP,
		`${label}: next block could exceed Stage B cap`);
	return {
		label,
		at: new Date().toISOString(),
		spent,
		ceiling,
		remaining: ceiling - spent,
		stageSpent: spent - FINAL_VALIDATION_START_SPENT,
		stageRemaining: STAGE_B_CAP - (spent - FINAL_VALIDATION_START_SPENT),
		reservedForNextBlock: Number(reserve),
		calls: usage.calls,
		byModel: usage.byModel,
	};
}

export function percentile(values, q) {
	const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
	if (!sorted.length) return null;
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

export function contentDigest(value) {
	return crypto.createHash("sha256").update(String(value)).digest("hex");
}

export async function expectedHealthActive() {
	const expected = {
		parent: ["allowlist", 30], capture: ["allowlist", 10], projection: ["allowlist", 10],
		coalescing: ["off", 0], hybrid: ["allowlist", 20], source: ["allowlist", 10],
		fallback: ["off", 0], adaptive: ["off", 0],
	};
	const snapshots = [];
	for (const domain of ["https://itsuki.app", "https://uml.gpmai.workers.dev"]) {
		const response = await fetch(`${domain}/health?final-stage-b=${Date.now()}-${Math.random()}`, {
			headers: { "cache-control": "no-cache" }, signal: AbortSignal.timeout(30_000),
		});
		assert(response.ok, `${domain}: health ${response.status}`);
		const status = (await response.json()).memory_v3;
		const check = (value, pair, label) => assert(value?.mode === pair[0] && value?.allowlistCount === pair[1],
			`${domain}: ${label} mismatch`);
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

export async function rulesDigest(token, externalId) {
	const response = await request(token, "GET", "/v1/rules", { query: { userId: externalId } });
	assert(response.ok && response.body?.ok === true && response.body?.rules, "rules read failed");
	return contentDigest(JSON.stringify(response.body.rules));
}

export async function stateCounts(slots = cohorts().treatment) {
	const ids = slots.map((slot) => sqlQuote(slot.memoryUserId)).join(", ");
	const [result] = await d1Select([`SELECT
		(SELECT COUNT(*) FROM source_episodes WHERE user_id IN (${ids})) AS episodes,
		(SELECT COUNT(*) FROM semantic_atom_candidates WHERE user_id IN (${ids})) AS atomic_candidates,
		(SELECT COUNT(*) FROM semantic_atom_capture_runs WHERE user_id IN (${ids})) AS atomic_runs,
		(SELECT COUNT(*) FROM semantic_atom_projections WHERE user_id IN (${ids})) AS projections,
		(SELECT COUNT(*) FROM nodes WHERE user_id IN (${ids}) AND deleted_at IS NULL) AS nodes,
		(SELECT COUNT(*) FROM slices WHERE user_id IN (${ids}) AND deleted_at IS NULL) AS slices,
		(SELECT COUNT(*) FROM events WHERE user_id IN (${ids}) AND deleted_at IS NULL) AS events,
		(SELECT COUNT(*) FROM edges WHERE user_id IN (${ids}) AND deleted_at IS NULL) AS edges,
		(SELECT COUNT(*) FROM memory_pages WHERE user_id IN (${ids}) AND deleted_at IS NULL) AS pages,
		(SELECT COUNT(*) FROM staged_memories WHERE user_id IN (${ids}) AND settled_at IS NULL) AS live_staged,
		(SELECT COUNT(*) FROM memory_jobs WHERE user_id IN (${ids})
			AND status NOT IN ('enriched','failed','completed')) AS nonterminal_jobs`]);
	return result.results?.[0] ?? {};
}

export function memoryCountsAreZero(counts) {
	return Object.values(counts).every((value) => integer(value) === 0);
}
