import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import {
	EVAL_BASE,
	GLOBAL_LOCK,
	HOLDOUT,
	OUTPUT,
	READER_MODEL,
	assert,
	burnSnapshot,
	integer,
	percentile,
	ratio,
	readJson,
	secret,
	shaFile,
	writeJsonAtomic,
	writeJsonExclusive,
} from "./common.mjs";

const require = createRequire(import.meta.url);
const { requireBenchmarkLockFromEnv } = require("../../../e2/harness/benchmark-lock.cjs");
const { Mem0StyleJudge } = require("../../../phase3-d04/judge/judge-client.js");
const SCORE_SCENARIO_RESERVE = 5_000;
const STOP = new Set("a an the and or but of in on at to for with is are was were be been being it its this that these those he she they them his her their i you we my your our as from by".split(" "));

function normalize(text) {
	return String(text ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
}

function coverage(needle, haystack) {
	const wanted = normalize(needle).filter((token) => !STOP.has(token));
	if (!wanted.length) return null;
	const have = new Set(normalize(haystack).filter((token) => !STOP.has(token)));
	return wanted.filter((token) => have.has(token)).length / wanted.length;
}

function tokenF1(reference, prediction) {
	const expected = normalize(reference);
	const actual = normalize(prediction);
	if (!expected.length || !actual.length) return expected.length === actual.length ? 1 : 0;
	const counts = new Map();
	for (const token of expected) counts.set(token, (counts.get(token) ?? 0) + 1);
	let overlap = 0;
	for (const token of actual) {
		const available = counts.get(token) ?? 0;
		if (available > 0) { overlap += 1; counts.set(token, available - 1); }
	}
	if (!overlap) return 0;
	const precision = overlap / actual.length;
	const recall = overlap / expected.length;
	return 2 * precision * recall / (precision + recall);
}

function extractJson(text) {
	let value = String(text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
	value = value.replace(/<think>[\s\S]*?<\/think>/gi, " ").replace(/<\|[^>]*\|>/g, " ").trim();
	try { return JSON.parse(value); } catch { /* bounded salvage below */ }
	const first = value.indexOf("{");
	const last = value.lastIndexOf("}");
	if (first >= 0 && last > first) {
		try { return JSON.parse(value.slice(first, last + 1)); } catch { /* invalid */ }
	}
	return null;
}

async function structuredCaptureScore(apiKey, label, source, targets, claims) {
	const targetIds = new Set(targets.map((target) => target.id));
	const claimIds = new Set(claims.map((claim) => claim.id));
	const targetFolded = new Map([...targetIds].map((id) => [id.toLowerCase(), id]));
	const claimFolded = new Map([...claimIds].map((id) => [id.toLowerCase(), id]));
	const canonicalIds = (values, exact, folded, kind) => values.map((raw) => {
		assert(typeof raw === "string", `${label}: non-string ${kind} id`);
		const value = raw.trim();
		const canonical = exact.has(value) ? value : folded.get(value.toLowerCase());
		assert(canonical, `${label}: invented ${kind} id ${value}`);
		return canonical;
	});
	const idArray = (ids) => ({
		type: "array",
		items: ids.size ? { type: "string", enum: [...ids] } : { type: "string" },
		maxItems: ids.size,
	});
	const schema = {
		type: "object",
		properties: {
			captured_target_ids: idArray(targetIds),
			unsupported_claim_ids: idArray(claimIds),
			contradictory_claim_ids: idArray(claimIds),
			duplicate_claim_ids: idArray(claimIds),
		},
		required: ["captured_target_ids", "unsupported_claim_ids", "contradictory_claim_ids", "duplicate_claim_ids"],
		additionalProperties: false,
	};
	const prompt = `You are evaluating a general-purpose long-term-memory extractor. Compare candidate semantic claims against the source conversation and frozen target facts.

Rules:
- captured_target_ids: include a target only when one or more candidate claims preserve enough information to answer it correctly. Paraphrase is allowed; unsupported inference is not.
- unsupported_claim_ids: include each candidate claim asserting information not supported by the source conversation.
- contradictory_claim_ids: include each candidate claim that conflicts with the source or presents a stale value as current.
- duplicate_claim_ids: include every redundant candidate after the first equivalent claim. Distinct atomic facts are not duplicates.
- Judge negation, quantities, relationships, temporal qualifiers, and procedure order exactly. Return IDs only.

SOURCE CONVERSATION:
${source}

TARGET FACTS:
${targets.map((target) => `${target.id}: ${target.text}`).join("\n")}

CANDIDATE CLAIMS:
${claims.length ? claims.map((claim) => `${claim.id}: ${claim.text}`).join("\n") : "(none)"}

Return exactly one JSON object with arrays captured_target_ids, unsupported_claim_ids, contradictory_claim_ids, duplicate_claim_ids.`;
	let last = "not_attempted";
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		const started = Date.now();
		try {
			const response = await fetch(`${EVAL_BASE}/eval/llm`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": apiKey },
				signal: AbortSignal.timeout(180_000),
				body: JSON.stringify({
					model: READER_MODEL,
					temperature: 0,
					max_tokens: 4_096,
					response_format: { type: "json_schema", json_schema: schema },
					messages: [{ role: "user", content: prompt }],
				}),
			});
			if (response.status === 429 || response.status >= 500) {
				last = `http_${response.status}`;
				await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
				continue;
			}
			assert(response.ok, `${label}: capture judge http ${response.status}`);
			const body = await response.json();
			assert(body.model === READER_MODEL, `${label}: capture judge model identity changed`);
			const parsed = extractJson(body.text);
			const fields = ["captured_target_ids", "unsupported_claim_ids", "contradictory_claim_ids", "duplicate_claim_ids"];
			if (!parsed || fields.some((field) => !Array.isArray(parsed[field]))) {
				last = "invalid_json_shape";
				continue;
			}
			return {
				capturedTargetIds: [...new Set(canonicalIds(parsed.captured_target_ids, targetIds, targetFolded, "target"))],
				unsupportedClaimIds: [...new Set(canonicalIds(parsed.unsupported_claim_ids, claimIds, claimFolded, "claim"))],
				contradictoryClaimIds: [...new Set(canonicalIds(parsed.contradictory_claim_ids, claimIds, claimFolded, "claim"))],
				duplicateClaimIds: [...new Set(canonicalIds(parsed.duplicate_claim_ids, claimIds, claimFolded, "claim"))],
				latencyMs: Date.now() - started,
				attempts: attempt,
			};
		} catch (error) {
			last = String(error?.message ?? error);
			if (error?.name === "TimeoutError" || error?.name === "AbortError") {
				throw new Error(`${label}: capture judge timed out; no automatic duplicate call`);
			}
		}
	}
	throw new Error(`${label}: capture judge failed: ${last}`);
}

function sourceText(input) {
	return input.messages.map((message, index) =>
		`${input.id}:m${index + 1} [${message.sourceTime}] ${message.role}: ${message.content}`).join("\n");
}

function categoryNumber(category) {
	if (category === "multi-hop") return 1;
	if (category === "temporal") return 2;
	if (category === "open-domain") return 3;
	return 4;
}

function aggregate(rows, product) {
	const atomRows = rows.flatMap((row) => row.atomResults).filter((row) => row.mustCapture);
	const captured = atomRows.filter((row) => row.captured).length;
	const claims = rows.reduce((sum, row) => sum + row.claims, 0);
	const unsupported = rows.reduce((sum, row) => sum + row.unsupportedClaims, 0);
	const captureRecall = ratio(captured, atomRows.length);
	const capturePrecision = ratio(claims - unsupported, claims, 1);
	const captureF1 = capturePrecision + captureRecall
		? 2 * capturePrecision * captureRecall / (capturePrecision + captureRecall)
		: 0;
	const answers = rows.flatMap((row) => row.answerResults);
	const available = answers.filter((row) => row.evidenceAvailable);
	const absent = answers.filter((row) => !row.evidenceAvailable);
	const byCategory = {};
	for (const answer of answers) {
		byCategory[answer.category] ??= { n: 0, correct: 0, available: 0, tokenF1Sum: 0 };
		const bucket = byCategory[answer.category];
		bucket.n += 1;
		bucket.correct += answer.correct ? 1 : 0;
		bucket.available += answer.evidenceAvailable ? 1 : 0;
		bucket.tokenF1Sum += answer.tokenF1;
	}
	for (const bucket of Object.values(byCategory)) {
		bucket.accuracy = ratio(bucket.correct, bucket.n);
		bucket.availability = ratio(bucket.available, bucket.n);
		bucket.tokenF1 = ratio(bucket.tokenF1Sum, bucket.n);
		delete bucket.tokenF1Sum;
	}
	const integrity = product.ingests.map((row) => row.integrity);
	const projection = integrity.reduce((out, row) => {
		out.candidates += row.sums.stored;
		out.promoted += row.outcomes.promoted;
		out.reinforced += row.outcomes.reinforced;
		out.ignored += row.outcomes.ignored;
		out.accountingFailures += row.accountingFailures;
		out.provenanceFailures += row.provenanceConserved ? 0 : 1;
		return out;
	}, { candidates: 0, promoted: 0, reinforced: 0, ignored: 0, accountingFailures: 0, provenanceFailures: 0 });
	const ingestion = product.ingests.map((row) => row.requestLatencyMs);
	const extractionWait = product.ingests.map((row) => row.ready.waitedMs);
	const atomicLatency = integrity.map((row) => row.atomicLatencyMs);
	const projectionLatency = integrity.map((row) => row.projectionLatencyMs);
	return {
		mustCapture: atomRows.length,
		captured,
		captureRecall,
		claims,
		unsupportedClaims: unsupported,
		capturePrecision,
		captureF1,
		duplicateClaims: rows.reduce((sum, row) => sum + row.duplicateClaims, 0),
		duplicateRate: ratio(rows.reduce((sum, row) => sum + row.duplicateClaims, 0), claims),
		falseContradictions: rows.reduce((sum, row) => sum + row.contradictoryClaims, 0),
		schemaValidity: ratio(integrity.filter((row) => row.runValidity).length, integrity.length),
		truncations: integrity.reduce((sum, row) => sum + row.sums.truncated, 0),
		questions: answers.length,
		judgeCorrect: answers.filter((row) => row.correct).length,
		judgeAccuracy: ratio(answers.filter((row) => row.correct).length, answers.length),
		tokenF1: ratio(answers.reduce((sum, row) => sum + row.tokenF1, 0), answers.length),
		evidenceAvailable: available.length,
		evidenceAvailability: ratio(available.length, answers.length),
		conditionalCorrect: available.filter((row) => row.correct).length,
		conditionalAccuracy: ratio(available.filter((row) => row.correct).length, available.length),
		absentCorrect: absent.filter((row) => row.correct).length,
		absentEvidenceAccuracy: ratio(absent.filter((row) => row.correct).length, absent.length),
		sourceStoredAvailability: ratio(answers.filter((row) => row.sourceStoredAvailable).length, answers.length),
		candidateStoredAvailability: ratio(answers.filter((row) => row.candidateStoredAvailable).length, answers.length),
		neverStoredSource: answers.filter((row) => !row.sourceStoredAvailable).length,
		neverCapturedSemantic: answers.filter((row) => !row.candidateStoredAvailable).length,
		storedButNotRetrieved: answers.filter((row) => row.candidateStoredAvailable && !row.retrievedAvailable).length,
		evidenceLostDuringAssembly: answers.filter((row) => row.retrievedAvailable && !row.evidenceAvailable).length,
		sourceRecoveredEvidence: answers.filter((row) => !row.retrievedAvailable && row.evidenceAvailable).length,
		readerErrorsWithEvidence: answers.filter((row) => row.evidenceAvailable && !row.correct).length,
		context: {
			meanItems: ratio(answers.reduce((sum, row) => sum + row.contextItems, 0), answers.length),
			meanLines: ratio(answers.reduce((sum, row) => sum + row.contextLines, 0), answers.length),
			meanChars: ratio(answers.reduce((sum, row) => sum + row.contextChars, 0), answers.length),
			meanTokensApprox: ratio(answers.reduce((sum, row) => sum + row.contextTokensApprox, 0), answers.length),
			maxChars: Math.max(...answers.map((row) => row.contextChars)),
		},
		sourceExpansion: {
			assertions: answers.reduce((sum, row) => sum + row.sourceExpansionAssertions, 0),
			linkedAssertions: answers.reduce((sum, row) => sum + row.sourceExpansionLinkedAssertions, 0),
			episodes: answers.reduce((sum, row) => sum + row.sourceExpansionEpisodes, 0),
			chars: answers.reduce((sum, row) => sum + row.sourceExpansionChars, 0),
			failures: answers.reduce((sum, row) => sum + row.sourceExpansionFailures, 0),
		},
		latencyMs: {
			ingestMean: ratio(ingestion.reduce((sum, value) => sum + value, 0), ingestion.length),
			ingestP95: percentile(ingestion, 0.95),
			extractionWaitMean: ratio(extractionWait.reduce((sum, value) => sum + value, 0), extractionWait.length),
			extractionWaitP95: percentile(extractionWait, 0.95),
			atomicMean: ratio(atomicLatency.reduce((sum, value) => sum + value, 0), atomicLatency.length),
			projectionMean: ratio(projectionLatency.reduce((sum, value) => sum + value, 0), projectionLatency.length),
			recallServerMean: ratio(answers.reduce((sum, row) => sum + row.recallServerLatencyMs, 0), answers.length),
			recallServerP95: percentile(answers.map((row) => row.recallServerLatencyMs), 0.95),
			recallClientMean: ratio(answers.reduce((sum, row) => sum + row.recallClientLatencyMs, 0), answers.length),
			readerMean: ratio(answers.reduce((sum, row) => sum + row.readerLatencyMs, 0), answers.length),
			readerP95: percentile(answers.map((row) => row.readerLatencyMs), 0.95),
			judgeMean: ratio(answers.reduce((sum, row) => sum + row.judgeLatencyMs, 0), answers.length),
			captureJudgeMean: ratio(rows.reduce((sum, row) => sum + row.captureJudge.latencyMs, 0), rows.length),
			sourceExpansionMean: ratio(answers.reduce((sum, row) => sum + row.sourceExpansionLatencyMs, 0), answers.length),
		},
		projection,
		safety: {
			episodeFailures: integrity.reduce((sum, row) => sum + row.episodeFailures, 0),
			acceptedGroundingFailures: integrity.reduce((sum, row) => sum + row.acceptedGroundingFailures, 0),
			acceptedScopeFailures: integrity.reduce((sum, row) => sum + row.acceptedScopeFailures, 0),
			acceptedSecretFailures: integrity.reduce((sum, row) => sum + row.acceptedSecretFailures, 0),
			accountingFailures: integrity.reduce((sum, row) => sum + row.accountingFailures, 0),
			extractionRunFailures: integrity.reduce((sum, row) => sum + row.extractionRunFailures, 0),
			extractionRunIdentityFailures: integrity.filter((row) => !row.extractionRunIdentityValid).length,
			receiptConservation: ratio(integrity.filter((row) => row.receiptConserved).length, integrity.length),
			projectionConservation: ratio(integrity.filter((row) => row.projectionConserved).length, integrity.length),
			provenanceConservation: ratio(integrity.filter((row) => row.provenanceConserved).length, integrity.length),
			boundedRecallFailures: product.answers.reduce((sum, answer) =>
				sum + integer(answer.retrieval.bounded?.failures), 0),
			readStateStable: product.afterReadFingerprint.sha256 === product.stateFingerprint.sha256,
			replayStable: product.replay?.sourcePacketStable === true && product.replay?.jobStable === true
				&& product.replay?.candidateRowsAdded === 0 && product.replay?.projectionRowsAdded === 0
				&& product.replay?.episodeRowsAdded === 0,
		},
		storage: {
			...product.stateFingerprint.counts,
			exportBytes: rows.reduce((sum, row) => sum + row.exportBytes, 0),
		},
		byCategory,
	};
}

function validateProgressRows(seed, rows, product) {
	assert(Array.isArray(rows) && rows.length <= 10, `seed${seed}: invalid score progress`);
	for (let index = 0; index < rows.length; index += 1) {
		const expectedScenarioId = `HO-${String(index + 1).padStart(2, "0")}`;
		const row = rows[index];
		assert(row?.scenarioId === expectedScenarioId, `seed${seed}: score progress is not an ordered prefix`);
		const expectedQuestionIds = product.answers.filter((answer) => answer.scenarioId === expectedScenarioId)
			.map((answer) => answer.questionId);
		assert(JSON.stringify(row.answerResults?.map((answer) => answer.questionId)) === JSON.stringify(expectedQuestionIds),
			`seed${seed}/${expectedScenarioId}: score progress question accounting changed`);
		assert(row.productIntegrity?.projectionConserved && row.productIntegrity?.receiptConserved,
			`seed${seed}/${expectedScenarioId}: score progress lost integrity proof`);
	}
}

async function scoreSeed(seed, apiKey, existingRows = [], checkpoint = async () => {}) {
	const productFile = path.join(OUTPUT, `seed${seed}.product.json`);
	const sealFile = path.join(OUTPUT, `seed${seed}.product.seal.json`);
	const exportFile = path.join(OUTPUT, `seed${seed}.exports.json`);
	assert(fs.existsSync(productFile) && fs.existsSync(sealFile) && fs.existsSync(exportFile),
		`seed${seed}: sealed product set missing`);
	const seal = readJson(sealFile);
	assert(seal.productSha256 === shaFile(productFile), `seed${seed}: product seal mismatch`);
	const product = readJson(productFile);
	assert(product.schema === "itsuki.v3-final-holdout-product/v1" && product.seed === seed
		&& product.answers.length === 42 && product.ingests.length === 10,
	`seed${seed}: product accounting mismatch`);
	assert(product.exportsSha256 === shaFile(exportFile), `seed${seed}: export seal mismatch`);
	const exports = readJson(exportFile);
	assert(exports.scenarios.length === 10, `seed${seed}: export accounting mismatch`);
	const exportByScenario = new Map(exports.scenarios.map((row) => [row.scenarioId, row]));
	const ingestByScenario = new Map(product.ingests.map((row) => [row.scenarioId, row]));
	const judge = new Mem0StyleJudge({ apiKey, model: READER_MODEL });
	validateProgressRows(seed, existingRows, product);
	const rows = [...existingRows];
	const completed = new Set(rows.map((row) => row.scenarioId));
	for (let index = 1; index <= 10; index += 1) {
		const id = `HO-${String(index).padStart(2, "0")}`;
		if (completed.has(id)) continue;
		await burnSnapshot(`StageD:seed${seed}:${id}:score-boundary`, SCORE_SCENARIO_RESERVE);
		const input = readJson(path.join(HOLDOUT, "inputs", `${id}.json`));
		const reference = readJson(path.join(HOLDOUT, "references", `${id}.json`));
		const ingest = ingestByScenario.get(id);
		const exported = exportByScenario.get(id);
		assert(ingest && exported?.secretAudit?.pass, `seed${seed}/${id}: product evidence missing/unsafe`);
		const claims = ingest.candidates.map((candidate, claimIndex) => ({
			id: `C${claimIndex + 1}`,
			atomId: candidate.id,
			text: candidate.assertion,
			type: candidate.atom_type,
			rawTemporalPhrase: candidate.raw_temporal_phrase,
		}));
		const capture = await structuredCaptureScore(apiKey, `seed${seed}/${id}`,
			sourceText(input), reference.atoms, claims);
		const captured = new Set(capture.capturedTargetIds);
		const candidateCorpus = claims.map((claim) => claim.text).join("\n");
		const sourceCorpus = JSON.stringify(exported.payload ?? {});
		const answers = product.answers.filter((answer) => answer.scenarioId === id);
		const answerResults = [];
		for (const answer of answers) {
			const qid = answer.questionId.split("#").at(-1);
			const target = reference.questions.find((question) => question.id === qid);
			assert(target && target.q === answer.question, `seed${seed}/${answer.questionId}: reference mismatch`);
			const verdict = await judge.judge({
				category: categoryNumber(target.category),
				question: target.q,
				referenceAnswer: target.answer,
				generatedAnswer: answer.answer.text,
			});
			assert(!verdict.error, `seed${seed}/${answer.questionId}: judge error ${verdict.error}`);
			const sourceStoredCoverage = coverage(target.answer, sourceCorpus);
			const candidateStoredCoverage = coverage(target.answer, candidateCorpus);
			const itemCoverage = coverage(target.answer, JSON.stringify(answer.retrieval.items ?? []));
			const contextCoverage = coverage(target.answer, answer.retrieval.context);
			const sourceStoredAvailable = sourceStoredCoverage != null && sourceStoredCoverage >= 0.5;
			const candidateStoredAvailable = candidateStoredCoverage != null && candidateStoredCoverage >= 0.5;
			const retrievedAvailable = itemCoverage != null && itemCoverage >= 0.5;
			const evidenceAvailable = contextCoverage != null && contextCoverage >= 0.5;
			answerResults.push({
				questionId: answer.questionId,
				category: target.category,
				correct: verdict.score === 1,
				tokenF1: tokenF1(target.answer, answer.answer.text),
				sourceStoredCoverage,
				candidateStoredCoverage,
				itemCoverage,
				contextCoverage,
				sourceStoredAvailable,
				candidateStoredAvailable,
				retrievedAvailable,
				evidenceAvailable,
				contextItems: integer(answer.retrieval.itemCount),
				contextLines: integer(answer.retrieval.contextLines),
				contextChars: integer(answer.retrieval.contextChars),
				contextTokensApprox: integer(answer.retrieval.contextTokensApprox),
				recallServerLatencyMs: Number(answer.retrieval.serverLatencyMs ?? 0),
				recallClientLatencyMs: Number(answer.retrieval.clientLatencyMs ?? 0),
				readerLatencyMs: Number(answer.answer.latencyMs ?? 0),
				judgeLatencyMs: Number(verdict.latencyMs ?? 0),
				sourceExpansionAssertions: integer(answer.retrieval.sourceExpansion?.assertions),
				sourceExpansionLinkedAssertions: integer(answer.retrieval.sourceExpansion?.linkedAssertions),
				sourceExpansionEpisodes: integer(answer.retrieval.sourceExpansion?.episodes),
				sourceExpansionChars: integer(answer.retrieval.sourceExpansion?.chars),
				sourceExpansionLatencyMs: Number(answer.retrieval.sourceExpansion?.latencyMs ?? 0),
				sourceExpansionFailures: answer.retrieval.sourceExpansion?.failed ? 1 : 0,
			});
		}
		const deterministicDuplicates = ingest.runs.reduce((sum, run) => sum + integer(run.duplicate_count), 0);
		rows.push({
			scenarioId: id,
			claims: claims.length,
			unsupportedClaims: capture.unsupportedClaimIds.length,
			contradictoryClaims: capture.contradictoryClaimIds.length,
			duplicateClaims: capture.duplicateClaimIds.length + deterministicDuplicates,
			deterministicDuplicates,
			atomResults: reference.atoms.map((atom) => ({
				id: atom.id,
				kind: atom.kind,
				mustCapture: atom.mustCapture === true,
				captured: captured.has(atom.id),
			})),
			answerResults,
			productIntegrity: ingest.integrity,
			captureJudge: { latencyMs: capture.latencyMs, attempts: capture.attempts },
			exportBytes: integer(exported.serializedBytes),
		});
		await checkpoint(rows);
		console.log(`seed${seed}/${id}: scored ${answerResults.length} answers and ${claims.length} claims`);
	}
	assert(rows.length === 10, `seed${seed}: score row count ${rows.length}/10`);
	return {
		seed,
		productSha256: seal.productSha256,
		rows,
		metrics: aggregate(rows, product),
	};
}

async function main() {
	requireBenchmarkLockFromEnv();
	assert(process.env.BENCHMARK_LOCK_DIR === GLOBAL_LOCK, "wrong benchmark lock path");
	const seed = Number(process.argv[2]);
	assert([1, 2, 3].includes(seed), "seed must be 1, 2, or 3");
	const output = path.join(OUTPUT, `seed${seed}.scores.json`);
	assert(!fs.existsSync(output), `seed${seed}: score artifact exists`);
	const progressFile = path.join(OUTPUT, `seed${seed}.score-progress.json`);
	const productFile = path.join(OUTPUT, `seed${seed}.product.json`);
	const sealFile = path.join(OUTPUT, `seed${seed}.product.seal.json`);
	assert(fs.existsSync(productFile) && fs.existsSync(sealFile), `seed${seed}: product must be sealed before references load`);
	const seal = readJson(sealFile);
	assert(seal.productSha256 === shaFile(productFile), `seed${seed}: product seal mismatch before reference load`);
	const apiKey = secret("API_KEY");
	console.log("eval-door key: LOADED");
	let progress = fs.existsSync(progressFile)
		? readJson(progressFile)
		: {
			schema: "itsuki.v3-final-holdout-score-progress/v1",
			seed,
			status: "running",
			productSha256: seal.productSha256,
			rows: [],
			startedAt: new Date().toISOString(),
		};
	assert(progress.schema === "itsuki.v3-final-holdout-score-progress/v1" && progress.seed === seed
		&& progress.status === "running" && progress.productSha256 === seal.productSha256,
	`seed${seed}: score progress cannot be resumed`);
	if (!fs.existsSync(progressFile)) writeJsonAtomic(progressFile, progress);
	const checkpoint = async (rows) => {
		progress.rows = rows;
		progress.updatedAt = new Date().toISOString();
		writeJsonAtomic(progressFile, progress);
	};
	const score = await scoreSeed(seed, apiKey, progress.rows, checkpoint);
	writeJsonExclusive(output, {
		schema: "itsuki.v3-final-holdout-scores/v1",
		seed,
		scoredAt: new Date().toISOString(),
		...score,
	});
	progress.status = "complete";
	progress.completedAt = new Date().toISOString();
	progress.finalScoreSha256 = shaFile(output);
	writeJsonAtomic(progressFile, progress);
	console.log(JSON.stringify({ seed, metrics: score.metrics }, null, 2));
}

main().catch((error) => {
	console.error(`STAGE D SCORE STOPPED: ${error.stack ?? error}`);
	process.exit(1);
});
