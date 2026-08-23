/**
 * Rollout identity must come from the server-owned AI meter lifecycle.
 *
 * Recall/rerank calls do not carry account ids in request metadata. A rollout
 * allowlist or sticky canary therefore has to read the authenticated account
 * that the command layer placed in AsyncLocalStorage, never a caller-supplied
 * `meta.accountUserId` value.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withAiMeter } from "../src/lib/ai_meter.js";
import { resetPolicyCacheForTests } from "../src/ai/policy.js";
import { rerankEntries } from "../src/pipeline/rerank.js";

beforeEach(() => resetPolicyCacheForTests());

describe("server-owned provider rollout identity", () => {
	it("routes an allowlisted recall rerank in track mode and denies a different account", async () => {
		await env.DB.prepare(
			`INSERT INTO ai_routing_policies
			 (capability, mode, primary_provider, primary_model, allowlist_json,
			  disabled, version, updated_at, updated_by)
			 VALUES ('rerank', 'google_only', 'google-vertex',
			         'semantic-ranker-default-004', ?, 0, 1, ?, 'routing-identity-test')
			 ON CONFLICT(capability) DO UPDATE SET
			  mode=excluded.mode, primary_provider=excluded.primary_provider,
			  primary_model=excluded.primary_model, allowlist_json=excluded.allowlist_json,
			  disabled=0, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
		).bind(JSON.stringify(["account-allowed"]), Date.now()).run();

		const calls = [];
		const track = [];
		const trackEnv = Object.assign(Object.create(Object.getPrototypeOf(env)), env, {
			AI_ROUTING: "track",
			AI: {
				run: async (...args) => {
					calls.push(args);
					return [{ id: 0, score: 0.9 }, { id: 1, score: 0.2 }];
				},
			},
		});
		const log = vi.spyOn(console, "log").mockImplementation((line) => {
			try {
				const parsed = JSON.parse(String(line));
				if (parsed?.event === "ai_routing_track") track.push(parsed);
			} catch {
				// Ignore unrelated non-JSON diagnostics.
			}
		});
		const entries = [
			{ type: "node", item: { label: "alpha" } },
			{ type: "node", item: { label: "beta" } },
		];

		try {
			await withAiMeter("recall", () => rerankEntries(trackEnv, "which", entries), {
				memoryUserId: "memory-allowed",
				accountUserId: "account-allowed",
				acceptedAt: 1_800_000_000_000,
			});
			await withAiMeter("recall", () => rerankEntries(trackEnv, "which", entries), {
				memoryUserId: "memory-denied",
				accountUserId: "account-denied",
				acceptedAt: 1_800_000_000_001,
			});
		} finally {
			log.mockRestore();
		}

		expect(calls).toHaveLength(2);
		expect(track).toHaveLength(2);
		expect(track[0]).toMatchObject({
			lane: "rerank",
			provider: "google-vertex",
			source: "policy",
		});
		expect(track[1]).toMatchObject({
			lane: "rerank",
			provider: "workers-ai",
			source: "not_allowlisted",
		});
		for (const row of track) expect(row).not.toHaveProperty("accountUserId");
	});
});
