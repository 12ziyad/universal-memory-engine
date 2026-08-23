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
import { utcDayKey } from "./ai_budget.js";
import { managedMutationGuardStatement } from "./managed_projects.js";
import { guardModelInput } from "./model_input.js";
import { dispatchAi, providerUsageForAccounting } from "../ai/dispatch.js";

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
function lifecycleId(value) {
	if (typeof value !== "string") return null;
	const cleaned = value.trim();
	if (!cleaned || cleaned.length > 256 || /[\u0000-\u001f\u007f]/.test(cleaned)) return null;
	return cleaned;
}

function lifecycleTime(value) {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
}

function normalizedMeterLifecycle(input = {}) {
	return {
		memoryUserId: lifecycleId(input.memoryUserId ?? input.memory_user_id),
		accountUserId: lifecycleId(input.accountUserId ?? input.account_user_id),
		managedProjectId: lifecycleId(input.managedProjectId ?? input.managed_project_id),
		acceptedAt: lifecycleTime(input.acceptedAt ?? input.accepted_at),
		// This is deliberately not a generic "skip lifecycle" switch.  The only
		// allowed exemption is checked again against the provider_health scope at
		// admission and carries a fixed, synthetic prompt rather than user text.
		providerHealthSynthetic: input.providerHealthSynthetic === true,
	};
}

export function withAiMeter(scope, fn, lifecycle = {}) {
	const meter = {
		scope,
		scopeId: null,
		lifecycle: normalizedMeterLifecycle(lifecycle),
		calls: [],
		startedAt: Date.now(),
		// Calls are ordered independently inside each task/lane. Adding an
		// unrelated conditional lane must not change a later lane's durable
		// provider identity; repeated calls within one lane still receive 0,1,2…
		// without hashing prompts or storing content.
		providerOperationOrdinals: new Map(),
	};
	return meterStore.run(meter, () => fn(meter));
}

/** Tag the in-flight meter with the run it belongs to, once that id exists. */
export function tagAiMeter(scopeId, lifecycle = null) {
	const meter = currentMeter();
	if (meter && scopeId) meter.scopeId = scopeId;
	if (meter && lifecycle && typeof lifecycle === "object") {
		const next = normalizedMeterLifecycle({ ...(meter.lifecycle ?? {}), ...lifecycle });
		meter.lifecycle = next;
	}
}

/**
 * Server-owned lifecycle provenance handed to provider admission.  runAi
 * computes this from AsyncLocalStorage after overwriting any caller metadata,
 * so an SDK request cannot mint its own erasure/project exemption.
 */
function providerLifecycleFromMeter(meter) {
	if (!meter) return null;
	const lifecycle = normalizedMeterLifecycle(meter.lifecycle ?? {});
	const scope = lifecycleId(meter.scope);
	const scopeId = lifecycleId(meter.scopeId);
	const healthExempt = lifecycle.providerHealthSynthetic === true && scope === "provider_health";
	return {
		memoryUserId: healthExempt ? null : lifecycle.memoryUserId,
		accountUserId: healthExempt ? null : lifecycle.accountUserId,
		managedProjectId: healthExempt ? null : lifecycle.managedProjectId,
		acceptedAt: healthExempt ? null : lifecycle.acceptedAt,
		scope,
		scopeId,
		lifecycleExempt: healthExempt,
	};
}

/**
 * Content-free, deterministic identity for one provider operation.
 *
 * Do not include the model or request body: changing either while replaying
 * the same durable operation must surface as a reservation conflict, not mint
 * a second spend authorization. The provider ledger accepts this opaque id
 * and owns all retry/invocation state beneath it.
 */
export async function providerOperationId({ scope, scopeId, task = null, ordinal = 0 }) {
	const encoded = new TextEncoder().encode(JSON.stringify([
		String(scope ?? ""),
		String(scopeId ?? ""),
		String(task ?? ""),
		Math.max(0, Math.floor(Number(ordinal) || 0)),
	]));
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoded));
	return `airesv_${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Attach a stable reservation id when the current meter has a durable id. */
export async function ensureProviderOperationIdentity(meta = {}) {
	const meter = currentMeter();
	if (!meter?.scopeId) return meta;
	// A caller-owned durable id is outside the automatic lane sequence. A
	// conditional explicit operation must not shift later implicit identities.
	if (meta.reservationId != null) return meta;
	const task = String(meta.task ?? "");
	const ordinals = meter.providerOperationOrdinals instanceof Map
		? meter.providerOperationOrdinals
		: new Map();
	meter.providerOperationOrdinals = ordinals;
	const ordinal = Math.max(0, Math.floor(Number(ordinals.get(task)) || 0));
	ordinals.set(task, ordinal + 1);
	return {
		...meta,
		reservationId: await providerOperationId({
			scope: meter.scope,
			scopeId: meter.scopeId,
			task,
			ordinal,
		}),
	};
}

/**
 * One-shot metered scope for lanes that are not part of a save or recall:
 * digest, title pass, manual router, playground. Wraps `fn` in a fresh meter
 * and flushes it on the way out, so a single-call lane gets accounted without
 * threading meter lifecycle through its caller. Flush is best-effort and never
 * throws; an empty meter flushes to nothing.
 */
export async function withFlushedAiMeter(env, scope, { userId = null, scopeId = null, lifecycle = {} } = {}, fn) {
	return withAiMeter(scope, async (meter) => {
		if (scopeId) meter.scopeId = scopeId;
		try {
			return await fn(meter);
		} finally {
			await flushAiMeter(env, userId, meter, lifecycle);
		}
	}, {
		...lifecycle,
		memoryUserId: lifecycle.memoryUserId ?? lifecycle.memory_user_id ?? userId,
		acceptedAt: lifecycle.acceptedAt ?? lifecycle.accepted_at ?? Date.now(),
	});
}

/**
 * Coarse, content-free failure class for the accounting row. Provider adapters
 * may pre-classify by setting `error.aiErrorClass`; anything else falls back to
 * a shape sniff that never touches the message beyond known marker words.
 */
function errorClassOf(error) {
	if (typeof error?.aiMeterErrorClass === "string" && error.aiMeterErrorClass) return error.aiMeterErrorClass;
	if (typeof error?.aiErrorClass === "string" && error.aiErrorClass) return error.aiErrorClass;
	if (error?.code === "model_input_boundary") return "input_boundary";
	const marker = `${error?.name ?? ""} ${error?.code ?? ""} ${error?.message ?? ""}`.toLowerCase();
	if (marker.includes("abort") || marker.includes("timeout") || marker.includes("timed out")) return "timeout";
	return "error";
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
 * Since the provider layer landed, the model invocation itself lives behind
 * dispatchAi (src/ai/dispatch.js): with AI_ROUTING off — the default — that is
 * a zero-I/O pass-through to the Workers AI provider whose invoke is byte-for-
 * byte the call that used to live here, options-arity branch included. The
 * golden-forwarding spec holds that equivalence to the pre-refactor fixtures.
 */
export async function runAi(env, model, inputs, options, meta = {}) {
	const startedAt = Date.now();
	// Dispatch stamps routing provenance (provider/capability) onto meta for
	// the record below; copy so a caller's own object is never mutated.
	meta = { ...meta };
	let res;
	let ok = 1;
	let inputBoundary = null;
	let lastError = null;
	try {
		const guarded = guardModelInput(inputs, { model });
		inputs = guarded.inputs;
		inputBoundary = guarded.boundary;
		if (inputBoundary?.bounded) {
			logInputBoundary("ai_input_bounded", model, meta.task, inputBoundary);
		}
		meta = await ensureProviderOperationIdentity(meta);
		// Lifecycle admission is not request metadata.  It is a separate internal
		// argument derived from the active meter immediately before dispatch.
		res = await dispatchAi(env, {
			model,
			inputs,
			options,
			meta,
			lifecycle: providerLifecycleFromMeter(currentMeter()),
		});
		return res;
	} catch (error) {
		ok = 0;
		lastError = error;
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
					let usage = ok ? readUsage(res) : { input: null, output: null, total: null, neurons: null, raw: null };
					// Google bills generated thoughts/tool use even when those tokens are
					// absent from candidatesTokenCount. Reuse the exact normalization that
					// settles the provider reservation, while leaving legacy Workers usage
					// byte-for-byte on readUsage's historical path.
					if (ok && meta.invokedProvider === "google-vertex" && usage.raw) {
						const providerUsage = providerUsageForAccounting(meta.capability, inputs, res);
						usage = {
							...usage,
							input: providerUsage.inputTokens,
							output: providerUsage.outputTokens,
							total: providerUsage.actualUnits,
						};
					}
					meter.calls.push({
						model: String(meta.invokedModel ?? model ?? "unknown"),
					task: meta.task ?? null,
					input_tokens: usage.input,
					output_tokens: usage.output,
					total_tokens: usage.total,
					neurons: usage.neurons,
					duration_ms: Date.now() - startedAt,
					ok,
					raw_usage: usage.raw,
					input_boundary: inputBoundary?.bounded || inputBoundary?.error ? inputBoundary : null,
					// Multi-provider accounting (migration 0052). All optional and
					// NULL for legacy callers: NULL provider reads as workers-ai,
					// NULL call_role reads as primary.
					provider: meta.provider ?? null,
					capability: meta.capability ?? null,
					model_version: meta.modelVersion ?? null,
					error_class: ok ? null : errorClassOf(lastError),
					retry_count: Number.isFinite(meta.retryCount) ? meta.retryCount : null,
					call_role: meta.callRole ?? null,
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
export async function flushAiMeter(env, userId, meter, lifecycle = {}) {
	const calls = meter?.calls ?? [];
	if (!env?.DB || !calls.length) return meterTotals(meter);
	const now = Date.now();
	try {
		const accountUserId = lifecycle.accountUserId ?? lifecycle.account_user_id ?? null;
		const managedProjectId = lifecycle.managedProjectId ?? lifecycle.managed_project_id ?? null;
		const managedAccess = lifecycle.managedAccess ?? lifecycle.managed_access ?? "write";
		// Account erasure can linearize after a provider invocation but before this
		// best-effort flush. Resolve the account and its selected memory subtenant
		// together inside the INSERT transaction: a flush that wins first is deleted
		// by teardown; a tombstone that wins first strips every tenant locator while
		// retaining only content-free call/accounting evidence. This is especially
		// important for default-project SDK subjects where userId != accountUserId.
		const statements = calls.map((call) => env.DB.prepare(
			`WITH erasure_state(erased) AS (
				SELECT CASE WHEN EXISTS (
					SELECT 1 FROM account_erasure_tombstones
					WHERE user_id = ? OR user_id = ?
				) THEN 1 ELSE 0 END
			)
			 INSERT INTO ai_calls (id, user_id, scope, scope_id, model, task, input_tokens,
				output_tokens, total_tokens, neurons, duration_ms, ok, raw_usage_json, created_at,
				account_user_id, managed_project_id, provider, capability, model_version,
				error_class, retry_count, call_role)
			 SELECT ?,
				CASE WHEN erased = 1 THEN NULL ELSE ? END,
				CASE WHEN erased = 1 THEN NULL ELSE ? END,
				CASE WHEN erased = 1 THEN NULL ELSE ? END,
				?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
				CASE WHEN erased = 1 THEN NULL ELSE ? END,
				CASE WHEN erased = 1 THEN NULL ELSE ? END,
				?, ?, ?, ?, ?, ?
			 FROM erasure_state`,
		).bind(
			accountUserId,
			userId ?? null,
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
			// The ACCOUNT, not the rotatable memory subject: the monthly quota
			// counts this column, so a caller rotating body.userId cannot reset
			// their own budget. Legacy operator-door rows stay null.
			accountUserId,
			managedProjectId,
			call.provider ?? null,
			call.capability ?? null,
			call.model_version ?? null,
			call.error_class ?? null,
			call.retry_count ?? null,
			call.call_role ?? null,
		));
		// One upsert per flush keeps the circuit breaker's read a single-row
		// primary-key lookup. Only binding-reported neurons land here; the
		// derived estimate for unreported calls is computed at read time from
		// the token sums, labelled as derived.
		const finite = (key) => calls.map((c) => c[key]).filter((v) => Number.isFinite(v));
		const sumOf = (key) => finite(key).reduce((a, b) => a + b, 0);
		const measured = finite("neurons");
		statements.push(env.DB.prepare(
			`INSERT INTO ai_daily_totals (day, calls, input_tokens, output_tokens, measured_neurons, measured_neuron_calls, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(day) DO UPDATE SET
				calls = calls + excluded.calls,
				input_tokens = input_tokens + excluded.input_tokens,
				output_tokens = output_tokens + excluded.output_tokens,
				measured_neurons = measured_neurons + excluded.measured_neurons,
				measured_neuron_calls = measured_neuron_calls + excluded.measured_neuron_calls,
				updated_at = excluded.updated_at`,
		).bind(
			utcDayKey(now),
			calls.length,
			sumOf("input_tokens"),
			sumOf("output_tokens"),
			measured.reduce((a, b) => a + b, 0),
			measured.length,
			now,
		));
		// Managed work additionally retains its project authorization fence. Legacy
		// API tenants are arbitrary memory ids, while account-shaped identities on
		// every lane are independently anonymized by the tombstone-aware INSERT.
		await env.DB.batch(managedProjectId
			? [managedMutationGuardStatement(env, {
				accountUserId,
				projectId: managedProjectId,
				access: managedAccess,
				// This batch writes only accounting. If erasure already won, the
				// adjacent INSERT strips every tenant locator; rejecting it on the
				// old project capability would lose provider spend truth.
				allowErasedAccounting: true,
				memoryUserId: userId ?? null,
			}), ...statements]
			: statements);
	} catch (error) {
		console.warn("ai meter flush failed:", error?.message ?? error);
	}
	return meterTotals(meter);
}
