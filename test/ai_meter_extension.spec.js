/**
 * Multi-provider accounting extension (migration 0052, Phase 0A).
 *
 * Three things this proves:
 *
 *   1. The meter records provider/capability/call_role metadata when a caller
 *      supplies it, and records NULLs — never guesses — when it doesn't. A
 *      NULL provider reads as "workers-ai", a NULL call_role as "primary".
 *   2. Failures carry a coarse, content-free error class. An adapter may
 *      pre-classify via error.aiErrorClass; nothing from the message content
 *      beyond known marker words is ever inspected.
 *   3. The playground_chat quota scope — published in GET /v1/limits since
 *      migration 0021 but never actually recorded before this change — now
 *      produces countable rows: one DISTINCT scope_id per turn.
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
	ensureProviderOperationIdentity,
	flushAiMeter,
	providerOperationId,
	runAi,
	tagAiMeter,
	withAiMeter,
	withFlushedAiMeter,
} from "../src/lib/ai_meter.js";
import { countWritesThisMonth } from "../src/lib/ai_budget.js";
import { buildPin, withAiPin } from "../src/ai/pin.js";
import { GOOGLE_DEFAULT_MODELS } from "../src/ai/providers/google/models.js";
import { resolveProvider } from "../src/ai/registry.js";

function fakeAi(response) {
	return { AI: { run: async () => {
		if (response instanceof Error) throw response;
		return response;
	} } };
}

const okResponse = { response: "ok", usage: { prompt_tokens: 5, completion_tokens: 7 } };

describe("stable provider operation identity", () => {
	it("is deterministic, content-free, and separates ordered calls", async () => {
		const base = { scope: "save", scopeId: "run_123", task: "extract" };
		const first = await providerOperationId({ ...base, ordinal: 0 });
		expect(first).toMatch(/^airesv_[0-9a-f]{64}$/);
		expect(await providerOperationId({ ...base, ordinal: 0 })).toBe(first);
		expect(await providerOperationId({ ...base, ordinal: 1 })).not.toBe(first);
		expect(first).not.toContain("run_123");
	});

	it("replays the same scope ids and preserves an explicit caller id", async () => {
		const collect = () => withAiMeter("save", async () => {
			tagAiMeter("run_replay");
			const one = await ensureProviderOperationIdentity({ task: "extract" });
			const explicit = await ensureProviderOperationIdentity({ task: "edges", reservationId: "caller-operation" });
			const three = await ensureProviderOperationIdentity({ task: "reflexion" });
			return [one.reservationId, explicit.reservationId, three.reservationId];
		});
		const firstRun = await collect();
		const replay = await collect();
		expect(replay).toEqual(firstRun);
		expect(firstRun[1]).toBe("caller-operation");
		expect(firstRun[0]).not.toBe(firstRun[2]);
	});

	it("keeps a lane identity stable when a different conditional lane is inserted", async () => {
		const collect = (tasks) => withAiMeter("save", async () => {
			tagAiMeter("run_conditional_lane");
			const ids = [];
			for (const task of tasks) {
				ids.push({ task, reservationId: (await ensureProviderOperationIdentity({ task })).reservationId });
			}
			return ids;
		});

		const withoutEdges = await collect(["extract", "reflexion"]);
		const withEdges = await collect(["extract", "edges", "reflexion"]);
		expect(withEdges.find((call) => call.task === "reflexion").reservationId)
			.toBe(withoutEdges.find((call) => call.task === "reflexion").reservationId);

		const repeated = await collect(["reflexion", "reflexion"]);
		expect(repeated[0].reservationId).not.toBe(repeated[1].reservationId);
	});

	it("does not consume a lane ordinal for an explicit same-task operation id", async () => {
		const collect = (includeExplicit) => withAiMeter("save", async () => {
			tagAiMeter("run_explicit_lane");
			const first = await ensureProviderOperationIdentity({ task: "reflexion" });
			const explicit = includeExplicit
				? await ensureProviderOperationIdentity({ task: "reflexion", reservationId: "caller-reflexion" })
				: null;
			const second = await ensureProviderOperationIdentity({ task: "reflexion" });
			return { first: first.reservationId, explicit: explicit?.reservationId ?? null, second: second.reservationId };
		});

		const baseline = await collect(false);
		const inserted = await collect(true);
		expect(inserted.explicit).toBe("caller-reflexion");
		expect(inserted.first).toBe(baseline.first);
		expect(inserted.second).toBe(baseline.second);
		expect(inserted.first).not.toBe(inserted.second);
	});

	it("does not invent an identity outside a durable metered scope", async () => {
		await expect(ensureProviderOperationIdentity({ task: "preview" })).resolves.toEqual({ task: "preview" });
	});
});

async function lastCallRow(userId) {
	return env.DB.prepare(
		`SELECT * FROM ai_calls WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
	).bind(userId).first();
}

function googleMeterEnv() {
	return Object.assign(Object.create(Object.getPrototypeOf(env)), env, {
		GCP_SERVICE_ACCOUNT: "{}",
		GCP_PROJECT_ID: "meter-spec-project",
	});
}

async function withStubbedGoogle(response, fn) {
	const provider = await resolveProvider("google-vertex");
	const originalInvoke = provider.invoke;
	const calls = [];
	provider.invoke = async (_env, call) => {
		calls.push(call);
		return response;
	};
	try {
		return await fn(calls);
	} finally {
		provider.invoke = originalInvoke;
	}
}

describe("provider metadata on the meter record", () => {
	it("records what the caller declares, and nulls when it declares nothing", async () => {
		const meter = await withAiMeter("save", async (m) => {
			await runAi(fakeAi(okResponse), "@cf/x/y", { messages: [] }, undefined, {
				task: "extract",
				capability: "generate_structured",
				provider: "workers-ai",
				callRole: "primary",
				retryCount: 0,
			});
			await runAi(fakeAi(okResponse), "@cf/x/y", { messages: [] }, undefined, { task: "legacy" });
			return m;
		});
		expect(meter.calls[0]).toMatchObject({
			provider: "workers-ai",
			capability: "generate_structured",
			call_role: "primary",
			retry_count: 0,
			error_class: null,
		});
		expect(meter.calls[1]).toMatchObject({
			provider: null,
			capability: null,
			call_role: null,
			retry_count: null,
			model_version: null,
		});
	});

	it("classifies failures coarsely and lets an adapter pre-classify", async () => {
		const abortish = new Error("The operation timed out");
		const preclassified = Object.assign(new Error("x"), { aiErrorClass: "rate_limited" });
		const meter = await withAiMeter("save", async (m) => {
			await expect(runAi(fakeAi(abortish), "@cf/x/y", {}, undefined, {})).rejects.toThrow();
			await expect(runAi(fakeAi(preclassified), "@cf/x/y", {}, undefined, {})).rejects.toThrow();
			await expect(runAi(fakeAi(new Error("boom")), "@cf/x/y", {}, undefined, {})).rejects.toThrow();
			return m;
		});
		expect(meter.calls.map((c) => c.error_class)).toEqual(["timeout", "rate_limited", "error"]);
		expect(meter.calls.every((c) => c.ok === 0)).toBe(true);
	});

	it("preserves attempted-provider provenance and the exact pinned admission refusal", async () => {
		const userId = `extrefusal-${crypto.randomUUID()}`;
		const pinnedEnv = Object.assign(Object.create(Object.getPrototypeOf(env)), env, {
			GCP_SERVICE_ACCOUNT: "",
			GCP_PROJECT_ID: "",
		});
		const pin = buildPin({
			routes: { extract: { provider: "google-vertex", model: "gemini-2.5-flash" } },
		});
		await expect(withFlushedAiMeter(pinnedEnv, "save", {
			userId,
			scopeId: `run-${crypto.randomUUID()}`,
		}, () => withAiPin(pin, () => runAi(
			pinnedEnv,
			"@cf/legacy/model",
			{ messages: [{ role: "user", content: "bounded test" }] },
			undefined,
			{ task: "extract" },
		)))).rejects.toMatchObject({
			aiErrorClass: "provider_refused",
			admissionReason: "no_credentials",
		});
		const row = await lastCallRow(userId);
		expect(row).toMatchObject({
			provider: "google-vertex",
			capability: "generate_structured",
			error_class: "admission_no_credentials",
			ok: 0,
		});
	});

	it("records the concrete Google transport model instead of the original Workers model", async () => {
		const userId = `ext-google-model-${crypto.randomUUID()}`;
		const reservationId = `ext-google-reservation-${crypto.randomUUID()}`;
		const googleEnv = googleMeterEnv();
		const pin = buildPin({
			routes: { extract: { provider: "google-vertex", model: GOOGLE_DEFAULT_MODELS.extract } },
		});
		await withStubbedGoogle(okResponse, async (calls) => {
			await withFlushedAiMeter(googleEnv, "provider_meter_spec", {
				userId,
				scopeId: `run-${crypto.randomUUID()}`,
			}, () => withAiPin(pin, () => runAi(
				googleEnv,
				"@cf/meta/legacy-workers-model",
				{ messages: [{ role: "user", content: "bounded test" }] },
				undefined,
				{ task: "extract", reservationId },
			)));
			expect(calls).toHaveLength(1);
			expect(calls[0].model).toBe(GOOGLE_DEFAULT_MODELS.extract);
		});
		const row = await lastCallRow(userId);
		expect(row).toMatchObject({
			provider: "google-vertex",
			model: GOOGLE_DEFAULT_MODELS.extract,
		});
	});

	it("records billable Google thought/tool output consistently with settlement", async () => {
		const userId = `ext-google-usage-${crypto.randomUUID()}`;
		const reservationId = `ext-google-usage-reservation-${crypto.randomUUID()}`;
		const googleEnv = googleMeterEnv();
		const pin = buildPin({
			routes: { extract: { provider: "google-vertex", model: GOOGLE_DEFAULT_MODELS.extract } },
		});
		const response = {
			response: "ok",
			usage: {
				prompt_tokens: 10,
				completion_tokens: 5,
				thoughts_tokens: 7,
				// The remaining eight output tokens represent billable tool-use
				// tokens included by Google only in total_tokens.
				total_tokens: 30,
			},
		};
		await withStubbedGoogle(response, () => withFlushedAiMeter(googleEnv, "provider_meter_spec", {
			userId,
			scopeId: `run-${crypto.randomUUID()}`,
		}, () => withAiPin(pin, () => runAi(
			googleEnv,
			"@cf/meta/legacy-workers-model",
			{ messages: [{ role: "user", content: "bounded test" }] },
			undefined,
			{ task: "extract", reservationId },
		))));

		const row = await lastCallRow(userId);
		expect(row).toMatchObject({
			input_tokens: 10,
			output_tokens: 20,
			total_tokens: 30,
		});
		const reservation = await env.DB.prepare(
			"SELECT status, actual_units FROM ai_provider_reservations WHERE id = ?",
		).bind(reservationId).first();
		expect(reservation).toEqual({ status: "settled", actual_units: 30 });
	});
});

describe("flush writes the 0052 columns", () => {
	it("persists provider metadata and reads NULL for legacy calls", async () => {
		const userId = `extmeter-${crypto.randomUUID()}`;
		const meter = await withAiMeter("save", async (m) => {
			await runAi(fakeAi(okResponse), "@cf/x/y", { messages: [] }, undefined, {
				task: "extract", capability: "generate_structured", provider: "workers-ai", callRole: "primary",
			});
			return m;
		});
		await flushAiMeter(env, userId, meter, {});
		const row = await lastCallRow(userId);
		expect(row).toMatchObject({
			provider: "workers-ai",
			capability: "generate_structured",
			call_role: "primary",
			error_class: null,
		});

		const legacy = await withAiMeter("save", async (m) => {
			await runAi(fakeAi(okResponse), "@cf/x/y", { messages: [] }, undefined, { task: "extract" });
			return m;
		});
		await flushAiMeter(env, userId, legacy, {});
		const legacyRow = await lastCallRow(userId);
		expect(legacyRow.provider).toBe(null);
		expect(legacyRow.call_role).toBe(null);
	});

	it("anonymizes every tenant locator when a subtenant/foreign-project meter flushes after account erasure", async () => {
		const accountUserId = `ext-erased-account-${crypto.randomUUID()}`;
		const memoryUserId = `ext-erased-subtenant-${crypto.randomUUID()}`;
		const scopeId = `ext-erased-run-${crypto.randomUUID()}`;
		const managedProjectId = `ext-erased-foreign-project-${crypto.randomUUID()}`;
		const task = `ext_erased_flush_${crypto.randomUUID()}`;
		const day = new Date().toISOString().slice(0, 10);
		const before = await env.DB.prepare(
			"SELECT calls, input_tokens, output_tokens FROM ai_daily_totals WHERE day = ?",
		).bind(day).first() ?? { calls: 0, input_tokens: 0, output_tokens: 0 };

		// The provider work began while the account was live. Account erasure then
		// linearized before the best-effort meter flush reached D1.
		const meter = await withAiMeter("save", async (activeMeter) => {
			tagAiMeter(scopeId);
			await runAi(fakeAi(okResponse), "@cf/x/y", { messages: [] }, undefined, {
				task,
				provider: "workers-ai",
				capability: "generate_structured",
			});
			return activeMeter;
		}, { memoryUserId, accountUserId, managedProjectId });
		await env.DB.prepare(
			"INSERT INTO account_erasure_tombstones (user_id, erased_at) VALUES (?, ?)",
		).bind(accountUserId, Date.now()).run();

		await flushAiMeter(env, memoryUserId, meter, { accountUserId, managedProjectId });

		const row = await env.DB.prepare(
			`SELECT user_id, account_user_id, scope, scope_id, managed_project_id,
				input_tokens, output_tokens, total_tokens
			 FROM ai_calls WHERE task = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
		).bind(task).first();
		expect(row).toMatchObject({
			user_id: null,
			account_user_id: null,
			scope: null,
			scope_id: null,
			managed_project_id: null,
			input_tokens: 5,
			output_tokens: 7,
			total_tokens: 12,
		});

		// Identity is gone, while the content-free aggregate spend truth remains.
		const after = await env.DB.prepare(
			"SELECT calls, input_tokens, output_tokens FROM ai_daily_totals WHERE day = ?",
		).bind(day).first();
		expect(Number(after.calls) - Number(before.calls)).toBe(1);
		expect(Number(after.input_tokens) - Number(before.input_tokens)).toBe(5);
		expect(Number(after.output_tokens) - Number(before.output_tokens)).toBe(7);
	});
});

describe("withFlushedAiMeter", () => {
	it("flushes on success with the given scope and scope id", async () => {
		const userId = `extflush-${crypto.randomUUID()}`;
		const out = await withFlushedAiMeter(env, "digest", { userId, scopeId: "packet-1" }, async () => {
			await runAi(fakeAi(okResponse), "@cf/d/igest", { messages: [] }, undefined, { task: "digest" });
			return "done";
		});
		expect(out).toBe("done");
		const row = await lastCallRow(userId);
		expect(row).toMatchObject({ scope: "digest", scope_id: "packet-1", task: "digest" });
	});

	it("flushes even when the wrapped work throws, and an empty meter writes nothing", async () => {
		const userId = `extthrow-${crypto.randomUUID()}`;
		await expect(withFlushedAiMeter(env, "title", { userId }, async () => {
			await runAi(fakeAi(new Error("boom")), "@cf/t/itle", {}, undefined, { task: "mcp_title" }).catch(() => {});
			throw new Error("caller failed after the model call");
		})).rejects.toThrow("caller failed");
		const row = await lastCallRow(userId);
		expect(row).toMatchObject({ scope: "title", ok: 0 });

		const emptyUser = `extempty-${crypto.randomUUID()}`;
		await withFlushedAiMeter(env, "digest", { userId: emptyUser }, async () => "no model call");
		expect(await lastCallRow(emptyUser)).toBe(null);
	});
});

describe("playground_chat finally counts against the published quota", () => {
	it("a flushed playground_chat scope with a scope_id is one monthly write", async () => {
		const userId = `extquota-${crypto.randomUUID()}`;
		const accountUserId = `extacct-${crypto.randomUUID()}`;
		const before = await countWritesThisMonth(env, { accountUserId });
		await withFlushedAiMeter(env, "playground_chat", {
			userId,
			lifecycle: { accountUserId },
		}, async () => {
			tagAiMeter("turn-message-1");
			await runAi(fakeAi(okResponse), "@cf/c/hat", { messages: [] }, undefined, { task: "playground_chat", capability: "chat" });
		});
		const after = await countWritesThisMonth(env, { accountUserId });
		expect(after).toBe(before + 1);

		// Same turn re-flushed (same scope_id) must not count twice.
		await withFlushedAiMeter(env, "playground_chat", { userId, lifecycle: { accountUserId } }, async () => {
			tagAiMeter("turn-message-1");
			await runAi(fakeAi(okResponse), "@cf/c/hat", { messages: [] }, undefined, { task: "playground_chat" });
		});
		expect(await countWritesThisMonth(env, { accountUserId })).toBe(before + 1);
	});
});
