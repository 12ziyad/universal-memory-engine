import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";

import { buildPin, withAiPin } from "../src/ai/pin.js";
import { resetProviderBudgetForTests } from "../src/ai/provider_budget.js";
import { resolveProvider } from "../src/ai/registry.js";
import { ensureProviderOperationIdentity, withAiMeter } from "../src/lib/ai_meter.js";
import { runExtraction } from "../src/pipeline/extract.js";
import { deleteSourceEpisodes, writeSourceEpisodes } from "../src/pipeline/episodes.js";
import {
	ATOMIC_CAPTURE_MODEL,
	atomicCaptureProviderOperationId,
	atomicCaptureSummaryForExtractionRun,
	captureAtomicCandidates,
	countSemanticAtomCandidates,
	hasRecoverableAtomicCaptureInterruption,
} from "../src/pipeline/atomic_candidates.mjs";

const EMPTY_GRAPH = { objects: [], notes: "control graph writes nothing" };
const RULES = { customInstructions: "", includes: [], excludes: [] };

function atom(messageId = "m1", overrides = {}) {
	return {
		type: "decision",
		entity: "Northwind",
		entity_type: "project",
		attribute: "database policy",
		value: "sqlc without an ORM",
		assertion: "Northwind uses sqlc and does not use an ORM.",
		source_message_id: messageId,
		evidence_quote: "uses sqlc; no ORM",
		cardinality: "single",
		confidence: 0.97,
		...overrides,
	};
}

function flagged(userId, projectId = "project-a") {
	return {
		...env,
		ITSUKI_MEMORY_V3: "allowlist",
		ITSUKI_MEMORY_V3_USERS: userId,
		ITSUKI_MEMORY_V3_ATOMIC_CAPTURE: "allowlist",
		ITSUKI_MEMORY_V3_ATOMIC_CAPTURE_USERS: userId,
		// This suite isolates append-only capture. Projection has its own tests;
		// production/test defaults now enable it, so the control must be explicit.
		ITSUKI_MEMORY_V3_ATOMIC_PROJECTION: "off",
		ITSUKI_MEMORY_V3_ATOMIC_PROJECTION_USERS: "",
		USE_VECTORS: "false",
		ENABLE_PASS2: "false",
		_projectId: projectId,
	};
}

async function fixture(label, { projectId = `project-${crypto.randomUUID()}`, content = "Northwind uses sqlc; no ORM." } = {}) {
	const userId = `atomic-${label}-${crypto.randomUUID()}`;
	const sourcePacketId = `packet-${crypto.randomUUID()}`;
	const message = {
		id: "m1",
		role: "user",
		content,
		ts: 1_762_250_400_000,
		source_time: { epoch_ms: 1_762_250_400_000, offset_minutes: 0, precision: "second" },
	};
	const testEnv = flagged(userId, projectId);
	const episode = await writeSourceEpisodes(testEnv, userId, {
		sourcePacketId,
		messages: [message],
		projectId,
		projectName: "Project A",
		rules: RULES,
		acceptedAt: message.ts,
		required: true,
	});
	expect(episode).toMatchObject({ ok: true, written: 1 });
	return { userId, sourcePacketId, message, testEnv, projectId };
}

async function extract(f, atomicLlmResponse, extra = {}) {
	const { meta: extraMeta = {}, ...rest } = extra;
	return runExtraction(f.testEnv, f.userId, [f.message], [], {
		llmResponse: EMPTY_GRAPH,
		atomicLlmResponse,
		meta: {
			source_packet_id: f.sourcePacketId,
			accepted_at: f.message.ts,
			project_id: f.projectId,
			project_name: "Project A",
			...extraMeta,
		},
		...rest,
	});
}

function googleAtomicEnv(base) {
	return Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
		AI: { run: async () => { throw new Error("unexpected Workers AI invocation"); } },
		GCP_SERVICE_ACCOUNT: "{}",
		GCP_PROJECT_ID: "atomic-spec-project",
		GOOGLE_DAILY_GEN_TOKENS: "10000000",
		GOOGLE_MONTHLY_COST_MICROS: "1000000000",
	});
}

async function captureWithAtomicPin(f, testEnv, {
	schedulerCalls = 0,
	extractionRunId = crypto.randomUUID(),
	route = { provider: "google-vertex", model: "gemini-2.5-flash" },
} = {}) {
	const pin = buildPin({
		routes: { extract_atomic: route },
	});
	return withAiPin(pin, () => withAiMeter("save", async (meter) => {
		meter.scopeId = `scheduler-${crypto.randomUUID()}`;
		// Simulate unrelated inference lanes moving before atomic capture. These
		// consume the parent meter ordinal but must not alter atomic authorization.
		for (let i = 0; i < schedulerCalls; i += 1) {
			await ensureProviderOperationIdentity({ task: `scheduler-noise-${i}` });
		}
		return captureAtomicCandidates(testEnv, {
			userId: f.userId,
			messages: [f.message],
			recent: [],
			rules: RULES,
			projectId: f.projectId,
			projectName: "Project A",
			sourcePacketId: f.sourcePacketId,
			extractionRunId,
			acceptedAt: f.message.ts,
		});
	}));
}

describe("E4 atomic candidate persistence", () => {
	it("stores only exact, source-episode-backed atoms without changing the graph outcome", async () => {
		const f = await fixture("grounded");
		const result = await extract(f, { atoms: [atom()] });

		expect(result.outcome).toBe("meaningful_no_write");
		expect(result.receipt).toMatchObject({
			atomic_capture_enabled: true,
			atomic_capture_outcome: "completed",
			atomic_capture_accepted: 1,
			atomic_capture_stored: 1,
			atomic_capture_complete: true,
		});
		const row = await env.DB.prepare(
			`SELECT c.*, e.text AS episode_text
			 FROM semantic_atom_candidates c
			 JOIN source_episodes e ON e.id = c.source_episode_id
			 WHERE c.user_id = ?`,
		).bind(f.userId).first();
		expect(row).toMatchObject({
			project_id: f.projectId,
			source_packet_id: f.sourcePacketId,
			source_message_id: "m1",
			evidence_quote: "uses sqlc; no ORM",
			atom_type: "decision",
			entity: "Northwind",
			attribute: "database policy",
			value: "sqlc without an ORM",
			extraction_model: ATOMIC_CAPTURE_MODEL,
			status: "candidate",
			episode_text: f.message.content,
		});
		expect(row.start_code_point).toBe(10);
		expect(row.end_code_point).toBe(27);

		const graph = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM nodes WHERE user_id = ?",
		).bind(f.userId).first();
		expect(Number(graph.n)).toBe(0);
	});

	it("persists only the stable id of an active governed project category", async () => {
		const f = await fixture("project-category");
		const category = {
			id: `cat_${crypto.randomUUID()}`,
			slug: "customer_success",
			description: "Customer adoption and renewal work",
		};
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO managed_projects
				 (id, owner_user_id, memory_owner_user_id, name, name_normalized, is_default, status, created_at, updated_at)
				 VALUES (?, ?, ?, 'Atomic category project', 'atomic category project', 0, 'active', ?, ?)`,
			).bind(f.projectId, f.userId, f.userId, Date.now(), Date.now()),
			env.DB.prepare(
				`INSERT INTO project_categories
				 (id, project_id, memory_owner_user_id, slug, name, status, created_at, updated_at)
				 VALUES (?, ?, ?, ?, 'Customer success', 'active', ?, ?)`,
			).bind(category.id, f.projectId, f.userId, category.slug, Date.now(), Date.now()),
		]);
		const result = await extract(f, { atoms: [atom("m1", {
			project_category: category.slug,
		})] }, {
			rules: { ...RULES, projectCategories: [category] },
			meta: { managed_project_id: f.projectId, owner_user_id: f.userId },
		});
		expect(result.receipt.atomic_capture_stored).toBe(1);
		const row = await env.DB.prepare(
			"SELECT project_category_id FROM semantic_atom_candidates WHERE user_id = ?",
		).bind(f.userId).first();
		expect(row).toEqual({ project_category_id: category.id });
	});

	it("stores Uncategorized when a governed category is archived after inference but before the V3 commit", async () => {
		const f = await fixture("project-category-race");
		const category = { id: `cat_${crypto.randomUUID()}`, slug: "release_risk" };
		const at = Date.now();
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO managed_projects
				 (id, owner_user_id, memory_owner_user_id, name, name_normalized, is_default, status, created_at, updated_at)
				 VALUES (?, ?, ?, 'Atomic category race', 'atomic category race', 0, 'active', ?, ?)`,
			).bind(f.projectId, f.userId, f.userId, at, at),
			env.DB.prepare(
				`INSERT INTO project_categories
				 (id, project_id, memory_owner_user_id, slug, name, status, created_at, updated_at)
				 VALUES (?, ?, ?, ?, 'Release risk', 'active', ?, ?)`,
			).bind(category.id, f.projectId, f.userId, category.slug, at, at),
		]);
		const result = await extract(f, async () => {
			await env.DB.prepare(
				"UPDATE project_categories SET status = 'archived', updated_at = ? WHERE id = ? AND project_id = ?",
			).bind(at + 1, category.id, f.projectId).run();
			return { atoms: [atom("m1", { project_category: category.slug })] };
		}, {
			rules: { ...RULES, projectCategories: [category] },
			meta: { managed_project_id: f.projectId, owner_user_id: f.userId },
		});
		expect(result.receipt.atomic_capture_stored).toBe(1);
		expect(await env.DB.prepare(
			"SELECT project_category_id FROM semantic_atom_candidates WHERE user_id = ?",
		).bind(f.userId).first()).toEqual({ project_category_id: null });
	});

	it("persists deterministic temporal fields with exact episode provenance", async () => {
		const f = await fixture("temporal", { content: "Northwind switched to sqlc yesterday." });
		const result = await extract(f, { atoms: [atom("m1", {
			type: "event",
			attribute: "database transition",
			value: "sqlc",
			assertion: "Northwind switched to sqlc.",
			evidence_quote: "switched to sqlc yesterday",
			raw_temporal_phrase: "yesterday",
		})] });
		expect(result.receipt).toMatchObject({
			atomic_capture_temporal_present: 1,
			atomic_capture_temporal_resolved: 1,
			atomic_capture_temporal_unresolved: 0,
		});
		const row = await env.DB.prepare(
			`SELECT event_time, event_time_end, event_time_precision, event_time_relation,
				event_time_source, event_time_anchor, temporal_schema, raw_temporal_phrase,
				source_episode_id
			 FROM semantic_atom_candidates WHERE user_id = ?`,
		).bind(f.userId).first();
		expect(row).toMatchObject({
			event_time: Date.UTC(2025, 10, 3, 12),
			event_time_end: null,
			event_time_precision: "day",
			event_time_relation: "at",
			event_time_source: "phrase",
			event_time_anchor: "source_time",
			temporal_schema: "itsuki.atomic-temporal/v1",
			raw_temporal_phrase: "yesterday",
		});
		expect(row.source_episode_id).toBeTruthy();
	});

	it("preserves an unsupported exact phrase but stores no fabricated event time", async () => {
		const f = await fixture("temporal-vague", { content: "Northwind may switch databases eventually." });
		const result = await extract(f, { atoms: [atom("m1", {
			type: "plan",
			attribute: "database plan",
			value: "switch databases",
			assertion: "Northwind may switch databases.",
			evidence_quote: "may switch databases eventually",
			raw_temporal_phrase: "eventually",
		})] });
		expect(result.receipt).toMatchObject({
			atomic_capture_temporal_present: 1,
			atomic_capture_temporal_resolved: 0,
			atomic_capture_temporal_unresolved: 1,
		});
		const row = await env.DB.prepare(
			`SELECT raw_temporal_phrase, event_time, event_time_end, event_time_precision,
				event_time_relation, event_time_source, event_time_anchor, temporal_schema
			 FROM semantic_atom_candidates WHERE user_id = ?`,
		).bind(f.userId).first();
		expect(row).toEqual({
			raw_temporal_phrase: "eventually",
			event_time: null,
			event_time_end: null,
			event_time_precision: null,
			event_time_relation: null,
			event_time_source: null,
			event_time_anchor: null,
			temporal_schema: "itsuki.atomic-temporal/v1",
		});
	});

	it("replay reuses the terminal capture run and never invokes the model twice", async () => {
		const f = await fixture("replay");
		let calls = 0;
		const response = () => {
			calls += 1;
			return { atoms: [atom()] };
		};
		const first = await extract(f, response);
		const second = await extract(f, response);
		expect(first.receipt.atomic_capture_stored).toBe(1);
		expect(second.receipt.atomic_capture_replayed).toBe(true);
		expect(calls).toBe(1);
		expect(await countSemanticAtomCandidates(env, f.userId)).toBe(1);
	});

	it("pins provider authorization to the durable capture attempt and never re-invokes an unknowable prior outcome", async () => {
		resetProviderBudgetForTests();
		const f = await fixture("provider-attempt-unknown");
		const testEnv = googleAtomicEnv(f.testEnv);
		const provider = await resolveProvider("google-vertex");
		const originalInvoke = provider.invoke;
		const reservationIds = [];
		provider.invoke = async (_providerEnv, call) => {
			reservationIds.push(call.meta.reservationId);
			// The provider completed and was settled, but application parsing lost
			// the response. This models a crash/response-loss ambiguity after billing.
			const response = { usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } };
			Object.defineProperty(response, "atoms", {
				get() { throw new Error("response lost after provider completion"); },
			});
			return response;
		};

		try {
			const first = await captureWithAtomicPin(f, testEnv, { schedulerCalls: 3 });
			expect(first).toMatchObject({ outcome: "transport_error", complete: false, stored: 0 });
			const run = await env.DB.prepare(
				"SELECT id, attempts, status, error_code FROM semantic_atom_capture_runs WHERE user_id = ?",
			).bind(f.userId).first();
			expect(run).toMatchObject({ attempts: 1, status: "failed", error_code: "transport_error" });
			expect(reservationIds).toEqual([atomicCaptureProviderOperationId(run.id, 1)]);
			expect(await env.DB.prepare(
				"SELECT status FROM ai_provider_reservations WHERE id = ?",
			).bind(reservationIds[0]).first()).toEqual({ status: "settled" });

			// Recreate the only durable state a dead isolate can leave, including a
			// legacy/malformed half-pin. The exact provider reservation still proves
			// that this was not a Workers-AI call. Settled is not proof of an unbilled
			// call, so a fresh meter and different call order must not mint attempt 2.
			await env.DB.prepare(
				`UPDATE semantic_atom_capture_runs
				 SET status = 'running', provider = NULL, error_code = NULL, updated_at = 1, completed_at = NULL
				 WHERE id = ?`,
			).bind(run.id).run();
			expect(await hasRecoverableAtomicCaptureInterruption(
				testEnv,
				f.userId,
				f.sourcePacketId,
				{ projectId: f.projectId },
			)).toBe(false);
			const replay = await captureWithAtomicPin(f, testEnv, { schedulerCalls: 0 });
			expect(replay).toMatchObject({ outcome: "interrupted_unknown", complete: false, stored: 0, replayed: true });
			expect(reservationIds).toHaveLength(1);
			expect(Number((await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM ai_provider_reservations WHERE provider = 'google-vertex' AND id LIKE 'airesv_atom:v1:%'",
			).first()).n)).toBe(1);
			expect(await env.DB.prepare(
				"SELECT attempts, status, error_code FROM semantic_atom_capture_runs WHERE id = ?",
			).bind(run.id).first()).toEqual({ attempts: 1, status: "failed", error_code: "interrupted_unknown" });
		} finally {
			provider.invoke = originalInvoke;
		}
	});

	it("reclaims under the provider and model stored by the atomic run, not a changed ambient pin", async () => {
		resetProviderBudgetForTests();
		const f = await fixture("provider-pin-flip");
		const testEnv = googleAtomicEnv(f.testEnv);
		const provider = await resolveProvider("google-vertex");
		const originalInvoke = provider.invoke;
		const calls = [];
		provider.invoke = async (_providerEnv, call) => {
			calls.push({ provider: "google-vertex", model: call.model, reservationId: call.meta.reservationId });
			if (calls.length === 1) {
				throw Object.assign(new Error("explicit unbilled provider response"), {
					status: 503,
					retryable: false,
					aiErrorClass: "provider_unavailable",
				});
			}
			return {
				atoms: [atom()],
				usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
			};
		};

		try {
			const first = await captureWithAtomicPin(f, testEnv);
			expect(first).toMatchObject({ outcome: "transport_error", complete: false });
			const run = await env.DB.prepare(
				"SELECT id, provider, model, attempts FROM semantic_atom_capture_runs WHERE user_id = ?",
			).bind(f.userId).first();
			expect(run).toMatchObject({ provider: "google-vertex", model: "gemini-2.5-flash", attempts: 1 });

			// A newer parent extraction/policy pin points at Workers AI. Reclaim must
			// ignore it and execute the exact provider/model claimed by this atom run.
			const replay = await captureWithAtomicPin(f, testEnv, {
				route: { provider: "workers-ai", model: null },
			});
			expect(replay).toMatchObject({ outcome: "completed", complete: true, stored: 1 });
			expect(calls).toEqual([
				{
					provider: "google-vertex",
					model: "gemini-2.5-flash",
					reservationId: atomicCaptureProviderOperationId(run.id, 1),
				},
				{
					provider: "google-vertex",
					model: "gemini-2.5-flash",
					reservationId: atomicCaptureProviderOperationId(run.id, 2),
				},
			]);
		} finally {
			provider.invoke = originalInvoke;
		}
	});

	it("mints a new persisted attempt only after the prior provider reservation is proven released", async () => {
		resetProviderBudgetForTests();
		const f = await fixture("provider-attempt-released");
		const testEnv = googleAtomicEnv(f.testEnv);
		const provider = await resolveProvider("google-vertex");
		const originalInvoke = provider.invoke;
		const reservationIds = [];
		let releaseRetryProvider;
		let signalRetryProviderStarted;
		const retryProviderStarted = new Promise((resolve) => { signalRetryProviderStarted = resolve; });
		const retryProviderRelease = new Promise((resolve) => { releaseRetryProvider = resolve; });
		provider.invoke = async (_providerEnv, call) => {
			reservationIds.push(call.meta.reservationId);
			if (reservationIds.length === 1) {
				throw Object.assign(new Error("explicit unbilled provider response"), {
					status: 503,
					retryable: false,
					aiErrorClass: "provider_unavailable",
				});
			}
			signalRetryProviderStarted();
			await retryProviderRelease;
			return {
				atoms: [atom()],
				usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
			};
		};

		try {
			const first = await captureWithAtomicPin(f, testEnv, { schedulerCalls: 2 });
			expect(first).toMatchObject({ outcome: "transport_error", complete: false, stored: 0 });
			const run = await env.DB.prepare(
				"SELECT id, attempts FROM semantic_atom_capture_runs WHERE user_id = ?",
			).bind(f.userId).first();
			expect(reservationIds).toEqual([atomicCaptureProviderOperationId(run.id, 1)]);
			expect(await env.DB.prepare(
				"SELECT status FROM ai_provider_reservations WHERE id = ?",
			).bind(reservationIds[0]).first()).toEqual({ status: "released" });
			expect(await hasRecoverableAtomicCaptureInterruption(
				testEnv,
				f.userId,
				f.sourcePacketId,
				{ projectId: f.projectId },
			)).toBe(true);

			// The reservation ledger, not a timeout guess, authorizes the next
			// persisted attempt. Two concurrent reclaimers use different scheduler
			// orders; the fenced run claim permits exactly one attempt-2 invocation.
			const replayPromise = captureWithAtomicPin(f, testEnv, { schedulerCalls: 0 });
			await retryProviderStarted;
			const concurrentReplay = await captureWithAtomicPin(f, testEnv, { schedulerCalls: 5 });
			expect(concurrentReplay).toMatchObject({ outcome: "in_progress", complete: false, replayed: true });
			releaseRetryProvider();
			const replay = await replayPromise;
			expect(replay).toMatchObject({ outcome: "completed", complete: true, stored: 1 });
			expect(reservationIds).toEqual([
				atomicCaptureProviderOperationId(run.id, 1),
				atomicCaptureProviderOperationId(run.id, 2),
			]);
			expect(await env.DB.prepare(
				"SELECT attempts, status FROM semantic_atom_capture_runs WHERE id = ?",
			).bind(run.id).first()).toEqual({ attempts: 2, status: "completed" });
			expect((await env.DB.prepare(
				"SELECT status FROM ai_provider_reservations WHERE id = ?",
			).bind(reservationIds[1]).first()).status).toBe("settled");
		} finally {
			provider.invoke = originalInvoke;
		}
	});

	it("deduplicates the same source atom when a later rescue reshapes the chunk", async () => {
		const f = await fixture("rechunk");
		await extract(f, { atoms: [atom()] });
		const secondMessage = {
			id: "m2",
			role: "user",
			content: "Northwind also uses Go.",
			ts: f.message.ts + 1,
		};
		await writeSourceEpisodes(f.testEnv, f.userId, {
			sourcePacketId: f.sourcePacketId,
			messages: [f.message, secondMessage],
			projectId: f.projectId,
			projectName: "Project A",
			rules: RULES,
			acceptedAt: f.message.ts,
			required: true,
		});
		const second = await runExtraction(f.testEnv, f.userId, [f.message, secondMessage], [], {
			llmResponse: EMPTY_GRAPH,
			atomicLlmResponse: { atoms: [atom()] },
			meta: {
				source_packet_id: f.sourcePacketId,
				accepted_at: f.message.ts,
				project_id: f.projectId,
				project_name: "Project A",
			},
		});
		expect(second.receipt).toMatchObject({
			atomic_capture_accepted: 1,
			atomic_capture_stored: 0,
			atomic_capture_duplicates: 1,
		});
		const durable = await atomicCaptureSummaryForExtractionRun(
			env,
			f.userId,
			second.receipt.extraction_run_id,
		);
		expect(durable).toMatchObject({ accepted: 1, stored: 0, duplicates: 1 });
		expect(await countSemanticAtomCandidates(env, f.userId)).toBe(1);
	});

	it("rejects inexact evidence without manufacturing a durable candidate", async () => {
		const f = await fixture("inexact");
		const result = await extract(f, { atoms: [atom("m1", { evidence_quote: "uses Prisma" })] });
		expect(result.receipt).toMatchObject({
			atomic_capture_outcome: "completed",
			atomic_capture_accepted: 0,
			atomic_capture_stored: 0,
			atomic_capture_rejected: 1,
		});
		expect(await countSemanticAtomCandidates(env, f.userId)).toBe(0);
	});

	it("binds candidate writes to tenant and project with no flag bleed", async () => {
		const f = await fixture("scope", { projectId: "project-private" });
		const controlId = `atomic-control-${crypto.randomUUID()}`;
		const controlEnv = {
			...f.testEnv,
			ITSUKI_MEMORY_V3_USERS: `${f.userId},${controlId}`,
			ITSUKI_MEMORY_V3_ATOMIC_CAPTURE_USERS: f.userId,
		};
		await extract({ ...f, testEnv: controlEnv }, { atoms: [atom()] });

		const otherPacket = `packet-${crypto.randomUUID()}`;
		await writeSourceEpisodes(controlEnv, controlId, {
			sourcePacketId: otherPacket,
			messages: [f.message],
			projectId: "project-other",
			rules: RULES,
			acceptedAt: f.message.ts,
			required: true,
		});
		const control = await runExtraction(controlEnv, controlId, [f.message], [], {
			llmResponse: EMPTY_GRAPH,
			atomicLlmResponse: { atoms: [atom()] },
			meta: { source_packet_id: otherPacket, accepted_at: f.message.ts, project_id: "project-other" },
		});
		expect(control.receipt.atomic_capture_enabled).toBe(false);
		expect(await countSemanticAtomCandidates(env, controlId)).toBe(0);
		const stored = await env.DB.prepare(
			"SELECT user_id, project_id FROM semantic_atom_candidates WHERE user_id = ?",
		).bind(f.userId).first();
		expect(stored).toEqual({ user_id: f.userId, project_id: "project-private" });
	});

	it("fails closed when extraction scope does not match the source episode", async () => {
		const f = await fixture("scope-mismatch", { projectId: "project-a" });
		const result = await runExtraction(f.testEnv, f.userId, [f.message], [], {
			llmResponse: EMPTY_GRAPH,
			atomicLlmResponse: { atoms: [atom()] },
			meta: {
				source_packet_id: f.sourcePacketId,
				accepted_at: f.message.ts,
				project_id: "project-b",
			},
		});
		expect(result.receipt).toMatchObject({
			atomic_capture_outcome: "source_episode_unavailable",
			atomic_capture_complete: false,
			atomic_capture_stored: 0,
		});
		expect(await countSemanticAtomCandidates(env, f.userId)).toBe(0);
	});

	it("hard-deletes candidates and terminal run state with their source episodes", async () => {
		const f = await fixture("erase");
		const result = await extract(f, { atoms: [atom()] });
		const summaryBefore = await atomicCaptureSummaryForExtractionRun(env, f.userId, result.receipt.extraction_run_id);
		expect(summaryBefore.stored).toBe(1);

		const deletion = await deleteSourceEpisodes(env, f.userId);
		expect(deletion).toMatchObject({ deleted: 1, atomicCandidatesDeleted: 1 });
		expect(await countSemanticAtomCandidates(env, f.userId)).toBe(0);
		const runs = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM semantic_atom_capture_runs WHERE user_id = ?",
		).bind(f.userId).first();
		expect(Number(runs.n)).toBe(0);
	});

	it("a post-inference erasure fence cancels the candidate commit", async () => {
		const f = await fixture("race");
		const response = async () => {
			await env.DB.prepare(
				`INSERT INTO deletion_barriers (user_id, barrier_at, created_at, by)
				 VALUES (?, ?, ?, 'test')
				 ON CONFLICT(user_id) DO UPDATE SET barrier_at = excluded.barrier_at`,
			).bind(f.userId, f.message.ts + 1, f.message.ts + 1).run();
			return { atoms: [atom()] };
		};
		const result = await extract(f, response);
		expect(result.receipt).toMatchObject({
			atomic_capture_outcome: "cancelled_by_delete",
			atomic_capture_complete: false,
			atomic_capture_stored: 0,
		});
		expect(await countSemanticAtomCandidates(env, f.userId)).toBe(0);
	});

	it("a post-inference erasure fence at the exact accepted millisecond cancels the candidate commit", async () => {
		const f = await fixture("race-equal-millisecond");
		const response = async () => {
			await env.DB.prepare(
				`INSERT INTO deletion_barriers (user_id, barrier_at, created_at, by)
				 VALUES (?, ?, ?, 'test')
				 ON CONFLICT(user_id) DO UPDATE SET barrier_at = excluded.barrier_at`,
			).bind(f.userId, f.message.ts, f.message.ts).run();
			return { atoms: [atom()] };
		};
		const result = await extract(f, response);
		expect(result.receipt).toMatchObject({
			atomic_capture_outcome: "cancelled_by_delete",
			atomic_capture_complete: false,
			atomic_capture_stored: 0,
		});
		expect(await countSemanticAtomCandidates(env, f.userId)).toBe(0);
	});

	it("does not create a late capture-run residue when erasure wins before the atomic claim", async () => {
		const f = await fixture("barrier-before-claim");
		await env.DB.prepare(
			`INSERT INTO deletion_barriers (user_id, barrier_at, created_at, by)
			 VALUES (?, ?, ?, 'test')
			 ON CONFLICT(user_id) DO UPDATE SET barrier_at = excluded.barrier_at`,
		).bind(f.userId, f.message.ts + 1, f.message.ts + 1).run();
		let modelCalls = 0;
		const result = await captureAtomicCandidates(f.testEnv, {
			userId: f.userId,
			messages: [f.message],
			recent: [],
			rules: RULES,
			projectId: f.projectId,
			projectName: "Project A",
			sourcePacketId: f.sourcePacketId,
			extractionRunId: `run-${crypto.randomUUID()}`,
			acceptedAt: f.message.ts,
			override: () => {
				modelCalls += 1;
				return { atoms: [atom()] };
			},
		});

		expect(result).toMatchObject({ outcome: "cancelled_by_delete", complete: false, stored: 0 });
		expect(modelCalls).toBe(0);
		expect(await countSemanticAtomCandidates(env, f.userId)).toBe(0);
		const runs = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM semantic_atom_capture_runs WHERE user_id = ?",
		).bind(f.userId).first();
		expect(Number(runs.n)).toBe(0);
	});

	it("does not claim or call the model when erasure shares the accepted millisecond", async () => {
		const f = await fixture("barrier-equal-before-claim");
		await env.DB.prepare(
			`INSERT INTO deletion_barriers (user_id, barrier_at, created_at, by)
			 VALUES (?, ?, ?, 'test')
			 ON CONFLICT(user_id) DO UPDATE SET barrier_at = excluded.barrier_at`,
		).bind(f.userId, f.message.ts, f.message.ts).run();
		let modelCalls = 0;
		const result = await captureAtomicCandidates(f.testEnv, {
			userId: f.userId,
			messages: [f.message],
			recent: [],
			rules: RULES,
			projectId: f.projectId,
			projectName: "Project A",
			sourcePacketId: f.sourcePacketId,
			extractionRunId: `run-${crypto.randomUUID()}`,
			acceptedAt: f.message.ts,
			override: () => {
				modelCalls += 1;
				return { atoms: [atom()] };
			},
		});

		expect(result).toMatchObject({ outcome: "cancelled_by_delete", complete: false, stored: 0 });
		expect(modelCalls).toBe(0);
		expect(await countSemanticAtomCandidates(env, f.userId)).toBe(0);
		const runs = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM semantic_atom_capture_runs WHERE user_id = ?",
		).bind(f.userId).first();
		expect(Number(runs.n)).toBe(0);
	});

	it("does not call the model or register a tenant after its managed project is quiesced", async () => {
		const f = await fixture("project-quiesced");
		const at = Date.now();
		await env.DB.prepare(
			`INSERT INTO managed_projects
			 (id, owner_user_id, memory_owner_user_id, name, name_normalized, is_default, status,
			  created_at, updated_at, archived_at)
			 VALUES (?, ?, ?, 'Quiesced atomic', 'quiesced atomic', 0, 'archived', ?, ?, ?)`,
		).bind(f.projectId, f.userId, f.userId, at, at, at).run();
		let modelCalls = 0;
		const result = await captureAtomicCandidates(f.testEnv, {
			userId: f.userId,
			memoryOwnerUserId: f.userId,
			managedProjectId: f.projectId,
			messages: [f.message],
			recent: [],
			rules: RULES,
			projectId: f.projectId,
			projectName: "Quiesced atomic",
			sourcePacketId: f.sourcePacketId,
			extractionRunId: `run-${crypto.randomUUID()}`,
			acceptedAt: f.message.ts,
			override: () => {
				modelCalls += 1;
				return { atoms: [atom()] };
			},
		});
		expect(result).toMatchObject({ outcome: "cancelled_by_delete", complete: false, stored: 0 });
		expect(modelCalls).toBe(0);
		expect(Number((await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM semantic_atom_capture_runs WHERE user_id = ?",
		).bind(f.userId).first()).n)).toBe(0);
		expect(Number((await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM project_memory_spaces WHERE project_id = ?",
		).bind(f.projectId).first()).n)).toBe(0);
	});

	it("records malformed output as a terminal typed failure without raw output", async () => {
		const f = await fixture("failure");
		const result = await extract(f, "private source-shaped garbage that must never be stored");
		expect(result.receipt).toMatchObject({
			atomic_capture_outcome: "parse_invalid",
			atomic_capture_complete: false,
			atomic_capture_stored: 0,
		});
		const run = await env.DB.prepare(
			"SELECT status, error_code FROM semantic_atom_capture_runs WHERE user_id = ?",
		).bind(f.userId).first();
		expect(run).toEqual({ status: "failed", error_code: "parse_invalid" });
		const rawLeak = await env.DB.prepare(
			`SELECT COUNT(*) AS n FROM semantic_atom_capture_runs
			 WHERE user_id = ? AND CAST(COALESCE(error_code, '') AS TEXT) LIKE '%private source-shaped%'`,
		).bind(f.userId).first();
		expect(Number(rawLeak.n)).toBe(0);
	});
});
