import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
	createConnectionToken,
	deleteConnectionToken,
	listConnectionTokens,
	MAX_ACTIVE_CONNECTION_TOKENS_PER_PROJECT,
	MAX_CONNECTION_TOKEN_HISTORY_PER_PROJECT,
	revokeConnectionToken,
} from "../src/auth.js";
import { newId } from "../src/lib/ids.js";

async function insertToken({
	id = newId("tok"), userId, projectId = null, label = "Key", at = Date.now(), revoked = false,
}) {
	await env.DB.prepare(
		`INSERT INTO connection_tokens
		 (id, user_id, project_id, label, token_hash, token_prefix, token_tail, type,
		  created_at, scopes_json, status, revoked_at)
		 VALUES (?, ?, ?, ?, ?, 'itsuki_live_test', 'test', 'api', ?, '[]', ?, ?)`,
	).bind(id, userId, projectId, label, `hash_${crypto.randomUUID()}`, at,
		revoked ? "revoked" : "active", revoked ? at : null).run();
	return id;
}

describe("enterprise project credentials", () => {
	it("lists and manages project keys across creators while containing historical unscoped keys", async () => {
		const projectId = newId("proj");
		const creatorA = newId("usr");
		const creatorB = newId("usr");
		const projectKeyA = await insertToken({ userId: creatorA, projectId, label: "A project" });
		const projectKeyB = await insertToken({ userId: creatorB, projectId, label: "B project" });
		const legacyA = await insertToken({ userId: creatorA, label: "A legacy" });
		const legacyB = await insertToken({ userId: creatorB, label: "B legacy" });

		const visible = await listConnectionTokens(env, creatorA, { projectId, isDefault: true });
		expect(visible.map((row) => row.id)).toEqual(expect.arrayContaining([projectKeyA, projectKeyB, legacyA]));
		expect(visible.map((row) => row.id)).not.toContain(legacyB);
		expect(visible.find((row) => row.id === projectKeyB).owner).toEqual({
			user_id: creatorB,
			name: null,
			email: null,
		});

		expect(await revokeConnectionToken(env, creatorA, projectKeyB, { projectId, isDefault: true }))
			.toEqual({ revoked: true });
		expect(await deleteConnectionToken(env, creatorA, projectKeyB, { projectId, isDefault: true }))
			.toEqual({ deleted: true });
		expect(await deleteConnectionToken(env, creatorA, legacyB, { projectId, isDefault: true }))
			.toEqual({ deleted: false });
	});

	it("enforces the 50-active-key project boundary atomically", async () => {
		const projectId = newId("proj");
		const creatorA = newId("usr");
		const creatorB = newId("usr");
		for (let index = 0; index < MAX_ACTIVE_CONNECTION_TOKENS_PER_PROJECT - 1; index += 1) {
			await insertToken({ userId: creatorA, projectId, label: `Existing ${index}`, at: Date.now() + index });
		}
		const boundary = await Promise.allSettled([
			createConnectionToken(env, creatorA, { label: "Boundary A" }, { projectId }),
			createConnectionToken(env, creatorB, { label: "Boundary B" }, { projectId }),
		]);
		expect(boundary.filter((item) => item.status === "fulfilled")).toHaveLength(1);
		expect(boundary.filter((item) => item.status === "rejected")[0].reason).toMatchObject({
			code: "credential_limit_reached",
			status: 409,
		});
		expect(Number((await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM connection_tokens WHERE project_id = ? AND status = 'active' AND revoked_at IS NULL",
		).bind(projectId).first()).n)).toBe(MAX_ACTIVE_CONNECTION_TOKENS_PER_PROJECT);
	});

	it("counts creator-owned historical NULL keys toward the default-project active cap", async () => {
		const projectId = newId("proj");
		const creator = newId("usr");
		for (let index = 0; index < MAX_ACTIVE_CONNECTION_TOKENS_PER_PROJECT - 1; index += 1) {
			await insertToken({ userId: creator, label: `Historical ${index}` });
		}
		const boundary = await Promise.allSettled([
			createConnectionToken(env, creator, { label: "Default boundary A" }, { projectId, isDefault: true }),
			createConnectionToken(env, creator, { label: "Default boundary B" }, { projectId, isDefault: true }),
		]);
		expect(boundary.filter((item) => item.status === "fulfilled")).toHaveLength(1);
		expect(boundary.filter((item) => item.status === "rejected")[0].reason)
			.toMatchObject({ code: "credential_limit_reached", status: 409 });
	});

	it("bounds retained credential history and list results", async () => {
		const projectId = newId("proj");
		const creator = newId("usr");
		const statements = Array.from({ length: MAX_CONNECTION_TOKEN_HISTORY_PER_PROJECT - 1 }, (_, index) => {
			const at = Date.now() + index;
			return env.DB.prepare(
				`INSERT INTO connection_tokens
				 (id, user_id, project_id, label, token_hash, token_prefix, token_tail, type,
				  created_at, scopes_json, status, revoked_at)
				 VALUES (?, ?, ?, ?, ?, 'itsuki_live_test', 'test', 'api', ?, '[]', 'revoked', ?)`,
			).bind(newId("tok"), creator, projectId, `Retained ${index}`, `hash_${crypto.randomUUID()}`, at, at);
		});
		for (let offset = 0; offset < statements.length; offset += 50) {
			await env.DB.batch(statements.slice(offset, offset + 50));
		}
		const boundary = await Promise.allSettled([
			createConnectionToken(env, creator, { label: "History boundary A" }, { projectId }),
			createConnectionToken(env, creator, { label: "History boundary B" }, { projectId }),
		]);
		expect(boundary.filter((item) => item.status === "fulfilled")).toHaveLength(1);
		expect(boundary.filter((item) => item.status === "rejected")[0].reason)
			.toMatchObject({ code: "credential_history_limit_reached", status: 409 });
		expect(await listConnectionTokens(env, creator, { projectId, limit: 9999 }))
			.toHaveLength(MAX_CONNECTION_TOKEN_HISTORY_PER_PROJECT);
	});
});
