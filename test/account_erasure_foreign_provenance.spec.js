import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createExtractionRun, storeReceipt } from "../src/lib/db.js";
import { applyPolicyChange, emergencyDisable } from "../src/ai/admin.js";
import { reconcileShadowJobs, shadowJobId } from "../src/ai/shadow.js";
import {
	markReservationInvoking,
	releaseReservation,
	reserveSpend,
} from "../src/ai/provider_budget.js";
import { deleteAccountCompletely } from "../src/pipeline/cleanup.js";
import { normalizeSourcePacket, storeSourcePacket } from "../src/pipeline/source.js";

function id(prefix) {
	return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

async function user(label) {
	const userId = id("usr");
	const email = `${label}-${crypto.randomUUID()}@example.com`.toLowerCase();
	const now = Date.now();
	await env.DB.prepare(
		`INSERT INTO users (id, email, email_normalized, name, created_at, updated_at, status, role)
		 VALUES (?, ?, ?, ?, ?, ?, 'active', 'user')`,
	).bind(userId, email, email, label, now, now).run();
	return { id: userId, email };
}

describe("foreign-project account erasure provenance", () => {
	it("fails closed when a late unattributed meter recreates an owned memory identity after the sweep", async () => {
		const target = await user("late-owned-meter-residue");
		const lateCallId = id("aicall");
		const lateScopeId = id("late_scope");
		const now = Date.now();
		const DB = new Proxy(env.DB, {
			get(db, property) {
				if (property === "prepare") return (sql) => {
					const statement = db.prepare(sql);
					if (!String(sql).includes("UPDATE ai_calls SET account_user_id = NULL WHERE account_user_id = ?")) {
						return statement;
					}
					// Deterministically model an old/incompatible in-flight meter that lands
					// after the owned-memory sweep but before the residual assertion. Its
					// account column is already anonymous, so checking that column alone
					// cannot prove account erasure converged.
					return {
						bind: () => db.prepare(
							`INSERT INTO ai_calls
							 (id, user_id, scope, scope_id, model, task, input_tokens,
							  output_tokens, total_tokens, ok, created_at, account_user_id,
							  managed_project_id, provider)
							 VALUES (?, ?, 'save', ?, '@cf/test-model', 'late_meter', 2,
							  3, 5, 1, ?, NULL, NULL, 'workers-ai')`,
						).bind(lateCallId, target.id, lateScopeId, now),
					};
				};
				const value = Reflect.get(db, property);
				return typeof value === "function" ? value.bind(db) : value;
			},
		});
		const raceEnv = Object.assign(Object.create(Object.getPrototypeOf(env)), env, { DB });

		await expect(deleteAccountCompletely(raceEnv, target.id))
			.rejects.toThrow("account teardown left owned usage identity residue");
	});

	it("retains global provider controls while removing exact and embedded account provenance", async () => {
		const target = await user("provider-control-target");
		const survivor = await user("provider-control-survivor");
		const now = Date.now();
		const actorAuditId = id("policy_audit");
		const mentionAuditId = id("policy_audit");
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO ai_routing_policies
				 (capability, mode, primary_provider, allowlist_json, disabled, version, updated_at, updated_by)
				 VALUES ('rerank', 'cloudflare_only', 'workers-ai', ?, 0, 7, ?, ?)`,
			).bind(JSON.stringify([target.id]), now, target.id),
			env.DB.prepare(
				`INSERT INTO ai_routing_policies
				 (capability, mode, primary_provider, allowlist_json, disabled, version, updated_at, updated_by)
				 VALUES ('extract', 'cloudflare_only', 'workers-ai', ?, 1, 4, ?, ?)`,
			).bind(JSON.stringify([target.id, survivor.id]), now, survivor.id),
			env.DB.prepare(
				`INSERT INTO ai_routing_policies
				 (capability, mode, primary_provider, allowlist_json, disabled, version, updated_at, updated_by)
				 VALUES ('edges', 'cloudflare_only', 'workers-ai', NULL, 0, 2, ?, ?)`,
			).bind(now, target.id),
			env.DB.prepare(
				`INSERT INTO ai_routing_policy_audit
				 (id, capability, actor_user_id, changed_at, old_json, new_json, note)
				 VALUES (?, 'rerank', ?, ?, ?, ?, 'private actor-authored explanation')`,
			).bind(
				actorAuditId,
				target.id,
				now,
				JSON.stringify({
					updated_by: target.id,
					allowlist_json: JSON.stringify([target.id, survivor.id]),
					nested: { owner: `prefix:${target.id}`, email: target.email.toUpperCase() },
				}),
				JSON.stringify({ direct: target.id, key_owner: { [target.id]: true } }),
			),
			env.DB.prepare(
				`INSERT INTO ai_routing_policy_audit
				 (id, capability, actor_user_id, changed_at, old_json, new_json, note)
				 VALUES (?, 'extract', ?, ?, ?, ?, ?)`,
			).bind(
				mentionAuditId,
				survivor.id,
				now,
				JSON.stringify({ prior_member: target.id }),
				JSON.stringify({ retained_actor: survivor.id }),
				`Removed ${target.email.toUpperCase()} from staged rollout`,
			),
			env.DB.prepare(
				`INSERT INTO ai_provider_overrides
				 (provider, disabled, actor_user_id, reason, updated_at)
				 VALUES ('google-vertex', 1, ?, 'private operational explanation', ?)`,
			).bind(target.id, now),
		]);

		const deleted = await deleteAccountCompletely(env, target.id);
		expect(deleted.deleted).toBe(true);

		const policies = await env.DB.prepare(
			`SELECT capability, mode, disabled, allowlist_json, updated_by
			   FROM ai_routing_policies
			  WHERE capability IN ('rerank', 'extract', 'edges')
			  ORDER BY capability`,
		).all();
		expect(policies.results).toEqual([
			{
				capability: "edges", mode: "cloudflare_only", disabled: 0,
				allowlist_json: null, updated_by: "deleted_user",
			},
			{
				capability: "extract", mode: "cloudflare_only", disabled: 1,
				allowlist_json: JSON.stringify([survivor.id]), updated_by: survivor.id,
			},
			{
				capability: "rerank", mode: "cloudflare_only", disabled: 0,
				allowlist_json: "[]", updated_by: "deleted_user",
			},
		]);
		// Removing the final rollout member is deliberately [] (deny all), never
		// NULL (the policy engine's open-all representation).
		expect(policies.results.find((row) => row.capability === "rerank")?.allowlist_json).toBe("[]");

		const actorAudit = await env.DB.prepare(
			"SELECT actor_user_id, old_json, new_json, note FROM ai_routing_policy_audit WHERE id = ?",
		).bind(actorAuditId).first();
		expect(actorAudit.actor_user_id).toBe("deleted_user");
		expect(actorAudit.note).toBeNull();
		const mentionAudit = await env.DB.prepare(
			"SELECT actor_user_id, old_json, new_json, note FROM ai_routing_policy_audit WHERE id = ?",
		).bind(mentionAuditId).first();
		expect(mentionAudit.actor_user_id).toBe(survivor.id);
		expect(mentionAudit.note).toBeNull();
		for (const row of [actorAudit, mentionAudit]) {
			const serialized = JSON.stringify(row);
			expect(serialized).not.toContain(target.id);
			expect(serialized.toLowerCase()).not.toContain(target.email.toLowerCase());
		}
		expect(actorAudit.old_json).toContain("deleted_user");

		const override = await env.DB.prepare(
			"SELECT disabled, actor_user_id, reason FROM ai_provider_overrides WHERE provider = 'google-vertex'",
		).first();
		expect(override).toEqual({ disabled: 1, actor_user_id: null, reason: null });

		for (const table of ["ai_routing_policies", "ai_routing_policy_audit", "ai_provider_overrides"]) {
			const rows = await env.DB.prepare(`SELECT * FROM ${table}`).all();
			const serialized = JSON.stringify(rows.results);
			expect(serialized).not.toContain(target.id);
			expect(serialized.toLowerCase()).not.toContain(target.email.toLowerCase());
		}
	});

	it("makes account erasure win a paused policy write and rejects later control-plane resurrection", async () => {
		const target = await user("provider-control-race");
		const survivor = await user("provider-control-race-survivor");
		let releaseRead;
		let markRead;
		const readArrived = new Promise((resolve) => { markRead = resolve; });
		const readReleased = new Promise((resolve) => { releaseRead = resolve; });
		const DB = new Proxy(env.DB, {
			get(db, property) {
				if (property === "prepare") return (sql) => {
					const statement = db.prepare(sql);
					if (!String(sql).includes("SELECT * FROM ai_routing_policies WHERE capability = ?")) return statement;
					const pause = (current) => new Proxy(current, {
						get(prepared, preparedProperty) {
							if (preparedProperty === "bind") return (...args) => pause(prepared.bind(...args));
							if (preparedProperty === "first") return async (...args) => {
								const row = await prepared.first(...args);
								markRead();
								await readReleased;
								return row;
							};
							const value = Reflect.get(prepared, preparedProperty);
							return typeof value === "function" ? value.bind(prepared) : value;
						},
					});
					return pause(statement);
				};
				const value = Reflect.get(db, property);
				return typeof value === "function" ? value.bind(db) : value;
			},
		});
		const raceEnv = Object.assign(Object.create(Object.getPrototypeOf(env)), env, { DB });
		const pausedWrite = applyPolicyChange(raceEnv, {
			lane: "rerank",
			patch: { mode: "cloudflare_only", allowlist: [target.id] },
			actorUserId: target.id,
			note: `must never persist ${target.email}`,
		});
		await readArrived;
		expect((await deleteAccountCompletely(env, target.id)).deleted).toBe(true);
		releaseRead();
		expect(await pausedWrite).toEqual({ error: "account_erased" });

		expect(await emergencyDisable(env, {
			actorUserId: target.id,
			reason: `must never persist ${target.email}`,
		})).toEqual({ error: "account_erased" });
		expect(await applyPolicyChange(env, {
			lane: "rerank",
			patch: { mode: "cloudflare_only", allowlist: [target.id] },
			actorUserId: survivor.id,
		})).toEqual({ error: "allowlist_contains_erased_account" });

		for (const table of ["ai_routing_policies", "ai_routing_policy_audit", "ai_provider_overrides"]) {
			const rows = await env.DB.prepare(`SELECT * FROM ${table}`).all();
			const serialized = JSON.stringify(rows.results);
			expect(serialized).not.toContain(target.id);
			expect(serialized.toLowerCase()).not.toContain(target.email.toLowerCase());
		}
	});

	it("does not confirm account erasure over a live admitted shadow invocation", async () => {
		const target = await user("active-shadow-account");
		const now = Date.now();
		const packetId = id("packet");
		const episodeId = id("episode");
		const shadowId = id("shadow");
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO source_episodes
				 (id, user_id, source_packet_id, message_index, role, text, text_hash, created_at)
				 VALUES (?, ?, ?, 0, 'user', 'Account erasure must wait for admission.', ?, ?)`,
			).bind(episodeId, target.id, packetId, "c".repeat(64), now),
			env.DB.prepare(
				`INSERT INTO ai_shadow_jobs
				 (id, user_id, account_user_id, primary_run_id, provider, status, attempts,
				  claim_token, lease_until, created_at, updated_at)
				 VALUES (?, ?, ?, ?, 'google-vertex', 'invoking', 1, 'live-invocation', ?, ?, ?)`,
			).bind(shadowId, target.id, target.id, id("run"), now + 60_000, now, now),
		]);

		await expect(deleteAccountCompletely(env, target.id)).rejects.toMatchObject({
			code: "shadow_invocation_in_flight",
			retryable: true,
		});
		expect(await env.DB.prepare("SELECT text FROM source_episodes WHERE id = ?")
			.bind(episodeId).first()).toEqual({ text: "Account erasure must wait for admission." });
		expect(await env.DB.prepare("SELECT status FROM users WHERE id = ?")
			.bind(target.id).first()).toEqual({ status: "disabled" });
		expect(await env.DB.prepare("SELECT user_id FROM account_erasure_tombstones WHERE user_id = ?")
			.bind(target.id).first()).toEqual({ user_id: target.id });

		await env.DB.prepare("UPDATE ai_shadow_jobs SET lease_until = ? WHERE id = ?")
			.bind(now - 1, shadowId).run();
		await expect(deleteAccountCompletely(env, target.id)).resolves.toMatchObject({ deleted: true });
		expect(await env.DB.prepare("SELECT id FROM source_episodes WHERE id = ?")
			.bind(episodeId).first()).toBeNull();
	});

	it("does not confirm account erasure over a live primary invocation and scrubs terminal provenance", async () => {
		const target = await user("active-primary-account");
		const now = Date.now();
		const packetId = id("packet");
		const episodeId = id("episode");
		const reservationId = id("provider");
		await env.DB.prepare(
			`INSERT INTO source_episodes
			 (id, user_id, source_packet_id, message_index, role, text, text_hash, created_at)
			 VALUES (?, ?, ?, 0, 'user', 'Account erasure must wait for the primary provider.', ?, ?)`,
		).bind(episodeId, target.id, packetId, "d".repeat(64), now).run();
		// The first scenario intentionally proves that global provider controls
		// survive account erasure and leaves the emergency override disabled. The
		// lifecycle race itself needs one already-admitted invocation, so briefly
		// reopen admission and restore the exact global control before erasing.
		const providerOverride = await env.DB.prepare(
			"SELECT disabled FROM ai_provider_overrides WHERE provider = 'google-vertex'",
		).first();
		if (Number(providerOverride?.disabled ?? 0) === 1) {
			await env.DB.prepare(
				"UPDATE ai_provider_overrides SET disabled = 0 WHERE provider = 'google-vertex'",
			).run();
		}
		const reservation = await reserveSpend({
			...env,
			GOOGLE_DAILY_GEN_TOKENS: "10000000",
			GOOGLE_MONTHLY_COST_MICROS: "1000000000",
		}, {
			provider: "google-vertex",
			model: "gemini-2.5-flash",
			capability: "generate_structured",
			inputs: { messages: [{ role: "user", content: "sensitive" }], max_tokens: 20 },
			reservationId,
			now,
			lifecycle: {
				memoryUserId: target.id,
				accountUserId: target.id,
				acceptedAt: now,
				scope: "provider_test",
				scopeId: reservationId,
			},
		});
		expect((await markReservationInvoking(env, reservation, { now })).applied).toBe(true);
		if (Number(providerOverride?.disabled ?? 0) === 1) {
			await env.DB.prepare(
				"UPDATE ai_provider_overrides SET disabled = 1 WHERE provider = 'google-vertex'",
			).run();
		}

		await expect(deleteAccountCompletely(env, target.id)).rejects.toMatchObject({
			code: "provider_invocation_in_flight",
			retryable: true,
		});
		expect(await env.DB.prepare("SELECT text FROM source_episodes WHERE id = ?")
			.bind(episodeId).first()).toEqual({ text: "Account erasure must wait for the primary provider." });
		expect(await env.DB.prepare("SELECT user_id FROM account_erasure_tombstones WHERE user_id = ?")
			.bind(target.id).first()).toEqual({ user_id: target.id });

		await releaseReservation(env, reservation, now + 1);
		await expect(deleteAccountCompletely(env, target.id)).resolves.toMatchObject({ deleted: true });
		expect(await env.DB.prepare("SELECT id FROM source_episodes WHERE id = ?")
			.bind(episodeId).first()).toBeNull();
		expect(await env.DB.prepare(
			`SELECT memory_user_id, account_user_id, managed_project_id, accepted_at, scope_id
			   FROM ai_provider_reservations WHERE id = ?`,
		).bind(reservationId).first()).toEqual({
			memory_user_id: null,
			account_user_id: null,
			managed_project_id: null,
			accepted_at: null,
			scope_id: null,
		});
	});

	it("preserves the organization's memory while removing every departing account link and transcript", async () => {
		const owner = await user("foreign-owner");
		const target = await user("departing-member");
		const now = Date.now();
		const orgId = id("org");
		const projectId = id("proj");
		const memoryOwner = id("mem");
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO organizations
				 (id, owner_user_id, name, name_normalized, is_default, status, created_at, updated_at)
				 VALUES (?, ?, 'Foreign org', ?, 1, 'active', ?, ?)`,
			).bind(orgId, owner.id, `foreign-${orgId}`, now, now),
			env.DB.prepare(
				`INSERT INTO organization_members
				 (id, org_id, user_id, role, created_at, updated_at)
				 VALUES (?, ?, ?, 'owner', ?, ?)`,
			).bind(id("orgm"), orgId, owner.id, now, now),
			env.DB.prepare(
				`INSERT INTO organization_members
				 (id, org_id, user_id, role, invited_by_user_id, created_at, updated_at)
				 VALUES (?, ?, ?, 'member', ?, ?, ?)`,
			).bind(id("orgm"), orgId, target.id, owner.id, now, now),
			env.DB.prepare(
				`INSERT INTO managed_projects
				 (id, owner_user_id, memory_owner_user_id, name, name_normalized, is_default,
				  status, organization_id, created_at, updated_at)
				 VALUES (?, ?, ?, 'Shared project', ?, 0, 'active', ?, ?, ?)`,
			).bind(projectId, owner.id, memoryOwner, `shared-${projectId}`, orgId, now, now),
			env.DB.prepare(
				`INSERT INTO project_members
				 (id, project_id, org_id, user_id, role, invited_by_user_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, 'member', ?, ?, ?)`,
			).bind(id("prjm"), projectId, orgId, target.id, owner.id, now, now),
		]);

		const normalized = await normalizeSourcePacket(memoryOwner, {
			type: "message",
			sourceMode: "foreign_erasure_test",
			content: "The shared project preserves this permitted fact.",
			messageId: id("msg"),
			scope: {
				memoryUserId: memoryOwner,
				ownerUserId: memoryOwner,
				accountUserId: target.id,
				managedProjectId: projectId,
				externalUserId: target.id,
			},
		});
		const packet = await storeSourcePacket(env, normalized.packet);
		const scopeJson = JSON.stringify({
			account_user_id: target.id,
			managed_project_id: projectId,
			owner_user_id: memoryOwner,
		});
		const runId = await createExtractionRun(env, memoryOwner, {
			toolName: "foreign-erasure-test",
			sourceMode: "test",
			sourcePacketId: packet.id,
			scopeJson,
		});
		const missingShadowRunId = await createExtractionRun(env, memoryOwner, {
			toolName: "foreign-erasure-shadow-gap",
			sourceMode: "test",
			sourcePacketId: packet.id,
			scopeJson,
		});
		const pinJson = JSON.stringify({
			v: 1,
			routes: {},
			shadow: { provider: "google-vertex", model: "gemini-2.5-flash", sampled: true },
		});
		await env.DB.batch([
			env.DB.prepare(
				"UPDATE extraction_runs SET status = 'wrote', pin_json = ?, updated_at = ? WHERE id = ?",
			).bind(pinJson, now, runId),
			env.DB.prepare(
				"UPDATE extraction_runs SET status = 'wrote', pin_json = ?, updated_at = ? WHERE id = ?",
			).bind(pinJson, now, missingShadowRunId),
			env.DB.prepare(
				`INSERT INTO ai_shadow_jobs
				 (id, user_id, account_user_id, primary_run_id, provider, model, status,
				  attempts, claim_token, lease_until, created_at, updated_at)
				 VALUES (?, ?, ?, ?, 'google-vertex', 'gemini-2.5-flash', 'running',
				  1, 'departing-claim', ?, ?, ?)`,
			).bind(await shadowJobId(runId), memoryOwner, target.id, runId, now + 60_000, now, now),
		]);
		const receiptId = id("receipt");
		await storeReceipt(env, memoryOwner, "test", {
			id: receiptId,
			outcome: "wrote",
			extraction_run_id: runId,
			source_packet_id: packet.id,
			scope_json: scopeJson,
		}, "Shared content saved.", { strict: true });

		const episodeId = id("episode");
		const atomId = id("atom");
		const threadId = id("pgthread");
		const messageId = id("pgmsg");
		const aiCallId = id("aicall");
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO source_episodes
				 (id, user_id, memory_user_id, owner_user_id, external_user_id, project_id,
				  source_packet_id, message_id, message_index, role, text, text_hash, observed_at, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'user', 'Shared permitted episode', ?, ?, ?)`,
			).bind(
				episodeId, memoryOwner, memoryOwner, memoryOwner, target.id, projectId,
				packet.id, id("msg"), "a".repeat(64), now, now,
			),
			env.DB.prepare(
				`INSERT INTO semantic_atom_candidates
				 (id, user_id, memory_user_id, owner_user_id, external_user_id, project_id,
				  capture_run_id, extraction_run_id, source_episode_id, source_packet_id, chunk_key,
				  source_message_id, start_code_point, end_code_point, evidence_quote, evidence_hash,
				  dedupe_key, atom_type, entity, entity_type, attribute, value, assertion, cardinality,
				  confidence, observed_at, extraction_model, schema_version, status, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'chunk', ?, 0, 10,
				  'Shared evidence', ?, ?, 'fact', 'Project', 'project', 'state', 'active',
				  'The shared project is active', 'single', 0.9, ?, 'test-model', 'v1', 'candidate', ?)`,
			).bind(
				atomId, memoryOwner, memoryOwner, memoryOwner, target.id, projectId,
				id("capture"), runId, episodeId, packet.id, id("msg"), "b".repeat(64), id("dedupe"), now, now,
			),
			env.DB.prepare(
				`INSERT INTO playground_threads
				 (id, user_id, account_user_id, managed_project_id, title, created_at, updated_at)
				 VALUES (?, ?, ?, ?, 'Private member transcript', ?, ?)`,
			).bind(threadId, memoryOwner, target.id, projectId, now, now),
			env.DB.prepare(
				`INSERT INTO playground_messages
				 (id, thread_id, user_id, account_user_id, managed_project_id, role, content, created_at)
				 VALUES (?, ?, ?, ?, ?, 'user', 'Member-only transcript canary', ?)`,
			).bind(messageId, threadId, memoryOwner, target.id, projectId, now),
			env.DB.prepare(
				`INSERT INTO ai_calls
				 (id, user_id, scope, scope_id, model, task, input_tokens, output_tokens,
				  total_tokens, neurons, duration_ms, ok, created_at, account_user_id,
				  managed_project_id, provider)
				 VALUES (?, ?, 'save', ?, '@cf/test-model', 'extract', 123, 45,
				  168, 9, 77, 1, ?, ?, ?, 'workers-ai')`,
			).bind(aiCallId, memoryOwner, runId, now, target.id, projectId),
		]);

		expect((await deleteAccountCompletely(env, target.id)).deleted).toBe(true);

		// Both the already-enqueued row and the sampled run whose enqueue was
		// missing are terminally reserved in the account-quiesce transaction.
		// Reconciliation after provenance anonymization cannot resurrect either.
		for (const primaryRunId of [runId, missingShadowRunId]) {
			const shadow = await env.DB.prepare(
				`SELECT status, account_user_id, claim_token, lease_until, terminal_at
				   FROM ai_shadow_jobs WHERE primary_run_id = ?`,
			).bind(primaryRunId).first();
			expect(shadow).toMatchObject({
				status: "cancelled_erased",
				account_user_id: null,
				claim_token: null,
				lease_until: null,
			});
			expect(Number(shadow.terminal_at)).toBeGreaterThan(0);
		}
		await reconcileShadowJobs(env, { limit: 25, now: now + 1 });
		expect(await env.DB.prepare(
			`SELECT COUNT(*) AS n FROM ai_shadow_jobs
			  WHERE primary_run_id IN (?, ?) AND status IN ('pending', 'running')`,
		).bind(runId, missingShadowRunId).first()).toEqual({ n: 0 });

		const survivingPacket = await env.DB.prepare(
			"SELECT external_user_id, raw_meta_json, content_preview FROM source_packets WHERE id = ?",
		).bind(packet.id).first();
		expect(survivingPacket).not.toBeNull();
		expect(survivingPacket.external_user_id).toBeNull();
		expect(JSON.stringify(JSON.parse(survivingPacket.raw_meta_json))).not.toContain(target.id);
		expect(survivingPacket.content_preview).toContain("shared project");
		expect(await env.DB.prepare(
			"SELECT text, external_user_id FROM source_episodes WHERE id = ?",
		).bind(episodeId).first()).toEqual({ text: "Shared permitted episode", external_user_id: null });
		expect(await env.DB.prepare(
			"SELECT assertion, external_user_id FROM semantic_atom_candidates WHERE id = ?",
		).bind(atomId).first()).toEqual({ assertion: "The shared project is active", external_user_id: null });
		for (const [table, rowId] of [
			["receipts", receiptId],
			["extraction_runs", runId],
			["extraction_runs", missingShadowRunId],
		]) {
			const row = await env.DB.prepare(`SELECT scope_json FROM ${table} WHERE id = ?`).bind(rowId).first();
			expect(row).not.toBeNull();
			expect(JSON.stringify(JSON.parse(row.scope_json))).not.toContain(target.id);
		}
		for (const [table, rowId] of [["playground_threads", threadId], ["playground_messages", messageId]]) {
			expect(await env.DB.prepare(`SELECT id FROM ${table} WHERE id = ?`).bind(rowId).first()).toBeNull();
		}
		const survivingUsage = await env.DB.prepare(
			`SELECT user_id, account_user_id, managed_project_id, input_tokens, output_tokens,
			        total_tokens, neurons, duration_ms, ok
			   FROM ai_calls WHERE id = ?`,
		).bind(aiCallId).first();
		expect(survivingUsage).toEqual({
			user_id: memoryOwner,
			account_user_id: null,
			managed_project_id: projectId,
			input_tokens: 123,
			output_tokens: 45,
			total_tokens: 168,
			neurons: 9,
			duration_ms: 77,
			ok: 1,
		});
		expect(JSON.stringify(survivingUsage)).not.toContain(target.id);
		expect(JSON.stringify(survivingUsage).toLowerCase()).not.toContain(target.email.toLowerCase());
		expect(await env.DB.prepare("SELECT id FROM managed_projects WHERE id = ?").bind(projectId).first())
			.toEqual({ id: projectId });
		expect(await env.DB.prepare("SELECT id FROM organizations WHERE id = ?").bind(orgId).first())
			.toEqual({ id: orgId });
		const canary = await env.DB.prepare(
			`SELECT
			 (SELECT COUNT(*) FROM source_packets WHERE external_user_id = ? OR raw_meta_json LIKE ?) +
			 (SELECT COUNT(*) FROM source_episodes WHERE external_user_id = ?) +
			 (SELECT COUNT(*) FROM semantic_atom_candidates WHERE external_user_id = ?) +
			 (SELECT COUNT(*) FROM receipts WHERE scope_json LIKE ?) +
			 (SELECT COUNT(*) FROM extraction_runs WHERE scope_json LIKE ?) +
			 (SELECT COUNT(*) FROM ai_shadow_jobs WHERE account_user_id = ?) +
			 (SELECT COUNT(*) FROM ai_calls WHERE account_user_id = ?) AS n`,
		).bind(
			target.id, `%${target.id}%`, target.id, target.id,
			`%${target.id}%`, `%${target.id}%`, target.id, target.id,
		).first();
		expect(Number(canary.n)).toBe(0);
	});
});
