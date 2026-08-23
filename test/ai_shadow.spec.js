/**
 * Shadow outbox durability and lifecycle citizenship (migration 0054).
 *
 * waitUntil is never the recovery mechanism: D1 + the cron claim/lease loop
 * is. Reconciliation detects and creates any sampled job a settlement path
 * missed. Erasure cancels a job before content is touched. Retention purges.
 * A shadow failure only ever skips the shadow.
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
	claimShadowJob,
	drainShadowJobs,
	processShadowJob,
	purgeExpiredShadowJobs,
	reconcileShadowJobs,
	settleShadowJob,
	shadowJobId,
} from "../src/ai/shadow.js";
import { resolveProvider } from "../src/ai/registry.js";
import { bulkDeleteBySource } from "../src/pipeline/cleanup.js";
import worker from "../src/index.js";

const SUCCESSFUL_SHADOW_RESPONSE = Object.freeze({
	response: '{"objects":[]}',
	usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
});

function providerTestEnv() {
	return Object.assign(Object.create(Object.getPrototypeOf(env)), env, {
		// callModel checks for the binding before dispatch; the shadow pin still
		// routes the call to the offline provider fake installed by each test.
		AI: { run: async () => { throw new Error("unexpected Workers AI invocation"); } },
		GCP_SERVICE_ACCOUNT: "{}",
		GCP_PROJECT_ID: "shadow-spec-project",
		GOOGLE_DAILY_GEN_TOKENS: "10000000",
		GOOGLE_MONTHLY_COST_MICROS: "1000000000",
	});
}

async function seedRun(userId, {
	pinShadow = true,
	status = "wrote",
	createdAt = Date.now(),
	scope = null,
	pinJson = undefined,
} = {}) {
	const runId = `run_extract_${crypto.randomUUID().replaceAll("-", "")}`;
	const pin = pinJson !== undefined ? pinJson : pinShadow
		? JSON.stringify({ v: 1, routes: {}, shadow: { provider: "google-vertex", model: "gemini-2.5-flash", sampled: true } })
		: null;
	await env.DB.prepare(
		`INSERT INTO extraction_runs (id, user_id, tool_name, status, created_pages_json, created_nodes_json,
			created_slices_json, created_events_json, created_edges_json, created_candidates_json,
			updated_objects_json, reinforced_objects_json, skipped_objects_json, created_at, updated_at,
			pin_json, scope_json, provider)
		 VALUES (?, ?, 'ingest', ?, '[]', '[]', '[]', '[]', '[]', '[]', '[]', '[]', '[]', ?, ?, ?, ?, ?)`,
	).bind(runId, userId, status, createdAt, createdAt, pin, scope ? JSON.stringify(scope) : null, pinShadow ? "workers-ai" : null).run();
	return runId;
}

async function seedRunnableJob(userId) {
	const runId = await seedRun(userId);
	const packetId = `packet-${runId}`;
	await env.DB.prepare(
		`INSERT INTO source_episodes (id, user_id, source_packet_id, message_index, role, text, text_hash, created_at)
		 VALUES (?, ?, ?, 0, 'user', 'I planted tomatoes.', ?, ?)`,
	).bind(`ep-${crypto.randomUUID()}`, userId, packetId, crypto.randomUUID(), Date.now()).run();
	await env.DB.prepare("UPDATE extraction_runs SET source_packet_id = ? WHERE id = ?").bind(packetId, runId).run();
	await reconcileShadowJobs(env, { limit: 10 });
	return { runId, id: await shadowJobId(runId) };
}

describe("reconciliation", () => {
	it("creates the missing job for a sampled terminal run, exactly once", async () => {
		const userId = `shadowrec-${crypto.randomUUID()}`;
		const runId = await seedRun(userId);
		const created = await reconcileShadowJobs(env, { limit: 10 });
		expect(created).toBeGreaterThanOrEqual(1);
		const job = await env.DB.prepare("SELECT * FROM ai_shadow_jobs WHERE id = ?").bind(await shadowJobId(runId)).first();
		expect(job).toMatchObject({ user_id: userId, primary_run_id: runId, status: "pending" });
		// Second pass: idempotent, nothing new for this run.
		await reconcileShadowJobs(env, { limit: 10 });
		const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM ai_shadow_jobs WHERE primary_run_id = ?").bind(runId).first();
		expect(Number(count.n)).toBe(1);
	});

	it("ignores unsampled and unpinned runs", async () => {
		const userId = `shadownone-${crypto.randomUUID()}`;
		const runId = await seedRun(userId, { pinShadow: false });
		await reconcileShadowJobs(env, { limit: 10 });
		const job = await env.DB.prepare("SELECT id FROM ai_shadow_jobs WHERE primary_run_id = ?").bind(runId).first();
		expect(job).toBe(null);
	});

	it("oldest missing work cannot starve behind newer runs that already have jobs", async () => {
		const userId = `shadowfair-${crypto.randomUUID()}`;
		const now = Date.now();
		const oldestMissing = await seedRun(userId, { createdAt: now - 10_000 });
		for (let i = 0; i < 8; i += 1) {
			const runId = await seedRun(userId, { createdAt: now - i });
			await env.DB.prepare(
				`INSERT INTO ai_shadow_jobs
				 (id, user_id, primary_run_id, provider, status, attempts, created_at, updated_at)
				 VALUES (?, ?, ?, 'google-vertex', 'done', 1, ?, ?)`,
			).bind(await shadowJobId(runId), userId, runId, now - i, now - i).run();
		}
		expect(await reconcileShadowJobs(env, { limit: 1, now })).toBe(1);
		expect(await env.DB.prepare("SELECT status FROM ai_shadow_jobs WHERE primary_run_id = ?")
			.bind(oldestMissing).first()).toEqual({ status: "pending" });
	});

	it("malformed pin JSON cannot abort reconciliation of a valid run", async () => {
		const userId = `shadowjson-${crypto.randomUUID()}`;
		await seedRun(userId, { createdAt: Date.now() - 10, pinJson: "{broken" });
		const valid = await seedRun(userId);
		await expect(reconcileShadowJobs(env, { limit: 10 })).resolves.toBe(1);
		expect(await env.DB.prepare("SELECT status FROM ai_shadow_jobs WHERE primary_run_id = ?")
			.bind(valid).first()).toEqual({ status: "pending" });
	});

	it("a tombstoned account receives a terminal anonymized marker, never live work", async () => {
		const memoryUserId = `shadowshared-${crypto.randomUUID()}`;
		const accountUserId = `shadowactor-${crypto.randomUUID()}`;
		const runId = await seedRun(memoryUserId, { scope: { account_user_id: accountUserId } });
		const now = Date.now();
		await env.DB.prepare("INSERT INTO account_erasure_tombstones (user_id, erased_at) VALUES (?, ?)")
			.bind(accountUserId, now).run();
		expect(await reconcileShadowJobs(env, { limit: 10, now })).toBe(1);
		expect(await env.DB.prepare(
			"SELECT status, account_user_id, terminal_at FROM ai_shadow_jobs WHERE primary_run_id = ?",
		).bind(runId).first()).toEqual({ status: "cancelled_erased", account_user_id: null, terminal_at: now });
	});
});

describe("drain", () => {
	it("an erasure that wins after plaintext load fences the provider invocation", async () => {
		const userId = `shadow-load-erase-${crypto.randomUUID()}`;
		const { id } = await seedRunnableJob(userId);
		const claimed = await claimShadowJob(env, id);
		const provider = await resolveProvider("google-vertex");
		const originalInvoke = provider.invoke;
		let invoked = 0;
		let releaseEpisodes;
		let episodesLoaded;
		const loaded = new Promise((resolve) => { episodesLoaded = resolve; });
		const resume = new Promise((resolve) => { releaseEpisodes = resolve; });

		provider.invoke = async () => {
			invoked += 1;
			return SUCCESSFUL_SHADOW_RESPONSE;
		};
		const testEnv = providerTestEnv();
		const pausingEnv = {
			...testEnv,
			DB: new Proxy(testEnv.DB, {
				get(target, property) {
					if (property === "prepare") return (sql) => {
						const statement = target.prepare(sql);
						if (!String(sql).includes("SELECT role, text FROM source_episodes")) return statement;
						const pauseAfterLoad = (currentStatement) => new Proxy(currentStatement, {
							get(statementTarget, statementProperty) {
								if (statementProperty === "bind") {
									return (...args) => pauseAfterLoad(statementTarget.bind(...args));
								}
								if (statementProperty === "all") return async (...args) => {
									const result = await statementTarget.all(...args);
									episodesLoaded();
									await resume;
									return result;
								};
								const value = Reflect.get(statementTarget, statementProperty);
								return typeof value === "function" ? value.bind(statementTarget) : value;
							},
						});
						return pauseAfterLoad(statement);
					};
					const value = Reflect.get(target, property);
					return typeof value === "function" ? value.bind(target) : value;
				},
			}),
		};

		try {
			const processing = processShadowJob(pausingEnv, claimed);
			await loaded;
			await bulkDeleteBySource(testEnv, userId, { dryRun: false, confirm: true });
			releaseEpisodes();
			await processing;
			expect(invoked).toBe(0);
			expect(await env.DB.prepare(
				"SELECT status, claim_token FROM ai_shadow_jobs WHERE id = ?",
			).bind(id).first()).toEqual({ status: "cancelled_erased", claim_token: null });
		} finally {
			releaseEpisodes();
			provider.invoke = originalInvoke;
		}
	});

	it("an admitted provider call makes erasure retry instead of confirming over it", async () => {
		const userId = `shadow-invoke-erase-${crypto.randomUUID()}`;
		const { id } = await seedRunnableJob(userId);
		const claimed = await claimShadowJob(env, id);
		const provider = await resolveProvider("google-vertex");
		const originalInvoke = provider.invoke;
		let invoked = 0;
		let signalStarted;
		let releaseInvoke;
		const started = new Promise((resolve) => { signalStarted = resolve; });
		const resume = new Promise((resolve) => { releaseInvoke = resolve; });

		provider.invoke = async () => {
			invoked += 1;
			signalStarted();
			await resume;
			return SUCCESSFUL_SHADOW_RESPONSE;
		};
		const testEnv = providerTestEnv();

		try {
			const processing = processShadowJob(testEnv, claimed);
			await started;
			await expect(bulkDeleteBySource(testEnv, userId, {
				dryRun: false,
				confirm: true,
			})).rejects.toMatchObject({
				code: "shadow_invocation_in_flight",
				retryable: true,
			});
			expect(invoked).toBe(1);
			expect(await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM source_episodes WHERE user_id = ?",
			).bind(userId).first()).toEqual({ n: 1 });

			releaseInvoke();
			await processing;
			expect(await env.DB.prepare(
				"SELECT status, claim_token FROM ai_shadow_jobs WHERE id = ?",
			).bind(id).first()).toEqual({ status: "cancelled_erased", claim_token: null });

			await expect(bulkDeleteBySource(testEnv, userId, {
				dryRun: false,
				confirm: true,
			})).resolves.toMatchObject({ ok: true, dry_run: false });
			expect(await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM source_episodes WHERE user_id = ?",
			).bind(userId).first()).toEqual({ n: 0 });
		} finally {
			releaseInvoke();
			provider.invoke = originalInvoke;
		}
	});

	it("a managed-project lifecycle fence prevents provider admission", async () => {
		const userId = `shadow-project-${crypto.randomUUID()}`;
		const projectId = `project-${crypto.randomUUID()}`;
		const now = Date.now();
		await env.DB.prepare(
			`INSERT INTO managed_projects
			 (id, owner_user_id, memory_owner_user_id, name, name_normalized,
			  is_default, status, lifecycle_state, created_at, updated_at)
			 VALUES (?, ?, ?, 'Shadow project', 'shadow project', 0, 'active', 'active', ?, ?)`,
		).bind(projectId, userId, userId, now, now).run();
		const runId = await seedRun(userId, { scope: { managed_project_id: projectId } });
		const packetId = `packet-${runId}`;
		await env.DB.prepare(
			`INSERT INTO source_episodes (id, user_id, source_packet_id, message_index, role, text, text_hash, created_at)
			 VALUES (?, ?, ?, 0, 'user', 'The project is active.', ?, ?)`,
		).bind(`ep-${crypto.randomUUID()}`, userId, packetId, crypto.randomUUID(), now).run();
		await env.DB.prepare("UPDATE extraction_runs SET source_packet_id = ? WHERE id = ?")
			.bind(packetId, runId).run();
		await reconcileShadowJobs(env, { limit: 10 });
		const id = await shadowJobId(runId);
		const claimed = await claimShadowJob(env, id);
		await env.DB.prepare(
			"UPDATE managed_projects SET status = 'archived', lifecycle_state = 'archiving', updated_at = ? WHERE id = ?",
		).bind(now + 1, projectId).run();

		const provider = await resolveProvider("google-vertex");
		const originalInvoke = provider.invoke;
		let invoked = 0;
		provider.invoke = async () => {
			invoked += 1;
			return SUCCESSFUL_SHADOW_RESPONSE;
		};
		try {
			await processShadowJob(providerTestEnv(), claimed);
			expect(invoked).toBe(0);
			expect(await env.DB.prepare(
				"SELECT status, claim_token FROM ai_shadow_jobs WHERE id = ?",
			).bind(id).first()).toEqual({ status: "cancelled_lifecycle", claim_token: null });
		} finally {
			provider.invoke = originalInvoke;
		}
	});

	it("cancels on an erasure barrier before touching any content", async () => {
		const userId = `shadowerase-${crypto.randomUUID()}`;
		const runId = await seedRun(userId);
		await reconcileShadowJobs(env, { limit: 10 });
		await env.DB.prepare(
			"INSERT INTO deletion_barriers (user_id, barrier_at, created_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET barrier_at = excluded.barrier_at",
		).bind(userId, Date.now() + 60_000, Date.now()).run();
		await drainShadowJobs(env, { limit: 5 });
		const job = await env.DB.prepare("SELECT status, comparison_json FROM ai_shadow_jobs WHERE id = ?").bind(await shadowJobId(runId)).first();
		expect(job.status).toBe("cancelled_erased");
		expect(job.comparison_json).toBe(null);
	});

	it("a failing shadow retries once then dead-letters — and never throws out of the drain", async () => {
		const userId = `shadowfail-${crypto.randomUUID()}`;
		const runId = await seedRun(userId);
		await reconcileShadowJobs(env, { limit: 10 });
		const id = await shadowJobId(runId);
		// No source episodes exist → source_gone is terminal cancelled_erased;
		// exercise the retry ladder instead via a run with episodes but no
		// google credentials: seed one episode so the drain reaches the model,
		// where the pinned google admission refuses (no credentials) and throws.
		await env.DB.prepare(
			`INSERT INTO source_episodes (id, user_id, source_packet_id, message_index, role, text, text_hash, created_at)
			 VALUES (?, ?, ?, 0, 'user', 'I planted tomatoes.', ?, ?)`,
		).bind(`ep-${crypto.randomUUID()}`, userId, `packet-${runId}`, crypto.randomUUID(), Date.now()).run();
		await env.DB.prepare("UPDATE extraction_runs SET source_packet_id = ? WHERE id = ?").bind(`packet-${runId}`, runId).run();

		await drainShadowJobs(env, { limit: 5 });
		let job = await env.DB.prepare("SELECT status, attempts, error_class FROM ai_shadow_jobs WHERE id = ?").bind(id).first();
		expect(["pending", "dead_letter"]).toContain(job.status); // attempt 1 failed → back to pending
		await drainShadowJobs(env, { limit: 5 });
		job = await env.DB.prepare("SELECT status, attempts FROM ai_shadow_jobs WHERE id = ?").bind(id).first();
		expect(job.status).toBe("dead_letter");
		expect(Number(job.attempts)).toBe(2);
		// The primary run row is untouched throughout.
		const run = await env.DB.prepare("SELECT status FROM extraction_runs WHERE id = ?").bind(runId).first();
		expect(run.status).toBe("wrote");
	});

	it("gives a proven-unbilled retry a new reservation and lets attempt 2 complete", async () => {
		const userId = `shadowretry-${crypto.randomUUID()}`;
		const { id } = await seedRunnableJob(userId);
		const provider = await resolveProvider("google-vertex");
		const originalInvoke = provider.invoke;
		const reservationIds = [];
		provider.invoke = async (_providerEnv, call) => {
			reservationIds.push(call.meta.reservationId);
			if (reservationIds.length === 1) {
				throw Object.assign(new Error("explicit provider response"), {
					status: 503,
					retryable: false,
					aiErrorClass: "provider_unavailable",
				});
			}
			return SUCCESSFUL_SHADOW_RESPONSE;
		};

		try {
			const testEnv = providerTestEnv();
			expect(await drainShadowJobs(testEnv, { limit: 1 })).toEqual({ drained: 1 });
			expect(await env.DB.prepare(
				"SELECT status, attempts, error_class FROM ai_shadow_jobs WHERE id = ?",
			).bind(id).first()).toEqual({ status: "pending", attempts: 1, error_class: "provider_unavailable" });
			expect(await env.DB.prepare(
				"SELECT status FROM ai_provider_reservations WHERE id = ?",
			).bind(reservationIds[0]).first()).toEqual({ status: "released" });

			expect(await drainShadowJobs(testEnv, { limit: 1 })).toEqual({ drained: 1 });
			expect(await env.DB.prepare(
				"SELECT status, attempts, error_class FROM ai_shadow_jobs WHERE id = ?",
			).bind(id).first()).toEqual({ status: "done", attempts: 2, error_class: null });
			expect(reservationIds).toHaveLength(2);
			expect(reservationIds[1]).not.toBe(reservationIds[0]);
			expect(await env.DB.prepare(
				"SELECT status FROM ai_provider_reservations WHERE id = ?",
			).bind(reservationIds[1]).first()).toEqual({ status: "settled" });
		} finally {
			provider.invoke = originalInvoke;
		}
	});

	it("never retries an ambiguous provider outcome under a new operation id", async () => {
		const userId = `shadowambiguous-${crypto.randomUUID()}`;
		const { id } = await seedRunnableJob(userId);
		const provider = await resolveProvider("google-vertex");
		const originalInvoke = provider.invoke;
		const reservationIds = [];
		provider.invoke = async (_providerEnv, call) => {
			reservationIds.push(call.meta.reservationId);
			throw Object.assign(new Error("transport timed out after request dispatch"), {
				aiErrorClass: "timeout",
			});
		};

		try {
			const testEnv = providerTestEnv();
			expect(await drainShadowJobs(testEnv, { limit: 1 })).toEqual({ drained: 1 });
			expect(await env.DB.prepare(
				"SELECT status, attempts, error_class FROM ai_shadow_jobs WHERE id = ?",
			).bind(id).first()).toEqual({ status: "dead_letter", attempts: 1, error_class: "timeout" });
			expect(reservationIds).toHaveLength(1);
			expect(await env.DB.prepare(
				"SELECT status, ambiguous_reason FROM ai_provider_reservations WHERE id = ?",
			).bind(reservationIds[0]).first()).toEqual({
				status: "ambiguous_charged",
				ambiguous_reason: "timeout_outcome_unknown",
			});

			// Terminal work is not claimable on the next cron tick. A second
			// reservation id or invocation would be an uncontrolled double charge.
			expect(await drainShadowJobs(testEnv, { limit: 1 })).toEqual({ drained: 0 });
			expect(reservationIds).toHaveLength(1);
		} finally {
			provider.invoke = originalInvoke;
		}
	});

	it("keeps one claim attempt replay-stable so duplicate execution cannot invoke twice", async () => {
		const userId = `shadowduplicate-${crypto.randomUUID()}`;
		const { id } = await seedRunnableJob(userId);
		const claimed = await claimShadowJob(env, id);
		const provider = await resolveProvider("google-vertex");
		const originalInvoke = provider.invoke;
		const reservationIds = [];
		provider.invoke = async (_providerEnv, call) => {
			reservationIds.push(call.meta.reservationId);
			return SUCCESSFUL_SHADOW_RESPONSE;
		};

		try {
			const testEnv = providerTestEnv();
			await processShadowJob(testEnv, claimed);
			// The durable invocation admission row now refuses a stale replay even
			// before it reaches the provider reservation layer.
			await expect(processShadowJob(testEnv, claimed)).resolves.toBe(0);
			expect(reservationIds).toHaveLength(1);
			expect(await env.DB.prepare(
				"SELECT status FROM ai_provider_reservations WHERE id = ?",
			).bind(reservationIds[0]).first()).toEqual({ status: "settled" });
			const calls = await env.DB.prepare(
				"SELECT scope_id, ok FROM ai_calls WHERE user_id = ? AND scope = 'shadow_extract' ORDER BY created_at, id",
			).bind(userId).all();
			expect(calls.results).toHaveLength(1);
			expect(new Set(calls.results.map((call) => call.scope_id)).size).toBe(1);
			expect(calls.results[0].scope_id).toBe(`${id}:attempt:1`);
			expect(calls.results.map((call) => Number(call.ok))).toEqual([1]);
			expect(await env.DB.prepare(
				"SELECT status, attempts, claim_token FROM ai_shadow_jobs WHERE id = ?",
			).bind(id).first()).toEqual({ status: "done", attempts: 1, claim_token: null });
		} finally {
			provider.invoke = originalInvoke;
		}
	});

	it("an expired lease is re-claimable (crash recovery)", async () => {
		const userId = `shadowlease-${crypto.randomUUID()}`;
		const runId = await seedRun(userId);
		await reconcileShadowJobs(env, { limit: 10 });
		const id = await shadowJobId(runId);
		await env.DB.prepare(
			"UPDATE ai_shadow_jobs SET status = 'running', attempts = 1, lease_until = 1 WHERE id = ?",
		).bind(id).run();
		await drainShadowJobs(env, { limit: 5 });
		const job = await env.DB.prepare("SELECT status, attempts FROM ai_shadow_jobs WHERE id = ?").bind(id).first();
		// Reclaimed (attempts 2) and processed to a terminal or pending state —
		// never stuck on the dead lease.
		expect(Number(job.attempts)).toBe(2);
		expect(job.status).not.toBe("running");
	});

	it("an expired owner cannot settle a job after a newer token reclaims it", async () => {
		const userId = `shadowtoken-${crypto.randomUUID()}`;
		const runId = await seedRun(userId);
		await reconcileShadowJobs(env, { limit: 10 });
		const id = await shadowJobId(runId);
		const ownerA = await claimShadowJob(env, id, { now: 100, leaseMs: 10 });
		const ownerB = await claimShadowJob(env, id, { now: 111, leaseMs: 10 });
		expect(ownerA.claim_token).not.toBe(ownerB.claim_token);
		expect(await settleShadowJob(env, ownerA, {
			status: "done", comparison: { owner: "A" }, now: 112,
		})).toBe(0);
		expect(await settleShadowJob(env, ownerB, {
			status: "done", comparison: { owner: "B" }, now: 113,
		})).toBe(1);
		const row = await env.DB.prepare(
			"SELECT status, comparison_json, claim_token, terminal_at FROM ai_shadow_jobs WHERE id = ?",
		).bind(id).first();
		expect(row).toEqual({ status: "done", comparison_json: JSON.stringify({ owner: "B" }), claim_token: null, terminal_at: 113 });
	});

	it("late reconciliation preserves acceptance time and an equal-time erasure barrier covers it", async () => {
		const userId = `shadowlate-${crypto.randomUUID()}`;
		const acceptedAt = Date.now() - 10_000;
		const runId = await seedRun(userId, { createdAt: acceptedAt });
		await env.DB.prepare(
			"INSERT INTO deletion_barriers (user_id, barrier_at, created_at) VALUES (?, ?, ?)",
		).bind(userId, acceptedAt, acceptedAt).run();
		await reconcileShadowJobs(env, { limit: 10, now: Date.now() });
		expect(await env.DB.prepare("SELECT created_at FROM ai_shadow_jobs WHERE primary_run_id = ?")
			.bind(runId).first()).toEqual({ created_at: acceptedAt });
		await drainShadowJobs(env, { limit: 5 });
		expect(await env.DB.prepare("SELECT status FROM ai_shadow_jobs WHERE primary_run_id = ?")
			.bind(runId).first()).toEqual({ status: "cancelled_erased" });
	});
});

describe("retention", () => {
	it("purges rows past the retention window, bounded", async () => {
		const userId = `shadowpurge-${crypto.randomUUID()}`;
		const runId = await seedRun(userId, { createdAt: Date.now() - 40 * 86_400_000 });
		await env.DB.prepare(
			`INSERT INTO ai_shadow_jobs
			 (id, user_id, primary_run_id, provider, status, attempts, created_at, updated_at, terminal_at)
			 VALUES (?, ?, ?, 'google-vertex', 'done', 1, ?, ?, ?)`,
		).bind(
			await shadowJobId(runId), userId, runId,
			Date.now() - 40 * 86_400_000,
			Date.now() - 40 * 86_400_000,
			Date.now() - 40 * 86_400_000,
		).run();
		const purged = await purgeExpiredShadowJobs(env, { retentionDays: 30, limit: 100 });
		expect(purged).toBeGreaterThanOrEqual(1);
		const job = await env.DB.prepare("SELECT id FROM ai_shadow_jobs WHERE primary_run_id = ?").bind(runId).first();
		expect(job).toBe(null);
	});

	it("ages from terminal completion and never purges live work", async () => {
		const userId = `shadowage-${crypto.randomUUID()}`;
		const now = Date.now();
		const recentTerminalRun = await seedRun(userId, { createdAt: now - 40 * 86_400_000 });
		const pendingRun = await seedRun(userId, { createdAt: now - 40 * 86_400_000 });
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO ai_shadow_jobs
				 (id, user_id, primary_run_id, provider, status, attempts, created_at, updated_at, terminal_at)
				 VALUES (?, ?, ?, 'google-vertex', 'done', 1, ?, ?, ?)`,
			).bind(await shadowJobId(recentTerminalRun), userId, recentTerminalRun,
				now - 40 * 86_400_000, now, now),
			env.DB.prepare(
				`INSERT INTO ai_shadow_jobs
				 (id, user_id, primary_run_id, provider, status, attempts, created_at, updated_at)
				 VALUES (?, ?, ?, 'google-vertex', 'pending', 0, ?, ?)`,
			).bind(await shadowJobId(pendingRun), userId, pendingRun,
				now - 40 * 86_400_000, now - 40 * 86_400_000),
		]);
		expect(await purgeExpiredShadowJobs(env, { retentionDays: 30, limit: 100, now })).toBe(0);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM ai_shadow_jobs WHERE user_id = ?")
			.bind(userId).first()).toEqual({ n: 2 });
	});

	it("one failing provider duty cannot skip the later shadow retention duty", async () => {
		const userId = `shadowduties-${crypto.randomUUID()}`;
		const runId = await seedRun(userId, { createdAt: Date.now() - 40 * 86_400_000 });
		const jobId = await shadowJobId(runId);
		const old = Date.now() - 40 * 86_400_000;
		await env.DB.prepare(
			`INSERT INTO ai_shadow_jobs
			 (id, user_id, primary_run_id, provider, status, attempts, created_at, updated_at, terminal_at)
			 VALUES (?, ?, ?, 'google-vertex', 'done', 1, ?, ?, ?)`,
		).bind(jobId, userId, runId, old, old, old).run();

		const failing = {
			...env,
			DB: new Proxy(env.DB, {
				get(target, property) {
					if (property === "prepare") return (sql) => {
						if (String(sql).includes("SELECT er.id, er.user_id, er.pin_json")) {
							throw new Error("injected reconciliation failure");
						}
						return target.prepare(sql);
					};
					const value = Reflect.get(target, property);
					return typeof value === "function" ? value.bind(target) : value;
				},
			}),
		};
		const waits = [];
		await worker.scheduled({ scheduledTime: Date.now(), cron: "* * * * *" }, failing, {
			waitUntil(promise) { waits.push(Promise.resolve(promise)); },
		});
		await Promise.allSettled(waits);
		expect(await env.DB.prepare("SELECT id FROM ai_shadow_jobs WHERE id = ?").bind(jobId).first()).toBeNull();
	});
});
