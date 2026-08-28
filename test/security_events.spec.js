/* Security events (0062): storm suppression, severity escalation, the
 * details allowlist, and the owner-alert drain with both suppression valves.
 *
 * The contract under test: an emit NEVER throws into its caller; identical
 * (group, 10-minute bucket) pairs collapse into ONE row whose count carries
 * the volume; volume escalates severity (>=10 → +1, >=100 → +2, capped);
 * details are structurally incapable of carrying memory text or secrets; and
 * email defers rather than drops when the valves close.
 */
import { env } from "cloudflare:test";
import { describe, it, expect, vi } from "vitest";
import {
	recordSecurityEvent,
	processSecurityEventNotifications,
	listSecurityEvents,
	SECURITY_EVENT_FIELDS,
	BUCKET_MS,
} from "../src/lib/security_events.js";

const T0 = Date.parse("2026-08-29T10:00:00Z");

function freshGroup(prefix = "grp") {
	return `${prefix}:${crypto.randomUUID()}`;
}

async function rowFor(groupKey) {
	return env.DB.prepare("SELECT * FROM security_events WHERE group_key = ? ORDER BY bucket_at").bind(groupKey).first();
}

describe("recordSecurityEvent", () => {
	it("stores one row with the emitted severity and a pending outbox only for high", async () => {
		const high = freshGroup("high");
		await recordSecurityEvent(env, { kind: "test_high", severity: "high", groupKey: high, now: T0 });
		const row = await rowFor(high);
		expect(row.severity).toBe("high");
		expect(row.severity_rank).toBe(2);
		expect(row.count).toBe(1);
		expect(row.notify_status).toBe("pending");

		const medium = freshGroup("med");
		await recordSecurityEvent(env, { kind: "test_medium", severity: "medium", groupKey: medium, now: T0 });
		expect((await rowFor(medium)).notify_status).toBe("skipped");
	});

	it("collapses a storm into one row and escalates severity with volume", async () => {
		const group = freshGroup("storm");
		for (let i = 0; i < 12; i++) {
			await recordSecurityEvent(env, { kind: "test_storm", severity: "medium", groupKey: group, now: T0 + i });
		}
		const { results } = await env.DB.prepare(
			"SELECT * FROM security_events WHERE group_key = ?",
		).bind(group).all();
		expect(results).toHaveLength(1);
		const row = results[0];
		expect(row.count).toBe(12);
		// medium (1) + storm bonus (+1 at >=10) = high (2), and crossing into
		// high flips the outbox from skipped to pending.
		expect(row.base_severity_rank).toBe(1);
		expect(row.severity_rank).toBe(2);
		expect(row.severity).toBe("high");
		expect(row.notify_status).toBe("pending");
	});

	it("keeps the strongest emitted severity and starts a new row per bucket", async () => {
		const group = freshGroup("mixed");
		await recordSecurityEvent(env, { kind: "test_mixed", severity: "low", groupKey: group, now: T0 });
		await recordSecurityEvent(env, { kind: "test_mixed", severity: "critical", groupKey: group, now: T0 + 1 });
		await recordSecurityEvent(env, { kind: "test_mixed", severity: "low", groupKey: group, now: T0 + 2 });
		const first = await rowFor(group);
		expect(first.severity).toBe("critical");
		expect(first.count).toBe(3);

		await recordSecurityEvent(env, { kind: "test_mixed", severity: "low", groupKey: group, now: T0 + BUCKET_MS });
		const { results } = await env.DB.prepare(
			"SELECT severity, count FROM security_events WHERE group_key = ? ORDER BY bucket_at",
		).bind(group).all();
		expect(results).toHaveLength(2);
		expect(results[1].severity).toBe("low");
	});

	it("drops unknown detail keys and bounds values — the allowlist is structural", async () => {
		const group = freshGroup("details");
		await recordSecurityEvent(env, {
			kind: "test_details", severity: "low", groupKey: group, now: T0,
			details: {
				count: 3,
				memory_user_id: "mem_abc",
				message: "the user's memory text must never land here",
				password: "hunter2",
				code: "x".repeat(500),
			},
		});
		const details = JSON.parse((await rowFor(group)).details_json);
		expect(details).toEqual({ count: 3, memory_user_id: "mem_abc", code: "x".repeat(120) });
		expect(SECURITY_EVENT_FIELDS.has("message")).toBe(false);
		expect(SECURITY_EVENT_FIELDS.has("password")).toBe(false);
	});

	it("never throws into the caller, even with a broken database", async () => {
		const broken = { DB: { prepare: () => { throw new Error("d1 down"); } } };
		await expect(recordSecurityEvent(broken, { kind: "x", severity: "high", groupKey: freshGroup() }))
			.resolves.toBeNull();
	});
});

describe("the owner-alert drain", () => {
	it("marks rows skipped rather than queueing forever when email is unconfigured", async () => {
		const group = freshGroup("noemail");
		await recordSecurityEvent(env, { kind: "test_noemail", severity: "high", groupKey: group, now: T0 });
		const bare = { ...env };
		delete bare.EMAIL;
		delete bare.OWNER_NOTIFY_EMAIL;
		const result = await processSecurityEventNotifications(bare, { now: T0 + 1000 });
		expect(result.skipped).toBeGreaterThanOrEqual(1);
		expect((await rowFor(group)).notify_status).toBe("skipped");
	});

	it("emails a pending high exactly once and stamps notified_at", async () => {
		const group = freshGroup("send");
		await recordSecurityEvent(env, { kind: "test_send", severity: "critical", groupKey: group, now: T0 });
		const send = vi.fn(async () => ({ messageId: "msg_sec_1" }));
		const mailEnv = { ...env, EMAIL: { send }, OWNER_NOTIFY_EMAIL: "owner@example.com" };
		const first = await processSecurityEventNotifications(mailEnv, { now: T0 + 1000, limit: 50 });
		expect(first.sent).toBeGreaterThanOrEqual(1);
		const ours = send.mock.calls.filter(([message]) => message.subject.includes("test_send"));
		expect(ours).toHaveLength(1);
		expect(ours[0][0].to).toBe("owner@example.com");
		const row = await rowFor(group);
		expect(row.notify_status).toBe("sent");
		expect(row.notified_at).toBeTruthy();

		send.mockClear();
		await processSecurityEventNotifications(mailEnv, { now: T0 + 2000, limit: 50 });
		expect(send.mock.calls.filter(([message]) => message.subject.includes("test_send"))).toHaveLength(0);
	});

	it("defers, never drops, on the one-email-per-group-per-hour valve", async () => {
		const group = freshGroup("cooldown");
		await recordSecurityEvent(env, { kind: "test_cooldown", severity: "high", groupKey: group, now: T0 });
		await recordSecurityEvent(env, { kind: "test_cooldown", severity: "high", groupKey: group, now: T0 + BUCKET_MS });
		const send = vi.fn(async () => ({ messageId: "msg_sec_2" }));
		const mailEnv = { ...env, EMAIL: { send }, OWNER_NOTIFY_EMAIL: "owner@example.com" };
		const result = await processSecurityEventNotifications(mailEnv, { now: T0 + BUCKET_MS + 1000, limit: 50 });
		expect(result.sent).toBeGreaterThanOrEqual(1);
		expect(result.deferred).toBeGreaterThanOrEqual(1);
		const { results } = await env.DB.prepare(
			"SELECT notify_status FROM security_events WHERE group_key = ? ORDER BY bucket_at",
		).bind(group).all();
		expect(results.map((r) => r.notify_status).sort()).toEqual(["pending", "sent"]);
	});

	it("defers everything past the global 10-emails-per-hour cap", async () => {
		// Seed ten already-notified rows inside the trailing hour.
		const now = T0 + 10 * BUCKET_MS;
		for (let i = 0; i < 10; i++) {
			const group = freshGroup("cap-seed");
			await recordSecurityEvent(env, { kind: "test_cap_seed", severity: "high", groupKey: group, now: now - 1000 - i });
			await env.DB.prepare(
				"UPDATE security_events SET notify_status = 'sent', notified_at = ? WHERE group_key = ?",
			).bind(now - 1000 - i, group).run();
		}
		const group = freshGroup("capped");
		await recordSecurityEvent(env, { kind: "test_capped", severity: "critical", groupKey: group, now });
		const send = vi.fn(async () => ({ messageId: "msg_sec_3" }));
		const mailEnv = { ...env, EMAIL: { send }, OWNER_NOTIFY_EMAIL: "owner@example.com" };
		const result = await processSecurityEventNotifications(mailEnv, { now: now + 1000, limit: 50 });
		expect(result.deferred).toBeGreaterThanOrEqual(1);
		const row = await rowFor(group);
		expect(row.notify_status).toBe("pending");
		expect(row.notify_after).toBeGreaterThan(now);
		expect(send.mock.calls.filter(([message]) => message.subject.includes("test_capped"))).toHaveLength(0);
	});
});

describe("vector drop classification", () => {
	it("splits routine deleted-vector residue (low, quiet) from foreign hits (medium)", async () => {
		const { queryNodeVectors } = await import("../src/lib/vectorize.js");
		const userId = `mem_${crypto.randomUUID()}`;
		const deletedId = `node_${crypto.randomUUID()}`;
		const liveId = `node_${crypto.randomUUID()}`;
		const foreignId = `node_${crypto.randomUUID()}`;
		await env.DB.prepare(
			"INSERT INTO nodes (id, user_id, label, created_at, updated_at, deleted_at, revision) VALUES (?, ?, 'gone', 1, 1, 2, 1), (?, ?, 'alive', 1, 1, NULL, 1)",
		).bind(deletedId, userId, liveId, userId).run();
		const vecEnv = {
			...env,
			VECTORIZE: {
				query: async () => ({ matches: [
					{ id: `${deletedId}#r1`, score: 0.9 },
					{ id: `${liveId}#r1`, score: 0.8 },
					{ id: `${foreignId}#r1`, score: 0.7 },
				] }),
			},
		};
		const results = await queryNodeVectors(vecEnv, { useVectors: true, shortlistSize: 10 }, { userId, values: [0.1], topK: 5 });
		expect(results.map((r) => r.id)).toEqual([liveId]);

		const residue = await rowFor(`vector_deleted_residue:${userId}`);
		expect(residue.severity).toBe("low");
		expect(residue.notify_status).toBe("skipped");
		expect(JSON.parse(residue.details_json).dropped).toBe(1);

		const foreign = await rowFor(`vector_scope_drop:${userId}`);
		expect(foreign.severity).toBe("medium");
		expect(JSON.parse(foreign.details_json).dropped).toBe(1);
	});
});

describe("listSecurityEvents", () => {
	it("returns parsed details, newest activity first", async () => {
		const group = freshGroup("list");
		await recordSecurityEvent(env, {
			kind: "test_list", severity: "low", groupKey: group,
			details: { count: 7 }, now: Date.now(),
		});
		const events = await listSecurityEvents(env, { limit: 200 });
		const mine = events.find((event) => event.group_key === group);
		expect(mine.details).toEqual({ count: 7 });
		expect(mine.details_json).toBeUndefined();
	});
});
