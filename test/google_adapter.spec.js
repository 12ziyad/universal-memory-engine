/**
 * Google Vertex adapter unit tests — fakes only, no network.
 *
 * Proves: JWT mint + refresh + single-flight; 401 re-auth exactly once; 429
 * backoff honoring Retry-After; timeout maps to the TimeoutError shape
 * llm.js already classifies; schema translation covers every repo idiom and
 * hard-fails on the untranslatable; responses satisfy the EXISTING parsers
 * (responseText / responseTruncated / responseRefused / readUsage) so no call
 * site ever learns a Google shape existed; embeddings assert dims and
 * L2-normalize; and NO credential substring can escape into an error.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { getAccessToken, invalidateToken, resetGoogleAuthForTests } from "../src/ai/providers/google/auth.js";
import { googleFetch } from "../src/ai/providers/google/client.js";
import { buildGenerateContent, buildRank, parseEmbed, parseGenerateContent, parseRank, translateJsonSchema } from "../src/ai/providers/google/map.js";
import { responseText, responseRefused, responseTruncated } from "../src/pipeline/llm.js";
import { readUsage } from "../src/lib/ai_meter.js";

async function makeServiceAccountEnv() {
	const pair = await crypto.subtle.generateKey(
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
		true,
		["sign", "verify"],
	);
	const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
	let b64 = "";
	for (const byte of der) b64 += String.fromCharCode(byte);
	const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(b64).replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`;
	return {
		GCP_SERVICE_ACCOUNT: JSON.stringify({
			client_email: "spec@example.iam.gserviceaccount.com",
			private_key: pem,
			private_key_id: "spec-key-1",
		}),
		GCP_PROJECT_ID: "spec-project",
	};
}

function tokenFetch(token = "spec-access-token", spy = { calls: 0 }) {
	return async (url, init) => {
		spy.calls += 1;
		expect(String(init.body)).toContain("assertion=");
		return new Response(JSON.stringify({ access_token: token, expires_in: 3600 }), { status: 200 });
	};
}

beforeEach(() => resetGoogleAuthForTests());

describe("auth", () => {
	it("mints once, caches, and single-flights concurrent callers", async () => {
		const env = await makeServiceAccountEnv();
		const spy = { calls: 0 };
		const fetchImpl = tokenFetch("tok-1", spy);
		const [a, b] = await Promise.all([getAccessToken(env, fetchImpl), getAccessToken(env, fetchImpl)]);
		expect(a).toBe("tok-1");
		expect(b).toBe("tok-1");
		expect(spy.calls).toBe(1);
		expect(await getAccessToken(env, fetchImpl)).toBe("tok-1"); // cached
		expect(spy.calls).toBe(1);
	});

	it("re-mints after invalidation and never leaks material into errors", async () => {
		const env = await makeServiceAccountEnv();
		await getAccessToken(env, tokenFetch("tok-1"));
		invalidateToken();
		expect(await getAccessToken(env, tokenFetch("tok-2"))).toBe("tok-2");

		resetGoogleAuthForTests();
		const rejecting = async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
		const error = await getAccessToken(env, rejecting).catch((e) => e);
		expect(String(error.message)).not.toContain("PRIVATE KEY");
		expect(String(error.message)).not.toContain("tok-");
		expect(error.googleStatus).toBe("exchange_rejected");
	});
});

describe("client", () => {
	async function envWithAuth() {
		return makeServiceAccountEnv();
	}

	it("re-auths exactly once on 401, then succeeds", async () => {
		const env = await envWithAuth();
		let apiCalls = 0;
		const fetchImpl = async (url, init) => {
			if (String(url).includes("oauth2") || String(init?.body ?? "").includes("assertion=")) {
				return new Response(JSON.stringify({ access_token: `tok-${Date.now()}`, expires_in: 3600 }), { status: 200 });
			}
			apiCalls += 1;
			if (apiCalls === 1) return new Response(JSON.stringify({ error: { status: "UNAUTHENTICATED" } }), { status: 401 });
			return new Response(JSON.stringify({ done: true }), { status: 200 });
		};
		const json = await googleFetch(env, { url: "https://x.example/api", body: {}, timeoutMs: 5000 }, { fetch: fetchImpl });
		expect(json.done).toBe(true);
		expect(apiCalls).toBe(2);
	});

	it("retries 429 with backoff then surfaces rate_limited", async () => {
		const env = await envWithAuth();
		let apiCalls = 0;
		const fetchImpl = async (url, init) => {
			if (String(init?.body ?? "").includes("assertion=")) {
				return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
			}
			apiCalls += 1;
			return new Response(JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED" } }), { status: 429, headers: { "retry-after": "0" } });
		};
		const error = await googleFetch(env, { url: "https://x.example/api", body: {}, timeoutMs: 5000 }, { fetch: fetchImpl }).catch((e) => e);
		expect(apiCalls).toBe(3); // 1 + 2 transient retries
		expect(error.aiErrorClass).toBe("rate_limited");
		expect(error.retryable).toBe(true);
	});

	it("maps an abort to the TimeoutError shape llm.js classifies, with no body echo", async () => {
		const env = await envWithAuth();
		const fetchImpl = async (url, init) => {
			if (String(init?.body ?? "").includes("assertion=")) {
				return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
			}
			return new Promise((resolve, reject) => {
				init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
			});
		};
		const error = await googleFetch(env, { url: "https://x.example/api", body: { secret: "SENTINEL_PROMPT" }, timeoutMs: 50 }, { fetch: fetchImpl }).catch((e) => e);
		expect(error.name).toBe("TimeoutError");
		expect(error.aiErrorClass).toBe("timeout");
		expect(String(error.message)).not.toContain("SENTINEL_PROMPT");
	});

	it("classifies billing-disabled as billing (the fast breaker trip)", async () => {
		const env = await envWithAuth();
		const fetchImpl = async (url, init) => {
			if (String(init?.body ?? "").includes("assertion=")) {
				return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
			}
			return new Response(JSON.stringify({ error: { status: "PERMISSION_DENIED", errors: [{ reason: "billingDisabled" }] } }), { status: 403 });
		};
		const error = await googleFetch(env, { url: "https://x.example/api", body: {}, timeoutMs: 5000 }, { fetch: fetchImpl }).catch((e) => e);
		expect(error.aiErrorClass).toBe("provider_misconfigured");
	});
});

describe("schema translation", () => {
	it("covers every idiom the repo's three schemas use", () => {
		const translated = translateJsonSchema({
			type: "object",
			additionalProperties: false,
			properties: {
				edges: {
					type: "array",
					items: {
						type: "object",
						properties: {
							source_entity_id: { type: "integer" },
							valid_at: { type: ["string", "null"] },
							category_slug: { anyOf: [{ type: "string" }, { type: "null" }] },
						},
						required: ["source_entity_id"],
					},
				},
			},
			required: ["edges"],
		});
		expect(translated.additionalProperties).toBeUndefined();
		const item = translated.properties.edges.items.properties;
		expect(item.valid_at).toEqual({ type: "string", nullable: true });
		expect(item.category_slug).toEqual({ type: "string", nullable: true });
		expect(translated.required).toEqual(["edges"]);
	});

	it("hard-fails on $ref rather than silently dropping it", () => {
		expect(() => translateJsonSchema({ $ref: "#/defs/x" })).toThrow("not translatable");
	});
});

describe("response mapping satisfies the EXISTING parsers", () => {
	it("a normal answer flows through responseText and readUsage unchanged", () => {
		const mapped = parseGenerateContent({
			candidates: [{ content: { parts: [{ text: '{"objects":[]}' }] }, finishReason: "STOP" }],
			usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120, thoughtsTokenCount: 0 },
			modelVersion: "gemini-2.5-flash-001",
		});
		expect(responseText(mapped)).toBe('{"objects":[]}');
		expect(responseRefused(mapped)).toBe(false);
		expect(responseTruncated(mapped)).toBe(false);
		expect(readUsage(mapped)).toMatchObject({ input: 100, output: 20, total: 120 });
	});

	it("MAX_TOKENS reads as truncation; SAFETY reads as refusal", () => {
		const truncated = parseGenerateContent({
			candidates: [{ content: { parts: [{ text: "partial" }] }, finishReason: "MAX_TOKENS" }],
			usageMetadata: {},
		});
		expect(responseTruncated(truncated)).toBe(true);

		const blocked = parseGenerateContent({
			candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }],
			promptFeedback: { blockReason: "SAFETY" },
			usageMetadata: {},
		});
		expect(responseRefused(blocked)).toBe(true);
		expect(blocked.refusal.reason).toBe("SAFETY");
	});

	it("generateContent requests carry system→systemInstruction, thinking off, BLOCK_NONE", () => {
		const body = buildGenerateContent({
			messages: [
				{ role: "system", content: "You extract." },
				{ role: "user", content: "I moved." },
				{ role: "assistant", content: "Noted." },
			],
			temperature: 0,
			max_tokens: 512,
			response_format: { type: "json_schema", json_schema: { type: "object", properties: {}, required: [] } },
		}, "gemini-2.5-flash");
		expect(body.systemInstruction.parts[0].text).toBe("You extract.");
		expect(body.contents.map((c) => c.role)).toEqual(["user", "model"]);
		expect(body.generationConfig).toMatchObject({ temperature: 0, maxOutputTokens: 512, responseMimeType: "application/json" });
		expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
		expect(body.safetySettings.every((s) => s.threshold === "BLOCK_NONE")).toBe(true);
	});

	it("embeddings assert dimension and are L2-normalized", () => {
		const raw = { predictions: [{ embeddings: { values: [3, 4, 0, ...Array(765).fill(0)], statistics: { token_count: 5 } } }] };
		const mapped = parseEmbed(raw, { expectedDim: 768 });
		const vec = mapped.data[0];
		expect(vec.length).toBe(768);
		const norm = Math.sqrt(vec.reduce((a, v) => a + v * v, 0));
		expect(norm).toBeCloseTo(1, 6);

		expect(() => parseEmbed({ predictions: [{ embeddings: { values: [1, 2, 3] } }] }, { expectedDim: 768 }))
			.toThrow("embedding_dim_mismatch");
	});

	it("rerank maps by input index and can never introduce a candidate", () => {
		const body = buildRank({ query: "q", contexts: [{ text: "a" }, { text: "b" }] }, "semantic-ranker-default-004");
		expect(body.records).toEqual([{ id: "0", content: "a" }, { id: "1", content: "b" }]);
		const mapped = parseRank({ records: [{ id: "1", score: 0.9 }, { id: "7", score: 0.5 }, { id: "junk", score: 1 }] });
		// Out-of-range ids survive here as numbers only; rerank.js discards any
		// index that does not map back into ITS OWN head list.
		expect(mapped.response).toEqual([{ id: 1, score: 0.9 }, { id: 7, score: 0.5 }]);
	});
});
