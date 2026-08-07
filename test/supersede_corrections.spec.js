/**
 * SUPERSEDE-01 — a correction must retire the fact it corrects.
 *
 * Measured before this suite existed: 3/3 correction shapes left the OLD value
 * asserted as current alongside the new one (a5-supersede-trials), i.e. memory
 * held two contradictory "current" facts about one attribute. Two independent
 * root causes were traced:
 *
 *   1. UPDATE_MODE_RE never recognised "changed X from A to B" or a bare
 *      "is now B", so those corrections selected the NARROW supersede set
 *      (progress/preference only) and could never retire anything.
 *   2. Supersession is keyed on (node, kind). A correction the extractor files
 *      under a different kind than the original never matches the old row, so
 *      even a recognised correction ("Correction: … not blue-green") left the
 *      original current.
 *
 * The contract this suite pins is deliberately narrow: a correction retires
 * the CONFLICTING fact, and nothing else. Multi-valued facts that legitimately
 * co-exist ("uses D1", "uses Vectorize", "uses Durable Objects") must all stay
 * current, and superseded rows must remain readable as history.
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { detectUpdateMode, supersedesValue } from "../src/pipeline/corrections.js";

describe("correction language recognition (root cause 1)", () => {
	// Each of these is a real user correction. Every one must put the pipeline
	// into update mode, or the broad supersede set is never selected.
	const corrections = [
		"Correction: the deploy runner now uses canary cutover, not blue-green.",
		"We changed the catalog service index from Postgres to SQLite.",
		"The archive retention is now 30 days.",
		"Actually the queue is now Redis.",
		"The primary region is no longer us-east-1.",
		"We switched the build to Bazel.",
		"The dashboard moved to Grafana.",
		"Scratch that, the runner uses canary now.",
		"Update: the retention window is 30 days instead of 14.",
		"That's wrong — the service uses SQLite.",
	];
	for (const text of corrections) {
		it(`recognises: ${text.slice(0, 46)}…`, () => {
			expect(detectUpdateMode(text)).toBe(true);
		});
	}

	// Ordinary additive statements must NOT trip update mode: doing so would
	// select the broad supersede set and start retiring co-existing facts.
	const additions = [
		"I decided the billing service will use event sourcing.",
		"We use D1 for storage and Vectorize for embeddings.",
		"The pipeline runs nightly at 02:00.",
		"I prefer release notes in plain English sentences.",
		"The team added a new staging environment.",
	];
	for (const text of additions) {
		it(`does not trip on an addition: ${text.slice(0, 40)}…`, () => {
			expect(detectUpdateMode(text)).toBe(false);
		});
	}
});

describe("conflict detection decides what a correction retires (root cause 2)", () => {
	it("retires the fact naming the value the correction replaces, regardless of kind", () => {
		// The original was filed as technical_detail; the correction arrives as
		// decision. Kind equality would miss it — value conflict must not.
		const older = { id: "s1", kind: "technical_detail", text: "The deploy runner uses blue-green cutover." };
		const correction = { kind: "decision", text: "The deploy runner now uses canary cutover, not blue-green." };
		expect(supersedesValue(correction, older)).toBe(true);
	});

	it("retires across the 'changed from A to B' shape", () => {
		const older = { id: "s1", kind: "other", text: "The catalog service index is stored in Postgres." };
		const correction = { kind: "technical_detail", text: "We changed the catalog service index from Postgres to SQLite." };
		expect(supersedesValue(correction, older)).toBe(true);
	});

	it("retires a bare value update naming the old value", () => {
		const older = { id: "s1", kind: "other", text: "The archive retention is 14 days." };
		const correction = { kind: "other", text: "The archive retention is now 30 days instead of 14 days." };
		expect(supersedesValue(correction, older)).toBe(true);
	});

	it("does NOT retire a co-existing multi-valued fact", () => {
		// The single most important guard: "uses Vectorize" is not obsoleted by
		// "uses Durable Objects". Blanket same-node supersession would destroy
		// legitimate memory.
		const older = { id: "s1", kind: "technical_detail", text: "The engine uses Vectorize for embeddings." };
		const correction = { kind: "technical_detail", text: "The engine uses Durable Objects for coordination." };
		expect(supersedesValue(correction, older)).toBe(false);
	});

	it("does NOT retire an unrelated fact on the same node", () => {
		const older = { id: "s1", kind: "other", text: "The deploy runner is owned by the platform team." };
		const correction = { kind: "decision", text: "The deploy runner now uses canary cutover, not blue-green." };
		expect(supersedesValue(correction, older)).toBe(false);
	});

	it("does NOT retire a fact that merely shares a common word", () => {
		const older = { id: "s1", kind: "other", text: "The service runs in the blue building on Tuesdays." };
		const correction = { kind: "decision", text: "The deploy runner now uses canary cutover, not blue-green." };
		expect(supersedesValue(correction, older)).toBe(false);
	});

	it("is not fooled into retiring the correction's own new value", () => {
		const older = { id: "s1", kind: "other", text: "The deploy runner uses canary cutover." };
		const correction = { kind: "decision", text: "The deploy runner now uses canary cutover, not blue-green." };
		// The old row already states the NEW truth — retiring it would delete
		// the very fact the correction establishes.
		expect(supersedesValue(correction, older)).toBe(false);
	});
});

describe("superseded facts remain readable as history", () => {
	it("supersession marks is_current = 0 rather than deleting the row", async () => {
		// Provenance is a campaign requirement: a corrected fact must stop being
		// current WITHOUT losing the record that it was once true.
		const userId = `supersede-history-${crypto.randomUUID()}`;
		const nodeId = `node_${crypto.randomUUID()}`;
		const now = Date.now();
		await env.DB.prepare(
			`INSERT INTO nodes (id, user_id, label, category, state, summary, aliases_json, created_at, updated_at, last_seen_at, heat_score)
			 VALUES (?, ?, 'Deploy runner', 'other', 'active', '', '[]', ?, ?, ?, 1)`,
		).bind(nodeId, userId, now, now, now).run();
		await env.DB.prepare(
			`INSERT INTO slices (id, user_id, node_id, page_id, text, kind, is_current, created_at, last_seen_at)
			 VALUES (?, ?, ?, NULL, 'The deploy runner uses blue-green cutover.', 'technical_detail', 1, ?, ?)`,
		).bind(`slice_${crypto.randomUUID()}`, userId, nodeId, now, now).run();

		await env.DB.prepare(
			"UPDATE slices SET is_current = 0 WHERE user_id = ? AND node_id = ?",
		).bind(userId, nodeId).run();

		const row = await env.DB.prepare(
			"SELECT is_current, deleted_at, text FROM slices WHERE user_id = ? AND node_id = ?",
		).bind(userId, nodeId).first();
		expect(row.is_current).toBe(0);
		expect(row.deleted_at).toBeNull();
		expect(row.text).toContain("blue-green");
	});
});
