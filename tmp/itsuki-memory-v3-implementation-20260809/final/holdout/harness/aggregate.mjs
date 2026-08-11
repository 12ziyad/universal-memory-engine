import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import {
	ACCEPTED_PATH_SUMMARY,
	GLOBAL_LOCK,
	OUTPUT,
	RESULTS,
	assert,
	ratio,
	readJson,
	writeJsonExclusive,
} from "./common.mjs";

const require = createRequire(import.meta.url);
const { requireBenchmarkLockFromEnv } = require("../../../e2/harness/benchmark-lock.cjs");

function mean(values) {
	return values.reduce((sum, value) => sum + Number(value), 0) / values.length;
}

function variance(values) {
	const average = mean(values);
	return mean(values.map((value) => (Number(value) - average) ** 2));
}

function summarize(values) {
	const numeric = values.map(Number);
	const valueVariance = variance(numeric);
	return {
		values: numeric,
		mean: mean(numeric),
		variance: valueVariance,
		stddev: Math.sqrt(valueVariance),
		min: Math.min(...numeric),
		max: Math.max(...numeric),
		range: Math.max(...numeric) - Math.min(...numeric),
	};
}

function metricMeans(scores) {
	const keys = [
		"captureRecall", "capturePrecision", "captureF1", "judgeAccuracy", "tokenF1",
		"evidenceAvailability", "conditionalAccuracy", "absentEvidenceAccuracy",
		"sourceStoredAvailability", "candidateStoredAvailability", "duplicateRate",
		"neverStoredSource", "neverCapturedSemantic", "storedButNotRetrieved",
		"evidenceLostDuringAssembly", "sourceRecoveredEvidence", "readerErrorsWithEvidence",
	];
	return Object.fromEntries(keys.map((key) => [key, mean(scores.map((score) => score.metrics[key]))]));
}

function categoryMeans(scores) {
	const categories = new Set(scores.flatMap((score) => Object.keys(score.metrics.byCategory)));
	return Object.fromEntries([...categories].sort().map((category) => {
		const rows = scores.map((score) => score.metrics.byCategory[category]).filter(Boolean);
		return [category, {
			nPerSeed: rows.map((row) => row.n),
			accuracy: mean(rows.map((row) => row.accuracy)),
			availability: mean(rows.map((row) => row.availability)),
			tokenF1: mean(rows.map((row) => row.tokenF1)),
		}];
	}));
}

function allZero(value, keys) {
	return keys.every((key) => Number(value?.[key] ?? 0) === 0);
}

function main() {
	requireBenchmarkLockFromEnv();
	assert(process.env.BENCHMARK_LOCK_DIR === GLOBAL_LOCK, "wrong benchmark lock path");
	const output = path.join(RESULTS, "summary.json");
	assert(!fs.existsSync(output), "Stage D summary already exists");
	const scores = [1, 2, 3].map((seed) => readJson(path.join(OUTPUT, `seed${seed}.scores.json`)));
	const products = [1, 2, 3].map((seed) => readJson(path.join(OUTPUT, `seed${seed}.product.json`)));
	const cleanups = [1, 2, 3].map((seed) => readJson(path.join(OUTPUT, `seed${seed}.cleanup.json`)));
	const manifest = readJson(path.join(OUTPUT, "run-manifest.json"));
	assert(scores.every((score, index) => score.seed === index + 1 && score.metrics.questions === 42),
		"Stage D score accounting changed");
	assert(products.every((product, index) => product.seed === index + 1 && product.answers.length === 42
		&& product.ingests.length === 10), "Stage D product accounting changed");
	assert(cleanups.every((cleanup, index) => cleanup.seed === index + 1 && cleanup.dirty === 0),
		"Stage D cleanup is not clean");
	assert(manifest.seeds?.every((seed) => seed.status === "complete" && Number.isFinite(seed.neuronDelta)),
		"Stage D manifest lacks complete seed burn boundaries");
	const accepted = readJson(ACCEPTED_PATH_SUMMARY).treatment;
	const means = metricMeans(scores);
	const categories = categoryMeans(scores);
	const categoryComparison = Object.fromEntries(Object.entries(accepted.byCategory).map(([category, baseline]) => {
		const current = categories[category];
		assert(current, `accepted-path category missing from Stage D: ${category}`);
		return [category, {
			acceptedPathAccuracy: baseline.accuracy,
			stageDMeanAccuracy: current.accuracy,
			delta: current.accuracy - baseline.accuracy,
			within15pp: current.accuracy >= baseline.accuracy - 0.15,
		}];
	}));
	const safetyKeys = ["episodeFailures", "acceptedGroundingFailures", "acceptedScopeFailures",
		"acceptedSecretFailures", "accountingFailures", "extractionRunIdentityFailures", "boundedRecallFailures"];
	const safetyPass = scores.every((score) => allZero(score.metrics.safety, safetyKeys)
		&& score.metrics.safety.receiptConservation === 1
		&& score.metrics.safety.projectionConservation === 1
		&& score.metrics.safety.provenanceConservation === 1
		&& score.metrics.safety.readStateStable === true
		&& score.metrics.safety.replayStable === true
		&& score.metrics.sourceExpansion.failures === 0);
	const cleanupPass = cleanups.every((cleanup) => cleanup.dirty === 0
		&& Object.entries(cleanup.fingerprint.counts)
			.every(([key, value]) => key === "nonTerminalJobs" || Number(value) === 0));
	const gates = {
		zeroSecurityDurabilityAccountingFailure: safetyPass,
		allCleanupZero: cleanupPass,
		meanCapturePrecisionAtLeast95: means.capturePrecision >= 0.95,
		meanJudgeAtLeast80: means.judgeAccuracy >= 0.80,
		noSeedJudgeBelow75: scores.every((score) => score.metrics.judgeAccuracy >= 0.75),
		meanEvidenceAvailabilityAtLeast75: means.evidenceAvailability >= 0.75,
		noAcceptedCategoryCollapseOver15pp: Object.values(categoryComparison).every((row) => row.within15pp),
		allProductsAndScoresAccounted: scores.length === 3 && products.length === 3
			&& scores.every((score) => score.metrics.questions === 42),
	};
	gates.pass = Object.values(gates).every(Boolean);
	const metricVariance = Object.fromEntries([
		"captureRecall", "capturePrecision", "captureF1", "judgeAccuracy", "tokenF1",
		"evidenceAvailability", "conditionalAccuracy", "absentEvidenceAccuracy", "duplicateRate",
	].map((key) => [key, summarize(scores.map((score) => score.metrics[key]))]));
	const graphVariance = Object.fromEntries(["candidates", "projections", "nodes", "slices", "events", "edges", "pages"]
		.map((key) => [key, summarize(scores.map((score) => score.metrics.storage[key]))]));
	const latency = Object.fromEntries([
		"ingestMean", "extractionWaitMean", "atomicMean", "projectionMean", "recallServerMean",
		"recallClientMean", "readerMean", "judgeMean", "captureJudgeMean", "sourceExpansionMean",
	].map((key) => [key, summarize(scores.map((score) => score.metrics.latencyMs[key]))]));
	const neuronDeltas = manifest.seeds.map((seed) => seed.neuronDelta);
	const result = {
		schema: "itsuki.v3-final-holdout-summary/v1",
		seeds: 3,
		questionsPerSeed: 42,
		means,
		perSeed: scores.map((score, index) => ({
			seed: index + 1,
			productSha256: score.productSha256,
			metrics: score.metrics,
			neuronDelta: neuronDeltas[index],
			cleanupZero: cleanups[index].dirty === 0,
		})),
		metricVariance,
		graphVariance,
		categoryMeans: categories,
		acceptedPathCategoryComparison: categoryComparison,
		latencyVariance: latency,
		storage: {
			exportBytes: summarize(scores.map((score) => score.metrics.storage.exportBytes)),
			meanRows: Object.fromEntries(["episodes", "candidates", "projections", "nodes", "slices", "events", "edges", "pages"]
				.map((key) => [key, mean(scores.map((score) => score.metrics.storage[key]))])),
		},
		inference: {
			perSeedNeurons: neuronDeltas,
			observedNeurons: neuronDeltas.reduce((sum, value) => sum + value, 0),
			stageCap: 90_000,
			capFraction: ratio(neuronDeltas.reduce((sum, value) => sum + value, 0), 90_000),
		},
		gates,
		verdict: gates.pass ? "PASS_TO_STAGE_E" : "HOLDOUT_REJECT",
		completedAt: new Date().toISOString(),
	};
	fs.mkdirSync(RESULTS, { recursive: true });
	writeJsonExclusive(output, result);
	console.log(JSON.stringify(result, null, 2));
}

main();
