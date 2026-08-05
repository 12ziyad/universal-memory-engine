/**
 * Workers AI accounting — one choke point for every model call.
 *
 * Every `env.AI.run` in the pipeline goes through `runAi`, which records the
 * model, the tokens the binding reported, and how long it took. An
 * AsyncLocalStorage meter attributes those calls to the save (or recall) that
 * caused them, so nothing has to thread a context object through eleven call
 * sites — and so a call added in a new lane is counted automatically instead of
 * being forgotten.
 *
 * Two rules this module must never break:
 *
 *   1. In-budget inputs are forwarded untouched. Over-budget chat inputs pass
 *      through the deterministic model-input boundary before the binding, and
 *      an unsafe fixed prompt is rejected explicitly before inference.
 *   2. `neurons` is only ever set from a number Workers AI actually returned.
 *      Converting tokens to neurons is a guess; a guess does not belong in a
 *      column named after the billed unit. Conversion, when needed, happens in
 *      reporting where it can be labelled as derived.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { newId } from "./ids.js";
import { guardModelInput } from "./model_input.js";

const meterStore = new AsyncLocalStorage();

function logInputBoundary(event, model, task, boundary) {
	try {
		console.warn(JSON.stringify({
			event,
			model: String(model ?? "unknown"),
			task: task == null ? null : String(task),
			...boundary,
		}));
	} catch {
		// Boundary enforcement must not depend on observability succeeding.
	}
}

/** The meter for the work currently running, or null outside a metered scope. */
export function currentMeter() {
	return meterStore.getStore() ?? null;
}

/**
 * Run `fn` with a fresh meter attached. Returns whatever `fn` returns; the
 * meter is reachable during it via currentMeter() and is flushed by the caller.
 */
export function withAiMeter(scope, fn) {
	const meter = { scope, scopeId: null, calls: [], startedAt: Date.now() };
	return meterStore.run(meter, () => fn(meter));
}

/** Tag the in-flight meter with the run it belongs to, once that id exists. */
export function tagAiMeter(scopeId) {
	const meter = currentMeter();
	if (meter && scopeId) meter.scopeId = scopeId;
}

/**
 * Pull token counts out of a Workers AI response.
 *
 * Different model families report differently — OpenAI-shaped models use
 * prompt/completion_tokens, others use input/output. Anything unrecognized is
 * kept verbatim in `raw` so we find out rather than assume.
 */
export function readUsage(res) {
	const usage = res && typeof res === "object" ? (res.usage ?? res.meta?.usage ?? null) : null;
	if (!usage || typeof usage !== "object") return { input: null, output: null, total: null, neurons: null, raw: null };
	const num = (...keys) => {
		for (const key of keys) {
			const value = Number(usage[key]);
			if (Number.isFinite(value)) return value;
		}
		return null;
	};
	const input = num("prompt_tokens", "input_tokens", "inputTokens");
	const output = num("completion_tokens", "output_tokens", "outputTokens");
	const total = num("total_tokens", "totalTokens") ?? (input !== null && output !== null ? input + output : null);
	return {
		input,
		output,
		total,
		// Only if Workers AI hands one back. We do not invent this.
		neurons: num("neurons", "neuron_count", "billed_neurons"),
		raw: usage,
	};
}

/**
 * THE call site. Enforces the shared chat-context boundary, then records cost.
 *
 * `options` is forwarded only when defined, so a model that rejects a third
 * argument behaves exactly as it did before this wrapper existed.
 */
export async function runAi(env, model, inputs, options, meta = {}) {
	const startedAt = Date.now();
	let res;
	let ok = 1;
	let inputBoundary = null;
	try {
		const guarded = guardModelInput(inputs, { model });
		inputs = guarded.inputs;
		inputBoundary = guarded.boundary;
		if (inputBoundary?.bounded) {
			logInputBoundary("ai_input_bounded", model, meta.task, inputBoundary);
		}
		res = options === undefined
			? await env.AI.run(model, inputs)
			: await env.AI.run(model, inputs, options);
		return res;
	} catch (error) {
		ok = 0;
		if (!inputBoundary && error?.code === "model_input_boundary") {
			inputBoundary = error.metadata ?? null;
			logInputBoundary("ai_input_blocked", model, meta.task, inputBoundary);
		}
		throw error;
	} finally {
		// Accounting must never be able to break a save.
		try {
			const meter = currentMeter();
			if (meter) {
				const usage = ok ? readUsage(res) : { input: null, output: null, total: null, neurons: null, raw: null };
				meter.calls.push({
					model: String(model ?? "unknown"),
					task: meta.task ?? null,
					input_tokens: usage.input,
					output_tokens: usage.output,
					total_tokens: usage.total,
					neurons: usage.neurons,
					duration_ms: Date.now() - startedAt,
					ok,
					raw_usage: usage.raw,
					input_boundary: inputBoundary?.bounded || inputBoundary?.error ? inputBoundary : null,
				});
			}
		} catch (meterError) {
			console.warn("ai meter record failed:", meterError?.message ?? meterError);
		}
	}
}

/** Per-scope totals. Nulls stay null: a missing count is not a zero. */
export function meterTotals(meter) {
	const calls = meter?.calls ?? [];
	const sum = (key) => {
		const values = calls.map((c) => c[key]).filter((v) => Number.isFinite(v));
		return values.length ? values.reduce((a, b) => a + b, 0) : null;
	};
	return {
		calls: calls.length,
		input_tokens: sum("input_tokens"),
		output_tokens: sum("output_tokens"),
		total_tokens: sum("total_tokens"),
		neurons: sum("neurons"),
	};
}

/**
 * Write the meter out. Best-effort and never throws — a failed insert costs us
 * a measurement, and that must never cost the user their memory.
 */
export async function flushAiMeter(env, userId, meter) {
	const calls = meter?.calls ?? [];
	if (!env?.DB || !calls.length) return meterTotals(meter);
	const now = Date.now();
	try {
		await env.DB.batch(calls.map((call) => env.DB.prepare(
			`INSERT INTO ai_calls (id, user_id, scope, scope_id, model, task, input_tokens,
				output_tokens, total_tokens, neurons, duration_ms, ok, raw_usage_json, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(
			newId("aicall"),
			userId ?? null,
			meter.scope ?? null,
			meter.scopeId ?? null,
			call.model,
			call.task,
			call.input_tokens,
			call.output_tokens,
			call.total_tokens,
			call.neurons,
			call.duration_ms,
			call.ok,
			call.input_boundary
				? JSON.stringify({ provider: call.raw_usage, itsuki_input_boundary: call.input_boundary })
				: call.raw_usage ? JSON.stringify(call.raw_usage) : null,
			now,
		)));
	} catch (error) {
		console.warn("ai meter flush failed:", error?.message ?? error);
	}
	return meterTotals(meter);
}
