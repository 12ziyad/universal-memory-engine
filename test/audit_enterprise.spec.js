import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { exportAuditCsv, listAuditEvents, writeAudit } from "../src/lib/audit.js";

describe("enterprise audit history", () => {
	const orgId = `org_audit_${crypto.randomUUID()}`;
	const projectId = `proj_audit_${crypto.randomUUID()}`;

	beforeEach(async () => {
		await env.DB.prepare("DELETE FROM audit_events WHERE project_id = ?").bind(projectId).run();
	});

	it("uses a stable tuple cursor and never drops events sharing one millisecond", async () => {
		const at = Date.now();
		const statements = [];
		for (let i = 0; i < 7; i++) {
			statements.push(env.DB.prepare(
				`INSERT INTO audit_events
				 (id, org_id, project_id, actor_user_id, actor_type, action, target_type, target_id,
				  outcome, reason, metadata_json, request_id, created_at)
				 VALUES (?, ?, ?, ?, 'user', ?, 'member', ?, 'ok', NULL, NULL, NULL, ?)`,
			).bind(`aud_same_${i}`, orgId, projectId, `usr_${i}`, i % 2 ? "member.role_changed" : "member.removed", `member_${i}`, at));
		}
		await env.DB.batch(statements);

		const ids = [];
		let cursor = null;
		do {
			const page = await listAuditEvents(env, { projectId, limit: 2, cursor });
			ids.push(...page.events.map((event) => event.id));
			cursor = page.next_cursor;
		} while (cursor);
		expect(ids).toHaveLength(7);
		expect(new Set(ids).size).toBe(7);
		expect(ids).toEqual([...ids].sort().reverse());
	});

	it("filters by action and bounded time without crossing project scope", async () => {
		const now = Date.now();
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO audit_events
				 (id, org_id, project_id, actor_type, action, outcome, created_at)
				 VALUES ('aud_filter_old', ?, ?, 'system', 'key.created', 'ok', ?)`,
			).bind(orgId, projectId, now - 10_000),
			env.DB.prepare(
				`INSERT INTO audit_events
				 (id, org_id, project_id, actor_type, action, outcome, created_at)
				 VALUES ('aud_filter_new', ?, ?, 'system', 'key.created', 'ok', ?)`,
			).bind(orgId, projectId, now),
			env.DB.prepare(
				`INSERT INTO audit_events
				 (id, org_id, project_id, actor_type, action, outcome, created_at)
				 VALUES ('aud_filter_other', ?, ?, 'system', 'webhook.created', 'ok', ?)`,
			).bind(orgId, projectId, now),
			env.DB.prepare(
				`INSERT INTO audit_events
				 (id, org_id, project_id, actor_type, action, outcome, created_at)
				 VALUES ('aud_foreign', 'org_foreign', 'project_foreign', 'system', 'key.created', 'ok', ?)`,
			).bind(now),
		]);
		const result = await listAuditEvents(env, {
			projectId,
			action: "key.created",
			from: now - 1_000,
			to: now + 1_000,
		});
		expect(result.events.map((event) => event.id)).toEqual(["aud_filter_new"]);
	});

	it("exports only allowlisted content and neutralizes spreadsheet formulas", async () => {
		await writeAudit(env, {
			orgId,
			projectId,
			actorUserId: "=2+5",
			action: "project.updated",
			targetType: "project",
			targetId: "+SUM(A1:A2)",
			metadata: {
				name_changed: { from: false, to: true },
				memory_text: "salary 90000",
				secret: "sk_live_unsafe",
			},
		});
		const result = await exportAuditCsv(env, { projectId });
		expect(result.count).toBe(1);
		expect(result.truncated).toBe(false);
		expect(result.csv).toContain("'=2+5");
		expect(result.csv).toContain("'+SUM(A1:A2)");
		expect(result.csv).toContain("name_changed");
		expect(result.csv).not.toContain("salary 90000");
		expect(result.csv).not.toContain("sk_live_unsafe");
	});
});
