import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";

import {
	MEMORY_V3_MODES,
	memoryV3Config,
	memoryV3Enabled,
	memoryV3AtomicCaptureConfig,
	memoryV3AtomicCaptureEnabled,
	memoryV3AtomicProjectionConfig,
	memoryV3AtomicProjectionEnabled,
	memoryV3AtomicCoalescingConfig,
	memoryV3AtomicCoalescingEnabled,
	memoryV3HybridRetrievalConfig,
	memoryV3HybridRetrievalEnabled,
	memoryV3SourceExpansionConfig,
	memoryV3SourceExpansionEnabled,
	memoryV3EpisodeFallbackConfig,
	memoryV3EpisodeFallbackEnabled,
	memoryV3AdaptiveContextConfig,
	memoryV3AdaptiveContextEnabled,
	memoryV3ExtractionB1Config,
	memoryV3ExtractionB1Enabled,
	memoryV3Status,
} from "../src/lib/memory_v3.js";

/**
 * The V3 write/read architecture ships behind a flag that is OFF in production
 * and can only be turned on for explicitly named accounts. This suite is the
 * rollback mechanism's proof: if any of it fails, V3 can reach a user who was
 * never selected for it.
 */

const base = { ...env };

describe("V3 feature flag: default state", () => {
	it("is OFF when nothing is configured", () => {
		expect(memoryV3Config({}).mode).toBe("off");
		expect(memoryV3Enabled({}, "user_a")).toBe(false);
	});

	it("is OFF for the real deployed environment (production default)", () => {
		// The deployed worker must not carry an enabling value by accident.
		expect(memoryV3Enabled(base, "user_a")).toBe(false);
	});

	it("fails closed on an unrecognised value rather than guessing", () => {
		for (const value of ["yes", "1", "true-ish", "ON!", "enabled", " ", "allowlist;on", null, 0, {}]) {
			expect(memoryV3Config({ ITSUKI_MEMORY_V3: value }).mode).toBe("off");
			expect(memoryV3Enabled({ ITSUKI_MEMORY_V3: value }, "user_a")).toBe(false);
		}
	});

	it("exposes only the three modes it claims to support", () => {
		expect([...MEMORY_V3_MODES].sort()).toEqual(["allowlist", "off", "on"]);
	});
});

describe("V3 extraction B1 experiment flag", () => {
	it("defaults off even for a V3 account, preserving the causal control", () => {
		const v3 = { ITSUKI_MEMORY_V3: "on" };
		expect(memoryV3ExtractionB1Config(v3).mode).toBe("off");
		expect(memoryV3ExtractionB1Enabled(v3, "control_user")).toBe(false);
	});

	it("requires both V3 membership and exact B1 membership", () => {
		const treatment = {
			ITSUKI_MEMORY_V3: "allowlist",
			ITSUKI_MEMORY_V3_USERS: "control_user,treatment_user",
			ITSUKI_MEMORY_V3_EXTRACTION_B1: "allowlist",
			ITSUKI_MEMORY_V3_EXTRACTION_B1_USERS: "treatment_user",
		};
		expect(memoryV3ExtractionB1Enabled(treatment, "control_user")).toBe(false);
		expect(memoryV3ExtractionB1Enabled(treatment, "treatment_user")).toBe(true);
		expect(memoryV3ExtractionB1Enabled(treatment, "treatment_user_suffix")).toBe(false);

		const notV3 = { ...treatment, ITSUKI_MEMORY_V3_USERS: "control_user" };
		expect(memoryV3ExtractionB1Enabled(notV3, "treatment_user")).toBe(false);
	});

	it("fails closed on malformed B1 configuration", () => {
		for (const value of ["yes", "enabled", "allowlist;on", "", null, 1, {}]) {
			const candidate = { ITSUKI_MEMORY_V3: "on", ITSUKI_MEMORY_V3_EXTRACTION_B1: value };
			expect(memoryV3ExtractionB1Config(candidate).mode).toBe("off");
			expect(memoryV3ExtractionB1Enabled(candidate, "user_a")).toBe(false);
		}
	});
});

describe("V3 atomic capture experiment flag", () => {
	it("defaults off even for a V3 account", () => {
		const v3 = { ITSUKI_MEMORY_V3: "on" };
		expect(memoryV3AtomicCaptureConfig(v3).mode).toBe("off");
		expect(memoryV3AtomicCaptureEnabled(v3, "control_user")).toBe(false);
	});

	it("requires exact membership in both the parent and nested allowlists", () => {
		const treatment = {
			ITSUKI_MEMORY_V3: "allowlist",
			ITSUKI_MEMORY_V3_USERS: "control_user,treatment_user",
			ITSUKI_MEMORY_V3_ATOMIC_CAPTURE: "allowlist",
			ITSUKI_MEMORY_V3_ATOMIC_CAPTURE_USERS: "treatment_user",
		};
		expect(memoryV3AtomicCaptureEnabled(treatment, "control_user")).toBe(false);
		expect(memoryV3AtomicCaptureEnabled(treatment, "treatment_user")).toBe(true);
		expect(memoryV3AtomicCaptureEnabled(treatment, "treatment_user_suffix")).toBe(false);

		const notV3 = { ...treatment, ITSUKI_MEMORY_V3_USERS: "control_user" };
		expect(memoryV3AtomicCaptureEnabled(notV3, "treatment_user")).toBe(false);
	});

	it("fails closed on malformed nested configuration", () => {
		for (const value of ["yes", "enabled", "allowlist;on", "", null, 1, {}]) {
			const candidate = { ITSUKI_MEMORY_V3: "on", ITSUKI_MEMORY_V3_ATOMIC_CAPTURE: value };
			expect(memoryV3AtomicCaptureConfig(candidate).mode).toBe("off");
			expect(memoryV3AtomicCaptureEnabled(candidate, "user_a")).toBe(false);
		}
	});
});

describe("V3 atomic projection experiment flag", () => {
	it("defaults off and requires parent V3 plus atomic capture plus exact projection membership", () => {
		const treatment = {
			ITSUKI_MEMORY_V3: "allowlist",
			ITSUKI_MEMORY_V3_USERS: "control_user,treatment_user",
			ITSUKI_MEMORY_V3_ATOMIC_CAPTURE: "allowlist",
			ITSUKI_MEMORY_V3_ATOMIC_CAPTURE_USERS: "treatment_user",
			ITSUKI_MEMORY_V3_ATOMIC_PROJECTION: "allowlist",
			ITSUKI_MEMORY_V3_ATOMIC_PROJECTION_USERS: "treatment_user",
		};
		expect(memoryV3AtomicProjectionConfig({ ITSUKI_MEMORY_V3: "on" }).mode).toBe("off");
		expect(memoryV3AtomicProjectionEnabled(treatment, "control_user")).toBe(false);
		expect(memoryV3AtomicProjectionEnabled(treatment, "treatment_user")).toBe(true);
		expect(memoryV3AtomicProjectionEnabled(treatment, "treatment_user_suffix")).toBe(false);
		expect(memoryV3AtomicProjectionEnabled({ ...treatment, ITSUKI_MEMORY_V3_ATOMIC_CAPTURE: "off" }, "treatment_user")).toBe(false);
		for (const value of ["yes", "enabled", "", null, 1, {}]) {
			expect(memoryV3AtomicProjectionEnabled({ ...treatment, ITSUKI_MEMORY_V3_ATOMIC_PROJECTION: value }, "treatment_user")).toBe(false);
		}
	});
});

describe("V3 atomic source-coalescing experiment flag", () => {
	it("defaults off and requires every parent plus exact coalescing membership", () => {
		const treatment = {
			ITSUKI_MEMORY_V3: "allowlist",
			ITSUKI_MEMORY_V3_USERS: "control_user,treatment_user",
			ITSUKI_MEMORY_V3_ATOMIC_CAPTURE: "allowlist",
			ITSUKI_MEMORY_V3_ATOMIC_CAPTURE_USERS: "control_user,treatment_user",
			ITSUKI_MEMORY_V3_ATOMIC_PROJECTION: "allowlist",
			ITSUKI_MEMORY_V3_ATOMIC_PROJECTION_USERS: "control_user,treatment_user",
			ITSUKI_MEMORY_V3_ATOMIC_COALESCING: "allowlist",
			ITSUKI_MEMORY_V3_ATOMIC_COALESCING_USERS: "treatment_user",
		};
		expect(memoryV3AtomicCoalescingConfig({ ITSUKI_MEMORY_V3: "on" }).mode).toBe("off");
		expect(memoryV3AtomicCoalescingEnabled(treatment, "control_user")).toBe(false);
		expect(memoryV3AtomicCoalescingEnabled(treatment, "treatment_user")).toBe(true);
		expect(memoryV3AtomicCoalescingEnabled(treatment, "treatment_user_suffix")).toBe(false);
		expect(memoryV3AtomicCoalescingEnabled({ ...treatment, ITSUKI_MEMORY_V3_ATOMIC_PROJECTION: "off" }, "treatment_user")).toBe(false);
		for (const value of ["yes", "enabled", "", null, 1, {}]) {
			expect(memoryV3AtomicCoalescingEnabled({ ...treatment, ITSUKI_MEMORY_V3_ATOMIC_COALESCING: value }, "treatment_user")).toBe(false);
		}
	});
});

describe("V3 hybrid retrieval experiment flag", () => {
	it("defaults off and requires exact parent-V3 and retrieval membership", () => {
		const treatment = {
			ITSUKI_MEMORY_V3: "allowlist",
			ITSUKI_MEMORY_V3_USERS: "control_user,treatment_user",
			ITSUKI_MEMORY_V3_HYBRID_RETRIEVAL: "allowlist",
			ITSUKI_MEMORY_V3_HYBRID_RETRIEVAL_USERS: "treatment_user",
		};
		expect(memoryV3HybridRetrievalConfig({ ITSUKI_MEMORY_V3: "on" }).mode).toBe("off");
		expect(memoryV3HybridRetrievalEnabled(treatment, "control_user")).toBe(false);
		expect(memoryV3HybridRetrievalEnabled(treatment, "treatment_user")).toBe(true);
		expect(memoryV3HybridRetrievalEnabled(treatment, "treatment_user_suffix")).toBe(false);
		expect(memoryV3HybridRetrievalEnabled({ ...treatment, ITSUKI_MEMORY_V3: "off" }, "treatment_user")).toBe(false);
		for (const value of ["yes", "enabled", "", null, 1, {}]) {
			expect(memoryV3HybridRetrievalEnabled({ ...treatment, ITSUKI_MEMORY_V3_HYBRID_RETRIEVAL: value }, "treatment_user")).toBe(false);
		}
	});
});

describe("V3 exact source-expansion experiment flag", () => {
	it("defaults off and requires exact parent V3, E7, and expansion membership", () => {
		const treatment = {
			ITSUKI_MEMORY_V3: "allowlist",
			ITSUKI_MEMORY_V3_USERS: "control_user,treatment_user",
			ITSUKI_MEMORY_V3_HYBRID_RETRIEVAL: "allowlist",
			ITSUKI_MEMORY_V3_HYBRID_RETRIEVAL_USERS: "control_user,treatment_user",
			ITSUKI_MEMORY_V3_SOURCE_EXPANSION: "allowlist",
			ITSUKI_MEMORY_V3_SOURCE_EXPANSION_USERS: "treatment_user",
		};
		expect(memoryV3SourceExpansionConfig({ ITSUKI_MEMORY_V3: "on" }).mode).toBe("off");
		expect(memoryV3SourceExpansionEnabled(treatment, "control_user")).toBe(false);
		expect(memoryV3SourceExpansionEnabled(treatment, "treatment_user")).toBe(true);
		expect(memoryV3SourceExpansionEnabled(treatment, "treatment_user_suffix")).toBe(false);
		expect(memoryV3SourceExpansionEnabled({ ...treatment, ITSUKI_MEMORY_V3_HYBRID_RETRIEVAL: "off" }, "treatment_user")).toBe(false);
		for (const value of ["yes", "enabled", "", null, 1, {}]) {
			expect(memoryV3SourceExpansionEnabled({ ...treatment, ITSUKI_MEMORY_V3_SOURCE_EXPANSION: value }, "treatment_user")).toBe(false);
		}
	});
});

describe("V3 episode-fallback experiment flag", () => {
	it("defaults off and requires exact parent V3, E7, E9A, and fallback membership", () => {
		const treatment = {
			ITSUKI_MEMORY_V3: "allowlist",
			ITSUKI_MEMORY_V3_USERS: "control_user,treatment_user",
			ITSUKI_MEMORY_V3_HYBRID_RETRIEVAL: "allowlist",
			ITSUKI_MEMORY_V3_HYBRID_RETRIEVAL_USERS: "control_user,treatment_user",
			ITSUKI_MEMORY_V3_SOURCE_EXPANSION: "allowlist",
			ITSUKI_MEMORY_V3_SOURCE_EXPANSION_USERS: "control_user,treatment_user",
			ITSUKI_MEMORY_V3_EPISODE_FALLBACK: "allowlist",
			ITSUKI_MEMORY_V3_EPISODE_FALLBACK_USERS: "treatment_user",
		};
		expect(memoryV3EpisodeFallbackConfig({ ITSUKI_MEMORY_V3: "on" }).mode).toBe("off");
		expect(memoryV3EpisodeFallbackEnabled(treatment, "control_user")).toBe(false);
		expect(memoryV3EpisodeFallbackEnabled(treatment, "treatment_user")).toBe(true);
		expect(memoryV3EpisodeFallbackEnabled(treatment, "treatment_user_suffix")).toBe(false);
		expect(memoryV3EpisodeFallbackEnabled({ ...treatment, ITSUKI_MEMORY_V3_SOURCE_EXPANSION: "off" }, "treatment_user")).toBe(false);
	});
});

describe("V3 adaptive-context experiment flag", () => {
	it("defaults off and requires exact parent V3, E7, and compiler membership", () => {
		const treatment = {
			ITSUKI_MEMORY_V3: "allowlist",
			ITSUKI_MEMORY_V3_USERS: "control_user,treatment_user",
			ITSUKI_MEMORY_V3_HYBRID_RETRIEVAL: "allowlist",
			ITSUKI_MEMORY_V3_HYBRID_RETRIEVAL_USERS: "control_user,treatment_user",
			ITSUKI_MEMORY_V3_ADAPTIVE_CONTEXT: "allowlist",
			ITSUKI_MEMORY_V3_ADAPTIVE_CONTEXT_USERS: "treatment_user",
		};
		expect(memoryV3AdaptiveContextConfig({ ITSUKI_MEMORY_V3: "on" }).mode).toBe("off");
		expect(memoryV3AdaptiveContextEnabled(treatment, "control_user")).toBe(false);
		expect(memoryV3AdaptiveContextEnabled(treatment, "treatment_user")).toBe(true);
		expect(memoryV3AdaptiveContextEnabled(treatment, "treatment_user_suffix")).toBe(false);
		expect(memoryV3AdaptiveContextEnabled({ ...treatment, ITSUKI_MEMORY_V3_HYBRID_RETRIEVAL: "off" }, "treatment_user")).toBe(false);
	});
});

describe("V3 feature flag: allowlist mode", () => {
	const allowlistEnv = {
		ITSUKI_MEMORY_V3: "allowlist",
		ITSUKI_MEMORY_V3_USERS: "user_campaign, user_bench ,user_test",
	};

	it("enables exactly the named accounts", () => {
		expect(memoryV3Enabled(allowlistEnv, "user_campaign")).toBe(true);
		expect(memoryV3Enabled(allowlistEnv, "user_bench")).toBe(true);
		expect(memoryV3Enabled(allowlistEnv, "user_test")).toBe(true);
	});

	it("leaves every other account on the legacy path", () => {
		for (const other of ["user_a", "user_campaign2", "campaign", "user_camp", "USER_CAMPAIGN", ""]) {
			expect(memoryV3Enabled(allowlistEnv, other)).toBe(false);
		}
	});

	it("matches the whole id, never a prefix, suffix, or substring", () => {
		const one = { ITSUKI_MEMORY_V3: "allowlist", ITSUKI_MEMORY_V3_USERS: "user_1" };
		expect(memoryV3Enabled(one, "user_1")).toBe(true);
		expect(memoryV3Enabled(one, "user_10")).toBe(false);
		expect(memoryV3Enabled(one, "xuser_1")).toBe(false);
		expect(memoryV3Enabled(one, "user_1x")).toBe(false);
	});

	it("is case sensitive, because account ids are", () => {
		const one = { ITSUKI_MEMORY_V3: "allowlist", ITSUKI_MEMORY_V3_USERS: "User_Mixed" };
		expect(memoryV3Enabled(one, "User_Mixed")).toBe(true);
		expect(memoryV3Enabled(one, "user_mixed")).toBe(false);
	});

	it("is OFF for everyone when the mode is allowlist but the list is empty", () => {
		for (const users of [undefined, "", "   ", ",,,", null]) {
			const cfg = { ITSUKI_MEMORY_V3: "allowlist", ITSUKI_MEMORY_V3_USERS: users };
			expect(memoryV3Config(cfg).allowlistCount).toBe(0);
			expect(memoryV3Enabled(cfg, "user_a")).toBe(false);
		}
	});

	it("never enables an absent, empty, or non-string account id", () => {
		for (const id of [undefined, null, "", "   ", 0, 123, {}, []]) {
			expect(memoryV3Enabled(allowlistEnv, id)).toBe(false);
		}
	});

	it("cannot be turned on by anything a caller can send", () => {
		// The resolver takes (env, userId) only. There is no request-body,
		// header, or scope-object path into it — a caller cannot opt themselves
		// in, which is what makes cross-tenant bleed impossible by construction.
		expect(memoryV3Enabled.length).toBe(2);
		const hostile = {
			ITSUKI_MEMORY_V3: "off",
			ITSUKI_MEMORY_V3_USERS: "user_a",
		};
		expect(memoryV3Enabled(hostile, "user_a")).toBe(false);
	});
});

describe("V3 feature flag: global on", () => {
	it("enables every account, and is the only mode that does", () => {
		const on = { ITSUKI_MEMORY_V3: "on" };
		expect(memoryV3Enabled(on, "user_a")).toBe(true);
		expect(memoryV3Enabled(on, "user_b")).toBe(true);
		// Still needs a real account id.
		expect(memoryV3Enabled(on, "")).toBe(false);
	});
});

describe("V3 feature flag: observability", () => {
	it("reports state without exposing a single account id", () => {
		const status = memoryV3Status({
			ITSUKI_MEMORY_V3: "allowlist",
			ITSUKI_MEMORY_V3_USERS: "user_campaign,user_bench",
		});
		expect(status).toEqual({
			schema: "itsuki.memory-v3-flag/v1",
			mode: "allowlist",
			allowlistCount: 2,
			extractionB1: { mode: "off", allowlistCount: 0 },
			atomicCapture: { mode: "off", allowlistCount: 0 },
			atomicProjection: { mode: "off", allowlistCount: 0 },
			atomicCoalescing: { mode: "off", allowlistCount: 0 },
			hybridRetrieval: { mode: "off", allowlistCount: 0 },
			sourceExpansion: { mode: "off", allowlistCount: 0 },
			episodeFallback: { mode: "off", allowlistCount: 0 },
			adaptiveContext: { mode: "off", allowlistCount: 0 },
		});
		const serialized = JSON.stringify(status);
		expect(serialized).not.toContain("user_campaign");
		expect(serialized).not.toContain("user_bench");
	});

	it("reports the off state plainly", () => {
		expect(memoryV3Status({})).toEqual({
			schema: "itsuki.memory-v3-flag/v1",
			mode: "off",
			allowlistCount: 0,
			extractionB1: { mode: "off", allowlistCount: 0 },
			atomicCapture: { mode: "off", allowlistCount: 0 },
			atomicProjection: { mode: "off", allowlistCount: 0 },
			atomicCoalescing: { mode: "off", allowlistCount: 0 },
			hybridRetrieval: { mode: "off", allowlistCount: 0 },
			sourceExpansion: { mode: "off", allowlistCount: 0 },
			episodeFallback: { mode: "off", allowlistCount: 0 },
			adaptiveContext: { mode: "off", allowlistCount: 0 },
		});
	});
});

describe("V3 feature flag: surfaced on the HTTP doors", () => {
	it("GET /health reports the flag mode and no account ids", async () => {
		const response = await (await import("../src/index.js")).default.fetch(
			new Request("https://itsuki.app/health"),
			env,
			{ waitUntil() {}, passThroughOnException() {} },
		);
		const body = await response.json();
		expect(response.status).toBe(200);
		expect(body.memory_v3).toEqual({
			schema: "itsuki.memory-v3-flag/v1",
			mode: "off",
			allowlistCount: 0,
			extractionB1: { mode: "off", allowlistCount: 0 },
			atomicCapture: { mode: "off", allowlistCount: 0 },
			atomicProjection: { mode: "off", allowlistCount: 0 },
			atomicCoalescing: { mode: "off", allowlistCount: 0 },
			hybridRetrieval: { mode: "off", allowlistCount: 0 },
			sourceExpansion: { mode: "off", allowlistCount: 0 },
			episodeFallback: { mode: "off", allowlistCount: 0 },
			adaptiveContext: { mode: "off", allowlistCount: 0 },
		});
	});
});
