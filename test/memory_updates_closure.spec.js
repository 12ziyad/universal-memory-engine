/**
 * Safe memory updates — final corrective closure regressions.
 *
 * Each test here reproduces a blocker that the previous campaign reported as
 * closed. They are behavioural: they drive the real writers against real D1
 * and a controllable Vectorize double, never a source-text search.
 *
 *  B1 the credential authorizing the request must still be valid AT COMMIT
 *  B2 every semantic writer must fail closed on a lost CAS, and must keep
 *     working on uncontended r2+ objects
 *  B3 every physical vector artifact ever submitted must be deleted
 */

import { describe, expect, it } from "vitest";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";

import worker from "../src/index.js";

const legacyHeaders = { "x-api-key": env.API_KEY, "content-type": "application/json" };
const idem = () => `idem-${crypto.randomUUID()}`;
let seed = 0;
const uid = () => `closure-${++seed}-${crypto.randomUUID().slice(0, 8)}`;

async function request(path, init = {}) {
	const req = new Request(`http://example.com${path}`, { headers: legacyHeaders, ...init });
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

async function seedNode(userId, { label = "Closure node", summary = "Original summary.", revision = null } = {}) {
	const id = `node_${crypto.randomUUID()}`;
	await env.DB.prepare(
		`INSERT INTO nodes (id, user_id, label, category, state, summary, created_at, updated_at, revision)
		 VALUES (?, ?, ?, 'tool', 'active', ?, ?, ?, ?)`,
	).bind(id, userId, label, summary, Date.now(), Date.now(), revision).run();
	return id;
}

/** A managed project owned by somebody else, plus a real credential row. */
async function seedTenant(memoryUserId, { tokenStatus = "active", revokedAt = null, scopes = ["memory:read", "memory:write"] } = {}) {
	const now = Date.now();
	const ownerId = `user_${crypto.randomUUID()}`;
	const actorId = `user_${crypto.randomUUID()}`;
	const orgId = `org_${crypto.randomUUID()}`;
	const projectId = `proj_${crypto.randomUUID()}`;
	const tokenId = `tok_${crypto.randomUUID()}`;
	await env.DB.batch([
		env.DB.prepare("INSERT INTO users (id, email, email_normalized, created_at, updated_at, status, role) VALUES (?, ?, ?, ?, ?, 'active', 'user')")
			.bind(ownerId, `${ownerId}@e.com`, `${ownerId}@e.com`, now, now),
		env.DB.prepare("INSERT INTO users (id, email, email_normalized, created_at, updated_at, status, role) VALUES (?, ?, ?, ?, ?, 'active', 'user')")
			.bind(actorId, `${actorId}@e.com`, `${actorId}@e.com`, now, now),
		env.DB.prepare("INSERT INTO organizations (id, owner_user_id, name, name_normalized, status, created_at, updated_at) VALUES (?, ?, 'Closure', 'closure', 'active', ?, ?)")
			.bind(orgId, ownerId, now, now),
		env.DB.prepare("INSERT INTO organization_members (id, org_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, 'owner', ?, ?)")
			.bind(`om_${crypto.randomUUID()}`, orgId, ownerId, now, now),
		// The actor is a full member: RBAC alone would let this write through, so
		// only a credential check can stop it.
		env.DB.prepare("INSERT INTO organization_members (id, org_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, 'member', ?, ?)")
			.bind(`om_${crypto.randomUUID()}`, orgId, actorId, now, now),
		env.DB.prepare(`INSERT INTO managed_projects (id, owner_user_id, organization_id, memory_owner_user_id, name, name_normalized, is_default, status, created_at, updated_at)
			VALUES (?, ?, ?, ?, 'Closure project', 'closure project', 0, 'active', ?, ?)`)
			.bind(projectId, ownerId, orgId, memoryUserId, now, now),
		env.DB.prepare("INSERT INTO project_members (id, org_id, project_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, 'member', ?, ?)")
			.bind(`pm_${crypto.randomUUID()}`, orgId, projectId, actorId, now, now),
		env.DB.prepare(`INSERT INTO connection_tokens (id, user_id, project_id, label, token_hash, token_prefix, token_tail, type, created_at, scopes_json, status, revoked_at)
			VALUES (?, ?, ?, 'closure', ?, 'itsuki_live_xxxxx', 'aaaa', 'api', ?, ?, ?, ?)`)
			.bind(tokenId, actorId, projectId, `hash_${crypto.randomUUID()}`, now, JSON.stringify(scopes), tokenStatus, revokedAt),
	]);
	return { ownerId, actorId, orgId, projectId, tokenId };
}

/* ------------------------------------------------------------------ B1 */

describe("B1 — the authorizing credential must still be valid at commit", () => {
	async function attemptUpdate(memoryUserId, nodeId, tenant) {
		const { applyMemoryChange } = await import("../src/lib/memory_versions.js");
		return applyMemoryChange(env, null, {
			userId: memoryUserId,
			project: { id: tenant.projectId },
			actor: {
				userId: tenant.actorId,
				type: "token",
				capability: "project.memory.write",
				orgId: tenant.orgId,
				credential: { kind: "token", id: tenant.tokenId, requiredScope: "memory:write", projectId: tenant.projectId },
			},
			actorClass: "token",
			actorRef: tenant.tokenId,
			id: nodeId,
			mode: "update",
			patch: { summary: "Written after the credential changed." },
			idempotencyKey: idem(),
			expectedRevision: 1,
		});
	}

	async function expectUntouched(nodeId) {
		const row = await env.DB.prepare("SELECT summary, COALESCE(revision,1) AS revision FROM nodes WHERE id = ?").bind(nodeId).first();
		expect(row.summary, "head content must be unchanged").toBe("Original summary.");
		expect(row.revision, "revision must not advance").toBe(1);
		const [rev, claim, proj] = await env.DB.batch([
			env.DB.prepare("SELECT COUNT(*) AS n FROM memory_revisions WHERE object_id = ?").bind(nodeId),
			env.DB.prepare("SELECT COUNT(*) AS n FROM memory_update_idempotency WHERE object_id = ?").bind(nodeId),
			env.DB.prepare("SELECT COUNT(*) AS n FROM memory_projection_state WHERE object_id = ?").bind(nodeId),
		]);
		expect(rev.results[0].n, "no revision row").toBe(0);
		expect(claim.results[0].n, "no idempotency claim").toBe(0);
		expect(proj.results[0].n, "no projection reset").toBe(0);
	}

	it("an ACTIVE credential commits normally (the control)", async () => {
		const userId = uid();
		const nodeId = await seedNode(userId);
		const tenant = await seedTenant(userId);
		const result = await attemptUpdate(userId, nodeId, tenant);
		expect(result.revision).toBe(2);
	});

	it("a credential revoked between preflight and commit loses atomically", async () => {
		const userId = uid();
		const nodeId = await seedNode(userId);
		const tenant = await seedTenant(userId);
		// Preflight already passed; the credential dies before the batch commits.
		await env.DB.prepare("UPDATE connection_tokens SET status = 'revoked', revoked_at = ? WHERE id = ?")
			.bind(Date.now(), tenant.tokenId).run();
		await expect(attemptUpdate(userId, nodeId, tenant)).rejects.toMatchObject({ name: "VersionError" });
		await expectUntouched(nodeId);
	});

	it("a credential whose scopes are narrowed below memory:write loses atomically", async () => {
		const userId = uid();
		const nodeId = await seedNode(userId);
		const tenant = await seedTenant(userId);
		await env.DB.prepare("UPDATE connection_tokens SET scopes_json = ? WHERE id = ?")
			.bind(JSON.stringify(["memory:read"]), tenant.tokenId).run();
		await expect(attemptUpdate(userId, nodeId, tenant)).rejects.toMatchObject({ name: "VersionError" });
		await expectUntouched(nodeId);
	});

	it("a credential rebound to a different project loses atomically", async () => {
		const userId = uid();
		const nodeId = await seedNode(userId);
		const tenant = await seedTenant(userId);
		await env.DB.prepare("UPDATE connection_tokens SET project_id = ? WHERE id = ?")
			.bind(`proj_${crypto.randomUUID()}`, tenant.tokenId).run();
		await expect(attemptUpdate(userId, nodeId, tenant)).rejects.toMatchObject({ name: "VersionError" });
		await expectUntouched(nodeId);
	});

	it("a deleted credential row loses atomically (absence is not permission)", async () => {
		const userId = uid();
		const nodeId = await seedNode(userId);
		const tenant = await seedTenant(userId);
		await env.DB.prepare("DELETE FROM connection_tokens WHERE id = ?").bind(tenant.tokenId).run();
		await expect(attemptUpdate(userId, nodeId, tenant)).rejects.toMatchObject({ name: "VersionError" });
		await expectUntouched(nodeId);
	});
});

/* ------------------------------------------------------------------ B2 */

describe("B2 — semantic writers fail closed, and keep working when uncontended", () => {
	it("pass2 still regenerates the summary of an UNCONTENDED r2+ node", async () => {
		const { runPass2 } = await import("../src/pipeline/pass2.js");
		const { getConfig } = await import("../src/config.js");
		const userId = uid();
		// A node that has simply been edited before: revision 3, nothing contending.
		const nodeId = await seedNode(userId, { summary: "Stale summary.", revision: 3 });
		await env.DB.prepare(
			"INSERT INTO slices (id, user_id, node_id, text, kind, is_current, created_at) VALUES (?, ?, ?, 'Runs on Cloudflare Workers.', 'technical_detail', 1, ?)",
		).bind(`slice_${crypto.randomUUID()}`, userId, nodeId, Date.now()).run();

		await runPass2(env, getConfig(env), userId, [nodeId]);

		const row = await env.DB.prepare("SELECT summary, COALESCE(revision,1) AS revision FROM nodes WHERE id = ?").bind(nodeId).first();
		expect(row.summary, "pass2 must not silently no-op on an r2+ node").not.toBe("Stale summary.");
		expect(row.revision).toBe(4);
	});

	it("retention summary regeneration also survives on an uncontended r2+ node", async () => {
		const { regenerateNodeSummaryFenced } = await import("../src/pipeline/cleanup.js");
		const userId = uid();
		const nodeId = await seedNode(userId, { summary: "Stale.", revision: 9 });
		const applied = await regenerateNodeSummaryFenced(env, userId, nodeId, {
			summary: "Refreshed at r9.",
			sourcesJson: "[]",
			observedRevision: 9,
		});
		expect(applied.applied).toBe(true);
		const row = await env.DB.prepare("SELECT summary, revision FROM nodes WHERE id = ?").bind(nodeId).first();
		expect(row.summary).toBe("Refreshed at r9.");
		expect(row.revision).toBe(10);
	});

	it("the census rejects nullable CAS predicates and unchecked affected-row counts", async () => {
		const { auditSemanticWriters } = await import("../src/lib/mutation_census.js");
		const findings = await auditSemanticWriters();
		expect(findings.unfenced, JSON.stringify(findings.unfenced, null, 2)).toEqual([]);
		// A fence that a NULL bind can switch off is not a fence.
		expect(findings.nullableFence ?? [], JSON.stringify(findings.nullableFence ?? [], null, 2)).toEqual([]);
		// A writer that ignores meta.changes cannot fail closed.
		expect(findings.uncheckedResult ?? [], JSON.stringify(findings.uncheckedResult ?? [], null, 2)).toEqual([]);
	});
});

/* ------------------------------------------------------------------ B3 */

function fakeVectorize() {
	const upserted = new Set();
	const deleted = new Set();
	return {
		state: { upserted, deleted },
		async upsert(vectors) {
			for (const v of vectors) upserted.add(v.id);
			return { mutationId: `mut_${crypto.randomUUID()}` };
		},
		async getByIds(ids) {
			return ids.filter((id) => upserted.has(id) && !deleted.has(id)).map((id) => ({ id }));
		},
		async deleteByIds(ids) {
			for (const id of ids) deleted.add(id);
			return { mutationId: `mut_${crypto.randomUUID()}` };
		},
		async query() { return { matches: [] }; },
	};
}

describe("B3 — every physical vector artifact is deleted", () => {
	it("deleting an object removes bare, r1, r2 and GAPPED r25/r50 vectors", async () => {
		const { deleteObject } = await import("../src/pipeline/cleanup.js");
		const { sweepPendingProjections } = await import("../src/lib/memory_versions.js");
		const userId = uid();
		const nodeId = await seedNode(userId, { revision: 1 });
		const vectorize = fakeVectorize();
		const vecEnv = { ...env, VECTORIZE: vectorize, USE_VECTORS: "true" };

		// Every physical artifact this object ever had: a legacy bare id plus
		// NON-CONTIGUOUS revisions far beyond any fixed window. These are recorded
		// exactly as the submission path records them, so the test measures
		// deletion enumeration rather than embedding-model availability.
		const { recordVectorArtifact, vectorIdFor } = await import("../src/lib/memory_versions.js");
		await vectorize.upsert([{ id: nodeId, values: [0.1] }]);
		await recordVectorArtifact(vecEnv, userId, nodeId, nodeId, { revision: null });
		for (const revision of [1, 2, 25, 50]) {
			const vid = vectorIdFor(nodeId, revision);
			await vectorize.upsert([{ id: vid, values: [0.1] }]);
			await recordVectorArtifact(vecEnv, userId, nodeId, vid, { revision });
		}
		await env.DB.prepare("UPDATE nodes SET revision = 50 WHERE id = ?").bind(nodeId).run();
		const submitted = [...vectorize.state.upserted];
		expect(submitted.length, "the double must have recorded real submissions").toBeGreaterThan(1);

		await deleteObject(vecEnv, userId, { kind: "node", id: nodeId });
		// Convergence is allowed to take a second sweep; residue is not.
		await sweepPendingProjections(vecEnv, { limit: 50 }).catch(() => {});

		const survivors = submitted.filter((id) => !vectorize.state.deleted.has(id));
		expect(survivors, `vector artifacts survived canonical deletion: ${survivors.join(", ")}`).toEqual([]);
	});

	it("an upsert that lands AFTER deletion is reconciled away", async () => {
		const { deleteObject } = await import("../src/pipeline/cleanup.js");
		const { sweepPendingProjections } = await import("../src/lib/memory_versions.js");
		const userId = uid();
		const nodeId = await seedNode(userId, { revision: 4 });
		const vectorize = fakeVectorize();
		const vecEnv = { ...env, VECTORIZE: vectorize, USE_VECTORS: "true" };

		const { recordVectorArtifact } = await import("../src/lib/memory_versions.js");
		const lateId = `${nodeId}#r4`;
		// The upsert was accepted and ledgered, but the provider has NOT made it
		// visible yet — the exact in-flight state deletion has to survive.
		await recordVectorArtifact(vecEnv, userId, nodeId, lateId, { revision: 4 });
		await env.DB.prepare(
			`INSERT INTO memory_projection_state (user_id, object_id, projection, applied_revision, status, attempts, updated_at)
			 VALUES (?, ?, 'vector', 4, 'submitted', 0, ?)`,
		).bind(userId, nodeId, Date.now()).run();

		await deleteObject(vecEnv, userId, { kind: "node", id: nodeId });
		// Only NOW does the provider make the in-flight write visible.
		await vectorize.upsert([{ id: lateId, values: [0.2] }]);

		// The reconciler must still be holding the artifact and remove it.
		await sweepPendingProjections(vecEnv, { limit: 50 });
		await sweepPendingProjections(vecEnv, { limit: 50 });

		expect(vectorize.state.deleted.has(lateId),
			"a delayed upsert that appeared after deletion must be reconciled away").toBe(true);
	});
});
