/**
 * Lifecycle races and fault injection: crashes between phases, duplicate
 * drivers, Vectorize failure/lag after D1 success, stale writers after the
 * purge barrier, and cross-operation conflicts. Deterministic â€” every
 * "crash" is a driver that simply stops, every resume is an explicit call.
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
	driveLifecycleRun,
	executeLifecycleAction,
	previewLifecycleAction,
	stepLifecycleRun,
	transferProjectOwnership,
} from "../src/lib/project_lifecycle.js";
import { residualSpaceCounts, residualTotal } from "../src/lib/lifecycle_census.js";
import { registerProjectMemorySpace } from "../src/lib/managed_projects.js";
import { claimMemoryJob } from "../src/lib/db.js";
import {
	ERASED_SOURCE_CONTENT_HASH,
	normalizeSourcePacket,
	storeSourcePacket,
} from "../src/pipeline/source.js";
import { writeApproved } from "../src/pipeline/write.js";
import { getConfig } from "../src/config.js";

const ctx = { waitUntil() {} };

async function makeWorld({ label = "race", subtenants = 1 } = {}) {
	const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 20);
	const now = Date.now();
	const ownerUserId = `user_${label}_${suffix}`;
	const orgId = `org_${suffix}`;
	const projectId = `proj_${suffix}`;
	const memoryOwnerUserId = `mem_${suffix}`;
	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO users (id, email, email_normalized, status, created_at) VALUES (?, ?, ?, 'active', ?)",
		).bind(ownerUserId, `${suffix}@example.com`, `${suffix}@example.com`, now),
		env.DB.prepare(
			`INSERT INTO organizations (id, owner_user_id, name, name_normalized, is_default, status, created_at, updated_at)
			 VALUES (?, ?, ?, ?, 1, 'active', ?, ?)`,
		).bind(orgId, ownerUserId, `Org ${suffix}`, `org ${suffix}`, now, now),
		env.DB.prepare(
			`INSERT INTO organization_members (id, org_id, user_id, role, created_at, updated_at)
			 VALUES (?, ?, ?, 'owner', ?, ?)`,
		).bind(`om_${suffix}`, orgId, ownerUserId, now, now),
		env.DB.prepare(
			`INSERT INTO managed_projects
			 (id, owner_user_id, organization_id, memory_owner_user_id, name, name_normalized, is_default, status, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, 0, 'active', ?, ?)`,
		).bind(projectId, ownerUserId, orgId, memoryOwnerUserId, `Project ${suffix}`, `project ${suffix}`, now, now),
	]);
	const spaces = [memoryOwnerUserId];
	await registerProjectMemorySpace(env, { projectId, memoryOwnerUserId, memoryUserId: memoryOwnerUserId });
	for (let i = 0; i < subtenants; i += 1) {
		const spaceId = `mem_sub_${suffix}_${i}`;
		await registerProjectMemorySpace(env, { projectId, memoryOwnerUserId, memoryUserId: spaceId });
		spaces.push(spaceId);
	}
	return { suffix, ownerUserId, orgId, projectId, memoryOwnerUserId, spaces, name: `Project ${suffix}` };
}

async function seed(world, spaceId) {
	const now = Date.now();
	const normalized = await normalizeSourcePacket(spaceId, {
		type: "message_batch",
		sourceMode: "ingest",
		messages: [{ role: "user", content: `race specimen ${spaceId}` }],
		conversationId: `conv_${spaceId}`,
	});
	const packet = await storeSourcePacket(env, normalized.packet, { immutableIdempotency: true });
	await env.DB.prepare(
		`INSERT INTO nodes (id, user_id, label, category, role, state, summary, created_at, updated_at)
		 VALUES (?, ?, ?, 'interest', NULL, 'active', 'race summary', ?, ?)`,
	).bind(`node_${crypto.randomUUID().slice(0, 12)}`, spaceId, `Race ${spaceId}`, now, now).run();
	await claimMemoryJob(env, spaceId, {
		type: "extract",
		status: "queued",
		idempotencyKey: packet.idempotency_key,
		sourcePacketId: packet.id,
		payload: { lane: "ingest", remaining: ["m1"] },
	});
	return packet;
}

async function startPurge(world, key = `race-${world.suffix}`) {
	const preview = await previewLifecycleAction(env, {
		actorUserId: world.ownerUserId, sessionRef: "s", projectId: world.projectId, action: "memory_purge",
	});
	const { run } = await executeLifecycleAction(env, {}, {
		actorUserId: world.ownerUserId, sessionRef: "s", projectId: world.projectId,
		action: "memory_purge", token: preview.confirmation.token,
		idempotencyKey: key, confirmName: world.name,
	});
	return run;
}

describe("crash/resume at every phase boundary", () => {
	it("a driver that dies after any single step leaves a resumable run that converges", async () => {
		const world = await makeWorld({ subtenants: 2 });
		for (const space of world.spaces) await seed(world, space);
		const run = await startPurge(world);
		// Step one phase at a time â€” every step is a full 'crash' boundary.
		let steps = 0;
		let last = null;
		for (; steps < 300; steps += 1) {
			last = await stepLifecycleRun(env, run.id);
			if (["completed", "failed_terminal", "cancelled"].includes(last.status)) break;
			if (last.status === "failed_retryable") {
				await env.DB.prepare(
					"UPDATE project_lifecycle_runs SET status = 'running', error_code = NULL, updated_at = ? WHERE id = ?",
				).bind(Date.now(), run.id).run();
			}
		}
		expect(last.status).toBe("completed");
		expect(steps).toBeGreaterThan(5); // it really was phase-by-phase
		for (const space of world.spaces) {
			const counts = await residualSpaceCounts(env, space, { erasedContentHash: ERASED_SOURCE_CONTENT_HASH });
			expect(residualTotal(counts)).toBe(0);
		}
		const row = await env.DB.prepare("SELECT status, lifecycle_state FROM managed_projects WHERE id = ?")
			.bind(world.projectId).first();
		expect(row.status).toBe("active");
		expect(row.lifecycle_state).toBe("active");
	});

	it("two drivers racing the same run cannot double-apply or wedge it", { timeout: 30000 }, async () => {
		const world = await makeWorld({ subtenants: 2 });
		for (const space of world.spaces) await seed(world, space);
		const run = await startPurge(world);
		for (let i = 0; i < 60; i += 1) {
			const [a, b] = await Promise.all([
				driveLifecycleRun(env, { runId: run.id, budgetMs: 1500 }),
				driveLifecycleRun(env, { runId: run.id, budgetMs: 1500 }),
			]);
			const status = (b ?? a)?.status;
			if (status === "completed") break;
			if (status === "failed_retryable") {
				await env.DB.prepare(
					"UPDATE project_lifecycle_runs SET status = 'running', error_code = NULL, updated_at = ? WHERE id = ?",
				).bind(Date.now(), run.id).run();
			}
		}
		const final = await env.DB.prepare(
			"SELECT status, checkpoint_json FROM project_lifecycle_runs WHERE id = ?",
		).bind(run.id).first();
		expect(final.status).toBe("completed");
		// Jobs were cancelled exactly once per space (2 seeded jobs total).
		const checkpoint = JSON.parse(final.checkpoint_json);
		expect(checkpoint.jobs_cancelled).toBe(world.spaces.length);
		for (const space of world.spaces) {
			const counts = await residualSpaceCounts(env, space, { erasedContentHash: ERASED_SOURCE_CONTENT_HASH });
			expect(residualTotal(counts)).toBe(0);
		}
	});
});

describe("Vectorize failure and asynchronous deletion after D1 acceptance", () => {
	it("a failing vector backend parks the run retryable; recovery converges and verifies absence", async () => {
		const world = await makeWorld({ subtenants: 0 });
		await seed(world, world.spaces[0]);
		let deleteCalls = 0;
		let failing = true;
		let pendingReads = 0;
		const fakeVectorize = {
			async deleteByIds(ids) {
				deleteCalls += 1;
				if (failing) throw new Error("vectorize unavailable");
				return { mutationId: `m_${deleteCalls}`, ids: ids.length };
			},
			async getByIds(ids) {
				// First verification still sees the vectors (async mutation lag),
				// later ones see them gone.
				pendingReads += 1;
				return pendingReads <= 1 ? ids.map((id) => ({ id, namespace: world.spaces[0] })) : [];
			},
		};
		const vEnv = Object.assign(Object.create(Object.getPrototypeOf(env)), env, {
			USE_VECTORS: "true",
			VECTORIZE: fakeVectorize,
			// Collapse the production verify backoff so the async-lag path runs
			// in test time without wall-clock waits.
			LIFECYCLE_VECTOR_WAIT_MS: "1",
		});
		const preview = await previewLifecycleAction(vEnv, {
			actorUserId: world.ownerUserId, sessionRef: "s", projectId: world.projectId, action: "memory_purge",
		});
		const { run } = await executeLifecycleAction(vEnv, {}, {
			actorUserId: world.ownerUserId, sessionRef: "s", projectId: world.projectId,
			action: "memory_purge", token: preview.confirmation.token,
			idempotencyKey: `vec-${world.suffix}`, confirmName: world.name,
		});
		let state = await driveLifecycleRun(vEnv, { runId: run.id, budgetMs: 8000 });
		expect(state.status).toBe("failed_retryable");
		expect(deleteCalls).toBeGreaterThan(0);

		failing = false;
		for (let i = 0; i < 40 && state.status !== "completed"; i += 1) {
			await env.DB.prepare(
				"UPDATE project_lifecycle_runs SET status = 'running', error_code = NULL, updated_at = ? WHERE id = ?",
			).bind(Date.now(), run.id).run();
			state = await driveLifecycleRun(vEnv, { runId: run.id, budgetMs: 8000 });
		}
		expect(state.status).toBe("completed");
		// The async-lag path was really exercised: presence once, absence later.
		expect(pendingReads).toBeGreaterThan(1);
		expect(state.counts.vectors_deleted).toBeGreaterThan(0);
	});
});

describe("stale writers after the purge barrier", () => {
	it("an old accepted write (pre-purge acceptedAt) is refused atomically by the commit fence", async () => {
		const world = await makeWorld({ subtenants: 0 });
		await seed(world, world.spaces[0]);
		const preAccept = Date.now() - 1;
		const run = await startPurge(world);
		for (let i = 0; i < 200; i += 1) {
			const s = await stepLifecycleRun(env, run.id);
			if (s.status === "completed") break;
			if (s.status === "failed_retryable") {
				await env.DB.prepare(
					"UPDATE project_lifecycle_runs SET status = 'running', error_code = NULL, updated_at = ? WHERE id = ?",
				).bind(Date.now(), run.id).run();
			}
		}
		// The "old embedding/extraction job" shape: a writer that read its
		// evidence before the purge and tries to commit graph rows after it.
		const stale = {
			newNodes: [{
				id: `node_${crypto.randomUUID().slice(0, 12)}`,
				user_id: world.spaces[0],
				label: "Resurrected fact",
				category: "interest",
				role: null,
				state: "active",
				summary: "should never land",
				created_at: preAccept,
				updated_at: preAccept,
			}],
			hasWrites: true,
		};
		await expect(
			writeApproved(env, getConfig(env), world.spaces[0], stale, { acceptedAt: preAccept }),
		).rejects.toThrow();
		const nodes = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM nodes WHERE user_id = ?",
		).bind(world.spaces[0]).first();
		expect(Number(nodes.n)).toBe(0);
	});
});

describe("cross-operation conflicts while a run is active", () => {
	it("transfer and a second lifecycle action are refused while the fence holds", async () => {
		const world = await makeWorld({ subtenants: 0 });
		await seed(world, world.spaces[0]);
		const run = await startPurge(world);
		expect(run.status).not.toBe("completed");
		// Transfer requires an ACTIVE project; the fence archived it.
		await expect(transferProjectOwnership(env, {
			actorUserId: world.ownerUserId,
			projectId: world.projectId,
			recipientUserId: "user_whoever",
			expectedRevision: "prv1.stale",
		})).rejects.toMatchObject({ code: "lifecycle_conflict" });
		// A different-key archive is a stable conflict.
		await expect(executeLifecycleAction(env, {}, {
			actorUserId: world.ownerUserId, sessionRef: "s", projectId: world.projectId,
			action: "archive", idempotencyKey: `arch2-${world.suffix}`,
		})).rejects.toMatchObject({ code: expect.stringMatching(/lifecycle_run_active|lifecycle_conflict/) });
	});
});
