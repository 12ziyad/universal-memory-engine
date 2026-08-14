/**
 * The spool is the only thing standing between "the network was down" and
 * "your memory is gone". These tests are about durability and honesty: an
 * envelope survives a crash, the same span never enqueues twice, and when the
 * bound is genuinely exceeded the loss is COUNTED rather than hidden.
 */

import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SPOOL_LIMITS, SPOOL_SCHEMA, Spool, type SpoolEnvelope } from "../src/spool.js";

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "openclaw-itsuki-spool-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

function envelope(key: string, content = "hello"): SpoolEnvelope {
	return {
		schema: SPOOL_SCHEMA,
		idempotencyKey: key,
		messages: [{ role: "user", content }],
		scope: { userId: null, conversationId: "sess", source: "pi" },
		createdAt: new Date().toISOString(),
		attempts: 0,
	};
}

describe("durability", () => {
	it("round-trips an envelope through the filesystem", async () => {
		const spool = new Spool(root);
		expect(await spool.enqueue(envelope("openclaw:v1:a"))).toBe(true);
		const listed = await spool.list();
		expect(listed.length).toBe(1);
		expect(listed[0]!.envelope.idempotencyKey).toBe("openclaw:v1:a");
		expect(listed[0]!.envelope.messages[0]!.content).toBe("hello");
	});

	it("leaves no partial file behind: only completed envelopes are visible", async () => {
		const spool = new Spool(root);
		await spool.enqueue(envelope("openclaw:v1:a"));
		// Everything in the spool directory must parse; temp files live elsewhere.
		const names = await readdir(join(root, "spool"));
		for (const name of names) expect(name.endsWith(".json")).toBe(true);
		expect((await spool.list()).length).toBe(names.length);
	});

	it("survives a process restart — a new instance sees the same queue", async () => {
		await new Spool(root).enqueue(envelope("openclaw:v1:a"));
		const reopened = new Spool(root);
		expect((await reopened.list()).length).toBe(1);
	});
});

describe("idempotent ownership", () => {
	it("enqueues the same span only once", async () => {
		const spool = new Spool(root);
		expect(await spool.enqueue(envelope("openclaw:v1:same"))).toBe(true);
		expect(await spool.enqueue(envelope("openclaw:v1:same"))).toBe(false);
		expect((await spool.list()).length).toBe(1);
	});

	it("keeps distinct spans distinct", async () => {
		const spool = new Spool(root);
		await spool.enqueue(envelope("openclaw:v1:a"));
		await spool.enqueue(envelope("openclaw:v1:b"));
		expect((await spool.list()).length).toBe(2);
	});
});

describe("bounds and honesty", () => {
	it("drops the oldest when full, and counts the loss", async () => {
		const spool = new Spool(root);
		for (let i = 0; i < SPOOL_LIMITS.maxEntries; i += 1) {
			await spool.enqueue({ ...envelope(`openclaw:v1:${i}`), createdAt: new Date(1_000 + i).toISOString() });
		}
		expect((await spool.stats()).depth).toBe(SPOOL_LIMITS.maxEntries);
		expect((await spool.stats()).dropped).toBe(0);

		await spool.enqueue({ ...envelope("openclaw:v1:new"), createdAt: new Date(9_999_999).toISOString() });
		const stats = await spool.stats();
		expect(stats.depth).toBe(SPOOL_LIMITS.maxEntries);
		// The loss is real and reported — never silently forgotten.
		expect(stats.dropped).toBe(1);
		const keys = (await spool.list()).map((e) => e.envelope.idempotencyKey);
		expect(keys).toContain("openclaw:v1:new");
		expect(keys).not.toContain("openclaw:v1:0");
	});

	it("refuses an oversized envelope and counts that too", async () => {
		const spool = new Spool(root);
		const huge = envelope("openclaw:v1:huge", "x".repeat(SPOOL_LIMITS.maxEnvelopeBytes + 10));
		expect(await spool.enqueue(huge)).toBe(false);
		const stats = await spool.stats();
		expect(stats.depth).toBe(0);
		expect(stats.dropped).toBe(1);
	});

	it("removes an unparseable file rather than retrying it forever, and counts it", async () => {
		const spool = new Spool(root);
		await spool.init();
		await writeFile(join(root, "spool", "corrupt.json"), "{ this is not json", "utf8");
		expect((await spool.list()).length).toBe(0);
		expect((await spool.stats()).dropped).toBe(1);
	});

	it("ignores an envelope written by a future schema rather than mis-sending it", async () => {
		const spool = new Spool(root);
		await spool.init();
		await writeFile(
			join(root, "spool", "future.json"),
			JSON.stringify({ ...envelope("openclaw:v1:future"), schema: "itsuki.openclaw-spool/v2" }),
			"utf8",
		);
		expect((await spool.list()).length).toBe(0);
	});
});

describe("delivery lifecycle", () => {
	it("removes an envelope once delivered", async () => {
		const spool = new Spool(root);
		await spool.enqueue(envelope("openclaw:v1:a"));
		const [entry] = await spool.list();
		await spool.remove(entry!.name);
		expect((await spool.stats()).depth).toBe(0);
	});

	it("records attempts without losing the payload", async () => {
		const spool = new Spool(root);
		await spool.enqueue(envelope("openclaw:v1:a"));
		const [entry] = await spool.list();
		await spool.update(entry!.name, { ...entry!.envelope, attempts: 3, lastErrorCode: "rate_limit" });
		const [after] = await spool.list();
		expect(after!.envelope.attempts).toBe(3);
		expect(after!.envelope.lastErrorCode).toBe("rate_limit");
		expect(after!.envelope.messages[0]!.content).toBe("hello");
	});

	it("drains oldest-first", async () => {
		const spool = new Spool(root);
		await spool.enqueue({ ...envelope("openclaw:v1:second"), createdAt: new Date(2_000).toISOString() });
		await spool.enqueue({ ...envelope("openclaw:v1:first"), createdAt: new Date(1_000).toISOString() });
		const order = (await spool.list()).map((e) => e.envelope.idempotencyKey);
		expect(order).toEqual(["openclaw:v1:first", "openclaw:v1:second"]);
	});
});
