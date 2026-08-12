/**
 * Stage 2 project-scope invariants inside the one per-account UserMemory DO.
 * These tests stop at held/queued state: no drain means no model or network.
 */

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const PROJECT_A = "project:local_alpha";
const PROJECT_B = "project:local_beta";

function message(id, content) {
	return { id, role: "user", content, ts: Date.now() };
}

function stubFor(userId) {
	return env.USER_MEMORY.get(env.USER_MEMORY.idFromName(userId));
}

describe("UserMemory project-scope boundaries", () => {
	it("does not deduplicate the same message ID across projects", async () => {
		const userId = `project-dedupe-${crypto.randomUUID()}`;
		const stub = stubFor(userId);

		await runInDurableObject(stub, async (instance, state) => {
			const sharedId = "same-host-message-id";
			// Noise finalizes immediately. The human-readable checkpoint remains
			// the host id, while the seen set stores the v2 content-bound identity.
			await instance.addMessages(userId, [message(sharedId, "okay")], {
				scopeKey: PROJECT_A,
			});
			const [projectAContext] = await state.storage.get("contextIndex:v1");
			expect(projectAContext.contextKey).toMatch(/^context:v1:[a-f0-9]{64}$/);
			expect(await state.storage.get(`checkpoint:${projectAContext.contextKey}`)).toBe(sharedId);
			const projectASeen = await state.storage.get(`seen:${projectAContext.contextKey}`);
			expect(projectASeen).toHaveLength(1);
			expect(projectASeen[0]).toMatch(/^message:v2:[a-f0-9]{64}$/);
			expect(projectASeen).not.toContain(sharedId);

			// The identical host ID is new inside B and must be held, not rejected
			// by A's finalized-ID state.
			const inProjectB = await instance.addMessages(userId, [message(
				sharedId,
				"Beta architecture keeps rendering separate from transport layers.",
			)], { scopeKey: PROJECT_B });

			expect(inProjectB).toMatchObject({ held: 1, skipped: 0, fired: false });
			expect(await state.storage.get("chunkScopeKey")).toBe(PROJECT_B);
			const chunk = await state.storage.get("chunk");
			expect(chunk.map((item) => item.id)).toEqual([sharedId]);
			const projectBContext = await state.storage.get("chunkContextKey");
			expect(projectBContext).not.toBe(projectAContext.contextKey);
			expect(await state.storage.get(`seen:${projectBContext}`)).toBeUndefined();
		});

		await stub.resetAll();
	}, 30_000);

	it("turns every project switch into a hard queue/chunk boundary", async () => {
		const userId = `project-boundary-${crypto.randomUUID()}`;
		const stub = stubFor(userId);

		await runInDurableObject(stub, async (instance, state) => {
			const sharedId = "same-id-in-two-projects";
			const alphaContent = "Alpha architecture keeps adapters separate from persistence layers.";
			const betaContent = "Beta architecture keeps rendering separate from transport layers.";

			const alpha = await instance.addMessages(userId, [message(sharedId, alphaContent)], {
				scopeKey: PROJECT_A,
			});
			const beta = await instance.addMessages(userId, [message(sharedId, betaContent)], {
				scopeKey: PROJECT_B,
			});
			const backToAlpha = await instance.addMessages(userId, [message(
				"alpha-held-after-switch",
				"The boundary regression leaves this final note held.",
			)], { scopeKey: PROJECT_A });

			expect(alpha).toMatchObject({ held: 1, skipped: 0, fired: false });
			expect(beta).toMatchObject({ held: 1, skipped: 0, fired: false });
			expect(backToAlpha).toMatchObject({ held: 1, skipped: 0, fired: false });

			const queued = await state.storage.list({ prefix: "q:" });
			const entries = [...queued.values()].filter((entry) => entry.kind === "extract");
			expect(entries).toHaveLength(2);
			expect(entries.map((entry) => entry.scopeKey).sort()).toEqual([PROJECT_A, PROJECT_B]);

			const byScope = new Map(entries.map((entry) => [entry.scopeKey, entry]));
			expect(byScope.get(PROJECT_A).messages).toEqual([
				expect.objectContaining({ id: sharedId, content: alphaContent }),
			]);
			expect(byScope.get(PROJECT_B).messages).toEqual([
				expect.objectContaining({ id: sharedId, content: betaContent }),
			]);

			// The third message stays in A's current chunk; it never co-batches
			// with either queued project entry.
			expect(await state.storage.get("chunkScopeKey")).toBe(PROJECT_A);
			const chunk = await state.storage.get("chunk");
			expect(chunk.map((item) => item.id)).toEqual(["alpha-held-after-switch"]);
		});

		await stub.resetAll();
	}, 30_000);

	it("restores a no-write rescue with its original project attribution", async () => {
		const userId = `project-rescue-${crypto.randomUUID()}`;
		const stub = stubFor(userId);

		await runInDurableObject(stub, async (instance, state) => {
			const alphaOverrides = {
				llmResponse: { objects: [], notes: "nothing durable yet" },
				meta: { project_id: "local_alpha", project_name: "Alpha" },
			};
			const betaOverrides = {
				llmResponse: { objects: [], notes: "unused" },
				meta: { project_id: "local_beta", project_name: "Beta" },
			};

			await instance.addMessages(userId, [message(
				"alpha-rescue",
				"Alpha has a brand new architecture idea that needs more context.",
			)], { scopeKey: PROJECT_A, flush: true, overrides: alphaOverrides });
			await instance.addMessages(userId, [message(
				"beta-held",
				"Beta keeps its rendering pipeline separate from storage.",
			)], { scopeKey: PROJECT_B, overrides: betaOverrides });

			await instance.drain({ userId, maxJobs: 1, ignoreBackoff: true });

			const chunk = await state.storage.get("chunk");
			expect(await state.storage.get("chunkScopeKey")).toBe(PROJECT_A);
			expect(chunk.map((item) => item.id)).toEqual(["alpha-rescue"]);
			expect(await state.storage.get("pendingOverrides")).toMatchObject({
				meta: { project_id: "local_alpha", project_name: "Alpha" },
			});

			const queued = await state.storage.list({ prefix: "q:" });
			const betaEntry = [...queued.values()].find((entry) => entry.scopeKey === PROJECT_B);
			expect(betaEntry).toMatchObject({
				overrides: { meta: { project_id: "local_beta", project_name: "Beta" } },
			});
		});

		await stub.resetAll();
	}, 30_000);

	it("does not ping-pong settled rescue buffers across project switches", async () => {
		const userId = `project-rescue-ping-pong-${crypto.randomUUID()}`;
		const stub = stubFor(userId);
		const noWrite = {
			llmResponse: { objects: [], notes: "nothing durable yet" },
			edgeResponse: { edges: [] },
			reflexionResponse: { entities: [], facts: [], edges: [] },
		};

		await runInDurableObject(stub, async (instance, state) => {
			await instance.addMessages(userId, [message(
				"alpha-rescue-loop",
				"Alpha has an early architecture thought that needs more context.",
			)], { scopeKey: PROJECT_A, flush: true, overrides: noWrite });
			await instance.drain({ userId, maxJobs: 1, ignoreBackoff: true, inlineOverrides: noWrite });
			const alphaChunk = await state.storage.get("chunk");
			expect(alphaChunk?.[0]?._settled).toBe(true);
			const acceptStates = await state.storage.get("chunkAcceptState");
			expect(acceptStates[alphaChunk[0]._accept]).toMatchObject({
				rescuedFromNoWrite: true,
				noWriteRescueCount: 1,
			});
			// Upgrade compatibility: pre-fix settled rescue chunks have the flag
			// but not the persisted generation. They must inherit the exhausted
			// generation instead of reopening the former infinite lineage.
			delete acceptStates[alphaChunk[0]._accept].noWriteRescueCount;
			await state.storage.put("chunkAcceptState", acceptStates);

			await instance.addMessages(userId, [message(
				"beta-rescue-loop",
				"Beta has another early architecture thought that needs more context.",
			)], { scopeKey: PROJECT_B, flush: true, overrides: noWrite });
			const queuedBeforeDrain = await state.storage.list({ prefix: "q:" });
			const alphaReconsideration = [...queuedBeforeDrain.values()].find(
				(entry) => entry.messages?.[0]?.id === "alpha-rescue-loop",
			);
			expect(alphaReconsideration).toMatchObject({
				rescuedFromNoWrite: true,
				noWriteRescueCount: 1,
			});
			for (let index = 0; index < 6; index++) {
				await instance.drain({ userId, maxJobs: 1, ignoreBackoff: true, inlineOverrides: noWrite });
			}

			const queued = await state.storage.list({ prefix: "q:" });
			expect([...queued.values()].filter((entry) => entry.kind === "extract")).toHaveLength(0);
			const chunk = (await state.storage.get("chunk")) ?? [];
			expect(chunk.every((item) => item._settled === true)).toBe(true);
		});

		const runs = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM extraction_runs WHERE user_id=?",
		).bind(userId).first();
		expect(Number(runs.n)).toBe(3);
		await stub.resetAll();
	}, 30_000);
});
