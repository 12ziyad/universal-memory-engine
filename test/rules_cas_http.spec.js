/**
 * Rules are a privacy policy, so every public writer is compare-and-set. These
 * tests use two genuine sessions for one account and exercise both the absent
 * and present row generations through HTTP.
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src";

async function request(path, init = {}) {
	const req = new Request(`http://example.com${path}`, init);
	const ctx = createExecutionContext();
	const response = await worker.fetch(req, env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

function json(method, body, cookie, headers = {}) {
	return {
		method,
		headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers },
		body: JSON.stringify(body),
	};
}

function cookieFrom(response) {
	return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

async function twoSessions(label) {
	const email = `${label}-${crypto.randomUUID()}@example.com`;
	const password = "correct-horse";
	const signup = await request("/auth/signup", json("POST", {
		email, password, name: label, acceptTerms: true,
	}));
	expect(signup.status).toBe(201);
	const signupBody = await signup.json();
	const login = await request("/auth/login", json("POST", { email, password }));
	expect(login.status).toBe(200);
	const first = cookieFrom(signup);
	const second = cookieFrom(login);
	expect(first).toMatch(/^uml_session=/);
	expect(second).toMatch(/^uml_session=/);
	expect(second).not.toBe(first);
	return { userId: signupBody.user.id, first, second };
}

async function settings(cookie) {
	const response = await request("/v1/settings", { headers: { cookie } });
	expect(response.status).toBe(200);
	return response.json();
}

async function writeSettings(cookie, expectedVersion, rules) {
	return request("/v1/settings/rules", json("PUT", {
		rules,
		expected_version: expectedVersion,
	}, cookie));
}

function assertVersion(value) {
	expect(value).toMatch(/^rules_v1_[a-f0-9]{48}$/);
}

function winnerAndConflict(responses) {
	const statuses = responses.map((response) => response.status).sort((a, b) => a - b);
	expect(statuses).toEqual([200, 409]);
	return {
		winner: responses.find((response) => response.status === 200),
		conflict: responses.find((response) => response.status === 409),
	};
}

describe("memory rules HTTP compare-and-set", () => {
	it("requires a precondition on Settings plus both legacy writer verbs", async () => {
		const { first } = await twoSessions("rules-precondition");
		for (const [path, method] of [
			["/v1/settings/rules", "PUT"],
			["/v1/rules", "PUT"],
			["/v1/rules", "POST"],
		]) {
			const response = await request(path, json(method, { rules: { excludes: ["salary"] } }, first));
			expect(response.status, `${method} ${path}`).toBe(428);
			expect(await response.json()).toMatchObject({ error: "precondition_required" });
		}
	});

	it("lets exactly one independent session create the first row", async () => {
		const { userId, first, second } = await twoSessions("rules-first-race");
		await env.DB.prepare("DELETE FROM memory_rules WHERE user_id = ?").bind(userId).run();
		const [leftRead, rightRead] = await Promise.all([settings(first), settings(second)]);
		assertVersion(leftRead.rules_version);
		expect(rightRead.rules_version).toBe(leftRead.rules_version);

		const responses = await Promise.all([
			writeSettings(first, leftRead.rules_version, {
				includes: ["deploy"], excludes: ["salary"], customInstructions: "Never save salary.",
			}),
			writeSettings(second, rightRead.rules_version, {
				includes: ["architecture"], excludes: ["password"], customInstructions: "Never save passwords.",
			}),
		]);
		const { winner, conflict } = winnerAndConflict(responses);
		const winnerBody = await winner.json();
		const conflictBody = await conflict.json();
		assertVersion(winnerBody.rules_version);
		expect(winnerBody.rules_version).not.toBe(leftRead.rules_version);
		expect(conflictBody).toMatchObject({
			error: "settings_conflict",
			rules: winnerBody.rules,
			rules_version: winnerBody.rules_version,
		});

		const final = await settings(first);
		expect(final.rules).toEqual(winnerBody.rules);
		expect(final.rules.excludes).toHaveLength(1);
		expect(final.rules_version).toBe(winnerBody.rules_version);
		const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM memory_rules WHERE user_id = ?")
			.bind(userId).first();
		expect(Number(count?.n ?? 0)).toBe(1);
	});

	it("lets exactly one session update an existing row and rejects a stale retry", async () => {
		const { first, second } = await twoSessions("rules-update-race");
		const initial = await settings(first);
		const seeded = await writeSettings(first, initial.rules_version, { excludes: ["baseline"] });
		expect(seeded.status).toBe(200);

		const [leftRead, rightRead] = await Promise.all([settings(first), settings(second)]);
		expect(rightRead.rules_version).toBe(leftRead.rules_version);
		const responses = await Promise.all([
			writeSettings(first, leftRead.rules_version, { excludes: ["salary"] }),
			writeSettings(second, rightRead.rules_version, { excludes: ["health"] }),
		]);
		const { winner, conflict } = winnerAndConflict(responses);
		const winnerBody = await winner.json();
		expect((await conflict.json()).rules_version).toBe(winnerBody.rules_version);
		const final = await settings(first);
		expect(final.rules.excludes).toEqual(winnerBody.rules.excludes);
		expect(final.rules.excludes).toHaveLength(1);

		const staleRetry = await writeSettings(second, rightRead.rules_version, winnerBody.rules);
		expect(staleRetry.status).toBe(409);
		expect(await staleRetry.json()).toMatchObject({
			error: "settings_conflict",
			rules_version: winnerBody.rules_version,
		});

		const noOp = await writeSettings(first, winnerBody.rules_version, winnerBody.rules);
		expect(noOp.status).toBe(200);
		const noOpBody = await noOp.json();
		expect(noOpBody.changed).toBe(false);
		expect(noOpBody.rules_version).not.toBe(winnerBody.rules_version);
		expect(noOpBody.rules_metadata).toMatchObject({
			version: noOpBody.rules_version,
			updated_by: expect.objectContaining({ id: expect.stringMatching(/^user_/) }),
		});
		expect(Number(noOpBody.rules_metadata.updated_at)).toBeGreaterThan(0);
	});

	it("cannot overwrite a direct legacy writer from a stale Settings tab", async () => {
		const { userId, first, second } = await twoSessions("rules-alternate-writer");
		const staleSettings = await settings(first);
		const legacyRead = await request("/v1/rules", { headers: { cookie: second } });
		const legacyState = await legacyRead.json();
		expect(legacyState.rules_version).toBe(staleSettings.rules_version);

		const direct = await request("/v1/rules", json("PUT", {
			expected_version: legacyState.rules_version,
			rules: { excludes: ["private-marker"] },
		}, second));
		expect(direct.status).toBe(200);
		const directBody = await direct.json();

		const stale = await writeSettings(first, staleSettings.rules_version, { excludes: [] });
		expect(stale.status).toBe(409);
		expect(await stale.json()).toMatchObject({
			error: "settings_conflict",
			rules: { excludes: ["private-marker"] },
			rules_version: directBody.rules_version,
		});
		const final = await settings(first);
		expect(final.rules.excludes).toEqual(["private-marker"]);
		expect(final.rules_metadata).toMatchObject({
			version: directBody.rules_version,
			updated_by: { id: userId },
		});
		expect(Number(final.rules_metadata.updated_at)).toBeGreaterThan(0);
		const directAudit = await env.DB.prepare(
			`SELECT metadata_json FROM audit_events
			  WHERE project_id = ? AND action = 'project.rules.updated' AND outcome IN ('ok', 'committed')
			  ORDER BY created_at DESC LIMIT 1`,
		).bind(final.project.id).first();
		expect(directAudit).not.toBeNull();
		expect(directAudit.metadata_json).not.toContain("private-marker");
		expect(JSON.parse(directAudit.metadata_json)).toMatchObject({
			excludes_count: { to: 1 },
		});
	});

	it("accepts raw If-Match and rejects contradictory body/header tokens", async () => {
		const { first } = await twoSessions("rules-if-match");
		const current = await settings(first);
		const saved = await request("/v1/settings/rules", json("PUT", {
			rules: { excludes: ["salary"] },
		}, first, { "If-Match": current.rules_version }));
		expect(saved.status).toBe(200);
		const savedBody = await saved.json();

		const contradictory = await request("/v1/settings/rules", json("PUT", {
			expected_version: current.rules_version,
			rules: { excludes: [] },
		}, first, { "If-Match": savedBody.rules_version }));
		expect(contradictory.status).toBe(400);
		expect(await contradictory.json()).toMatchObject({ error: "invalid_precondition" });
	});
});
