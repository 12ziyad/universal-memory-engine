import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

import {
	DATASET,
	GLOBAL_LOCK,
	JUDGE_BLOCK,
	OFFICIAL_SCORER,
	OUTPUT,
	PYTHON,
	READER_MODEL,
	RESULTS,
	assert,
	appendJsonl,
	burnSnapshot,
	percentile,
	productInputs,
	ratio,
	readJson,
	readJsonl,
	secret,
	shaFile,
	validateFrozenInputs,
	writeJsonAtomic,
	writeJsonExclusive,
} from "./common.mjs";

const require = createRequire(import.meta.url);
const { requireBenchmarkLockFromEnv } = require("../../../e2/harness/benchmark-lock.cjs");
const { Mem0StyleJudge, PROTOCOL } = require("../../../phase3-d04/judge/judge-client.js");

const PRODUCT = path.join(OUTPUT, "product.json");
const SEAL = path.join(OUTPUT, "product.seal.json");
const PROGRESS = path.join(OUTPUT, "score-progress.json");
const SCORER_INPUT = path.join(RESULTS, "official-scorer-input.jsonl");
const SCORER_OUTPUT = path.join(RESULTS, "official-scorer-output.json");
const JUDGE_LEDGER = path.join(OUTPUT, "judge.jsonl");
const SCORES = path.join(OUTPUT, "scores.json");
const QUESTION_CONCURRENCY = 4;
const RETRIEVED_THRESHOLD = 0.5;
const STOPWORDS = new Set("a an the and or but of in on at to for with is are was were be been being it its this that these those he she they them his her their i you we my your our as from by".split(" "));

function stageStart() {
	const value = Number(process.env.STAGE_E_START_SPENT);
	assert(Number.isInteger(value) && value >= 0, "STAGE_E_START_SPENT is required");
	return value;
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
	const lines = String(context ?? "").split("\n").map((line) => line.trim().toLowerCase()).filter(Boolean);
	return lines.length ? (lines.length - new Set(lines).size) / lines.length : 0;
}

function referenceRows(product) {
	// This is the first point in Stage E that opens the reference-bearing source.
	// The caller has already verified the exclusive product seal.
	const dataset = JSON.parse(fs.readFileSync(DATASET, "utf8"));
	const productById = new Map(product.answers.map((row) => [row.questionId, row]));
	const rows = [];
	for (const sample of dataset) {
		for (const [questionIndex, qa] of sample.qa.entries()) {
			if (![1, 2, 3, 4].includes(Number(qa.category))) continue;
			const questionId = `${sample.sample_id}#${questionIndex}`;
			const answer = productById.get(questionId);
			assert(answer, `sealed product omitted ${questionId}`);
			assert(answer.sampleId === sample.sample_id && answer.question === String(qa.question)
				&& answer.category === Number(qa.category), `${questionId}: product/reference identity mismatch`);
			rows.push({
				questionId,
				sampleId: sample.sample_id,
				category: Number(qa.category),
				question: String(qa.question),
				reference: String(qa.answer ?? ""),
				evidence: Array.isArray(qa.evidence) ? qa.evidence : [],
				prediction: answer.answer.text,
				product: answer,
			});
		}
	}
	assert(rows.length === 1_540 && new Set(rows.map((row) => row.questionId)).size === 1_540,
		"reference accounting changed");
	return rows;
}

function validateProduct() {
	validateFrozenInputs();
	assert(fs.existsSync(PRODUCT) && fs.existsSync(SEAL), "sealed product is required before scoring");
	const product = readJson(PRODUCT);
	const seal = readJson(SEAL);
	assert(product.schema === "itsuki.v3-stage-e-product/v1"
		&& product.answers?.length === 1_540 && product.ingests?.length === 272,
	"Stage E product is inconsistent");
	assert(seal.schema === "itsuki.v3-stage-e-product-seal/v1"
		&& seal.productSha256 === shaFile(PRODUCT)
		&& seal.questions === 1_540 && seal.sessions === 272 && seal.messages === 5_882,
	"Stage E product seal is inconsistent");
	for (const [name, detail] of Object.entries(seal.files ?? {})) {
		const candidates = [path.join(OUTPUT, name), path.join(path.dirname(OUTPUT), "frozen", name),
			path.join(path.dirname(OUTPUT), name)];
		const file = candidates.find(fs.existsSync);
		assert(file && shaFile(file) === detail.sha256 && fs.statSync(file).size === detail.bytes,
			`sealed product dependency changed: ${name}`);
	}
	return { product, seal };
}

function runOfficialScorer(rows) {
	fs.mkdirSync(RESULTS, { recursive: true });
	const inputExists = fs.existsSync(SCORER_INPUT);
	const outputExists = fs.existsSync(SCORER_OUTPUT);
	assert(inputExists || !outputExists, "official scorer output exists without its sealed input; STOP");
	const serialized = rows.map((row) => JSON.stringify({
		question_id: row.questionId,
		category: row.category,
		reference: row.reference,
		prediction: row.prediction,
		evidence: row.evidence,
	})).join("\n") + "\n";
	if (!inputExists) {
		fs.writeFileSync(SCORER_INPUT, serialized, { flag: "wx" });
	} else {
		assert(fs.readFileSync(SCORER_INPUT, "utf8") === serialized,
			"official scorer input does not match sealed product/reference join");
	}
	// A local interpreter launch can fail after the immutable scorer input is
	// durably written but before output exists. Re-running that deterministic,
	// inference-free subprocess is safe; an output without its exact input is not.
	if (!outputExists) {
		assert(fs.existsSync(PYTHON), `official scorer Python runtime is missing: ${PYTHON}`);
		execFileSync(PYTHON, [OFFICIAL_SCORER, "--in", SCORER_INPUT, "--out", SCORER_OUTPUT], {
			stdio: "inherit", windowsHide: true,
		});
	}
	const scored = readJson(SCORER_OUTPUT);
	assert(scored.totals?.questions_scored === 1_540
		&& scored.totals?.questions_excluding_adversarial === 1_540
		&& scored.per_question?.length === 1_540,
	"official scorer accounting failed");
	return scored;
}

function assertJudgeLedger(rows, references, productSha256) {
	const expected = new Map(references.map((row) => [row.questionId, row]));
	const seen = new Set();
	for (const row of rows) {
		const wanted = expected.get(row.question_id);
		assert(wanted && !seen.has(row.question_id), `inconsistent judge ledger row ${row.question_id}`);
		seen.add(row.question_id);
		assert(row.product_sha256 === productSha256 && row.sample_id === wanted.sampleId
			&& row.category === wanted.category && row.question === wanted.question
			&& row.reference_answer === wanted.reference && row.generated_answer === wanted.prediction
			&& row.judge_model === READER_MODEL && ["CORRECT", "WRONG"].includes(row.judgment),
		`${row.question_id}: judge protocol/input mismatch`);
	}
	return seen;
}

async function judgeAll(references, productSha256, start) {
	let ledger = readJsonl(JUDGE_LEDGER);
	let seen = assertJudgeLedger(ledger, references, productSha256);
	const apiKey = secret("API_KEY");
	console.log("eval-door key: LOADED");
	const judge = new Mem0StyleJudge({ model: READER_MODEL, apiKey });
	assert(judge.temperature === 0 && judge.maxTokens === 4_096,
		"judge protocol changed");
	let todo = references.filter((row) => !seen.has(row.questionId));
	while (todo.length) {
		const block = todo.slice(0, JUDGE_BLOCK);
		await burnSnapshot(`StageE:judge:${seen.size + 1}-${seen.size + block.length}`, 12_000, start);
		await Promise.all(Array.from({ length: Math.min(QUESTION_CONCURRENCY, block.length) }, async (_, worker) => {
			for (let index = worker; index < block.length; index += QUESTION_CONCURRENCY) {
				const row = block[index];
				const verdict = await judge.judge({
					category: row.category,
					question: row.question,
					referenceAnswer: row.reference,
					generatedAnswer: row.prediction,
				});
				appendJsonl(JUDGE_LEDGER, {
					schema: "itsuki.v3-stage-e-judge/v1",
					product_sha256: productSha256,
					question_id: row.questionId,
					sample_id: row.sampleId,
					category: row.category,
					category_name: PROTOCOL.category_names[String(row.category)],
					question: row.question,
					reference_answer: row.reference,
					processed_reference_answer: verdict.processedReference,
					generated_answer: row.prediction,
					judgment: verdict.judgment,
					score: verdict.score,
					judge_reason: verdict.reason,
					judge_model: verdict.model,
					judge_latency_ms: verdict.latencyMs,
					judge_retries: verdict.retries,
					judge_error: verdict.error,
					at: new Date().toISOString(),
				});
			}
		}));
		ledger = readJsonl(JUDGE_LEDGER);
		seen = assertJudgeLedger(ledger, references, productSha256);
		console.log(`JUDGE ${seen.size}/1540`);
		todo = references.filter((row) => !seen.has(row.questionId));
	}
	assert(ledger.length === 1_540 && seen.size === 1_540,
		`judge accounting failed ${ledger.length}/${seen.size}`);
	const order = new Map(references.map((row, index) => [row.questionId, index]));
	return ledger.sort((a, b) => order.get(a.question_id) - order.get(b.question_id));
}

async function settledBurn(start) {
	let previous = null;
	let stable = 0;
	let snapshot = null;
	for (let attempt = 1; attempt <= 12; attempt += 1) {
		snapshot = await burnSnapshot(`StageE:settle:${attempt}`, 1_000, start);
		if (snapshot.spent === previous) stable += 1;
		else stable = 0;
		if (stable >= 2) return { ...snapshot, settledPolls: attempt, settled: true };
		previous = snapshot.spent;
		await new Promise((resolve) => setTimeout(resolve, 10_000));
	}
	return { ...snapshot, settledPolls: 12, settled: false };
}

function metrics(product, references, scored, judged, finalBurn, start) {
	const scoreById = new Map(scored.per_question.map((row) => [row.question_id, row.score]));
	const judgeById = new Map(judged.map((row) => [row.question_id, row]));
	const stateBySample = new Map(product.state.map((row) => [row.sampleId, row]));
	const rows = references.map((row) => {
		const judge = judgeById.get(row.questionId);
		const state = stateBySample.get(row.sampleId);
		const selected = JSON.stringify([row.product.retrieval.nodes, row.product.retrieval.pages]);
		const sourceCoverage = coverage(row.reference, state.corpora.source);
		const candidateCoverage = coverage(row.reference, state.corpora.candidates);
		const selectedCoverage = coverage(row.reference, selected);
		const semanticRenderedCoverage = coverage(row.reference, row.product.retrieval.semanticContext);
		const finalCoverage = coverage(row.reference, row.product.retrieval.context);
		return {
			questionId: row.questionId,
			sampleId: row.sampleId,
			category: row.category,
			categoryName: PROTOCOL.category_names[String(row.category)],
			tokenF1: Number(scoreById.get(row.questionId) ?? 0),
			judgeCorrect: judge?.judgment === "CORRECT",
			judgeError: judge?.judge_error ?? null,
			sourceCoverage,
			candidateCoverage,
			selectedCoverage,
			semanticRenderedCoverage,
			finalCoverage,
			sourceStoredAvailable: sourceCoverage !== null && sourceCoverage >= RETRIEVED_THRESHOLD,
			candidateStoredAvailable: candidateCoverage !== null && candidateCoverage >= RETRIEVED_THRESHOLD,
			selectedAvailable: selectedCoverage !== null && selectedCoverage >= RETRIEVED_THRESHOLD,
			semanticRenderedAvailable: semanticRenderedCoverage !== null && semanticRenderedCoverage >= RETRIEVED_THRESHOLD,
			evidenceAvailable: finalCoverage !== null && finalCoverage >= RETRIEVED_THRESHOLD,
			contextItems: row.product.retrieval.itemCount,
			contextLines: row.product.retrieval.contextLines,
			contextChars: row.product.retrieval.contextChars,
			contextTokensApprox: row.product.retrieval.contextTokensApprox,
			duplicateRate: duplicateRate(row.product.retrieval.context),
			hybridAssertionCandidates: row.product.retrieval.hybridAssertionCandidates,
			hybridParentCandidates: row.product.retrieval.hybridParentCandidates,
			sourceExpansionAssertions: row.product.retrieval.sourceExpansion.assertions,
			sourceExpansionEpisodes: row.product.retrieval.sourceExpansion.episodes,
			recallServerMs: row.product.retrieval.serverLatencyMs,
			recallClientMs: row.product.retrieval.clientLatencyMs,
			sourceExpansionMs: row.product.retrieval.sourceExpansion.latencyMs,
			readerMs: row.product.answer.latencyMs,
			judgeMs: judge?.judge_latency_ms ?? null,
		};
	});
	const available = rows.filter((row) => row.evidenceAvailable);
	const absent = rows.filter((row) => !row.evidenceAvailable);
	const byCategory = Object.values(PROTOCOL.category_names).filter((name) => name !== "adversarial")
		.map((name) => {
			const subset = rows.filter((row) => row.categoryName === name);
			return {
				name,
				n: subset.length,
				judgeCorrect: subset.filter((row) => row.judgeCorrect).length,
				judgeAccuracy: ratio(subset.filter((row) => row.judgeCorrect).length, subset.length),
				tokenF1: ratio(subset.reduce((sum, row) => sum + row.tokenF1, 0), subset.length),
				evidenceAvailable: subset.filter((row) => row.evidenceAvailable).length,
				evidenceAvailability: ratio(subset.filter((row) => row.evidenceAvailable).length, subset.length),
				conditionalAccuracy: ratio(subset.filter((row) => row.evidenceAvailable && row.judgeCorrect).length,
					subset.filter((row) => row.evidenceAvailable).length),
			};
		});
	const latency = (field) => {
		const values = rows.map((row) => Number(row[field])).filter(Number.isFinite);
		return { n: values.length, mean: ratio(values.reduce((sum, value) => sum + value, 0), values.length),
			p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: values.length ? Math.max(...values) : null };
	};
	const ingestRequests = product.ingests.flatMap((row) => row.batches.map((batch) => batch.requestLatencyMs));
	const extractionWait = product.ingests.flatMap((row) => row.batches.map((batch) => batch.ready.waitedMs));
	const integrity = product.state.reduce((out, state) => {
		for (const key of ["episodeFailures", "groundingFailures", "scopeFailures", "secretFailures",
			"runAccountingFailures", "projectionFailures", "truncations", "extractionRetries"])
			out[key] += Number(state.integrity[key] ?? 0);
		for (const [key, value] of Object.entries(state.integrity.counts)) out.storage[key] = (out.storage[key] ?? 0) + Number(value);
		return out;
	}, { episodeFailures: 0, groundingFailures: 0, scopeFailures: 0, secretFailures: 0,
		runAccountingFailures: 0, projectionFailures: 0, truncations: 0, extractionRetries: 0, storage: {} });
	return {
		schema: "itsuki.v3-stage-e-scores/v1",
		completedAt: new Date().toISOString(),
		productSha256: shaFile(PRODUCT),
		accounting: {
			productAnswers: product.answers.length,
			officialScores: scored.per_question.length,
			judgeVerdicts: judged.length,
			reconciles: product.answers.length === 1_540 && scored.per_question.length === 1_540 && judged.length === 1_540,
		},
		overall: {
			questions: rows.length,
			judgeCorrect: rows.filter((row) => row.judgeCorrect).length,
			judgeAccuracy: ratio(rows.filter((row) => row.judgeCorrect).length, rows.length),
			tokenF1: scored.totals.overall_f1_excluding_adversarial,
			evidenceAvailable: available.length,
			evidenceAvailability: ratio(available.length, rows.length),
			conditionalCorrect: available.filter((row) => row.judgeCorrect).length,
			conditionalAccuracy: ratio(available.filter((row) => row.judgeCorrect).length, available.length),
			absentEvidence: absent.length,
			absentCorrect: absent.filter((row) => row.judgeCorrect).length,
			absentEvidenceAccuracy: ratio(absent.filter((row) => row.judgeCorrect).length, absent.length),
			sourceStoredAvailability: ratio(rows.filter((row) => row.sourceStoredAvailable).length, rows.length),
			candidateStoredAvailability: ratio(rows.filter((row) => row.candidateStoredAvailable).length, rows.length),
			selectedBeforeRenderAvailability: ratio(rows.filter((row) => row.selectedAvailable).length, rows.length),
			semanticRenderedAvailability: ratio(rows.filter((row) => row.semanticRenderedAvailable).length, rows.length),
			neverStoredSource: rows.filter((row) => !row.sourceStoredAvailable).length,
			neverCapturedSemantic: rows.filter((row) => !row.candidateStoredAvailable).length,
			storedButNotRetrieved: rows.filter((row) => (row.sourceStoredAvailable || row.candidateStoredAvailable)
				&& !row.evidenceAvailable).length,
			evidenceLostDuringAssembly: rows.filter((row) => row.selectedAvailable && !row.semanticRenderedAvailable).length,
			sourceRecoveredEvidence: rows.filter((row) => !row.semanticRenderedAvailable && row.evidenceAvailable).length,
			readerErrorsWithEvidence: available.filter((row) => !row.judgeCorrect).length,
			judgeErrorsCountedWrong: rows.filter((row) => row.judgeError).length,
		},
		byCategory,
		context: {
			itemsMean: ratio(rows.reduce((sum, row) => sum + row.contextItems, 0), rows.length),
			itemsP95: percentile(rows.map((row) => row.contextItems), 0.95),
			linesMean: ratio(rows.reduce((sum, row) => sum + row.contextLines, 0), rows.length),
			charsMean: ratio(rows.reduce((sum, row) => sum + row.contextChars, 0), rows.length),
			charsP95: percentile(rows.map((row) => row.contextChars), 0.95),
			charsMax: Math.max(...rows.map((row) => row.contextChars)),
			tokensApproxMean: ratio(rows.reduce((sum, row) => sum + row.contextTokensApprox, 0), rows.length),
			duplicateRateMean: ratio(rows.reduce((sum, row) => sum + row.duplicateRate, 0), rows.length),
			hybridAssertionCandidatesMean: ratio(rows.reduce((sum, row) => sum + row.hybridAssertionCandidates, 0), rows.length),
			hybridParentCandidatesMean: ratio(rows.reduce((sum, row) => sum + row.hybridParentCandidates, 0), rows.length),
			sourceExpansionAssertions: rows.reduce((sum, row) => sum + row.sourceExpansionAssertions, 0),
			sourceExpansionEpisodes: rows.reduce((sum, row) => sum + row.sourceExpansionEpisodes, 0),
		},
		latencyMs: {
			ingestRequest: { n: ingestRequests.length, mean: ratio(ingestRequests.reduce((a, b) => a + b, 0), ingestRequests.length),
				p95: percentile(ingestRequests, 0.95), max: Math.max(...ingestRequests) },
			extractionWait: { n: extractionWait.length, mean: ratio(extractionWait.reduce((a, b) => a + b, 0), extractionWait.length),
				p95: percentile(extractionWait, 0.95), max: Math.max(...extractionWait) },
			recallServer: latency("recallServerMs"),
			recallClient: latency("recallClientMs"),
			sourceExpansion: latency("sourceExpansionMs"),
			reader: latency("readerMs"),
			judge: latency("judgeMs"),
		},
		integrity,
		inference: {
			stageStartSpent: start,
			finalSpent: finalBurn.spent,
			stageNeuronDelta: finalBurn.spent - start,
			stageCap: 500_000,
			settled: finalBurn.settled,
			settledPolls: finalBurn.settledPolls,
			campaignCeiling: finalBurn.ceiling,
			campaignRemaining: finalBurn.remaining,
			calls: finalBurn.calls,
			byModel: finalBurn.byModel,
		},
		comparison: {
			v1: { tokenF1: 0.1540, judgeAccuracy: 0.2565, evidenceAvailability: 0.2883 },
			combinedE1E0: { tokenF1: 0.2745108589005224, judgeAccuracy: 0.4675,
				evidenceAvailability: 0.6597402597402597 },
		},
		perQuestion: rows,
	};
}

async function main() {
	requireBenchmarkLockFromEnv();
	assert(process.env.BENCHMARK_LOCK_DIR === GLOBAL_LOCK, "wrong benchmark lock path");
	assert(!fs.existsSync(SCORES), "Stage E score artifact already exists");
	const { product, seal } = validateProduct();
	const start = stageStart();
	let progress;
	if (fs.existsSync(PROGRESS)) {
		progress = readJson(PROGRESS);
		assert(progress.schema === "itsuki.v3-stage-e-score-progress/v1"
			&& progress.status === "running" && progress.productSha256 === seal.productSha256
			&& progress.stageStartSpent === start, "score progress is not safely resumable");
	} else {
		progress = {
			schema: "itsuki.v3-stage-e-score-progress/v1",
			status: "running",
			startedAt: new Date().toISOString(),
			productSha256: seal.productSha256,
			stageStartSpent: start,
			burnBefore: await burnSnapshot("StageE:score-start", 15_000, start),
		};
		writeJsonAtomic(PROGRESS, progress);
	}
	const references = referenceRows(product);
	const scored = runOfficialScorer(references);
	progress.officialScoreCompleteAt = new Date().toISOString();
	progress.officialScores = scored.per_question.length;
	writeJsonAtomic(PROGRESS, progress);
	const judged = await judgeAll(references, seal.productSha256, start);
	const finalBurn = await settledBurn(start);
	const result = metrics(product, references, scored, judged, finalBurn, start);
	assert(result.accounting.reconciles, "Stage E final accounting did not reconcile");
	assert(result.integrity.episodeFailures === 0 && result.integrity.groundingFailures === 0
		&& result.integrity.scopeFailures === 0 && result.integrity.secretFailures === 0
		&& result.integrity.runAccountingFailures === 0 && result.integrity.projectionFailures === 0,
	"Stage E product integrity failed");
	writeJsonExclusive(SCORES, result);
	writeJsonExclusive(path.join(RESULTS, "summary.json"), { ...result, perQuestion: undefined });
	progress.status = "complete";
	progress.completedAt = new Date().toISOString();
	progress.scoresSha256 = shaFile(SCORES);
	progress.finalBurn = finalBurn;
	writeJsonAtomic(PROGRESS, progress);
	console.log(`STAGE E SCORE COMPLETE judge=${(result.overall.judgeAccuracy * 100).toFixed(2)}% tokenF1=${(result.overall.tokenF1 * 100).toFixed(2)}% availability=${(result.overall.evidenceAvailability * 100).toFixed(2)}%`);
}

main().catch((error) => {
	console.error(`STAGE E SCORE STOPPED: ${error.stack ?? error}`);
	process.exit(1);
});
