import path from "node:path";
import { createRequire } from "node:module";

import {
	EVIDENCE,
	GLOBAL_LOCK,
	PROJECT_ALPHA,
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
	request,
	rulesDigest,
	secret,
	sqlQuote,
	validateInputs,
	waitReady,
	writeJsonExclusive,
} from "./common.mjs";

const require = createRequire(import.meta.url);
const { EXIT_LOCK_HELD, BenchmarkLockHeldError, acquireBenchmarkLock } = require("../../e2/harness/benchmark-lock.cjs");
const RESULT = path.join(EVIDENCE, "v3-d10-production-reattack.json");
const TERMINAL = new Set(["enriched", "completed"]);

function sourceMessage(id, content) {
	return { id, role: "user", content, sourceTime: "2026-08-11T12:00:00+05:30" };
}

async function packetAudit(slot, packetId, allowed, forbidden) {
	const user = sqlQuote(slot.memoryUserId);
	const packet = sqlQuote(packetId);
	const good = sqlQuote(allowed);
	const denied = sqlQuote(forbidden);
	const [result] = await d1Select([`SELECT
		(SELECT COUNT(*) FROM source_packets WHERE user_id=${user} AND id=${packet}) AS packet_rows,
		(SELECT COUNT(*) FROM source_packets WHERE user_id=${user} AND id=${packet}
		 AND instr(coalesce(content_preview,'') || ' ' || coalesce(raw_meta_json,''),${good})>0) AS packet_allowed,
		(SELECT COUNT(*) FROM source_packets WHERE user_id=${user} AND id=${packet}
		 AND instr(coalesce(content_preview,'') || ' ' || coalesce(raw_meta_json,''),${denied})>0) AS packet_forbidden,
		(SELECT message_count FROM source_packets WHERE user_id=${user} AND id=${packet}) AS packet_messages,
		(SELECT COUNT(*) FROM source_episodes WHERE user_id=${user} AND source_packet_id=${packet} AND instr(text,${good})>0) AS episode_allowed,
		(SELECT COUNT(*) FROM source_episodes WHERE user_id=${user} AND source_packet_id=${packet} AND instr(text,${denied})>0) AS episode_forbidden,
		(SELECT COUNT(*) FROM semantic_atom_candidates WHERE user_id=${user} AND source_packet_id=${packet}
		 AND instr(coalesce(evidence_quote,'') || ' ' || coalesce(assertion,'') || ' ' || coalesce(value,''),${denied})>0) AS atom_forbidden,
		(SELECT COUNT(*) FROM staged_memories WHERE user_id=${user} AND source_packet_id=${packet} AND instr(text,${denied})>0) AS staged_forbidden`]);
	return result.results?.[0] ?? {};
}

async function minimizedAudit(slot, packetId) {
	const user = sqlQuote(slot.memoryUserId);
	const packet = sqlQuote(packetId);
	const [result] = await d1Select([`SELECT COUNT(*) AS packet_rows,
		SUM(CASE WHEN content_hash='itsuki-erased-source/v1' THEN 1 ELSE 0 END) AS minimized,
		SUM(CASE WHEN length(trim(coalesce(content_preview,'')))>0 OR trim(coalesce(raw_meta_json,'{}')) NOT IN ('','{}') THEN 1 ELSE 0 END) AS content_rows,
		SUM(CASE WHEN message_count=0 THEN 1 ELSE 0 END) AS zero_message_rows
	 FROM source_packets WHERE user_id=${user} AND id=${packet}`]);
	return result.results?.[0] ?? {};
}

async function run() {
	validateInputs();
	const slot = cohorts().treatment[0];
	const token = secret("ITSUKI_API_KEY");
	console.log("ITSUKI_API_KEY: LOADED");
	const health = await expectedHealthActive();
	await assertBillingPreflight();
	const burnBefore = await burnSnapshot("FINAL-B:D10-start", 5_000);
	const rulesBefore = await rulesDigest(token, slot.externalId);
	await eraseCohort(token, [slot]);

	const suffix = String(Math.trunc(Date.now() / 1000) % 1_000_000);
	const allowed = `d10allowedwillow${suffix}`;
	const forbidden = `d10forbiddencedar${suffix}`;
	const idempotencyKey = `itsuki-v3:final-d10:${suffix}`;
	const body = {
		userId: slot.externalId,
		conversationId: `final-d10-${suffix}`,
		idempotencyKey,
		memoryScope: { ...PROJECT_ALPHA },
		rules: { excludes: [forbidden] },
		flush: true,
		messages: [
			sourceMessage("d10-allowed", `My permitted D10 codename is ${allowed}.`),
			sourceMessage("d10-forbidden", `My excluded D10 codename is ${forbidden}.`),
		],
	};
	const accepted = await request(token, "POST", "/v1/ingest", { body, attempts: 1, timeoutMs: 300_000 });
	assert(accepted.ok && accepted.body?.ok === true, `D10 ingest failed ${accepted.status}/${accepted.body?.code}`);
	assert(integer(accepted.body.source_episodes_written) === 1
		&& integer(accepted.body.source_episodes_rule_filtered) === 1, "D10 rule-filter episode accounting failed");
	const ready = await waitReady(token, slot.externalId, accepted.body.job_id);
	assert(TERMINAL.has(ready.status), `D10 job did not settle: ${ready.status}`);

	const persisted = await packetAudit(slot, accepted.body.source_packet_id, allowed, forbidden);
	assert(integer(persisted.packet_rows) === 1 && integer(persisted.packet_allowed) === 1
		&& integer(persisted.packet_forbidden) === 0 && integer(persisted.packet_messages) === 1,
		`D10 packet rules audit failed: ${JSON.stringify(persisted)}`);
	assert(integer(persisted.episode_allowed) === 1 && integer(persisted.episode_forbidden) === 0
		&& integer(persisted.atom_forbidden) === 0 && integer(persisted.staged_forbidden) === 0,
		`D10 downstream rules audit failed: ${JSON.stringify(persisted)}`);

	const recalled = await request(token, "POST", "/v1/recall", { body: {
		userId: slot.externalId,
		query: "What is my permitted D10 codename?",
		limit: 200,
		recallScope: "project_only",
		memoryScope: { ...PROJECT_ALPHA },
	} });
	assert(recalled.ok && String(recalled.body?.context ?? "").includes(allowed)
		&& !String(recalled.body?.context ?? "").includes(forbidden), "D10 recall rules audit failed");
	const exported = await request(token, "GET", "/v1/export", { query: { userId: slot.externalId } });
	assert(exported.ok && !JSON.stringify(exported.body).includes(forbidden), "D10 export retained excluded marker");
	assert(auditExportSecrets(exported.body).pass, "D10 export generic secret audit failed");

	const erased = await eraseCohort(token, [slot]);
	const minimized = await minimizedAudit(slot, accepted.body.source_packet_id);
	assert(integer(minimized.packet_rows) === 1 && integer(minimized.minimized) === 1
		&& integer(minimized.content_rows) === 0 && integer(minimized.zero_message_rows) === 1,
		`D10 packet erasure audit failed: ${JSON.stringify(minimized)}`);
	const replay = await request(token, "POST", "/v1/ingest", { body, attempts: 1, timeoutMs: 60_000 });
	assert(replay.status === 409 && replay.body?.code === "source_write_erased" && replay.body?.retryable === false,
		`D10 erased replay was not fenced: ${replay.status}/${replay.body?.code}`);
	assert(await rulesDigest(token, slot.externalId) === rulesBefore, "D10 request-scoped rules mutated account rules");
	const burnAfter = await burnSnapshot("FINAL-B:D10-complete", 1_000);

	writeJsonExclusive(RESULT, {
		schema: "itsuki.v3-final-d10-production-reattack/v1",
		at: new Date().toISOString(),
		pass: true,
		health: health.map(({ domain, status }) => ({ domain, memoryV3: status })),
		markerDigests: { allowed: contentDigest(allowed), forbidden: contentDigest(forbidden) },
		accepted: {
			status: accepted.status,
			packetId: accepted.body.source_packet_id,
			jobId: accepted.body.job_id,
			episodesWritten: integer(accepted.body.source_episodes_written),
			episodesRuleFiltered: integer(accepted.body.source_episodes_rule_filtered),
			jobStatus: ready.status,
		},
		persisted: Object.fromEntries(Object.entries(persisted).map(([key, value]) => [key, integer(value)])),
		recall: { status: recalled.status, forbiddenAbsent: true, permittedPresent: true },
		export: { status: exported.status, forbiddenAbsent: true, genericSecretAudit: true },
		erasure: { apiClean: erased.clean, minimized: Object.fromEntries(Object.entries(minimized).map(([key, value]) => [key, integer(value)])) },
		replay: { status: replay.status, code: replay.body.code, retryable: replay.body.retryable },
		rulesUnchanged: true,
		burnBefore,
		burnAfter,
		neuronDeltaObserved: burnAfter.spent - burnBefore.spent,
	});
	console.log("V3-D10 production reattack: PASS");
}

let lock;
try {
	lock = acquireBenchmarkLock(GLOBAL_LOCK, { experiment: "FINAL-B-D10-REATTACK" });
	await run();
} catch (error) {
	if (error instanceof BenchmarkLockHeldError) {
		console.error(error.message);
		process.exitCode = EXIT_LOCK_HELD;
	} else {
		console.error(error?.stack ?? error);
		process.exitCode = 1;
	}
} finally {
	lock?.release();
}
