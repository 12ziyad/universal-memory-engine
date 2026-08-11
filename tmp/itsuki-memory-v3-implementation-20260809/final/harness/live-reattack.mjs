import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { scrubText } from "../../../../src/pipeline/scrub.js";
import {
	BASE,
	EVIDENCE,
	GLOBAL_LOCK,
	PROJECT_ALPHA,
	PROJECT_BETA,
	assert,
	assertBillingPreflight,
	auditExportSecrets,
	burnSnapshot,
	cohorts,
	contentDigest,
	d1Select,
	eraseCohort,
	expectedHealthActive,
	integer,
	memoryCountsAreZero,
	percentile,
	pool,
	request,
	rulesDigest,
	secret,
	sha,
	sqlQuote,
	stateCounts,
	validateInputs,
	waitReady,
	writeJsonAtomic,
	writeJsonExclusive,
} from "./common.mjs";

const require = createRequire(import.meta.url);
const { EXIT_LOCK_HELD, BenchmarkLockHeldError, acquireBenchmarkLock } = require("../../e2/harness/benchmark-lock.cjs");

const RESULT = path.join(EVIDENCE, "stage-b-live-reattack.json");
const FAILURE_CLEANUP = path.join(EVIDENCE, "stage-b-failure-cleanup.json");
const REQUEST_TIMEOUT_MS = 300_000;
const TERMINAL = new Set(["enriched", "completed"]);

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function marker(prefix, suffix, index = null) {
	return `${prefix}${index == null ? "" : index}${suffix}`.toLowerCase();
}

function markerSummary(values) {
	return Object.fromEntries(Object.entries(values).map(([key, value]) => [key,
		Array.isArray(value) ? value.map(contentDigest) : contentDigest(value)]));
}

function sourceMessage(id, content, sourceTime = "2026-08-11T12:00:00+05:30") {
	return { id, role: "user", content, sourceTime };
}

function ingestBody(slot, idempotencyKey, messages, memoryScope = PROJECT_ALPHA, rules = undefined) {
	return {
		userId: slot.externalId,
		conversationId: `final-stage-b-${idempotencyKey}`,
		idempotencyKey: `itsuki-v3:final-stage-b:${idempotencyKey}`,
		...(memoryScope ? { memoryScope: { ...memoryScope } } : {}),
		...(rules ? { rules } : {}),
		flush: true,
		messages,
	};
}

async function accept(token, body, expectedEpisodes = null) {
	const response = await request(token, "POST", "/v1/ingest", {
		body, attempts: 3, timeoutMs: REQUEST_TIMEOUT_MS,
	});
	assert(response.ok && response.body?.ok === true,
		`ingest failed status=${response.status} code=${response.body?.code ?? "not_ok"}`);
	assert(response.body.source_packet_id && response.body.job_id, "accepted ingest missing durable ids");
	if (expectedEpisodes != null) {
		assert(integer(response.body.source_episodes_written) === expectedEpisodes,
			`accepted episode count ${response.body.source_episodes_written}/${expectedEpisodes}`);
	}
	return {
		status: response.status,
		elapsedMs: response.elapsedMs,
		packetId: response.body.source_packet_id,
		jobId: response.body.job_id,
		duplicate: response.body.duplicate === true,
		episodesWritten: integer(response.body.source_episodes_written),
	};
}

async function settle(token, slot, accepted) {
	const ready = await waitReady(token, slot.externalId, accepted.jobId);
	assert(TERMINAL.has(ready.status) && !ready.cancelledByDelete,
		`job did not enrich: status=${ready.status} cancelled=${ready.cancelledByDelete}`);
	return { ...accepted, ready };
}

async function recall(token, slot, query, {
	recallScope = "project_only", memoryScope = PROJECT_ALPHA,
} = {}) {
	const response = await request(token, "POST", "/v1/recall", {
		body: {
			userId: slot.externalId, query, limit: 200, recallScope,
			...(memoryScope ? { memoryScope: { ...memoryScope } } : {}),
		},
	});
	assert(response.ok && response.body?.ok === true, `recall failed status=${response.status}`);
	const context = String(response.body.context ?? "");
	const itemCount = integer(response.body.count ?? response.body.items?.length);
	assert(itemCount <= 200, `unbounded evidence count ${itemCount}`);
	assert(context.length <= 24_000, `unbounded context ${context.length}`);
	return {
		context,
		itemCount,
		contextChars: context.length,
		contextTokensApprox: Math.ceil(context.length / 4),
		serverLatencyMs: Number(response.body.recall_latency_ms ?? 0),
		clientLatencyMs: response.elapsedMs,
		sourceExpansionUsed: response.body.source_expansion_used === true,
		sourceExpansionEpisodes: integer(response.body.source_expansion_episodes),
		sourceExpansionChars: integer(response.body.source_expansion_chars),
	};
}

function contains(haystack, needle) {
	return String(haystack).toLowerCase().includes(String(needle).toLowerCase());
}

function valuesSql(rows) {
	return rows.map((row) => `(${row.map(sqlQuote).join(",")})`).join(",");
}

async function markerIsolationAudit(slots, markers) {
	const rows = markers.map((needle, index) => [String(index), slots[index].memoryUserId, needle]);
	const [result] = await d1Select([`WITH m(idx, owner, needle) AS (VALUES ${valuesSql(rows)})
		SELECT idx,
		 (SELECT COUNT(*) FROM source_episodes e
		  WHERE e.user_id = m.owner AND instr(lower(e.text), lower(m.needle)) > 0) AS episode_own,
		 (SELECT COUNT(*) FROM source_episodes e
		  WHERE e.user_id <> m.owner AND instr(lower(e.text), lower(m.needle)) > 0) AS episode_cross,
		 (SELECT COUNT(*) FROM semantic_atom_candidates c
		  WHERE c.user_id = m.owner AND instr(lower(coalesce(c.evidence_quote,'') || ' ' || coalesce(c.assertion,'') || ' ' || coalesce(c.value,'')), lower(m.needle)) > 0) AS atom_own,
		 (SELECT COUNT(*) FROM semantic_atom_candidates c
		  WHERE c.user_id <> m.owner AND instr(lower(coalesce(c.evidence_quote,'') || ' ' || coalesce(c.assertion,'') || ' ' || coalesce(c.value,'')), lower(m.needle)) > 0) AS atom_cross,
		 ((SELECT COUNT(*) FROM nodes n WHERE n.user_id = m.owner AND n.deleted_at IS NULL
		   AND instr(lower(coalesce(n.label,'') || ' ' || coalesce(n.summary,'')), lower(m.needle)) > 0)
		  +(SELECT COUNT(*) FROM slices s WHERE s.user_id = m.owner AND s.deleted_at IS NULL
		   AND instr(lower(coalesce(s.text,'') || ' ' || coalesce(s.source_snippet,'')), lower(m.needle)) > 0)
		  +(SELECT COUNT(*) FROM events e WHERE e.user_id = m.owner AND e.deleted_at IS NULL
		   AND instr(lower(coalesce(e.action,'') || ' ' || coalesce(e.text,'') || ' ' || coalesce(e.source_snippet,'')), lower(m.needle)) > 0)
		  +(SELECT COUNT(*) FROM edges e WHERE e.user_id = m.owner AND e.deleted_at IS NULL
		   AND instr(lower(coalesce(e.fact,'') || ' ' || coalesce(e.source_snippet,'')), lower(m.needle)) > 0)) AS graph_own,
		 ((SELECT COUNT(*) FROM nodes n WHERE n.user_id <> m.owner AND n.deleted_at IS NULL
		   AND instr(lower(coalesce(n.label,'') || ' ' || coalesce(n.summary,'')), lower(m.needle)) > 0)
		  +(SELECT COUNT(*) FROM slices s WHERE s.user_id <> m.owner AND s.deleted_at IS NULL
		   AND instr(lower(coalesce(s.text,'') || ' ' || coalesce(s.source_snippet,'')), lower(m.needle)) > 0)
		  +(SELECT COUNT(*) FROM events e WHERE e.user_id <> m.owner AND e.deleted_at IS NULL
		   AND instr(lower(coalesce(e.action,'') || ' ' || coalesce(e.text,'') || ' ' || coalesce(e.source_snippet,'')), lower(m.needle)) > 0)
		  +(SELECT COUNT(*) FROM edges e WHERE e.user_id <> m.owner AND e.deleted_at IS NULL
		   AND instr(lower(coalesce(e.fact,'') || ' ' || coalesce(e.source_snippet,'')), lower(m.needle)) > 0)) AS graph_cross
		FROM m ORDER BY CAST(idx AS INTEGER)`]);
	const audited = result.results ?? [];
	assert(audited.length === markers.length, "marker audit accounting mismatch");
	for (const row of audited) {
		assert(integer(row.episode_own) > 0, `marker ${row.idx}: accepted evidence missing`);
		assert(integer(row.atom_own) > 0, `marker ${row.idx}: semantic candidate missing`);
		assert(integer(row.graph_own) > 0, `marker ${row.idx}: governed projection missing`);
		assert(integer(row.episode_cross) === 0 && integer(row.atom_cross) === 0 && integer(row.graph_cross) === 0,
			`marker ${row.idx}: cross-subtenant persistence`);
	}
	return audited.map((row) => ({
		index: integer(row.idx), episodeOwn: integer(row.episode_own), atomOwn: integer(row.atom_own),
		graphOwn: integer(row.graph_own), episodeCross: integer(row.episode_cross),
		atomCross: integer(row.atom_cross), graphCross: integer(row.graph_cross),
	}));
}

async function projectPersistenceAudit(slot, projectMarkers) {
	const user = sqlQuote(slot.memoryUserId);
	const rows = Object.entries(projectMarkers).map(([scope, needle], index) => [String(index), scope, needle]);
	const [result] = await d1Select([`WITH m(idx, scope, needle) AS (VALUES ${valuesSql(rows)})
		SELECT idx, scope,
		 (SELECT COUNT(*) FROM source_episodes e WHERE e.user_id = ${user}
		  AND coalesce(e.project_id, '__global__') = m.scope
		  AND instr(lower(e.text), lower(m.needle)) > 0) AS correct_scope,
		 (SELECT COUNT(*) FROM source_episodes e WHERE e.user_id = ${user}
		  AND coalesce(e.project_id, '__global__') <> m.scope
		  AND instr(lower(e.text), lower(m.needle)) > 0) AS wrong_scope
		FROM m ORDER BY CAST(idx AS INTEGER)`]);
	const audited = result.results ?? [];
	assert(audited.length === 3, "project persistence accounting mismatch");
	for (const row of audited) {
		assert(integer(row.correct_scope) > 0 && integer(row.wrong_scope) === 0,
			`project persistence mismatch index=${row.idx}`);
	}
	return audited.map((row) => ({ index: integer(row.idx), scope: row.scope,
		correctScope: integer(row.correct_scope), wrongScope: integer(row.wrong_scope) }));
}

async function forbiddenAndSecretAudit(slots, needles) {
	const ids = slots.map((slot) => sqlQuote(slot.memoryUserId)).join(",");
	const rows = needles.map((needle, index) => [String(index), needle]);
	const [result] = await d1Select([`WITH m(idx, needle) AS (VALUES ${valuesSql(rows)})
		SELECT idx,
		 (SELECT COUNT(*) FROM source_episodes e WHERE e.user_id IN (${ids})
		  AND instr(e.text, m.needle) > 0) AS episodes,
		 (SELECT COUNT(*) FROM source_episodes_fts f JOIN source_episodes e ON e.rowid = f.rowid
		  WHERE e.user_id IN (${ids}) AND instr(f.text, m.needle) > 0) AS episode_fts,
		 (SELECT COUNT(*) FROM semantic_atom_candidates c WHERE c.user_id IN (${ids})
		  AND instr(coalesce(c.evidence_quote,'') || ' ' || coalesce(c.entity,'') || ' ' || coalesce(c.value,'') || ' ' || coalesce(c.assertion,''), m.needle) > 0) AS atoms,
		 (SELECT COUNT(*) FROM nodes n WHERE n.user_id IN (${ids})
		  AND instr(coalesce(n.label,'') || ' ' || coalesce(n.summary,'') || ' ' || coalesce(n.aliases_json,''), m.needle) > 0) AS nodes,
		 (SELECT COUNT(*) FROM slices s WHERE s.user_id IN (${ids})
		  AND instr(coalesce(s.text,'') || ' ' || coalesce(s.source_snippet,''), m.needle) > 0) AS slices,
		 (SELECT COUNT(*) FROM events e WHERE e.user_id IN (${ids})
		  AND instr(coalesce(e.action,'') || ' ' || coalesce(e.text,'') || ' ' || coalesce(e.source_snippet,''), m.needle) > 0) AS events,
		 (SELECT COUNT(*) FROM edges e WHERE e.user_id IN (${ids})
		  AND instr(coalesce(e.fact,'') || ' ' || coalesce(e.source_snippet,''), m.needle) > 0) AS edges,
		 (SELECT COUNT(*) FROM candidates c WHERE c.user_id IN (${ids})
		  AND instr(coalesce(c.label,'') || ' ' || coalesce(c.label_guess,'') || ' ' || coalesce(c.evidence_json,''), m.needle) > 0) AS legacy_candidates,
		 (SELECT COUNT(*) FROM source_packets p WHERE p.user_id IN (${ids})
		  AND instr(coalesce(p.content_preview,'') || ' ' || coalesce(p.raw_meta_json,''), m.needle) > 0) AS packets,
		 (SELECT COUNT(*) FROM staged_memories s WHERE s.user_id IN (${ids})
		  AND instr(coalesce(s.text,''), m.needle) > 0) AS staged,
		 (SELECT COUNT(*) FROM receipts r WHERE r.user_id IN (${ids})
		  AND instr(coalesce(r.summary,'') || ' ' || coalesce(r.detail,''), m.needle) > 0) AS receipts,
		 (SELECT COUNT(*) FROM manual_search_profiles p WHERE p.user_id IN (${ids})
		  AND instr(coalesce(p.identity_text,'') || ' ' || coalesce(p.semantic_text,'') || ' ' || coalesce(p.context_text,''), m.needle) > 0) AS search_profiles,
		 (SELECT COUNT(*) FROM manual_search_fts f JOIN manual_search_profiles p ON p.rowid = f.rowid
		  WHERE p.user_id IN (${ids}) AND instr(coalesce(f.identity_text,'') || ' ' || coalesce(f.semantic_text,'') || ' ' || coalesce(f.context_text,''), m.needle) > 0) AS semantic_fts
		FROM m ORDER BY CAST(idx AS INTEGER)`]);
	const audited = result.results ?? [];
	assert(audited.length === needles.length, "secret/rules audit accounting mismatch");
	for (const row of audited) {
		for (const [field, value] of Object.entries(row)) {
			if (field !== "idx") assert(integer(value) === 0, `needle ${row.idx} survived in ${field}`);
		}
	}
	return audited.map((row) => ({ index: integer(row.idx), pass: true,
		survivingStores: Object.entries(row).filter(([key, value]) => key !== "idx" && integer(value) > 0).map(([key]) => key) }));
}

async function packetIdempotencyAudit(slot, packetId) {
	const user = sqlQuote(slot.memoryUserId);
	const packet = sqlQuote(packetId);
	const rows = await d1Select([
		`SELECT COUNT(*) AS n FROM source_packets WHERE user_id = ${user} AND id = ${packet}`,
		`SELECT COUNT(*) AS n FROM source_episodes WHERE user_id = ${user} AND source_packet_id = ${packet}`,
		`SELECT COUNT(*) AS n FROM memory_jobs WHERE user_id = ${user} AND source_packet_id = ${packet}`,
		`SELECT COUNT(*) AS n FROM semantic_atom_capture_runs WHERE user_id = ${user} AND source_packet_id = ${packet}`,
	]);
	const counts = rows.map((row) => integer(row.results?.[0]?.n));
	assert(counts[0] === 1 && counts[1] === 1 && counts[2] === 1 && counts[3] === 1,
		`idempotency convergence failed: ${counts.join("/")}`);
	return { packets: counts[0], episodes: counts[1], jobs: counts[2], captureRuns: counts[3] };
}

async function ftsErasureAudit(slots, markers) {
	const ids = slots.map((slot) => sqlQuote(slot.memoryUserId)).join(",");
	const rows = markers.map((needle, index) => [String(index), needle]);
	const [result] = await d1Select([`WITH m(idx, needle) AS (VALUES ${valuesSql(rows)})
		SELECT idx,
		 (SELECT COUNT(*) FROM source_episodes_fts f JOIN source_episodes e ON e.rowid = f.rowid
		  WHERE e.user_id IN (${ids}) AND instr(lower(f.text), lower(m.needle)) > 0) AS episode_fts,
		 (SELECT COUNT(*) FROM manual_search_fts f JOIN manual_search_profiles p ON p.rowid = f.rowid
		  WHERE p.user_id IN (${ids})
		  AND instr(lower(coalesce(f.identity_text,'') || ' ' || coalesce(f.semantic_text,'') || ' ' || coalesce(f.context_text,'')), lower(m.needle)) > 0) AS semantic_fts
		FROM m ORDER BY CAST(idx AS INTEGER)`]);
	const audited = result.results ?? [];
	assert(audited.length === markers.length, "FTS erasure accounting mismatch");
	assert(audited.every((row) => integer(row.episode_fts) === 0 && integer(row.semantic_fts) === 0),
		"erased marker survived FTS");
	return { markers: audited.length, episodeFtsHits: 0, semanticFtsHits: 0 };
}

async function unauthorizedWriteProbe(slot, invalidMarker) {
	const response = await fetch(new URL("/v1/ingest", BASE), {
		method: "POST",
		headers: { authorization: "Bearer invalid-final-stage-b-token", "content-type": "application/json" },
		body: JSON.stringify(ingestBody(slot, `invalid-${Date.now()}`, [sourceMessage("invalid-m1",
			`The unauthorized security codename is ${invalidMarker}.`)])),
		signal: AbortSignal.timeout(30_000),
	});
	const body = await response.json().catch(() => ({}));
	assert(response.status === 401 && body?.error === "unauthorized", `invalid auth returned ${response.status}`);
	return { status: response.status, accepted: body?.ok === true };
}

async function liveRun() {
	assert(!fs.existsSync(RESULT), "Stage B result already exists");
	const frozen = validateInputs();
	const slots = cohorts().treatment;
	const token = secret("ITSUKI_API_KEY");
	console.log("ITSUKI_API_KEY: LOADED");
	const health = await expectedHealthActive();
	await assertBillingPreflight();
	const burnBefore = await burnSnapshot("FINAL-B:start", 18_000);
	const rulesBefore = await rulesDigest(token, slots[0].externalId);
	const preclean = await eraseCohort(token, slots);
	const cleanBefore = await stateCounts(slots);
	assert(memoryCountsAreZero(cleanBefore), `Stage B precondition residue: ${JSON.stringify(cleanBefore)}`);
	console.log("stage-b preclean: PASS");

	const suffix = String(Math.trunc(Date.now() / 1000) % 10_000).padStart(4, "0");
	const marks = {
		base: slots.map((_, index) => marker("marigoldorbit", suffix, index)),
		beta: marker("betacobalt", suffix),
		global: marker("globalsaffron", suffix),
		forbidden: marker("forbiddencedar", suffix),
		unauthorized: marker("unauthorizedviolet", suffix),
		duplicate: marker("duplicatequartz", suffix),
		immediate: marker("immediatehazel", suffix),
		burst: Array.from({ length: 6 }, (_, index) => marker("burstcomet", suffix, index)),
		soak: slots.map((_, index) => marker("soakwillow", suffix, index)),
		race: marker("racejuniper", suffix),
		fresh: marker("freshjuniper", suffix),
	};
	const syntheticSecrets = [
		"AKIAIOSFODNN7EXAMPLE",
		"ASIAIOSFODNN7EXAMPLE",
		"ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD",
		"v3syntheticdatabasepass2026",
		"v3syntheticjsonkey2026ABCDEFGHIJ",
		"v3syntheticlabeltoken2026ABCDEFGHIJ",
		"v3syntheticconnectionpass2026",
		"v3syntheticcanarytoken2026ABCDEFGHIJ",
		"v3syntheticprivatekeybody2026",
	];
	const secretText = [
		`AWS_ACCESS_KEY_ID=${syntheticSecrets[0]}`,
		`AWS_SESSION_KEY=${syntheticSecrets[1]}`,
		`GITHUB_TOKEN=${syntheticSecrets[2]}`,
		`DATABASE_PASSWORD=${syntheticSecrets[3]}`,
		`{\"api_key\":\"${syntheticSecrets[4]}\"}`,
		`secret: ${syntheticSecrets[5]}`,
		`postgresql://v3user:${syntheticSecrets[6]}@db.example.invalid/v3`,
		`API_TOKEN=${syntheticSecrets[7]}`,
		`-----BEGIN PRIVATE KEY-----\n${syntheticSecrets[8]}\n-----END PRIVATE KEY-----`,
	].join("\n");
	const localScrub = scrubText(secretText);
	assert(syntheticSecrets.every((value) => !localScrub.text.includes(value)), "synthetic secret battery is not scrub-detectable");

	const unauthorized = await unauthorizedWriteProbe(slots[9], marks.unauthorized);
	const baseBodies = slots.map((slot, index) => {
		const messages = [sourceMessage(`base-${index}`,
			`My durable final security codename is ${marks.base[index]}. Remember it exactly.`)];
		if (index === 1) messages.push(sourceMessage("secret-battery", `Synthetic credentials for scrub testing:\n${secretText}`));
		if (index === 2) messages.push(sourceMessage("forbidden-rule",
			`My ${marks.forbidden} preference is a forbidden private detail.`));
		return ingestBody(slot, `base-${suffix}-${index}`, messages, PROJECT_ALPHA,
			index === 2 ? { excludes: [marks.forbidden] } : undefined);
	});
	const baseExpected = slots.map((_, index) => index === 2 ? 1 : index === 1 ? 2 : 1);
	const baseAccepted = await pool(baseBodies, 10, (body, index) => accept(token, body, baseExpected[index]));
	const baseSettled = await pool(baseAccepted, 5, (accepted, index) => settle(token, slots[index], accepted));
	assert(baseSettled.every((row) => TERMINAL.has(row.ready.status)), "base concurrent jobs lost");
	console.log("stage-b concurrent subtenant ingest: PASS");

	const duplicateBody = ingestBody(slots[4], `duplicate-${suffix}`, [sourceMessage("duplicate-m1",
		`My duplicate-race security codename is ${marks.duplicate}.`)]);
	const duplicateResponses = await Promise.all([
		accept(token, duplicateBody, 1), accept(token, duplicateBody, 1),
	]);
	assert(duplicateResponses[0].packetId === duplicateResponses[1].packetId
		&& duplicateResponses[0].jobId === duplicateResponses[1].jobId, "same-key race diverged");
	await settle(token, slots[4], duplicateResponses[0]);
	const idempotency = await packetIdempotencyAudit(slots[4], duplicateResponses[0].packetId);
	console.log("stage-b same-key race: PASS");

	const projectBodies = [
		ingestBody(slots[0], `beta-${suffix}`, [sourceMessage("beta-m1",
			`My beta project security codename is ${marks.beta}.`)], PROJECT_BETA),
		ingestBody(slots[0], `global-${suffix}`, [sourceMessage("global-m1",
			`My account-global security codename is ${marks.global}.`)], null),
	];
	const projectAccepted = await Promise.all(projectBodies.map((body) => accept(token, body, 1)));
	await Promise.all(projectAccepted.map((accepted) => settle(token, slots[0], accepted)));

	const burstBodies = marks.burst.map((value, index) => ingestBody(slots[5], `burst-${suffix}-${index}`,
		[sourceMessage(`burst-${index}`, `My durable burst fact number ${index + 1} is ${value}.`)]));
	const burstAccepted = await pool(burstBodies, 6, (body) => accept(token, body, 1));
	const burstBacklog = (await request(token, "GET", "/v1/jobs", {
		query: { userId: slots[5].externalId, limit: 200 },
	})).body?.jobs?.filter((job) => !["enriched", "failed", "completed"].includes(job.status)).length ?? 0;
	const burstSettled = await pool(burstAccepted, 3, (accepted) => settle(token, slots[5], accepted));
	assert(burstSettled.every((row) => TERMINAL.has(row.ready.status)), "same-tenant burst lost accepted work");

	const immediateBody = ingestBody(slots[6], `immediate-${suffix}`, [sourceMessage("immediate-m1",
		`My immediate-read security codename is ${marks.immediate}.`)]);
	const immediateAccepted = await accept(token, immediateBody, 1);
	const immediateRecall = await recall(token, slots[6], "What is my immediate-read security codename?");
	assert(contains(immediateRecall.context, marks.immediate), "read-your-writes index lag hid accepted evidence");
	await settle(token, slots[6], immediateAccepted);
	console.log("stage-b same-tenant/project/index-lag ingest: PASS");

	const ownRecalls = [];
	for (let index = 0; index < slots.length; index += 1) {
		const row = await recall(token, slots[index], "What is my durable final security codename?");
		assert(contains(row.context, marks.base[index]), `slot ${index}: own evidence precondition failed`);
		assert(row.sourceExpansionUsed && row.sourceExpansionEpisodes > 0,
			`slot ${index}: exact source expansion was not active`);
		ownRecalls.push(row);
	}
	const persistenceIsolation = await markerIsolationAudit(slots, marks.base);
	const projectPersistence = await projectPersistenceAudit(slots[0], {
		[PROJECT_ALPHA.projectId]: marks.base[0], [PROJECT_BETA.projectId]: marks.beta, __global__: marks.global,
	});
	const secretAndRules = await forbiddenAndSecretAudit(slots,
		[...syntheticSecrets, marks.forbidden, marks.unauthorized]);

	const exports = [];
	for (const index of [0, 1, 2]) {
		const response = await request(token, "GET", "/v1/export", { query: { userId: slots[index].externalId } });
		assert(response.ok && response.body, `export slot ${index} failed`);
		const serialized = JSON.stringify(response.body);
		assert(syntheticSecrets.every((value) => !serialized.includes(value)), `export slot ${index} retained raw secret`);
		assert(!serialized.includes(marks.forbidden), `export slot ${index} retained excluded content`);
		const audit = auditExportSecrets(response.body);
		assert(audit.pass, `export slot ${index} generic secret audit failed`);
		exports.push({ slot: index, checkedStrings: audit.checkedStrings, failures: audit.failures.length });
	}
	console.log("stage-b persistence/rules/secrets/export: PASS");

	const crossTenant = [];
	for (let index = 0; index < slots.length; index += 1) {
		const target = (index + 1) % slots.length;
		const row = await recall(token, slots[target], `What do you know about ${marks.base[index]}?`);
		assert(!contains(row.context, marks.base[index]), `slot ${index}: cross-subtenant recall leak`);
		crossTenant.push({ source: index, target, items: row.itemCount, chars: row.contextChars });
	}
	const alphaWrongBeta = await recall(token, slots[0], `What do you know about ${marks.beta}?`);
	assert(!contains(alphaWrongBeta.context, marks.beta), "project_only alpha leaked beta");
	const betaOwn = await recall(token, slots[0], "What is my beta project security codename?", {
		recallScope: "project_only", memoryScope: PROJECT_BETA,
	});
	assert(contains(betaOwn.context, marks.beta) && !contains(betaOwn.context, marks.base[0]),
		"project_only beta scope was not isolated");
	const alphaGlobal = await recall(token, slots[0], "What is my account-global security codename?", {
		recallScope: "project_then_global", memoryScope: PROJECT_ALPHA,
	});
	assert(contains(alphaGlobal.context, marks.global) && !contains(alphaGlobal.context, marks.beta),
		"project_then_global contract failed");
	const rulesRecall = await recall(token, slots[2], "What forbidden private preference did I mention?");
	assert(!contains(rulesRecall.context, marks.forbidden), "rules-excluded content returned in recall");
	const secretRecall = await recall(token, slots[1], "What credentials did I share for the synthetic scrub test?");
	assert(syntheticSecrets.every((value) => !secretRecall.context.includes(value)), "raw secret returned in recall");
	console.log("stage-b recall isolation/source expansion: PASS");

	await burnSnapshot("FINAL-B:before-soak-writes", 10_000);
	const soakBodies = slots.map((slot, index) => ingestBody(slot, `soak-${suffix}-${index}`,
		[sourceMessage(`soak-${index}`, `My bounded soak checkpoint is ${marks.soak[index]}.`)]));
	const soakAccepted = await pool(soakBodies, 10, (body) => accept(token, body, 1));
	const soakSettled = await pool(soakAccepted, 5, (accepted, index) => settle(token, slots[index], accepted));
	assert(soakSettled.every((row) => TERMINAL.has(row.ready.status)), "soak write loss");
	const recallLatencies = [];
	const soakRows = Array.from({ length: 200 }, (_, index) => ({
		slot: slots[index % slots.length], marker: marks.soak[index % slots.length], index,
	}));
	await pool(soakRows, 10, async (item) => {
		const row = await recall(token, item.slot, "What is my bounded soak checkpoint?");
		assert(contains(row.context, item.marker), `soak recall ${item.index}: evidence loss`);
		recallLatencies.push(row.clientLatencyMs);
	});
	const drained = await stateCounts(slots);
	assert(integer(drained.nonterminal_jobs) === 0 && integer(drained.live_staged) === 0,
		`pressure did not drain: ${JSON.stringify(drained)}`);
	await sleep(30_000);
	const stable = await stateCounts(slots);
	assert(integer(stable.nonterminal_jobs) === 0 && integer(stable.live_staged) === 0,
		"stability grace found backlog");
	console.log("stage-b bounded soak: PASS");

	await burnSnapshot("FINAL-B:before-delete-race", 4_000);
	const raceMessages = Array.from({ length: 20 }, (_, index) => sourceMessage(`race-${index}`,
		index === 0
			? `My pre-erasure race codename is ${marks.race}.`
			: `Race workload detail ${index} records a durable procedure checkpoint.`));
	const raceBody = ingestBody(slots[3], `race-${suffix}`, raceMessages);
	const raceAccepted = await accept(token, raceBody, 20);
	const raceDelete = await request(token, "DELETE", "/v1/memories", {
		query: { userId: slots[3].externalId, confirm: "true" }, attempts: 3,
	});
	assert(raceDelete.ok && raceDelete.body?.ok === true, "delete during extraction failed");
	const replay = await request(token, "POST", "/v1/ingest", {
		body: raceBody, attempts: 1, timeoutMs: REQUEST_TIMEOUT_MS,
	});
	assert(replay.status === 409 && replay.body?.code === "source_write_erased" && replay.body?.retryable === false,
		`pre-erasure replay was not fenced: ${replay.status}/${replay.body?.code}`);
	await sleep(15_000);
	const raceAfter = await stateCounts([slots[3]]);
	assert(memoryCountsAreZero(raceAfter), `late commit resurrected erased state: ${JSON.stringify(raceAfter)}`);
	const raceRecall = await recall(token, slots[3], "What was my pre-erasure race codename?");
	assert(!contains(raceRecall.context, marks.race), "erased evidence survived recall/vector lane");
	const freshBody = ingestBody(slots[3], `fresh-${suffix}`, [sourceMessage("fresh-m1",
		`My genuinely new post-delete codename is ${marks.fresh}.`)]);
	const freshAccepted = await accept(token, freshBody, 1);
	await settle(token, slots[3], freshAccepted);
	const freshRecall = await recall(token, slots[3], "What is my genuinely new post-delete codename?");
	assert(contains(freshRecall.context, marks.fresh) && !contains(freshRecall.context, marks.race),
		"post-delete new-write contract failed");
	console.log("stage-b erasure/replay/new-write: PASS");

	const rulesAfter = await rulesDigest(token, slots[0].externalId);
	assert(rulesBefore === rulesAfter, "request-scoped rules mutated account rules");
	const burnPrecleanup = await burnSnapshot("FINAL-B:before-cleanup", 2_000);
	const cleanupFirst = await eraseCohort(token, slots);
	const postEraseRecalls = [];
	for (let index = 0; index < slots.length; index += 1) {
		const row = await recall(token, slots[index], `What do you know about ${marks.base[index]}?`);
		assert(!contains(row.context, marks.base[index]), `slot ${index}: erased evidence returned`);
		postEraseRecalls.push({ slot: index, items: row.itemCount, chars: row.contextChars });
	}
	const allSafeMarkers = [
		...marks.base, marks.beta, marks.global, marks.forbidden, marks.unauthorized, marks.duplicate,
		marks.immediate, ...marks.burst, ...marks.soak, marks.race, marks.fresh,
	];
	const ftsErasure = await ftsErasureAudit(slots, allSafeMarkers);
	const cleanupSecond = await eraseCohort(token, slots);
	await sleep(30_000);
	const cleanAfter = await stateCounts(slots);
	assert(memoryCountsAreZero(cleanAfter), `Stage B residue after stability grace: ${JSON.stringify(cleanAfter)}`);
	assert(await rulesDigest(token, slots[0].externalId) === rulesBefore, "rules changed during cleanup");
	const burnAfter = await burnSnapshot("FINAL-B:complete", 1_000);
	assert(burnAfter.spent - burnBefore.spent <= 40_000, "Stage B exceeded preregistered inference cap");

	const recallMetrics = [...ownRecalls, immediateRecall, alphaWrongBeta, betaOwn, alphaGlobal,
		rulesRecall, secretRecall, freshRecall];
	const result = {
		schema: "itsuki.v3-final-stage-b-live-reattack/v1",
		pass: true,
		startedAt: burnBefore.at,
		completedAt: new Date().toISOString(),
		frozen,
		health: health.map(({ domain, status }) => ({ domain, memoryV3: status })),
		markers: markerSummary(marks),
		syntheticSecretCount: syntheticSecrets.length,
		localSecretScrub: { pass: true, redactionKinds: Object.keys(localScrub.redactions).sort() },
		auth: unauthorized,
		preclean: { clean: preclean.clean, counts: cleanBefore },
		concurrency: {
			parallelSubtenantWrites: baseSettled.length,
			sameTenantBurstWrites: burstSettled.length,
			maxObservedBurstBacklog: burstBacklog,
			idempotency,
			acceptedLoss: 0,
		},
		isolation: {
			persistence: persistenceIsolation,
			projectPersistence,
			crossTenantRecalls: crossTenant,
			projectOnly: { alphaExcludedBeta: true, betaExcludedAlpha: true },
			projectThenGlobal: { includedGlobal: true, excludedSiblingProject: true },
			sourceExpansion: { ownPreconditions: ownRecalls.length, allUsed: true },
		},
		privacy: {
			secretAndRules,
			exports,
			rulesDigestUnchanged: true,
			rawEpisodeArchive: false,
			episodeVectorsActive: false,
			rerankerActive: false,
		},
		boundedness: {
			limit: 200,
			contextCharsHardMax: 24_000,
			observedItemMax: Math.max(...recallMetrics.map((row) => row.itemCount)),
			observedContextCharsMax: Math.max(...recallMetrics.map((row) => row.contextChars)),
		},
		latencyMs: {
			ingestMean: baseSettled.reduce((sum, row) => sum + row.elapsedMs, 0) / baseSettled.length,
			recallMean: recallMetrics.reduce((sum, row) => sum + row.clientLatencyMs, 0) / recallMetrics.length,
			recallP95: percentile(recallMetrics.map((row) => row.clientLatencyMs), 0.95),
			soakRecallMean: recallLatencies.reduce((sum, value) => sum + value, 0) / recallLatencies.length,
			soakRecallP95: percentile(recallLatencies, 0.95),
		},
		soak: {
			writes: soakSettled.length,
			recalls: soakRows.length,
			backlogDrained: true,
			stabilityGraceMs: 30_000,
			countsBeforeCleanup: stable,
		},
		erasure: {
			deleteDuringExtraction: true,
			preBarrierReplayStatus: replay.status,
			preBarrierReplayCode: replay.body.code,
			lateCommitResidue: raceAfter,
			newPostDeleteWrite: true,
			postEraseRecalls,
			ftsErasure,
			cleanupFirst: cleanupFirst.clean,
			cleanupSecond: cleanupSecond.clean,
			finalCounts: cleanAfter,
		},
		burnBefore,
		burnPrecleanup,
		burnAfter,
		neuronDeltaObserved: burnAfter.spent - burnBefore.spent,
	};
	writeJsonExclusive(RESULT, result);
	console.log(JSON.stringify({ pass: result.pass, soak: result.soak, erasure: result.erasure,
		neuronDeltaObserved: result.neuronDeltaObserved, latencyMs: result.latencyMs }, null, 2));
}

async function cleanupOnly() {
	const token = secret("ITSUKI_API_KEY");
	console.log("ITSUKI_API_KEY: LOADED");
	const slots = cohorts().treatment;
	const first = await eraseCohort(token, slots);
	await sleep(30_000);
	const counts = await stateCounts(slots);
	assert(memoryCountsAreZero(counts), `cleanup-only residue: ${JSON.stringify(counts)}`);
	writeJsonAtomic(FAILURE_CLEANUP, {
		schema: "itsuki.v3-final-stage-b-failure-cleanup/v1", at: new Date().toISOString(),
		clean: first.clean, counts,
	});
	console.log("Stage B cleanup-only: PASS");
}

async function runCommand(command) {
	if (command === "lock-proof") {
		const ms = Number(process.argv[3] ?? 5_000);
		assert(Number.isFinite(ms) && ms > 0 && ms <= 30_000, "invalid lock-proof duration");
		await sleep(ms);
		return;
	}
	if (command === "run") return liveRun();
	if (command === "cleanup") return cleanupOnly();
	throw new Error("usage: live-reattack.mjs <lock-proof|run|cleanup>");
}

async function main() {
	let lock;
	try {
		lock = acquireBenchmarkLock(GLOBAL_LOCK, { experiment: `FINAL-B-${process.argv[2] ?? "missing"}` });
	} catch (error) {
		if (error instanceof BenchmarkLockHeldError) {
			console.error(`LOCK_HELD: ${error.message}`);
			process.exit(EXIT_LOCK_HELD);
		}
		throw error;
	}
	try {
		await runCommand(process.argv[2]);
		lock.assertHeld();
	} finally {
		lock.release();
	}
}

main().catch((error) => {
	console.error(error.stack ?? error);
	process.exit(1);
});
