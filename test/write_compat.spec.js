import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { writeApproved } from "../src/pipeline/write.js";

describe("shared write compatibility", () => {
	it("still embeds an unguarded API/AutoMode node when later effects are tracked", async () => {
		const userId = `write-compat-${crypto.randomUUID()}`;
		const nodeId = `node-${crypto.randomUUID()}`;
		const upserts = [];
		const vectorEnv = {
			...env,
			AI: { run: async () => ({ data: [[0.1, 0.2, 0.3]] }) },
			VECTORIZE: { upsert: async (items) => { upserts.push(...items); } },
		};
		const now = Date.now();
		const result = await writeApproved(vectorEnv, {
			useVectors: true,
			embedModel: "test-embedding",
		}, userId, {
			newNodes: [{
				id: nodeId,
				user_id: userId,
				label: "Automatic Atlas",
				category: "project",
				role: null,
				state: "active",
				summary: "Automatic Atlas is active.",
				created_at: now,
				updated_at: now,
			}],
			nodeStateUpdates: [{ id: nodeId, state: "active" }],
		});

		expect(result.committed.nodes).toEqual([nodeId]);
		expect(upserts).toEqual([
			expect.objectContaining({ id: nodeId, namespace: userId }),
		]);
	});
});
