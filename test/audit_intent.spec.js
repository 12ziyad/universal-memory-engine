import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
	AuditUnavailableError,
	auditInvariantStatement,
	auditRequestId,
	auditedMutationResult,
	beginAuditIntent,
	commitAuditedBatch,
	deriveRequestId,
	exportAuditCsv,
	finalizeAuditIntent,
	listAuditEvents,
	runAuditedMutation,
	withAuditRequestId,
	withResponseRequestId,
} from "../src/lib/audit.js";
import { newId } from "../src/lib/ids.js";
import { deleteAccountCompletely } from "../src/pipeline/cleanup.js";

beforeAll(async () => {
	// Kept compatible with the additive migration so this focused contract can
	// also run while migration 0040 is being assembled by another release lane.
	await env.DB.prepare("ALTER TABLE audit_events ADD COLUMN dedupe_key TEXT").run().catch(() => {});
	await env.DB.prepare(
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_request_dedupe
		   ON audit_events(COALESCE(actor_user_id, 'system'), request_id, dedupe_key)
		   WHERE request_id IS NOT NULL AND dedupe_key IS NOT NULL`,
	).run();
	await env.DB.prepare(
		`CREATE TABLE IF NOT EXISTS audit_event_completions (
			event_id TEXT PRIMARY KEY,
			org_id TEXT,
			project_id TEXT,
			target_type TEXT,
			target_id TEXT,
			outcome TEXT NOT NULL,
			reason TEXT,
			metadata_json TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`,
	).run();
});

function failingAuditEnv({ insert = false, finalize = false, completionInsert = false } = {}) {
	const DB = new Proxy(env.DB, {
		get(target, property) {
			if (property === "prepare") {
				return (sql) => {
					const normalized = String(sql).replace(/\s+/g, " ").trim().toLowerCase();
					if (insert && normalized.startsWith("insert into audit_events")) {
						throw new Error("injected audit intent failure");
					}
					if (finalize && normalized.startsWith("update audit_events")) {
						throw new Error("injected audit finalization failure");
					}
					if (completionInsert && normalized.startsWith("insert into audit_event_completions")) {
						throw new Error("injected audit completion insert failure");
					}
					return target.prepare(sql);
				};
			}
			const value = Reflect.get(target, property);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return { ...env, DB };
}

async function makeState() {
	const id = newId("audstate");
	await env.DB.prepare("CREATE TABLE IF NOT EXISTS audit_intent_test_state (id TEXT PRIMARY KEY, revision INTEGER NOT NULL)").run();
	await env.DB.prepare("INSERT INTO audit_intent_test_state (id, revision) VALUES (?, 0)").bind(id).run();
	return id;
}

describe("fail-closed audit intents", () => {
	it("does not start a mutation when the intent insert fails, then records one retry transition", async () => {
		const stateId = await makeState();
		const projectId = newId("proj");
		const actorUserId = newId("usr");
		const requestId = crypto.randomUUID();
		const details = {
			projectId,
			actorUserId,
			guardActorUserId: null,
			guardProjectId: null,
			action: "project.test.updated",
			targetType: "project",
			targetId: projectId,
			requestId,
		};
		const mutate = async () => {
			throw new Error("mutate must receive its audit intent");
		};

		await expect(runAuditedMutation(failingAuditEnv({ insert: true }), details, mutate))
			.rejects.toBeInstanceOf(AuditUnavailableError);
		expect(await env.DB.prepare("SELECT revision FROM audit_intent_test_state WHERE id = ?").bind(stateId).first())
			.toEqual({ revision: 0 });

		await runAuditedMutation(env, details, async (intent) => {
			await commitAuditedBatch(env, intent, [
				env.DB.prepare("UPDATE audit_intent_test_state SET revision = revision + 1 WHERE id = ?").bind(stateId),
			]);
			return auditedMutationResult({ changed: true }, intent);
		}, () => ({
			metadata: { status: { from: "draft", to: "active" } },
		}));
		expect(await env.DB.prepare("SELECT revision FROM audit_intent_test_state WHERE id = ?").bind(stateId).first())
			.toEqual({ revision: 1 });
		const events = await listAuditEvents(env, { projectId });
		expect(events.events).toHaveLength(1);
		expect(events.events[0]).toMatchObject({
			action: "project.test.updated",
			outcome: "ok",
			request_id: requestId,
		});
	});

	it("rolls back state when the exact pending intent marker is missing or replayed", async () => {
		const stateId = await makeState();
		const intent = await beginAuditIntent(env, {
			projectId: newId("proj"),
			guardProjectId: null,
			action: "project.test.updated",
			targetType: "project",
			requestId: crypto.randomUUID(),
		});
		await finalizeAuditIntent(env, intent, { outcome: "failed", reason: "precondition_failed" });
		await expect(commitAuditedBatch(env, intent, [
			env.DB.prepare("UPDATE audit_intent_test_state SET revision = revision + 1 WHERE id = ?").bind(stateId),
		])).rejects.toThrow(/fence_guard|violation IS NULL/i);
		expect(await env.DB.prepare("SELECT revision FROM audit_intent_test_state WHERE id = ?").bind(stateId).first())
			.toEqual({ revision: 0 });
	});

	it("aborts a zero-row CAS instead of falsely committing audit success", async () => {
		const stateId = await makeState();
		const projectId = newId("proj");
		const intent = await beginAuditIntent(env, {
			projectId,
			guardProjectId: null,
			action: "project.test.updated",
			targetType: "project",
			targetId: projectId,
			requestId: crypto.randomUUID(),
		});
		await expect(commitAuditedBatch(env, intent, [
			env.DB.prepare(
				"UPDATE audit_intent_test_state SET revision = 1 WHERE id = ? AND revision = 99",
			).bind(stateId),
		], {
			postconditions: [auditInvariantStatement(
				env,
				"SELECT 1 FROM audit_intent_test_state WHERE id = ? AND revision = 1",
				[stateId],
			)],
		})).rejects.toThrow(/fence_guard|violation IS NULL/i);
		expect(await env.DB.prepare("SELECT revision FROM audit_intent_test_state WHERE id = ?").bind(stateId).first())
			.toEqual({ revision: 0 });
		await finalizeAuditIntent(env, intent, { outcome: "conflict", reason: "settings_conflict" });
		expect((await listAuditEvents(env, { projectId })).events[0]).toMatchObject({
			outcome: "conflict",
			reason: "settings_conflict",
		});
	});

	it("rejects an in-flight mutation when its actor loses authorization after the initial check", async () => {
		const stateId = await makeState();
		const actorUserId = newId("usr");
		const orgId = newId("org");
		const at = Date.now();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO users (id, email, name, role, status, created_at, updated_at) VALUES (?, ?, 'Actor', 'user', 'active', ?, ?)",
			).bind(actorUserId, `${actorUserId}@example.com`, at, at),
			env.DB.prepare(
				`INSERT INTO organizations
				 (id, owner_user_id, name, name_normalized, is_default, status, created_at, updated_at)
				 VALUES (?, ?, 'Audit guard', ?, 0, 'active', ?, ?)`,
			).bind(orgId, newId("usr"), orgId, at, at),
			env.DB.prepare(
				`INSERT INTO organization_members
				 (id, org_id, user_id, role, created_at, updated_at)
				 VALUES (?, ?, ?, 'admin', ?, ?)`,
			).bind(newId("orgm"), orgId, actorUserId, at, at),
		]);
		const intent = await beginAuditIntent(env, {
			orgId,
			actorUserId,
			action: "organization.test.updated",
			targetType: "organization",
			targetId: orgId,
			requestId: crypto.randomUUID(),
			authorizationGuards: [auditInvariantStatement(
				env,
				`SELECT 1 FROM organization_members
				  WHERE org_id = ? AND user_id = ? AND role IN ('owner', 'admin')
				    AND (access_starts_at IS NULL OR access_starts_at <= ?)
				    AND (access_expires_at IS NULL OR access_expires_at > ?)`,
				[orgId, actorUserId, at, at],
			)],
		});
		// Deterministic pause after route authorization and durable intent.
		await env.DB.prepare(
			"UPDATE organization_members SET role = 'member', updated_at = ? WHERE org_id = ? AND user_id = ?",
		).bind(at + 1, orgId, actorUserId).run();
		await expect(commitAuditedBatch(env, intent, [
			env.DB.prepare("UPDATE audit_intent_test_state SET revision = 1 WHERE id = ?").bind(stateId),
		])).rejects.toThrow(/fence_guard|violation IS NULL/i);
		expect(await env.DB.prepare("SELECT revision FROM audit_intent_test_state WHERE id = ?").bind(stateId).first())
			.toEqual({ revision: 0 });
		await finalizeAuditIntent(env, intent, { outcome: "denied", reason: "authorization_changed" });
		expect((await listAuditEvents(env, { orgId })).events[0]).toMatchObject({
			outcome: "denied",
			reason: "authorization_changed",
		});
	});

	it("leaves one durable, visible pending event when finalization fails and finalizes idempotently", async () => {
		const projectId = newId("proj");
		const intent = await beginAuditIntent(env, {
			projectId,
			guardProjectId: null,
			action: "project.test.updated",
			targetType: "project",
			targetId: projectId,
			requestId: crypto.randomUUID(),
		});
		const failed = await finalizeAuditIntent(failingAuditEnv({ finalize: true }), intent, { outcome: "ok" });
		expect(failed).toEqual({ id: intent.id, pending: true });
		expect(await env.DB.prepare("SELECT outcome FROM audit_event_completions WHERE event_id = ?").bind(intent.id).first())
			.toEqual({ outcome: "ok" });
		expect((await listAuditEvents(env, { projectId })).events[0]).toMatchObject({
			id: intent.id,
			outcome: "pending",
			reason: "awaiting_completion",
		});
		await commitAuditedBatch(env, intent, []);
		expect(await finalizeAuditIntent(env, intent, { outcome: "ok" })).toEqual({ id: intent.id, pending: false });
		expect(await finalizeAuditIntent(env, intent, { outcome: "ok" })).toEqual({ id: intent.id, pending: false });
		expect((await listAuditEvents(env, { projectId })).events).toHaveLength(1);
		expect(await env.DB.prepare("SELECT 1 FROM audit_event_completions WHERE event_id = ?").bind(intent.id).first())
			.toBeNull();
	});

	it("keeps committed success truth when completion outbox insertion is unavailable", async () => {
		const projectId = newId("proj");
		const intent = await beginAuditIntent(env, {
			projectId,
			guardProjectId: null,
			action: "project.test.updated",
			targetType: "project",
			targetId: projectId,
			requestId: crypto.randomUUID(),
		});
		await commitAuditedBatch(env, intent, []);
		expect(await finalizeAuditIntent(failingAuditEnv({ completionInsert: true }), intent, { outcome: "ok" }))
			.toEqual({ id: intent.id, pending: true });
		expect((await listAuditEvents(env, { projectId })).events[0]).toMatchObject({
			id: intent.id,
			outcome: "committed",
			reason: "awaiting_details",
		});
	});

	it("records an honest partial failure when work fails after its atomic commit and allows a new-id retry", async () => {
		const stateId = await makeState();
		const projectId = newId("proj");
		const firstDetails = {
			projectId,
			guardProjectId: null,
			action: "admin.user.delete",
			targetType: "user",
			targetId: newId("usr"),
			requestId: crypto.randomUUID(),
		};
		await expect(runAuditedMutation(env, firstDetails, async (intent) => {
			await commitAuditedBatch(env, intent, [
				env.DB.prepare("UPDATE audit_intent_test_state SET revision = 1 WHERE id = ?").bind(stateId),
			], {
				postconditions: [auditInvariantStatement(
					env,
					"SELECT 1 FROM audit_intent_test_state WHERE id = ? AND revision = 1",
					[stateId],
				)],
			});
			throw Object.assign(new Error("injected post-quiesce storage failure"), { code: "storage_reset_failed" });
		})).rejects.toThrow("post-quiesce");
		expect(await env.DB.prepare("SELECT revision FROM audit_intent_test_state WHERE id = ?").bind(stateId).first())
			.toEqual({ revision: 1 });
		expect((await listAuditEvents(env, { projectId })).events[0]).toMatchObject({
			action: "admin.user.delete",
			outcome: "failed_partial",
			reason: "storage_reset_failed",
		});

		await runAuditedMutation(env, { ...firstDetails, requestId: crypto.randomUUID() }, async (intent) => {
			await commitAuditedBatch(env, intent, [
				env.DB.prepare("UPDATE audit_intent_test_state SET revision = 2 WHERE id = ? AND revision = 1").bind(stateId),
			], {
				postconditions: [auditInvariantStatement(
					env,
					"SELECT 1 FROM audit_intent_test_state WHERE id = ? AND revision = 2",
					[stateId],
				)],
			});
			return auditedMutationResult({ retried: true }, intent);
		});
		expect(await env.DB.prepare("SELECT revision FROM audit_intent_test_state WHERE id = ?").bind(stateId).first())
			.toEqual({ revision: 2 });
		expect((await listAuditEvents(env, { projectId })).events.map((event) => event.outcome).sort())
			.toEqual(["failed_partial", "ok"]);
	});

	it("marks an account erasure partial after a post-quiesce coordinator failure and completes on a new-id retry", async () => {
		const targetUserId = newId("usr");
		const at = Date.now();
		await env.DB.prepare(
			`INSERT INTO users
			 (id, email, email_normalized, name, role, status, created_at, updated_at)
			 VALUES (?, ?, ?, 'Partial erasure', 'user', 'active', ?, ?)`,
		).bind(targetUserId, `${targetUserId}@example.com`, `${targetUserId}@example.com`, at, at).run();
		const details = {
			actorType: "system",
			guardActorUserId: null,
			action: "admin.user.delete",
			targetType: "user",
			targetId: targetUserId,
			requestId: crypto.randomUUID(),
		};
		const failingEnv = {
			...env,
			USER_MEMORY: {
				idFromName: env.USER_MEMORY.idFromName.bind(env.USER_MEMORY),
				get: () => ({ resetAll: async () => { throw new Error("injected coordinator outage"); } }),
			},
		};
		await expect(runAuditedMutation(
			failingEnv,
			details,
			(intent) => deleteAccountCompletely(failingEnv, targetUserId, { auditIntent: intent }),
		)).rejects.toThrow("coordinator outage");
		expect(await env.DB.prepare("SELECT status FROM users WHERE id = ?").bind(targetUserId).first())
			.toEqual({ status: "disabled" });
		expect(await env.DB.prepare(
			"SELECT outcome FROM audit_events WHERE action = 'admin.user.delete' AND target_id = ?",
		).bind(targetUserId).first()).toEqual({ outcome: "failed_partial" });

		await runAuditedMutation(
			env,
			{ ...details, requestId: crypto.randomUUID() },
			(intent) => deleteAccountCompletely(env, targetUserId, { auditIntent: intent }),
		);
		expect(await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(targetUserId).first()).toBeNull();
		const events = await env.DB.prepare(
			"SELECT outcome FROM audit_events WHERE action = 'admin.user.delete' ORDER BY created_at DESC LIMIT 2",
		).all();
		expect(events.results.map((event) => event.outcome).sort()).toEqual(["failed_partial", "ok"]);
	});

	it("refuses a transport replay with the same actor, request id, action and target", async () => {
		const projectId = newId("proj");
		const actorUserId = newId("usr");
		const requestId = crypto.randomUUID();
		const details = {
			projectId,
			actorUserId,
			guardActorUserId: null,
			guardProjectId: null,
			action: "project.test.updated",
			targetType: "project",
			targetId: projectId,
			requestId,
		};
		const first = await beginAuditIntent(env, details);
		await expect(beginAuditIntent(env, details)).rejects.toMatchObject({
			code: "audit_request_replayed",
			eventId: first.id,
			outcome: "pending",
		});
		await commitAuditedBatch(env, first, []);
		await finalizeAuditIntent(env, first, { outcome: "ok" });
		await expect(beginAuditIntent(env, details)).rejects.toMatchObject({
			code: "audit_request_replayed",
			eventId: first.id,
			outcome: "ok",
		});
	});
});

describe("audit correlation and privacy", () => {
	it("accepts only standardized bounded ids, overrides the internal header, and echoes it", async () => {
		const clientId = crypto.randomUUID();
		const accepted = deriveRequestId(new Request("https://example.com", { headers: {
			"x-request-id": clientId,
			"cf-ray": "0123456789abcdef-IAD",
		} }));
		expect(accepted).toBe(clientId);

		const hostile = `sk-live-${"private".repeat(30)}`;
		const replaced = deriveRequestId(new Request("https://example.com", { headers: {
			"x-request-id": hostile,
			"x-itsuki-audit-request-id": hostile,
		} }));
		expect(replaced).toMatch(/^[0-9a-f-]{36}$/i);
		expect(replaced).not.toContain("private");

		const correlated = withAuditRequestId(new Request("https://example.com", {
			headers: { "x-itsuki-audit-request-id": hostile },
		}), replaced);
		expect(auditRequestId(correlated)).toBe(replaced);
		const response = withResponseRequestId(new Response("ok"), replaced);
		expect(response.headers.get("x-request-id")).toBe(replaced);
	});

	it("exposes correlation in list and CSV while persisting only allowlisted scalar metadata", async () => {
		const projectId = newId("proj");
		const requestId = crypto.randomUUID();
		const canary = "private salary token sk-live-never-store";
		const intent = await beginAuditIntent(env, {
			projectId,
			guardProjectId: null,
			action: "project.category.reassigned",
			targetType: "category",
			targetId: newId("cat"),
			requestId,
			metadata: {
				replacement_category_id: { from: "old", to: "new" },
				assignment_count: { from: 7, to: 0 },
				project_count: { from: 1, to: 2 },
				access_starts_at: { from: null, to: 1234 },
				access_expires_at: { from: null, to: 5678 },
				memory_text: canary,
				secret: canary,
			},
		});
		await commitAuditedBatch(env, intent, []);
		await finalizeAuditIntent(env, intent, {
			outcome: "ok",
			metadata: {
				retention_class: { from: null, to: "source_episodes" },
				retention_days: { from: null, to: 30 },
				policy_version: { from: 0, to: 1 },
				capture_enabled: { from: false, to: true },
				capture_state: { from: "off", to: "on" },
				request_body: canary,
			},
		});

		const page = await listAuditEvents(env, { projectId });
		expect(page.events[0].request_id).toBe(requestId);
		const serialized = JSON.stringify(page.events[0]);
		expect(serialized).not.toContain(canary);
		expect(page.events[0].metadata).toMatchObject({
			retention_class: { from: null, to: "source_episodes" },
			retention_days: { from: null, to: 30 },
			policy_version: { from: 0, to: 1 },
		});
		const exported = await exportAuditCsv(env, { projectId });
		expect(exported.csv.split("\r\n")[0]).toContain("request_id");
		expect(exported.csv).toContain(requestId);
		expect(exported.csv).not.toContain(canary);
		expect(await env.DB.prepare("SELECT metadata_json FROM audit_event_completions WHERE event_id = ?")
			.bind(intent.id).first()).toBeNull();
	});

	it("cannot retain or reintroduce an erased target account through dedupe or completion rows", async () => {
		const targetUserId = newId("usr");
		const foreignOwnerId = newId("usr");
		const orgId = newId("org");
		const at = Date.now();
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO users
				 (id, email, email_normalized, name, role, status, created_at, updated_at)
				 VALUES (?, ?, ?, 'Erasure target', 'user', 'active', ?, ?)`,
			).bind(targetUserId, `${targetUserId}@example.com`, `${targetUserId}@example.com`, at, at),
			env.DB.prepare(
				`INSERT INTO organizations
				 (id, owner_user_id, name, name_normalized, is_default, status, created_at, updated_at)
				 VALUES (?, ?, 'Foreign audit org', ?, 0, 'active', ?, ?)`,
			).bind(orgId, foreignOwnerId, orgId, at, at),
		]);
		const makeIntent = () => beginAuditIntent(env, {
			orgId,
			actorUserId: targetUserId,
			action: "organization.member.updated",
			targetType: "member",
			targetId: targetUserId,
			requestId: crypto.randomUUID(),
		});
		const pending = await makeIntent();
		await finalizeAuditIntent(failingAuditEnv({ finalize: true }), pending, {
			outcome: "failed",
			targetType: "member",
			targetId: targetUserId,
		});
		const committed = await makeIntent();
		await commitAuditedBatch(env, committed, []);
		await finalizeAuditIntent(failingAuditEnv({ finalize: true }), committed, {
			outcome: "ok",
			targetType: "member",
			targetId: targetUserId,
		});

		for (const eventId of [pending.id, committed.id]) {
			const event = await env.DB.prepare(
				"SELECT dedupe_key FROM audit_events WHERE id = ?",
			).bind(eventId).first();
			expect(event.dedupe_key).toMatch(/^[0-9a-f]{64}$/);
			expect(event.dedupe_key).not.toContain(targetUserId);
		}
		expect((await deleteAccountCompletely(env, targetUserId)).deleted).toBe(true);
		for (const eventId of [pending.id, committed.id]) {
			expect(await env.DB.prepare(
				"SELECT actor_user_id, target_id FROM audit_events WHERE id = ?",
			).bind(eventId).first()).toEqual({ actor_user_id: null, target_id: null });
			expect(await env.DB.prepare(
				"SELECT target_id FROM audit_event_completions WHERE event_id = ?",
			).bind(eventId).first()).toEqual({ target_id: null });
		}
	});
});
