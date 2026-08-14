/**
 * Tenancy is the part of this adapter that could leak one person's memory to
 * another, so it gets attacked rather than merely exercised.
 *
 * Two hard rules:
 *   1. scope can only ever NARROW — the credential picks the project;
 *   2. a sender identity from one channel can never select another channel's
 *      (or another person's) memory space, and cannot be forged into one.
 */

import { describe, expect, it } from "vitest";

import { resolveConfig } from "../src/config.js";
import { senderTenant } from "../src/identity.js";
import { resolveScope } from "../src/index.js";

const ownerConfig = resolveConfig({});
const perSender = resolveConfig({ tenancy: "per-sender" });

describe("owner mode (the default)", () => {
	it("defaults to owner scope and ignores sender identity entirely", () => {
		expect(ownerConfig.tenancy).toBe("owner");
		const scope = resolveScope(ownerConfig, { channel: "discord", senderId: "user-1", sessionKey: "s1" });
		expect(scope.userId).toBeUndefined();
		expect(scope.conversationId).toBe("s1");
		expect(scope.source).toBe("openclaw");
	});

	it("uses a configured sub-tenant when the operator set one", () => {
		const config = resolveConfig({ userId: "team-a" });
		expect(resolveScope(config, { channel: "discord", senderId: "user-1" }).userId).toBe("team-a");
	});

	it("cannot be switched to per-sender by anything in the run context", () => {
		// A hostile channel payload must not be able to change the mode.
		const scope = resolveScope(ownerConfig, {
			channel: "discord",
			senderId: "user-1",
			// deliberately hostile extras
			...({ tenancy: "per-sender", userId: "victim", pluginConfig: { tenancy: "per-sender" } } as object),
		});
		expect(scope.userId).toBeUndefined();
	});
});

describe("per-sender mode", () => {
	it("derives a stable, one-way tenant from channel + sender", () => {
		const a = senderTenant("discord", "user-1");
		expect(a).toMatch(/^oc_[a-f0-9]{32}$/);
		expect(senderTenant("discord", "user-1")).toBe(a);
		// The raw platform id never appears in the tenant.
		expect(a).not.toContain("user-1");
	});

	it("NEVER collides across channels for the same sender id", () => {
		// Discord user ids and Feishu open_ids live in different namespaces and
		// can coincide; the channel must be part of the identity.
		expect(senderTenant("discord", "12345")).not.toBe(senderTenant("feishu", "12345"));
		expect(senderTenant("telegram", "12345")).not.toBe(senderTenant("slack", "12345"));
	});

	it("cannot be confused by concatenation boundaries", () => {
		// ("ab","c") and ("a","bc") must not hash alike.
		expect(senderTenant("ab", "c")).not.toBe(senderTenant("a", "bc"));
		expect(senderTenant("x:", "y")).not.toBe(senderTenant("x", ":y"));
	});

	it("separates two senders on the same channel", () => {
		expect(senderTenant("discord", "alice")).not.toBe(senderTenant("discord", "bob"));
	});

	it("falls back to owner scope when identity is missing, never inventing a tenant", () => {
		// System-originated runs (heartbeat, cron, exec-event) have no sender.
		expect(senderTenant("discord", undefined)).toBeNull();
		expect(senderTenant(undefined, "user-1")).toBeNull();
		expect(senderTenant("", "")).toBeNull();
		const scope = resolveScope(perSender, { sessionKey: "s1" });
		expect(scope.userId).toBeUndefined();
	});

	it("ignores non-string identity rather than coercing it", () => {
		expect(senderTenant(42 as unknown as string, "u")).toBeNull();
		expect(senderTenant("discord", { toString: () => "spoofed" } as unknown as string)).toBeNull();
	});

	it("produces a different memory space per sender in a real scope", () => {
		const alice = resolveScope(perSender, { channel: "discord", senderId: "alice", sessionKey: "s1" });
		const bob = resolveScope(perSender, { channel: "discord", senderId: "bob", sessionKey: "s2" });
		expect(alice.userId).toBeTruthy();
		expect(bob.userId).toBeTruthy();
		expect(alice.userId).not.toBe(bob.userId);
	});
});

describe("scope can never widen", () => {
	it("has no configuration path that removes a configured sub-tenant", () => {
		const config = resolveConfig({ userId: "narrow" });
		// Even a hostile run context cannot clear it in owner mode.
		const scope = resolveScope(config, { channel: "discord", senderId: "x", ...({ userId: null } as object) });
		expect(scope.userId).toBe("narrow");
	});

	it("treats conversationId as attribution only, never as tenancy", () => {
		const a = resolveScope(ownerConfig, { sessionKey: "session-a" });
		const b = resolveScope(ownerConfig, { sessionKey: "session-b" });
		expect(a.userId).toBe(b.userId);
		expect(a.conversationId).not.toBe(b.conversationId);
	});
});
