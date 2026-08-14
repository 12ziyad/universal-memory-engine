/**
 * Scale and boundedness: the behaviours that only matter once this is real
 * infrastructure — a thousand isolated tenants, a long-lived gateway, disks
 * that must not grow forever. Local simulation only; nothing here touches a
 * network.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { planBatches } from "../src/batching.js";
import { captureIdentity, senderTenant } from "../src/identity.js";
import { normalizeMessages, planCaptureSpan } from "../src/messages.js";
import { SESSION_LIMITS, SessionStore } from "../src/sessionstate.js";

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "openclaw-itsuki-scale-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("1,000 isolated tenants", () => {
	it("derives 1,000 distinct, collision-free sender tenants across 10 channels", () => {
		const tenants = new Set<string>();
		const channels = ["discord", "telegram", "whatsapp", "slack", "feishu", "signal", "matrix", "irc", "line", "sms"];
		for (const channel of channels) {
			for (let i = 0; i < 100; i += 1) {
				const tenant = senderTenant(channel, `user-${i}`);
				expect(tenant).toMatch(/^oc_[a-f0-9]{32}$/);
				tenants.add(tenant!);
			}
		}
		expect(tenants.size).toBe(1_000);
	});

	it("keeps 1,000 tenants' capture identities disjoint for identical content", () => {
		// Same sentence from a thousand different people: a thousand different
		// writes. Anything less is cross-tenant bleed.
		const keys = new Set<string>();
		for (let i = 0; i < 1_000; i += 1) {
			keys.add(captureIdentity(
				{ userId: `oc_${String(i).padStart(32, "0")}`, conversationId: "shared-channel", source: "openclaw" },
				[{ role: "user", content: "identical sentence" }],
			));
		}
		expect(keys.size).toBe(1_000);
	});
});

describe("long-lived gateway state stays bounded", () => {
	it("holds 1,000 concurrent session states and prunes past the bound", async () => {
		const store = new SessionStore(root);
		await store.init();
		// Write in modest parallel batches — a gateway serving many channels.
		const batch = 50;
		const total = SESSION_LIMITS.maxSessions + 76;
		for (let start = 0; start < total; start += batch) {
			await Promise.all(
				Array.from({ length: Math.min(batch, total - start) }, (_, i) => store.write(`session-${start + i}`, {
					schema: "itsuki.openclaw-session/v1",
					watermarkCount: start + i,
					watermarkDigest: "d",
					fingerprints: [],
					updatedAt: "",
				})),
			);
		}
		expect(await store.count()).toBe(total);
		await store.prune();
		expect(await store.count()).toBeLessThanOrEqual(SESSION_LIMITS.maxSessions);
		// A recently-active session survived pruning.
		const recent = await store.read(`session-${total - 1}`);
		expect(recent.watermarkCount).toBe(total - 1);
	}, 120_000);

	it("bounds fingerprints per session no matter how many turns inject", async () => {
		const store = new SessionStore(root);
		const fingerprints = Array.from({ length: 5_000 }, (_, i) => `sha256:${String(i).padStart(64, "0")}`);
		await store.write("busy-session", {
			schema: "itsuki.openclaw-session/v1",
			watermarkCount: 1,
			watermarkDigest: "d",
			fingerprints,
			updatedAt: "",
		});
		const state = await store.read("busy-session");
		expect(state.fingerprints.length).toBeLessThanOrEqual(SESSION_LIMITS.maxFingerprints);
		// The NEWEST fingerprints are the ones kept — recent injections matter most.
		expect(state.fingerprints.at(-1)).toBe(fingerprints.at(-1));
	});
});

describe("hostile message volumes stay bounded and fast", () => {
	it("normalizes a 10,000-entry hostile transcript without choking", () => {
		const hostile: unknown[] = [];
		for (let i = 0; i < 10_000; i += 1) {
			hostile.push(
				i % 5 === 0 ? { role: "user", content: `m${i}` }
				: i % 5 === 1 ? { role: "assistant", content: [{ type: "text", text: `a${i}` }] }
				: i % 5 === 2 ? { role: "tool", content: "noise" }
				: i % 5 === 3 ? null
				: { unexpected: true },
			);
		}
		const started = Date.now();
		const normalized = normalizeMessages(hostile);
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(normalized.length).toBe(4_000);
	});

	it("splits a giant span into bounded batches, deterministically", () => {
		const span = planCaptureSpan(
			Array.from({ length: 500 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `turn ${i} ${"x".repeat(500)}` })),
			{ count: 0, digest: "" },
			(t) => t,
		);
		const batches = planBatches(span.messages);
		expect(batches.length).toBeGreaterThan(1);
		for (const b of batches) {
			expect(b.length).toBeLessThanOrEqual(30);
		}
		expect(batches.flat().length).toBe(500);
	});
});
