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

	it("closes a relation when the obsoleting language is only in the USER's message", async () => {
		// Production shape (SUPERSEDE-01 final): extraction normalizes
		// "now uses CircleCI, not Jenkins" into the clean fact "X uses CircleCI",
		// which names nothing obsolete. Reading conflict from the fact alone left
		// the Jenkins relation current — measured live on 57338efe.
		const userId = `supersede-srctext-${crypto.randomUUID()}`;
		const rel = (to, fact) => ({
			objects: [
				{ kind: "node", label: "Deploy runner", category: "other", confidence: 0.9 },
				{ kind: "node", label: to, category: "other", confidence: 0.9 },
				{ kind: "slice", on: "Deploy runner", text: `pipeline runs on ${to}`, kind_detail: "technical_detail", confidence: 0.9 },
				{ kind: "edge", _v2: true, from: "Deploy runner", to, type: "USES", fact, confidence: 0.9 },
			],
			notes: "",
		});
		await save(userId, "I decided the deploy runner uses Jenkins for its pipeline.",
			rel("Jenkins", "Deploy runner uses Jenkins"), `x1-${crypto.randomUUID()}`);
		await drain(userId);
		// The correction's EXTRACTED fact is clean; only the user text says "not Jenkins".
		await save(userId, "Correction: the deploy runner now uses CircleCI, not Jenkins.",
			rel("CircleCI", "Deploy runner uses CircleCI"), `x2-${crypto.randomUUID()}`);
		await drain(userId);

		const { results } = await env.DB.prepare(
			"SELECT fact, invalid_at FROM edges WHERE user_id = ? AND fact IS NOT NULL ORDER BY created_at",
		).bind(userId).all();
		console.error("SUPERSEDE-SRCTEXT", JSON.stringify((results ?? []).map((e) => ({ f: String(e.fact).slice(0, 36), inv: e.invalid_at !== null }))));
		const jenkins = (results ?? []).filter((e) => /jenkins/i.test(String(e.fact)));
		const circle = (results ?? []).filter((e) => /circleci/i.test(String(e.fact)));
		expect(jenkins.length).toBeGreaterThan(0);
		expect(jenkins.every((e) => e.invalid_at !== null), "the Jenkins relation must be closed").toBe(true);
		expect(circle.every((e) => e.invalid_at === null), "the CircleCI relation must stay current").toBe(true);
	});

	it("closes a fact-null legacy relation the correction obsoletes (production S1 shape)", async () => {
		// Measured live on aaeeac77 (a5-supersede-battery-v2.1786110506677): the
		// model emits a LEGACY edge alongside the v2 one — from/type/to only,
		// fact null — and the closure pass skipped every edge without fact text,
		// so "Deploy runner --uses--> Jenkins" stayed current after the
		// correction and recall still rendered Jenkins. The relation's assertion
		// IS its triple: from-label + type + to-label.
		const userId = `supersede-factnull-${crypto.randomUUID()}`;
		const rel = (to, fact) => ({
			objects: [
				{ kind: "node", label: "Deploy runner", category: "other", confidence: 0.9 },
				{ kind: "node", label: to, category: "other", confidence: 0.9 },
				{ kind: "slice", on: "Deploy runner", text: `pipeline runs on ${to}`, kind_detail: "technical_detail", confidence: 0.9 },
				// the legacy edge: closed lowercase vocabulary, never carries fact
				{ kind: "edge", from: "Deploy runner", to, type: "uses", confidence: 0.9 },
				// the v2 edge the model emits in parallel
				{ kind: "edge", _v2: true, from: "Deploy runner", to, type: "USES", fact, confidence: 0.9 },
			],
			notes: "",
		});
		await save(userId, "I decided the deploy runner uses Jenkins for its pipeline.",
			rel("Jenkins", "Deploy runner uses Jenkins"), `f1-${crypto.randomUUID()}`);
		await drain(userId);
		await save(userId, "Correction: the deploy runner now uses CircleCI, not Jenkins.",
			rel("CircleCI", "Deploy runner uses CircleCI"), `f2-${crypto.randomUUID()}`);
		await drain(userId);

		const { results } = await env.DB.prepare(
			`SELECT e.fact, e.type, e.invalid_at, e.deleted_at, tn.label AS to_label
			 FROM edges e JOIN nodes tn ON tn.id = e.to_node
			 WHERE e.user_id = ? ORDER BY e.created_at`,
		).bind(userId).all();
		console.error("SUPERSEDE-FACTNULL", JSON.stringify((results ?? []).map((e) => ({ t: e.type, to: e.to_label, f: e.fact !== null, inv: e.invalid_at !== null }))));
		const factNullJenkins = (results ?? []).filter((e) => e.fact === null && /jenkins/i.test(String(e.to_label)));
		expect(factNullJenkins.length).toBeGreaterThan(0);
		expect(factNullJenkins.every((e) => e.invalid_at !== null), "the fact-null Jenkins relation must be closed").toBe(true);
		expect(factNullJenkins.every((e) => e.deleted_at === null), "closed, not deleted — history stays queryable").toBe(true);
		const factNullCircle = (results ?? []).filter((e) => e.fact === null && /circleci/i.test(String(e.to_label)));
		expect(factNullCircle.every((e) => e.invalid_at === null), "the fact-null CircleCI relation must stay current").toBe(true);
	});

	it("S3 production shape: the copula lives only in the USER's message and the extractor drops the qualifier", async () => {
		// Measured live on d2c243f2 (a5-supersede-battery-v2.1786114431231):
		// v1's slice landed as "Cache backend is Redis" while extraction
		// mutilated the correction "Update: the <tag> cache backend is now
		// Memcached." into the fragment "now Memcached" — no copula, so the
		// attribute-change pass never fired. And the source attribute carries a
		// qualifier the v1 slice does not, so exact attribute equality would
		// still refuse. Both must be read the way eb7ecae reads obsoleting
		// language: from the user's words, with whole-token attribute
		// containment (the identityRelatedLabels standard).
		const userId = `supersede-s3src-${crypto.randomUUID()}`;
		const mk = (sliceText) => ({
			objects: [
				{ kind: "node", label: "Cache backend", category: "other", confidence: 0.9 },
				{ kind: "slice", on: "Cache backend", text: sliceText, kind_detail: "technical_detail", confidence: 0.9 },
			],
			notes: "",
		});
		await save(userId, "The itsuki cache backend is Redis.", mk("Cache backend is Redis"), `p1-${crypto.randomUUID()}`);
		await drain(userId);
		await save(userId, "Update: the itsuki cache backend is now Memcached.", mk("now Memcached"), `p2-${crypto.randomUUID()}`);
		await drain(userId);

		const after = await slicesFor(userId);
		console.error("SUPERSEDE-S3SRC", JSON.stringify(after.map((s) => ({ t: s.text.slice(0, 40), cur: s.is_current }))));
		expect(after.filter((s) => /redis/i.test(s.text)).every((s) => s.is_current === 0), "the old copula value must be retired from the user's words alone").toBe(true);
		expect(after.filter((s) => /memcached/i.test(s.text)).some((s) => s.is_current === 1), "the correction must be current").toBe(true);
	});

	it("S3 production shape: the attribute change lands on a SPLIT node (identity-related)", async () => {
		// Measured live on 42ffad14 (a5-supersede-battery-v2.1786115588860):
		// v1 wrote one node with "The <tag> cache backend is Redis."; the
		// correction's subject did not resolve onto it — TWO new nodes appeared
		// — so the same-node attribute scan missed and Redis stayed current
		// beside Memcached. Identity-related label + matching multi-token
		// attribute + copula + update mode is the same evidence standard S1
		// already accepts for named-obsolete widening.
		const userId = `supersede-s3split-${crypto.randomUUID()}`;
		const v1 = {
			objects: [
				{ kind: "node", label: "Cache backend", category: "other", confidence: 0.9 },
				{ kind: "slice", on: "Cache backend", text: "The 588860 cache backend is Redis.", kind_detail: "technical_detail", confidence: 0.9 },
			],
			notes: "",
		};
		const v2 = {
			objects: [
				{ kind: "node", label: "588860 cache backend", category: "other", confidence: 0.9 },
				{ kind: "node", label: "Memcached", category: "other", confidence: 0.9 },
				{ kind: "slice", on: "588860 cache backend", text: "now Memcached", kind_detail: "decision", confidence: 0.9 },
				{ kind: "edge", _v2: true, from: "588860 cache backend", to: "Memcached", type: "USES", fact: "The 588860 cache backend is now Memcached", confidence: 0.9 },
			],
			notes: "",
		};
		await save(userId, "The 588860 cache backend is Redis.", v1, `r1-${crypto.randomUUID()}`);
		await drain(userId);
		await save(userId, "Update: the 588860 cache backend is now Memcached.", v2, `r2-${crypto.randomUUID()}`);
		await drain(userId);

		const after = await slicesFor(userId);
		console.error("SUPERSEDE-S3SPLIT", JSON.stringify(after.map((s) => ({ t: s.text.slice(0, 40), cur: s.is_current }))));
		expect(after.filter((s) => /redis/i.test(s.text)).every((s) => s.is_current === 0), "the split-node copula value must be retired").toBe(true);
		expect(after.filter((s) => /memcached/i.test(s.text)).some((s) => s.is_current === 1)).toBe(true);
	});

	it("S3 split guard: the same attribute on an UNRELATED node survives an attribute change", async () => {
		// The reason widening was same-node-only: a same-worded attribute on a
		// DIFFERENT subject is ambiguous. Identity-relation is the boundary —
		// an unrelated label must never be reached.
		const userId = `supersede-s3split-neg-${crypto.randomUUID()}`;
		const v1 = {
			objects: [
				{ kind: "node", label: "Weather station", category: "other", confidence: 0.9 },
				{ kind: "slice", on: "Weather station", text: "cache backend is Redis", kind_detail: "technical_detail", confidence: 0.9 },
			],
			notes: "",
		};
		const v2 = {
			objects: [
				{ kind: "node", label: "Cache backend", category: "other", confidence: 0.9 },
				{ kind: "node", label: "Memcached", category: "other", confidence: 0.9 },
				{ kind: "slice", on: "Cache backend", text: "now Memcached", kind_detail: "decision", confidence: 0.9 },
			],
			notes: "",
		};
		await save(userId, "The weather station's cache backend is Redis.", v1, `u1-${crypto.randomUUID()}`);
		await drain(userId);
		await save(userId, "Update: the cache backend is now Memcached.", v2, `u2-${crypto.randomUUID()}`);
		await drain(userId);

		const after = await slicesFor(userId);
		expect(after.filter((s) => /redis/i.test(s.text)).every((s) => s.is_current === 1), "an unrelated node's attribute must survive").toBe(true);
	});

	it("S3 containment guard: a single generic attribute token never widens retirement", async () => {
		// "the retention is now 30 days" must NOT retire "archive retention is
		// 14 days" — a one-token attribute is too generic for containment; only
		// exact attribute equality or a >=2-token contained attribute may fire.
		const userId = `supersede-s3guard-${crypto.randomUUID()}`;
		const mk = (sliceText) => ({
			objects: [
				{ kind: "node", label: "Archive retention", category: "other", confidence: 0.9 },
				{ kind: "slice", on: "Archive retention", text: sliceText, kind_detail: "technical_detail", confidence: 0.9 },
			],
			notes: "",
		});
		await save(userId, "The archive retention is 14 days.", mk("archive retention is 14 days"), `q1-${crypto.randomUUID()}`);
		await drain(userId);
		await save(userId, "Update: the retention is now 30 days.", mk("retention is now 30 days"), `q2-${crypto.randomUUID()}`);
		await drain(userId);

		const after = await slicesFor(userId);
		console.error("SUPERSEDE-S3GUARD", JSON.stringify(after.map((s) => ({ t: s.text.slice(0, 40), cur: s.is_current }))));
		expect(after.filter((s) => /14 days/i.test(s.text)).every((s) => s.is_current === 1), "a generic one-token attribute must not retire the qualified one").toBe(true);
	});

	it("an edge-only correction retires the conflicting slice (production S2 shape)", async () => {
		// Measured live on 2e3790e4: "We changed the index from Postgres to
		// SQLite" extracted as RELATIONS only — no slice — so the slice conflict
		// pass never ran and v1's "stores its index in Postgres" slice stayed
		// current while every Postgres relation closed. Retirement must not
		// depend on which object kinds the correction's extraction happens to
		// emit.
		const userId = `supersede-edgeonly-${crypto.randomUUID()}`;
		const v1 = {
			objects: [
				{ kind: "node", label: "Catalog service", category: "other", confidence: 0.9 },
				{ kind: "node", label: "Postgres", category: "other", confidence: 0.9 },
				{ kind: "slice", on: "Catalog service", text: "stores its index in Postgres", kind_detail: "technical_detail", confidence: 0.9 },
				{ kind: "edge", _v2: true, from: "Catalog service", to: "Postgres", type: "USES", fact: "Catalog service stores its index in Postgres", confidence: 0.9 },
			],
			notes: "",
		};
		// The correction emits ONLY relations — the shape measured in production.
		const v2 = {
			objects: [
				{ kind: "node", label: "Catalog service", category: "other", confidence: 0.9 },
				{ kind: "node", label: "SQLite", category: "other", confidence: 0.9 },
				{ kind: "edge", _v2: true, from: "Catalog service", to: "SQLite", type: "USES", fact: "Catalog service uses SQLite", confidence: 0.9 },
			],
			notes: "",
		};
		await save(userId, "The catalog service stores its index in Postgres.", v1, `h1-${crypto.randomUUID()}`);
		await drain(userId);
		await save(userId, "We changed the catalog service index from Postgres to SQLite.", v2, `h2-${crypto.randomUUID()}`);
		await drain(userId);

		const after = await slicesFor(userId);
		console.error("SUPERSEDE-EDGEONLY", JSON.stringify(after.map((s) => ({ t: s.text.slice(0, 40), cur: s.is_current }))));
		const postgres = after.filter((s) => /postgres/i.test(s.text));
		expect(postgres.length).toBeGreaterThan(0);
		expect(postgres.every((s) => s.is_current === 0), "the conflicting slice must be retired by an edge-only correction").toBe(true);
		expect(postgres.every((s) => s.deleted_at === null), "retired, not deleted — history stays readable").toBe(true);
	});

	it("edge-only negative control: an additive edge-only save retires no slice", async () => {
		// "uses D1" as a slice must survive an edge-only additive save about
		// Vectorize — the widened pass must not let a non-correction retire.
		const userId = `supersede-edgeonly-neg-${crypto.randomUUID()}`;
		const v1 = {
			objects: [
				{ kind: "node", label: "Engine", category: "other", confidence: 0.9 },
				{ kind: "node", label: "D1", category: "other", confidence: 0.9 },
				{ kind: "slice", on: "Engine", text: "uses D1 for storage", kind_detail: "technical_detail", confidence: 0.9 },
				{ kind: "edge", _v2: true, from: "Engine", to: "D1", type: "USES", fact: "Engine uses D1", confidence: 0.9 },
			],
			notes: "",
		};
		const v2 = {
			objects: [
				{ kind: "node", label: "Engine", category: "other", confidence: 0.9 },
				{ kind: "node", label: "Vectorize", category: "other", confidence: 0.9 },
				{ kind: "edge", _v2: true, from: "Engine", to: "Vectorize", type: "USES", fact: "Engine uses Vectorize", confidence: 0.9 },
			],
			notes: "",
		};
		await save(userId, "The engine uses D1 for storage.", v1, `j1-${crypto.randomUUID()}`);
		await drain(userId);
		await save(userId, "The engine also uses Vectorize for embeddings.", v2, `j2-${crypto.randomUUID()}`);
		await drain(userId);

		const after = await slicesFor(userId);
		expect(after.filter((s) => /D1/i.test(s.text)).every((s) => s.is_current === 1), "the additive edge-only save must retire nothing").toBe(true);
	});

	it("fact-null negative control: an additive statement never closes a fact-null relation", async () => {
		// "uses D1" and "uses Vectorize" co-exist as legacy triples too — the
		// triple resolution must not widen what a non-correction can retire.
		const userId = `supersede-factnull-neg-${crypto.randomUUID()}`;
		const rel = (to, fact) => ({
			objects: [
				{ kind: "node", label: "Engine", category: "other", confidence: 0.9 },
				{ kind: "node", label: to, category: "other", confidence: 0.9 },
				{ kind: "slice", on: "Engine", text: `uses ${to}`, kind_detail: "technical_detail", confidence: 0.9 },
				{ kind: "edge", from: "Engine", to, type: "uses", confidence: 0.9 },
				{ kind: "edge", _v2: true, from: "Engine", to, type: "USES", fact, confidence: 0.9 },
			],
			notes: "",
		});
		await save(userId, "The engine uses D1 for storage.", rel("D1", "Engine uses D1"), `g1-${crypto.randomUUID()}`);
		await drain(userId);
		await save(userId, "The engine also uses Vectorize for embeddings.", rel("Vectorize", "Engine uses Vectorize"), `g2-${crypto.randomUUID()}`);
		await drain(userId);

		const { results } = await env.DB.prepare(
			`SELECT e.fact, e.invalid_at, tn.label AS to_label
			 FROM edges e JOIN nodes tn ON tn.id = e.to_node
			 WHERE e.user_id = ? AND e.fact IS NULL ORDER BY e.created_at`,
		).bind(userId).all();
		expect((results ?? []).length).toBeGreaterThanOrEqual(2);
		expect((results ?? []).every((e) => e.invalid_at === null), "both fact-null relations must remain current").toBe(true);
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
