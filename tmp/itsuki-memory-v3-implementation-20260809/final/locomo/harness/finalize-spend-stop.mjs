import fs from "node:fs";
import path from "node:path";

import {
	GLOBAL_LOCK,
	OUTPUT,
	READER_MODEL,
	RESULTS,
	STAGE_CAP,
	assert,
	percentile,
	readJson,
	readJsonl,
	shaFile,
	writeJsonAtomic,
	writeJsonExclusive,
} from "./common.mjs";

const PRODUCT = path.join(OUTPUT, "product.json");
const SEAL = path.join(OUTPUT, "product.seal.json");
const CLEANUP = path.join(OUTPUT, "cleanup.json");
const PROGRESS = path.join(OUTPUT, "score-progress.json");
const JUDGE = path.join(OUTPUT, "judge.jsonl");
const SCORER_INPUT = path.join(RESULTS, "official-scorer-input.jsonl");
const SCORER_OUTPUT = path.join(RESULTS, "official-scorer-output.json");
const TERMINAL = path.join(RESULTS, "stage-e-terminal-summary.json");
const RETRIEVED_THRESHOLD = 0.5;
const EXPECTED_QUESTIONS = 1_540;
const EXPECTED_JUDGE_ROWS_AT_CAP = 960;
const NEXT_JUDGE_BLOCK_RESERVE = 12_000;
const CATEGORY_NAMES = Object.freeze({
	1: "multi-hop",
	2: "temporal-reasoning",
	3: "open-domain-knowledge",
	4: "single-hop",
});
const STOPWORDS = new Set("a an the and or but of in on at to for with is are was were be been being it its this that these those he she they them his her their i you we my your our as from by".split(" "));

function ratio(numerator, denominator) {
	return denominator ? numerator / denominator : null;
}

function normalizeTokens(text) {
	return String(text ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ")
		.split(/\s+/).filter((word) => word && !STOPWORDS.has(word));
}

function coverage(needle, haystack) {
	const wanted = normalizeTokens(needle);
	if (!wanted.length) return null;
	const corpus = new Set(normalizeTokens(haystack));
	return wanted.filter((token) => corpus.has(token)).length / wanted.length;
}

function duplicateRate(context) {
	const lines = String(context ?? "").split("\n")
		.map((line) => line.trim().toLowerCase()).filter(Boolean);
	return lines.length ? (lines.length - new Set(lines).size) / lines.length : 0;
}

function latency(rows, field) {
	const values = rows.map((row) => Number(row[field])).filter(Number.isFinite);
	return {
		n: values.length,
		mean: ratio(values.reduce((sum, value) => sum + value, 0), values.length),
		p50: percentile(values, 0.5),
		p95: percentile(values, 0.95),
		max: values.length ? Math.max(...values) : null,
	};
}

function validateJudge(judged, productById, scorerById, productSha256) {
	const seen = new Set();
	for (const row of judged) {
		const product = productById.get(row.question_id);
		const scored = scorerById.get(row.question_id);
		assert(product && scored && !seen.has(row.question_id),
			`invalid or duplicate judge row ${row.question_id}`);
		seen.add(row.question_id);
		assert(row.schema === "itsuki.v3-stage-e-judge/v1"
			&& row.product_sha256 === productSha256
			&& row.sample_id === product.sampleId
			&& row.category === product.category
			&& row.question === product.question
			&& row.reference_answer === scored.reference
			&& row.generated_answer === product.answer.text
			&& row.judge_model === READER_MODEL
			&& ["CORRECT", "WRONG"].includes(row.judgment),
		`${row.question_id}: judge protocol/input mismatch`);
	}
	return seen;
}

function main() {
	assert(!fs.existsSync(GLOBAL_LOCK), "benchmark lock exists; terminalization refused");
	for (const file of [PRODUCT, SEAL, CLEANUP, PROGRESS, JUDGE, SCORER_INPUT, SCORER_OUTPUT])
		assert(fs.existsSync(file), `required Stage E artifact is missing: ${file}`);
	assert(!fs.existsSync(path.join(OUTPUT, "scores.json")),
		"a purported complete score artifact exists despite the incomplete judge");
	assert(!fs.existsSync(TERMINAL), "Stage E terminal summary already exists");

	const product = readJson(PRODUCT);
	const seal = readJson(SEAL);
	const cleanup = readJson(CLEANUP);
	const progress = readJson(PROGRESS);
	const scored = readJson(SCORER_OUTPUT);
	const scorerRows = readJsonl(SCORER_INPUT);
	const judged = readJsonl(JUDGE);
	assert(product.schema === "itsuki.v3-stage-e-product/v1"
		&& product.answers?.length === EXPECTED_QUESTIONS && product.state?.length === 10,
	"sealed product accounting failed");
	assert(seal.productSha256 === shaFile(PRODUCT)
		&& seal.questions === EXPECTED_QUESTIONS && seal.sessions === 272 && seal.messages === 5_882,
	"sealed product hash/accounting failed");
	assert(scorerRows.length === EXPECTED_QUESTIONS
		&& scored.per_question?.length === EXPECTED_QUESTIONS
		&& scored.totals?.questions_excluding_adversarial === EXPECTED_QUESTIONS,
	"official scorer accounting failed");
	assert(judged.length === EXPECTED_JUDGE_ROWS_AT_CAP,
		`judge ledger changed after spend stop (${judged.length}/${EXPECTED_JUDGE_ROWS_AT_CAP})`);

	const productById = new Map(product.answers.map((row) => [row.questionId, row]));
	const stateBySample = new Map(product.state.map((row) => [row.sampleId, row]));
	const scorerById = new Map(scorerRows.map((row) => [row.question_id, row]));
	assert(productById.size === EXPECTED_QUESTIONS && scorerById.size === EXPECTED_QUESTIONS,
		"product/scorer identities are not unique");
	const judgeIds = validateJudge(judged, productById, scorerById, seal.productSha256);
	assert(judgeIds.size === EXPECTED_JUDGE_ROWS_AT_CAP, "judge identity accounting failed");

	const rows = product.answers.map((answer) => {
		const reference = scorerById.get(answer.questionId);
		const state = stateBySample.get(answer.sampleId);
		assert(reference && state && reference.category === answer.category,
			`${answer.questionId}: product/reference/state identity mismatch`);
		const sourceCoverage = coverage(reference.reference, state.corpora.source);
		const candidateCoverage = coverage(reference.reference, state.corpora.candidates);
		const selectedCoverage = coverage(reference.reference,
			JSON.stringify([answer.retrieval.nodes, answer.retrieval.pages]));
		const semanticRenderedCoverage = coverage(reference.reference,
			answer.retrieval.semanticContext);
		const finalCoverage = coverage(reference.reference, answer.retrieval.context);
		return {
			category: answer.category,
			sourceStoredAvailable: sourceCoverage !== null && sourceCoverage >= RETRIEVED_THRESHOLD,
			candidateStoredAvailable: candidateCoverage !== null && candidateCoverage >= RETRIEVED_THRESHOLD,
			selectedAvailable: selectedCoverage !== null && selectedCoverage >= RETRIEVED_THRESHOLD,
			semanticRenderedAvailable: semanticRenderedCoverage !== null
				&& semanticRenderedCoverage >= RETRIEVED_THRESHOLD,
			evidenceAvailable: finalCoverage !== null && finalCoverage >= RETRIEVED_THRESHOLD,
			contextItems: Number(answer.retrieval.itemCount),
			contextLines: Number(answer.retrieval.contextLines),
			contextChars: Number(answer.retrieval.contextChars),
			contextTokensApprox: Number(answer.retrieval.contextTokensApprox),
			duplicateRate: duplicateRate(answer.retrieval.context),
			hybridAssertionCandidates: Number(answer.retrieval.hybridAssertionCandidates),
			hybridParentCandidates: Number(answer.retrieval.hybridParentCandidates),
			sourceExpansionAssertions: Number(answer.retrieval.sourceExpansion?.assertions ?? 0),
			sourceExpansionEpisodes: Number(answer.retrieval.sourceExpansion?.episodes ?? 0),
			recallServerMs: Number(answer.retrieval.serverLatencyMs),
			recallClientMs: Number(answer.retrieval.clientLatencyMs),
			sourceExpansionMs: Number(answer.retrieval.sourceExpansion?.latencyMs),
			readerMs: Number(answer.answer.latencyMs),
		};
	});

	const available = rows.filter((row) => row.evidenceAvailable);
	const categories = scored.by_category.map((scoreCategory) => {
		const subset = rows.filter((row) => row.category === Number(scoreCategory.category));
		const categoryAvailable = subset.filter((row) => row.evidenceAvailable).length;
		return {
			category: Number(scoreCategory.category),
			name: CATEGORY_NAMES[scoreCategory.category],
			n: subset.length,
			tokenF1: Number(scoreCategory.mean),
			evidenceAvailable: categoryAvailable,
			evidenceAvailability: ratio(categoryAvailable, subset.length),
			judgeAccuracy: null,
			judgeStatus: "INCOMPLETE_HARD_SPEND_CAP",
		};
	});
	const ingestRequests = product.ingests.flatMap((row) => row.batches ?? [])
		.map((batch) => Number(batch.requestLatencyMs)).filter(Number.isFinite);
	const extractionWait = product.ingests.flatMap((row) => row.batches ?? [])
		.map((batch) => Number(batch.ready?.waitedMs)).filter(Number.isFinite);
	const integrity = product.state.reduce((out, state) => {
		for (const key of ["episodeFailures", "groundingFailures", "scopeFailures", "secretFailures",
			"runAccountingFailures", "projectionFailures", "truncations", "extractionRetries"])
			out[key] += Number(state.integrity[key] ?? 0);
		for (const [key, value] of Object.entries(state.integrity.counts ?? {}))
			out.storage[key] = (out.storage[key] ?? 0) + Number(value);
		return out;
	}, { episodeFailures: 0, groundingFailures: 0, scopeFailures: 0, secretFailures: 0,
		runAccountingFailures: 0, projectionFailures: 0, truncations: 0,
		extractionRetries: 0, storage: {} });
	for (const key of ["episodeFailures", "groundingFailures", "scopeFailures", "secretFailures",
		"runAccountingFailures", "projectionFailures"])
		assert(integrity[key] === 0, `product integrity failed: ${key}=${integrity[key]}`);

	const cleanupCounts = cleanup.clean?.counts ?? {};
	const cleanupDerived = cleanup.clean?.derived ?? {};
	assert(Object.values(cleanupCounts).every((value) => Number(value) === 0)
		&& Object.values(cleanupDerived).every((value) => Number(value) === 0)
		&& cleanup.fts?.episodeFts === 0 && cleanup.fts?.semanticFts === 0
		&& cleanup.packets?.content_rows === 0
		&& cleanup.packets?.packets === cleanup.packets?.minimized
		&& cleanup.recall?.length === 10 && cleanup.recall.every((row) => row.count === 0 && row.contextChars === 0)
		&& cleanup.exports?.length === 10
		&& cleanup.exports.every((row) => Object.values(row.counts ?? {}).every((value) => Number(value) === 0)),
	"cleanup zero-state proof failed");
	const burn = cleanup.burnAfter;
	assert(Number(burn.stageSpent) <= STAGE_CAP
		&& Number(burn.stageRemaining) < NEXT_JUDGE_BLOCK_RESERVE,
	"hard Stage E spend-stop proof failed");

	const terminal = {
		schema: "itsuki.v3-stage-e-terminal-summary/v1",
		completedAt: new Date().toISOString(),
		status: "TERMINAL_HARD_SPEND_CAP_AFTER_CLEANUP",
		product: {
			sha256: seal.productSha256,
			bytes: seal.files["product.json"].bytes,
			answers: product.answers.length,
			sessions: seal.sessions,
			messages: seal.messages,
			stateFingerprintSha256: seal.stateFingerprintSha256,
			fixed: product.fixed,
			productNeuronDeltaObserved: product.neuronDeltaObserved,
		},
		officialTokenF1: {
			status: "COMPLETE",
			questions: scored.totals.questions_excluding_adversarial,
			overall: scored.totals.overall_f1_excluding_adversarial,
			byCategory: categories,
			scorerInputSha256: shaFile(SCORER_INPUT),
			scorerOutputSha256: shaFile(SCORER_OUTPUT),
		},
		judge: {
			status: "INCOMPLETE_HARD_SPEND_CAP",
			completedRows: judged.length,
			requiredRows: EXPECTED_QUESTIONS,
			missingRows: EXPECTED_QUESTIONS - judged.length,
			accuracy: null,
			conditionalAccuracy: null,
			absentEvidenceAccuracy: null,
			partialAccuracyWithheld: true,
			extrapolationPerformed: false,
			judgeModel: READER_MODEL,
			ledgerSha256: shaFile(JUDGE),
			stopReason: `Stage E remaining ${burn.stageRemaining} neurons was below the ${NEXT_JUDGE_BLOCK_RESERVE}-neuron fail-closed reserve required for the next judge block`,
		},
		evidence: {
			threshold: RETRIEVED_THRESHOLD,
			available: available.length,
			availability: ratio(available.length, rows.length),
			sourceStoredAvailable: rows.filter((row) => row.sourceStoredAvailable).length,
			sourceStoredAvailability: ratio(rows.filter((row) => row.sourceStoredAvailable).length, rows.length),
			candidateStoredAvailable: rows.filter((row) => row.candidateStoredAvailable).length,
			candidateStoredAvailability: ratio(rows.filter((row) => row.candidateStoredAvailable).length, rows.length),
			selectedBeforeRenderAvailable: rows.filter((row) => row.selectedAvailable).length,
			selectedBeforeRenderAvailability: ratio(rows.filter((row) => row.selectedAvailable).length, rows.length),
			semanticRenderedAvailable: rows.filter((row) => row.semanticRenderedAvailable).length,
			semanticRenderedAvailability: ratio(rows.filter((row) => row.semanticRenderedAvailable).length, rows.length),
			neverStoredSource: rows.filter((row) => !row.sourceStoredAvailable).length,
			neverCapturedSemantic: rows.filter((row) => !row.candidateStoredAvailable).length,
			storedButNotRetrieved: rows.filter((row) => (row.sourceStoredAvailable || row.candidateStoredAvailable)
				&& !row.evidenceAvailable).length,
			evidenceLostDuringAssembly: rows.filter((row) => row.selectedAvailable
				&& !row.semanticRenderedAvailable).length,
			sourceRecoveredEvidence: rows.filter((row) => !row.semanticRenderedAvailable
				&& row.evidenceAvailable).length,
		},
		context: {
			itemsMean: ratio(rows.reduce((sum, row) => sum + row.contextItems, 0), rows.length),
			itemsP95: percentile(rows.map((row) => row.contextItems), 0.95),
			itemsMax: Math.max(...rows.map((row) => row.contextItems)),
			linesMean: ratio(rows.reduce((sum, row) => sum + row.contextLines, 0), rows.length),
			charsMean: ratio(rows.reduce((sum, row) => sum + row.contextChars, 0), rows.length),
			charsP95: percentile(rows.map((row) => row.contextChars), 0.95),
			charsMax: Math.max(...rows.map((row) => row.contextChars)),
			tokensApproxMean: ratio(rows.reduce((sum, row) => sum + row.contextTokensApprox, 0), rows.length),
			tokensApproxP95: percentile(rows.map((row) => row.contextTokensApprox), 0.95),
			tokensApproxMax: Math.max(...rows.map((row) => row.contextTokensApprox)),
			duplicateRateMean: ratio(rows.reduce((sum, row) => sum + row.duplicateRate, 0), rows.length),
			hybridAssertionCandidatesMean: ratio(rows.reduce((sum, row) => sum + row.hybridAssertionCandidates, 0), rows.length),
			hybridParentCandidatesMean: ratio(rows.reduce((sum, row) => sum + row.hybridParentCandidates, 0), rows.length),
			sourceExpansionAssertions: rows.reduce((sum, row) => sum + row.sourceExpansionAssertions, 0),
			sourceExpansionEpisodes: rows.reduce((sum, row) => sum + row.sourceExpansionEpisodes, 0),
		},
		latencyMs: {
			ingestRequest: { n: ingestRequests.length,
				mean: ratio(ingestRequests.reduce((sum, value) => sum + value, 0), ingestRequests.length),
				p95: percentile(ingestRequests, 0.95), max: ingestRequests.length ? Math.max(...ingestRequests) : null },
			extractionWait: { n: extractionWait.length,
				mean: ratio(extractionWait.reduce((sum, value) => sum + value, 0), extractionWait.length),
				p95: percentile(extractionWait, 0.95), max: extractionWait.length ? Math.max(...extractionWait) : null },
			recallServer: latency(rows, "recallServerMs"),
			recallClient: latency(rows, "recallClientMs"),
			sourceExpansion: latency(rows, "sourceExpansionMs"),
			reader: latency(rows, "readerMs"),
			judgeCompletedRowsOnly: latency(judged.map((row) => ({ value: row.judge_latency_ms })), "value"),
		},
		integrity,
		inference: {
			campaignSpent: burn.spent,
			campaignCeiling: burn.ceiling,
			campaignRemaining: burn.remaining,
			stageStartSpent: burn.stageStart,
			stageSpent: burn.stageSpent,
			stageCap: STAGE_CAP,
			stageRemaining: burn.stageRemaining,
			calls: burn.calls,
			byModel: burn.byModel,
			estimatedCampaignUsdAt0_011Per1k: burn.spent / 1_000 * 0.011,
		},
		cleanup: {
			status: "PASS_ZERO",
			cleanedAt: cleanup.cleanedAt,
			counts: cleanupCounts,
			derived: cleanupDerived,
			fts: cleanup.fts,
			recallProofs: cleanup.recall.length,
			exportProofs: cleanup.exports.length,
			packets: cleanup.packets,
			sha256: shaFile(CLEANUP),
		},
		comparison: {
			v1: { tokenF1: 0.1540, judgeAccuracy: 0.2565, evidenceAvailability: 0.2883 },
			combinedE1E0: { tokenF1: 0.2745108589005224, judgeAccuracy: 0.4675,
				evidenceAvailability: 0.6597402597402597 },
			finalV3: { tokenF1: scored.totals.overall_f1_excluding_adversarial,
				judgeAccuracy: null, evidenceAvailability: ratio(available.length, rows.length) },
		},
	};

	writeJsonExclusive(TERMINAL, terminal);
	progress.status = "stopped_hard_spend_cap_after_cleanup";
	progress.stoppedAt = terminal.completedAt;
	progress.judgeRows = judged.length;
	progress.requiredJudgeRows = EXPECTED_QUESTIONS;
	progress.stopReason = terminal.judge.stopReason;
	progress.terminalSummarySha256 = shaFile(TERMINAL);
	progress.finalBurn = burn;
	writeJsonAtomic(PROGRESS, progress);
	console.log(`STAGE E TERMINALIZED tokenF1=${(terminal.officialTokenF1.overall * 100).toFixed(2)}% availability=${(terminal.evidence.availability * 100).toFixed(2)}% judge=INCOMPLETE ${judged.length}/${EXPECTED_QUESTIONS}`);
}

main();
