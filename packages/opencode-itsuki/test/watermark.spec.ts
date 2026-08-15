/**
 * First-sight watermarks: the exactly-once story for forks, replays and
 * pre-install history.
 *
 * The owner's binding correction: the seed must land IMMEDIATELY BEFORE the
 * identified current human message, never at the transcript end — otherwise
 * the very turn the user just typed is swallowed. Phase 0 (P4) proved
 * `chat.message` supplies that boundary (messageID + time.created) before the
 * model runs, so these tests pin it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SessionStore, withinOwnedSpan } from "../src/sessionstate.js";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "itsuki-wm-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const msg = (id: string, createdAt: number | null) => ({ id, role: "user", createdAt, completedAt: null });

describe("seeding", () => {
	it("seeds at the current human message, which therefore stays capturable", () => {
		const store = new SessionStore(root);
		const state = store.seed("s1", "m_current", 1000);
		expect(state.seedMessageID).toBe("m_current");
		// The seed message itself is inside the owned span — this is the whole point.
		expect(withinOwnedSpan(state, msg("m_current", 1000))).toBe(true);
	});

	it("excludes everything strictly older than the seed (inherited history)", () => {
		const store = new SessionStore(root);
		const state = store.seed("s1", "m_current", 1000);
		expect(withinOwnedSpan(state, msg("m_old", 999))).toBe(false);
		expect(withinOwnedSpan(state, msg("m_ancient", 1))).toBe(false);
	});

	it("includes the assistant reply that follows the seed", () => {
		const store = new SessionStore(root);
		const state = store.seed("s1", "m_current", 1000);
		expect(withinOwnedSpan(state, { id: "m_reply", role: "assistant", createdAt: 1001, completedAt: 1002 })).toBe(true);
	});

	it("is idempotent: a later turn never moves the boundary forward", () => {
		const store = new SessionStore(root);
		store.seed("s1", "m_first", 1000);
		const again = store.seed("s1", "m_second", 5000);
		expect(again.seedMessageID).toBe("m_first");
		// A turn between the two seeds is still ours, not silently dropped.
		expect(withinOwnedSpan(again, msg("m_between", 2000))).toBe(true);
	});

	it("owns nothing at all before a seed exists", () => {
		const store = new SessionStore(root);
		const state = store.load("never-seeded");
		expect(withinOwnedSpan(state, msg("anything", 1))).toBe(false);
	});

	it("refuses to guess when timestamps are missing", () => {
		const store = new SessionStore(root);
		const state = store.seed("s1", "m_current", null);
		// Undatable history is not ours: capturing it is how duplicates appear.
		expect(withinOwnedSpan(state, msg("m_other", 1000))).toBe(false);
		// The seed message itself is still identifiable by id.
		expect(withinOwnedSpan(state, msg("m_current", null))).toBe(true);
	});
});

describe("fork and replay", () => {
	it("a fork starts fresh: copied history predates its own first sight", () => {
		const store = new SessionStore(root);
		// Original session, seeded early.
		store.seed("original", "m1", 1000);
		// The fork is a different session id and sees its first human turn later.
		const forked = store.seed("forked", "m9", 9000);
		// Every message copied from the original is older than the fork's seed.
		for (const id of ["m1", "m2", "m3"]) {
			expect(withinOwnedSpan(forked, msg(id, 1000))).toBe(false);
		}
		expect(withinOwnedSpan(forked, msg("m9", 9000))).toBe(true);
	});

	it("two genuinely separate identical prompts both remain capturable", () => {
		const store = new SessionStore(root);
		const a = store.seed("sessA", "mA", 1000);
		const b = store.seed("sessB", "mB", 1000);
		// Same text, same instant, different sessions and message ids: both ours.
		expect(withinOwnedSpan(a, msg("mA", 1000))).toBe(true);
		expect(withinOwnedSpan(b, msg("mB", 1000))).toBe(true);
	});

	it("a replayed idempotency key is recognised and not staged twice", () => {
		const store = new SessionStore(root);
		store.seed("s1", "m1", 1000);
		expect(store.hasKey("s1", "k-abc")).toBe(false);
		store.noteCaptured("s1", "k-abc", "m2", Date.now());
		expect(store.hasKey("s1", "k-abc")).toBe(true);
	});

	it("keeps the recent-key window bounded", () => {
		const store = new SessionStore(root);
		store.seed("s1", "m1", 1000);
		for (let i = 0; i < 200; i += 1) store.noteCaptured("s1", `k${i}`, `m${i}`, Date.now());
		expect(store.load("s1").recentKeys.length).toBeLessThanOrEqual(50);
		// The newest key survives; the oldest is evicted.
		expect(store.hasKey("s1", "k199")).toBe(true);
		expect(store.hasKey("s1", "k0")).toBe(false);
	});
});

describe("persistence across process restarts", () => {
	it("a new store instance reads the seed written by the previous one", () => {
		const first = new SessionStore(root);
		first.seed("s1", "m1", 1000);
		first.noteCaptured("s1", "k1", "m2", 1234);

		const second = new SessionStore(root);
		const state = second.load("s1");
		expect(state.seedMessageID).toBe("m1");
		expect(state.lastCapturedMessageID).toBe("m2");
		expect(second.hasKey("s1", "k1")).toBe(true);
	});

	it("a corrupt state file re-seeds rather than resurrecting old history", () => {
		const first = new SessionStore(root);
		first.seed("s1", "m1", 1000);
		// Corrupt it the way a half-written file would look.
		const fs = require("node:fs") as typeof import("node:fs");
		fs.writeFileSync(join(root, "sessions", "s1.json"), "{ truncated");

		const second = new SessionStore(root);
		const state = second.load("s1");
		expect(state.seedMessageID).toBeNull();
		// And with no seed, nothing is owned — so nothing is captured until the
		// next human turn re-seeds. Silence beats duplication.
		expect(withinOwnedSpan(state, msg("m1", 1000))).toBe(false);
	});

	it("forgetting a session removes its state", () => {
		const store = new SessionStore(root);
		store.seed("s1", "m1", 1000);
		store.forget("s1");
		expect(new SessionStore(root).load("s1").seedMessageID).toBeNull();
	});
});
