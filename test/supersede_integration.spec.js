/**
 * SUPERSEDE-01 — integration level.
 *
 * The unit regressions in supersede_corrections.spec.js prove the predicate.
 * They did NOT prove the pipeline uses it: after deploying that work, the
 * production battery still measured 3/3 stale. This drives the real two-save
 * correction through the actual ingest path with canned extraction output
 * shaped like the model's real output, then reads the rows back — so "did the
 * old fact stop being current?" is answered by the database, not by inference.
 */

import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../src";

const headers = { "x-api-key": env.API_KEY, "content-type": "application/json" };

async function save(userId, content, llmResponse, key) {
	const request = new Request("http://example.com/v1/ingest", {
		method: "POST",
		headers,
		body: JSON.stringify({
			userId, flush: true, idempotencyKey: key,
			messages: [{ id: `m-${key}`, role: "user", content }],
			_test: { llmResponse },
		}),
	});
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return { status: response.status, body: await response.json() };
}

async function drain(userId) {
	const stub = env.USER_MEMORY.get(env.USER_MEMORY.idFromName(userId));
	for (let i = 0; i < 30; i++) {
		const pending = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM memory_jobs WHERE user_id = ? AND status NOT IN ('enriched','failed','completed')",
		).bind(userId).first();
		if (Number(pending?.n ?? 0) === 0) return;
		await runInDurableObject(stub, (instance) => instance.alarm());
		await new Promise((r) => setTimeout(r, 60));
	}
}

async function slicesFor(userId) {
	const { results } = await env.DB.prepare(
		"SELECT text, kind, is_current, deleted_at FROM slices WHERE user_id = ? ORDER BY created_at",
	).bind(userId).all();
	return results ?? [];
}

// Extraction output shaped the way the real model shapes it: the correction
// arrives as a DIFFERENT kind than the original, which is the whole point.
const V1 = {
	objects: [
		{ kind: "node", label: "Deploy runner", category: "other", confidence: 0.9 },
		{ kind: "slice", on: "Deploy runner", text: "uses blue-green cutover", kind_detail: "technical_detail", confidence: 0.9 },
	],
	notes: "",
};
const V2 = {
	objects: [
		{ kind: "node", label: "Deploy runner", category: "other", confidence: 0.9 },
		{ kind: "slice", on: "Deploy runner", text: "now uses canary cutover, not blue-green", kind_detail: "decision", confidence: 0.9 },
	],
	notes: "",
};

describe("a correction retires the conflicting fact through the real ingest path", () => {
	it("marks the superseded slice non-current while keeping the new one", async () => {
		const userId = `supersede-int-${crypto.randomUUID()}`;
		const r1 = await save(userId, "I decided the deploy runner uses blue-green cutover.", V1, `k1-${crypto.randomUUID()}`);
		expect(r1.status).toBe(200);
		await drain(userId);

		const afterV1 = await slicesFor(userId);
		expect(afterV1.some((s) => /blue-green/i.test(s.text) && s.is_current === 1)).toBe(true);

		const r2 = await save(userId, "Correction: the deploy runner now uses canary cutover, not blue-green.", V2, `k2-${crypto.randomUUID()}`);
		expect(r2.status).toBe(200);
		await drain(userId);

		const after = await slicesFor(userId);
		const old = after.filter((s) => /uses blue-green cutover/i.test(s.text));
		const fresh = after.filter((s) => /canary/i.test(s.text));
		// Diagnostic on failure: shows exactly what the pipeline left behind.
		console.error("SUPERSEDE-INT", JSON.stringify(after.map((s) => ({ t: s.text.slice(0, 46), k: s.kind, cur: s.is_current }))));

		expect(fresh.some((s) => s.is_current === 1), "the correction must be current").toBe(true);
		expect(old.every((s) => s.is_current === 0), "the corrected fact must stop being current").toBe(true);
		// History is preserved, not deleted.
		expect(old.every((s) => s.deleted_at === null)).toBe(true);
	});

	it("retires the conflicting fact through /v1/save too (the SDK's save() path)", async () => {
		// The production battery that measured 3/3 stale used the SDK's save(),
		// which posts /v1/save (manual lane) — NOT /v1/ingest. A fix that only
		// holds on the auto lane is not a fix for what users actually hit.
		const userId = `supersede-save-${crypto.randomUUID()}`;
		const post = async (content, llmResponse, key) => {
			const request = new Request("http://example.com/v1/save", {
				method: "POST",
				headers,
				body: JSON.stringify({ userId, content, idempotencyKey: key, _test: { llmResponse } }),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);
			return { status: response.status, body: await response.json() };
		};

		const a = await post("I decided the deploy runner uses blue-green cutover.", V1, `s1-${crypto.randomUUID()}`);
		expect(a.status).toBe(200);
		await drain(userId);
		const b = await post("Correction: the deploy runner now uses canary cutover, not blue-green.", V2, `s2-${crypto.randomUUID()}`);
		expect(b.status).toBe(200);
		await drain(userId);

		const after = await slicesFor(userId);
		console.error("SUPERSEDE-SAVE", JSON.stringify(after.map((s) => ({ t: s.text.slice(0, 46), k: s.kind, cur: s.is_current }))));
		const old = after.filter((s) => /uses blue-green cutover/i.test(s.text));
		const fresh = after.filter((s) => /canary/i.test(s.text));
		expect(fresh.some((s) => s.is_current === 1), "the correction must be current").toBe(true);
		expect(old.every((s) => s.is_current === 0), "the corrected fact must stop being current on the save lane").toBe(true);
	});

	it("closes the validity window on a relation the correction obsoletes", async () => {
		// Relations LEAD the recall context, so a correction that only retires
		// slices still shows the obsolete fact first. Measured live: slices went
		// non-current correctly while 2/3 scenarios stayed stale via edges.
		const userId = `supersede-edge-${crypto.randomUUID()}`;
		const withEdge = (fact, to, sliceText) => ({
			objects: [
				{ kind: "node", label: "Deploy runner", category: "other", confidence: 0.9 },
				{ kind: "node", label: to, category: "other", confidence: 0.9 },
				// Real extraction pairs a relation with a slice; an edge alone is
				// gated as meaningful_no_write.
				{ kind: "slice", on: "Deploy runner", text: sliceText, kind_detail: "technical_detail", confidence: 0.9 },
				// v2 shape: only v2 edges carry `fact`, which is what a correction
				// can conflict with. Legacy edges use the closed lowercase list.
				{ kind: "edge", _v2: true, from: "Deploy runner", to, type: "USES", fact, confidence: 0.9 },
			],
			notes: "",
		});
		await save(userId, "The deploy runner uses blue-green cutover.", withEdge("Deploy runner uses blue-green cutover", "blue-green cutover", "uses blue-green cutover"), `e1-${crypto.randomUUID()}`);
		await drain(userId);
		await save(userId, "Correction: the deploy runner now uses canary cutover, not blue-green.", withEdge("Deploy runner now uses canary cutover, not blue-green", "canary cutover", "now uses canary cutover, not blue-green"), `e2-${crypto.randomUUID()}`);
		await drain(userId);

		const { results } = await env.DB.prepare(
			"SELECT fact, invalid_at, deleted_at FROM edges WHERE user_id = ? ORDER BY created_at",
		).bind(userId).all();
		console.error("SUPERSEDE-EDGE", JSON.stringify((results ?? []).map((e) => ({ f: String(e.fact).slice(0, 44), inv: e.invalid_at !== null }))));
		const obsolete = (results ?? []).filter((e) => /blue-green cutover$/i.test(String(e.fact ?? "")));
		expect(obsolete.length).toBeGreaterThan(0);
		expect(obsolete.every((e) => e.invalid_at !== null), "the obsoleted relation must have a closed validity window").toBe(true);
		// Closed, not deleted — history stays queryable.
		expect(obsolete.every((e) => e.deleted_at === null)).toBe(true);
	});

	it("S3: a single-valued state change retires the old value without the user naming it", async () => {
		// "retention is now 30 days" names no old value, yet a reader must not
		// see both 14 and 30 as current. The signal is a copula attribute in
		// UPDATE MODE ("is now"): same attribute, different value.
		const userId = `supersede-s3-${crypto.randomUUID()}`;
		const attr = (text) => ({
			objects: [
				{ kind: "node", label: "Archive retention", category: "other", confidence: 0.9 },
				{ kind: "slice", on: "Archive retention", text, kind_detail: "technical_detail", confidence: 0.9 },
			],
			notes: "",
		});
		await save(userId, "The archive retention is 14 days.", attr("archive retention is 14 days"), `t1-${crypto.randomUUID()}`);
		await drain(userId);
		await save(userId, "The archive retention is now 30 days.", attr("archive retention is now 30 days"), `t2-${crypto.randomUUID()}`);
		await drain(userId);

		const after = await slicesFor(userId);
		console.error("SUPERSEDE-S3", JSON.stringify(after.map((s) => ({ t: s.text.slice(0, 40), cur: s.is_current }))));
		expect(after.filter((s) => /30 days/i.test(s.text)).some((s) => s.is_current === 1)).toBe(true);
		expect(after.filter((s) => /14 days/i.test(s.text)).every((s) => s.is_current === 0)).toBe(true);
	});

	it("S3 negative control: an additive multi-valued fact is NEVER retired", async () => {
		// The exact disaster to avoid: "uses D1" must survive "uses Vectorize".
		// Different predicate (uses, not a copula) — S3 must not fire.
		const userId = `supersede-s3neg-${crypto.randomUUID()}`;
		const attr = (text) => ({
			objects: [
				{ kind: "node", label: "Engine", category: "other", confidence: 0.9 },
				{ kind: "slice", on: "Engine", text, kind_detail: "technical_detail", confidence: 0.9 },
			],
			notes: "",
		});
		await save(userId, "The engine uses D1 for storage.", attr("uses D1 for storage"), `n1-${crypto.randomUUID()}`);
		await drain(userId);
		await save(userId, "The engine now uses Vectorize for embeddings.", attr("now uses Vectorize for embeddings"), `n2-${crypto.randomUUID()}`);
		await drain(userId);
		const after = await slicesFor(userId);
		expect(after.filter((s) => /D1/i.test(s.text)).some((s) => s.is_current === 1), "D1 must remain current").toBe(true);
		expect(after.filter((s) => /Vectorize/i.test(s.text)).some((s) => s.is_current === 1), "Vectorize must be current").toBe(true);
	});

	it("S1: retires a conflicting fact that landed on a DIFFERENT but identity-related node", async () => {
		// The model split one subject: the obsolete fact sits on "Deploy runner"
		// while the correction lands on "Deploy runner service". Label
		// containment + an explicitly named obsolete value is sufficient evidence.
		const userId = `supersede-s1-${crypto.randomUUID()}`;
		const on = (label, text) => ({
			objects: [
				{ kind: "node", label, category: "other", confidence: 0.9 },
				{ kind: "slice", on: label, text, kind_detail: "technical_detail", confidence: 0.9 },
			],
			notes: "",
		});
		await save(userId, "The deploy runner uses blue-green cutover.", on("Deploy runner", "uses blue-green cutover"), `a1-${crypto.randomUUID()}`);
		await drain(userId);
		await save(userId, "Correction: the deploy runner service now uses canary cutover, not blue-green.", on("Deploy runner service", "now uses canary cutover, not blue-green"), `a2-${crypto.randomUUID()}`);
		await drain(userId);

		const after = await slicesFor(userId);
		console.error("SUPERSEDE-S1", JSON.stringify(after.map((s) => ({ t: s.text.slice(0, 40), cur: s.is_current }))));
		expect(after.filter((s) => /canary/i.test(s.text)).some((s) => s.is_current === 1)).toBe(true);
		expect(after.filter((s) => /uses blue-green cutover/i.test(s.text)).every((s) => s.is_current === 0), "the cross-node obsolete fact must be retired").toBe(true);
	});

	it("S1 negative control: a same-worded fact about an UNRELATED node is untouched", async () => {
		// "blue" appears in both, but "Weather station" is not identity-related
		// to "Deploy runner", so its fact must survive.
		const userId = `supersede-s1neg-${crypto.randomUUID()}`;
		const on = (label, text) => ({
			objects: [
				{ kind: "node", label, category: "other", confidence: 0.9 },
				{ kind: "slice", on: label, text, kind_detail: "technical_detail", confidence: 0.9 },
			],
			notes: "",
		});
		await save(userId, "The weather station paints its roof blue-green.", on("Weather station", "paints its roof blue-green"), `w1-${crypto.randomUUID()}`);
		await drain(userId);
		await save(userId, "Correction: the deploy runner now uses canary cutover, not blue-green.", on("Deploy runner", "now uses canary cutover, not blue-green"), `w2-${crypto.randomUUID()}`);
		await drain(userId);
		const after = await slicesFor(userId);
		expect(after.filter((s) => /paints its roof/i.test(s.text)).every((s) => s.is_current === 1), "the unrelated node's fact must survive").toBe(true);
	});

	it("leaves legitimately co-existing facts current", async () => {
		const userId = `supersede-int-multi-${crypto.randomUUID()}`;
		const multi = (text, kind) => ({
			objects: [
				{ kind: "node", label: "Engine", category: "other", confidence: 0.9 },
				{ kind: "slice", on: "Engine", text, kind_detail: kind, confidence: 0.9 },
			],
			notes: "",
		});
		await save(userId, "The engine uses D1 for storage.", multi("uses D1 for storage", "technical_detail"), `m1-${crypto.randomUUID()}`);
		await drain(userId);
		await save(userId, "The engine uses Vectorize for embeddings.", multi("uses Vectorize for embeddings", "technical_detail"), `m2-${crypto.randomUUID()}`);
		await drain(userId);
		await save(userId, "The engine uses Durable Objects for coordination.", multi("uses Durable Objects for coordination", "technical_detail"), `m3-${crypto.randomUUID()}`);
		await drain(userId);

		const after = await slicesFor(userId);
		const current = after.filter((s) => s.is_current === 1).map((s) => s.text);
		// None of these corrects another: all three must survive as current.
		expect(current.some((t) => /D1/i.test(t))).toBe(true);
		expect(current.some((t) => /Vectorize/i.test(t))).toBe(true);
		expect(current.some((t) => /Durable Objects/i.test(t))).toBe(true);
	});
});

describe("SUPERSEDE-01 blanket-kind risk probe", () => {
	it("PROBE: an update-cued multi-valued 'uses' must not retire a sibling 'uses'", async () => {
		const userId = `s3probe-${crypto.randomUUID()}`;
		const attr = (text) => ({ objects: [ { kind: "node", label: "Engine", category: "other", confidence: 0.9 }, { kind: "slice", on: "Engine", text, kind_detail: "technical_detail", confidence: 0.9 } ], notes: "" });
		const save2 = async (content, llm, key) => {
			const request = new Request("http://example.com/v1/ingest", { method: "POST", headers, body: JSON.stringify({ userId, flush: true, idempotencyKey: key, messages: [{ id: `m-${key}`, role: "user", content }], _test: { llmResponse: llm } }) });
			const ctx = createExecutionContext(); const r = await worker.fetch(request, env, ctx); await waitOnExecutionContext(ctx); return r;
		};
		await save2("The engine uses D1 for storage.", attr("uses D1 for storage"), `p1-${crypto.randomUUID()}`);
		const stub = env.USER_MEMORY.get(env.USER_MEMORY.idFromName(userId));
		for (let i=0;i<25;i++){const p=await env.DB.prepare("SELECT COUNT(*) n FROM memory_jobs WHERE user_id=? AND status NOT IN ('enriched','failed','completed')").bind(userId).first(); if(Number(p?.n??0)===0)break; await runInDurableObject(stub,(x)=>x.alarm()); await new Promise(r=>setTimeout(r,60));}
		await save2("Actually, the engine uses Vectorize now.", attr("actually uses Vectorize now"), `p2-${crypto.randomUUID()}`);
		for (let i=0;i<25;i++){const p=await env.DB.prepare("SELECT COUNT(*) n FROM memory_jobs WHERE user_id=? AND status NOT IN ('enriched','failed','completed')").bind(userId).first(); if(Number(p?.n??0)===0)break; await runInDurableObject(stub,(x)=>x.alarm()); await new Promise(r=>setTimeout(r,60));}
		const { results } = await env.DB.prepare("SELECT text, is_current FROM slices WHERE user_id=?").bind(userId).all();
		console.error("S3PROBE", JSON.stringify((results||[]).map(s=>({t:s.text.slice(0,30),cur:s.is_current}))));
		expect((results||[]).filter(s=>/D1/i.test(s.text)).some(s=>s.is_current===1)).toBe(true);
	});
});
