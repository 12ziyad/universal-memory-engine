/**
 * Durability: the spool is the only thing standing between a settled turn and
 * the ~20ms gap Phase 0 measured between `session.idle` and process exit.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Spool, SPOOL_LIMITS, SPOOL_SCHEMA, type SpoolEnvelope } from "../src/spool.js";

let root: string;

const envelope = (key: string, content = "hello"): SpoolEnvelope => ({
	schema: SPOOL_SCHEMA,
	idempotencyKey: key,
	scope: { source: "opencode", conversationId: "ses_1" },
	messages: [{ role: "user", content }],
	discriminator: null,
	stagedAt: Date.now(),
	attempts: 0,
});

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "itsuki-spool-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("atomic staging", () => {
	it("stages an envelope and reads it back", () => {
		const spool = new Spool(root);
		expect(spool.stage(envelope("k1"))).toBe(true);
		const listed = spool.list();
		expect(listed).toHaveLength(1);
		expect(listed[0]!.envelope.idempotencyKey).toBe("k1");
	});

	it("leaves no temp files behind — a crash must never expose a partial write", () => {
		const spool = new Spool(root);
		spool.stage(envelope("k1"));
		const names = readdirSync(join(root, "spool"));
		expect(names.every((n) => n.endsWith(".json"))).toBe(true);
		expect(names.some((n) => n.includes(".tmp"))).toBe(false);
	});

	it("is idempotent: the same key never produces a second envelope", () => {
		const spool = new Spool(root);
		expect(spool.stage(envelope("dup"))).toBe(true);
		expect(spool.stage(envelope("dup"))).toBe(true);
		expect(spool.list()).toHaveLength(1);
	});

	it("survives a simulated crash: envelopes staged by a dead process are found by a new one", () => {
		const first = new Spool(root);
		first.stage(envelope("k1"));
		first.stage(envelope("k2"));
		// A brand-new instance is what the next `opencode run` gets.
		const second = new Spool(root);
		expect(second.list().map((e) => e.envelope.idempotencyKey).sort()).toEqual(["k1", "k2"]);
	});

	it("refuses an envelope larger than the cap rather than storing it", () => {
		const spool = new Spool(root);
		const huge = envelope("big", "x".repeat(SPOOL_LIMITS.maxEnvelopeBytes + 1_000));
		expect(spool.stage(huge)).toBe(false);
		expect(spool.list()).toHaveLength(0);
	});
});

describe("bounds and corruption", () => {
	it("enforces the depth bound, dropping oldest first and counting it", () => {
		const spool = new Spool(root);
		for (let i = 0; i < SPOOL_LIMITS.maxEnvelopes + 5; i += 1) spool.stage(envelope(`k${i}`));
		expect(spool.list().length).toBeLessThanOrEqual(SPOOL_LIMITS.maxEnvelopes);
		expect(spool.stats().dropped).toBeGreaterThan(0);
	});

	it("quarantines an unparseable file instead of crashing the listing", () => {
		const spool = new Spool(root);
		spool.stage(envelope("good"));
		writeFileSync(join(root, "spool", "corrupt.json"), "{ not json");
		const listed = spool.list();
		expect(listed.map((e) => e.envelope.idempotencyKey)).toEqual(["good"]);
		expect(spool.stats().quarantined).toBe(1);
	});

	it("quarantines a file with the wrong schema", () => {
		const spool = new Spool(root);
		mkdirSync(join(root, "spool"), { recursive: true });
		writeFileSync(join(root, "spool", "alien.json"), JSON.stringify({ schema: "someone-else/v9" }));
		expect(spool.list()).toHaveLength(0);
		expect(spool.stats().quarantined).toBe(1);
	});

	it("quarantine notes carry metadata only — never the payload", () => {
		const spool = new Spool(root);
		spool.stage(envelope("x"));
		writeFileSync(join(root, "spool", "corrupt.json"), "SUPER_SECRET_CONVERSATION_TEXT{{{");
		spool.list();
		const qdir = join(root, "quarantine");
		const notes = readdirSync(qdir).map((n) => readFileSync(join(qdir, n), "utf8"));
		expect(notes).toHaveLength(1);
		expect(notes[0]).not.toContain("SUPER_SECRET_CONVERSATION_TEXT");
		const parsed = JSON.parse(notes[0]!);
		expect(parsed).toMatchObject({ schema: "itsuki.opencode-quarantine/v1", reason: "unreadable" });
		expect(typeof parsed.bytes).toBe("number");
	});

	it("quarantines an envelope that exhausts its delivery attempts", () => {
		const spool = new Spool(root);
		spool.stage(envelope("doomed"));
		for (let i = 0; i < SPOOL_LIMITS.maxAttempts + 1; i += 1) {
			const listed = spool.list();
			if (listed.length === 0) break;
			spool.recordAttempt(listed[0]!.path, listed[0]!.envelope);
		}
		expect(spool.list()).toHaveLength(0);
		expect(spool.stats().quarantined).toBe(1);
	});
});

describe("filesystem hygiene", () => {
	it("derives filenames — a hostile idempotency key never becomes a path", () => {
		const spool = new Spool(root);
		const hostile = envelope("../../escape/../../etc/passwd");
		expect(spool.stage(hostile)).toBe(true);
		const names = readdirSync(join(root, "spool"));
		expect(names).toHaveLength(1);
		expect(names[0]).toMatch(/^[0-9a-f]{32}\.json$/);
		// Nothing was written outside the spool directory.
		expect(existsSync(join(root, "..", "etc"))).toBe(false);
	});

	it("removes a delivered envelope", () => {
		const spool = new Spool(root);
		spool.stage(envelope("k1"));
		const [entry] = spool.list();
		spool.remove(entry!.path);
		expect(spool.list()).toHaveLength(0);
		expect(spool.stats().depth).toBe(0);
	});
});
