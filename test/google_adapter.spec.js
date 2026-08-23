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

import fs from "node:fs";
import { parse } from "acorn";
import { beforeEach, describe, expect, it } from "vitest";
import { getAccessToken, invalidateToken, resetGoogleAuthForTests } from "../src/ai/providers/google/auth.js";
import { googleFetch } from "../src/ai/providers/google/client.js";
import { googleProvider, resolveGoogleModel } from "../src/ai/providers/google/index.js";
import {
	GOOGLE_RESPONSE_SCHEMA_KEYWORDS,
	buildGenerateContent,
	buildRank,
	parseEmbed,
	parseGenerateContent,
	parseRank,
	translateJsonSchema,
} from "../src/ai/providers/google/map.js";
import { generateContentUrl, GOOGLE_DEFAULT_MODELS } from "../src/ai/providers/google/models.js";
import { responseText, responseRefused, responseTruncated } from "../src/pipeline/llm.js";
import { readUsage } from "../src/lib/ai_meter.js";

async function makeServiceAccountFixture({
	clientEmail = "spec@example.iam.gserviceaccount.com",
	privateKeyId = "spec-key-1",
} = {}) {
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
		publicKey: pair.publicKey,
		env: {
			GCP_SERVICE_ACCOUNT: JSON.stringify({
				client_email: clientEmail,
				private_key: pem,
				private_key_id: privateKeyId,
			}),
			GCP_PROJECT_ID: "spec-project",
		},
	};
}

async function makeServiceAccountEnv(options) {
	return (await makeServiceAccountFixture(options)).env;
}

function tokenFetch(token = "spec-access-token", spy = { calls: 0 }) {
	return async (url, init) => {
		spy.calls += 1;
		expect(String(init.body)).toContain("assertion=");
		return new Response(JSON.stringify({ access_token: token, expires_in: 3600 }), { status: 200 });
	};
}

function apiUrl(env) {
	return generateContentUrl(env, GOOGLE_DEFAULT_MODELS.extract);
}

function walkAst(node, visit) {
	if (!node || typeof node !== "object") return;
	visit(node);
	for (const value of Object.values(node)) {
		if (Array.isArray(value)) value.forEach((entry) => walkAst(entry, visit));
		else if (value && typeof value === "object" && typeof value.type === "string") walkAst(value, visit);
	}
}

function propertyName(property) {
	if (property?.computed) return null;
	if (property?.key?.type === "Identifier") return property.key.name;
	if (property?.key?.type === "Literal") return String(property.key.value);
	return null;
}

function collectSchemaKeywords(node, keywords) {
	if (node?.type !== "ObjectExpression") return;
	for (const property of node.properties ?? []) {
		if (property?.type !== "Property") continue;
		const key = propertyName(property);
		if (!key) continue;
		keywords.add(key);
		if (key === "properties" && property.value?.type === "ObjectExpression") {
			for (const field of property.value.properties ?? []) collectSchemaKeywords(field?.value, keywords);
		} else if (key === "items") {
			collectSchemaKeywords(property.value, keywords);
		} else if (key === "anyOf" && property.value?.type === "ArrayExpression") {
			for (const arm of property.value.elements ?? []) collectSchemaKeywords(arm, keywords);
		}
	}
}

function schemaInitializer(node) {
	if (node?.type === "ObjectExpression") return node;
	if (
		node?.type === "CallExpression"
		&& node.callee?.type === "MemberExpression"
		&& node.callee.object?.name === "Object"
		&& node.callee.property?.name === "freeze"
		&& node.arguments?.[0]?.type === "ObjectExpression"
	) return node.arguments[0];
	return null;
}

function productionSchemaCensus() {
	const files = [
		["engine_v2", new URL("../src/pipeline/engine_v2.js", import.meta.url), new Set(["EDGE_SCHEMA", "REFLEXION_SCHEMA"])],
		["atomic", new URL("../src/pipeline/atomic_candidates.mjs", import.meta.url), new Set(["ATOMIC_CAPTURE_JSON_SCHEMA"])],
		["rules", new URL("../src/lib/rules_preview.js", import.meta.url), new Set()],
	];
	const keywords = new Set();
	const roots = [];
	for (const [label, url, declarations] of files) {
		const source = fs.readFileSync(url, "utf8");
		const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
		walkAst(ast, (node) => {
			const declarationSchema = node.type === "VariableDeclarator" && declarations.has(node.id?.name)
				? schemaInitializer(node.init)
				: null;
			if (declarationSchema) {
				roots.push(`${label}:${node.id.name}`);
				collectSchemaKeywords(declarationSchema, keywords);
			}
			if (label === "rules" && node.type === "Property" && propertyName(node) === "json_schema" && node.value?.type === "ObjectExpression") {
				roots.push("rules:schema.json_schema");
				collectSchemaKeywords(node.value, keywords);
			}
		});
	}
	return { keywords, roots };
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

	it("never trusts a service-account token_uri", async () => {
		const env = await makeServiceAccountEnv();
		const serviceAccount = JSON.parse(env.GCP_SERVICE_ACCOUNT);
		serviceAccount.token_uri = "https://attacker.example/token";
		env.GCP_SERVICE_ACCOUNT = JSON.stringify(serviceAccount);
		let fetches = 0;
		const error = await getAccessToken(env, async () => {
			fetches += 1;
			return new Response("{}", { status: 200 });
		}).catch((caught) => caught);
		expect(fetches).toBe(0);
		expect(error.googleStatus).toBe("invalid_credentials");
	});

	it("rejects a missing, empty, non-string, or oversized private_key_id before signing", async () => {
		const cases = [
			["missing", (serviceAccount) => { delete serviceAccount.private_key_id; }],
			["empty", (serviceAccount) => { serviceAccount.private_key_id = "   "; }],
			["non-string", (serviceAccount) => { serviceAccount.private_key_id = 17; }],
			["oversized", (serviceAccount) => { serviceAccount.private_key_id = "k".repeat(257); }],
		];

		for (const [label, mutate] of cases) {
			resetGoogleAuthForTests();
			const env = await makeServiceAccountEnv();
			const serviceAccount = JSON.parse(env.GCP_SERVICE_ACCOUNT);
			mutate(serviceAccount);
			env.GCP_SERVICE_ACCOUNT = JSON.stringify(serviceAccount);
			let fetches = 0;
			const error = await getAccessToken(env, async () => {
				fetches += 1;
				return new Response(JSON.stringify({ access_token: "must-not-mint", expires_in: 3600 }), { status: 200 });
			}).catch((caught) => caught);
			expect(fetches, label).toBe(0);
			expect(error?.googleStatus, label).toBe("invalid_credentials");
			expect(String(error?.message), label).toBe("google auth invalid_credentials");
			expect(String(error?.message), label).not.toContain(String(serviceAccount.private_key_id));
		}
	});

	it("imports the rotated private key when key ids change under one service identity", async () => {
		const first = await makeServiceAccountFixture({ privateKeyId: "rotation-key-1" });
		const second = await makeServiceAccountFixture({ privateKeyId: "rotation-key-2" });
		const encoder = new TextEncoder();
		const verifyExchange = (expectedKeyId, publicKey, token) => async (_url, init) => {
			const assertion = new URLSearchParams(String(init?.body ?? "")).get("assertion");
			const parts = String(assertion).split(".");
			expect(parts).toHaveLength(3);
			const decode = (part) => {
				const normalized = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
				return Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0));
			};
			expect(JSON.parse(new TextDecoder().decode(decode(parts[0]))).kid).toBe(expectedKeyId);
			expect(await crypto.subtle.verify(
				"RSASSA-PKCS1-v1_5",
				publicKey,
				decode(parts[2]),
				encoder.encode(`${parts[0]}.${parts[1]}`),
			)).toBe(true);
			return new Response(JSON.stringify({ access_token: token, expires_in: 3600 }), { status: 200 });
		};

		expect(await getAccessToken(first.env, verifyExchange("rotation-key-1", first.publicKey, "token-1"))).toBe("token-1");
		invalidateToken();
		expect(await getAccessToken(second.env, verifyExchange("rotation-key-2", second.publicKey, "token-2"))).toBe("token-2");
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
			expect(init.headers["x-goog-user-project"]).toBe("spec-project");
			if (apiCalls === 1) return new Response(JSON.stringify({ error: { status: "UNAUTHENTICATED" } }), { status: 401 });
			return new Response(JSON.stringify({ done: true }), { status: 200 });
		};
		const json = await googleFetch(env, { url: apiUrl(env), body: {}, timeoutMs: 5000 }, { fetch: fetchImpl });
		expect(json.done).toBe(true);
		expect(apiCalls).toBe(2);
	});

	it("rejects authority injection before minting or attaching a bearer token", async () => {
		const env = await envWithAuth();
		env.GCP_REGION = "us-central1-aiplatform.googleapis.com@evil.example/";
		expect(() => generateContentUrl(env, GOOGLE_DEFAULT_MODELS.extract)).toThrow("invalid_region");
		env.GCP_REGION = "us-central1";

		let fetches = 0;
		const error = await googleFetch(env, {
			url: "https://evil.example/v1/models:generateContent",
			body: { secret: "SENTINEL_PROMPT" },
			timeoutMs: 5000,
		}, {
			fetch: async () => {
				fetches += 1;
				return new Response("{}", { status: 200 });
			},
		}).catch((caught) => caught);
		expect(fetches).toBe(0);
		expect(error.googleStatus).toBe("invalid_endpoint");
		expect(String(error.message)).not.toContain("SENTINEL_PROMPT");
	});

	it("rejects unsafe project ids before URL construction", async () => {
		const env = await envWithAuth();
		env.GCP_PROJECT_ID = "spec-project/locations/x";
		expect(() => generateContentUrl(env, GOOGLE_DEFAULT_MODELS.extract)).toThrow("invalid_project");
	});

	it("retries 429 with backoff then surfaces rate_limited", async () => {
		const env = await envWithAuth();
		let apiCalls = 0;
		const waits = [];
		const fetchImpl = async (url, init) => {
			if (String(init?.body ?? "").includes("assertion=")) {
				return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
			}
			apiCalls += 1;
			return new Response(JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED" } }), { status: 429, headers: { "retry-after": "0" } });
		};
		const error = await googleFetch(env, { url: apiUrl(env), body: {}, timeoutMs: 5000 }, {
			fetch: fetchImpl,
			sleep: async (ms) => waits.push(ms),
			random: () => 0,
		}).catch((e) => e);
		expect(apiCalls).toBe(3); // 1 + 2 transient retries
		expect(waits).toEqual([1000, 2000]);
		expect(error.aiErrorClass).toBe("rate_limited");
		expect(error.retryable).toBe(true);
	});

	it("honors Retry-After seconds and HTTP dates without clipping server hints", async () => {
		const env = await envWithAuth();
		const waits = [];
		let apiCalls = 0;
		const now = Date.parse("2026-08-22T00:00:00Z");
		const fetchImpl = async (url, init) => {
			if (String(init?.body ?? "").includes("assertion=")) {
				return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
			}
			apiCalls += 1;
			if (apiCalls === 1) return new Response("{}", { status: 503, headers: { "retry-after": "2" } });
			if (apiCalls === 2) {
				return new Response("{}", {
					status: 503,
					headers: { "retry-after": new Date(now + 5_000).toUTCString() },
				});
			}
			return new Response(JSON.stringify({ done: true }), { status: 200 });
		};
		const json = await googleFetch(env, { url: apiUrl(env), body: {}, timeoutMs: 5000 }, {
			fetch: fetchImpl,
			sleep: async (ms) => waits.push(ms),
			random: () => 0,
			now: () => now,
		});
		expect(json.done).toBe(true);
		expect(json.__retry_count).toBe(2);
		expect(json.__ambiguous_retry_count).toBe(0);
		expect(waits).toEqual([2000, 5000]);
	});

	it("does not replay when Retry-After exceeds the bounded transport window", async () => {
		const env = await envWithAuth();
		let apiCalls = 0;
		const waits = [];
		const fetchImpl = async (url, init) => {
			if (String(init?.body ?? "").includes("assertion=")) {
				return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
			}
			apiCalls += 1;
			return new Response(JSON.stringify({ error: { status: "UNAVAILABLE" } }), {
				status: 503,
				headers: { "retry-after": "120" },
			});
		};
		const error = await googleFetch(env, { url: apiUrl(env), body: {}, timeoutMs: 5000 }, {
			fetch: fetchImpl,
			sleep: async (ms) => waits.push(ms),
		}).catch((e) => e);
		expect(apiCalls).toBe(1);
		expect(waits).toEqual([]);
		expect(error.aiErrorClass).toBe("provider_unavailable");
		expect(error.retryable).toBe(false);
	});

	it("never replays ambiguous network failures or 504 responses", async () => {
		for (const mode of ["network", "gateway_timeout"]) {
			resetGoogleAuthForTests();
			const env = await envWithAuth();
			let apiCalls = 0;
			const waits = [];
			const fetchImpl = async (url, init) => {
				if (String(init?.body ?? "").includes("assertion=")) {
					return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
				}
				apiCalls += 1;
				if (mode === "network") throw new TypeError("socket closed after write");
				return new Response(JSON.stringify({ error: { status: "DEADLINE_EXCEEDED" } }), { status: 504 });
			};
			const error = await googleFetch(env, { url: apiUrl(env), body: {}, timeoutMs: 5000 }, {
				fetch: fetchImpl,
				sleep: async (ms) => waits.push(ms),
			}).catch((e) => e);
			expect(apiCalls, mode).toBe(1);
			expect(waits, mode).toEqual([]);
			expect(error.retryable, mode).toBe(false);
		}
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
		const error = await googleFetch(env, { url: apiUrl(env), body: { secret: "SENTINEL_PROMPT" }, timeoutMs: 50 }, { fetch: fetchImpl }).catch((e) => e);
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
		const error = await googleFetch(env, { url: apiUrl(env), body: {}, timeoutMs: 5000 }, { fetch: fetchImpl }).catch((e) => e);
		expect(error.aiErrorClass).toBe("billing");
		expect(error.googleStatus).toBe("PERMISSION_DENIED");
		expect(error.googleReason).toBe("billingDisabled");
	});

	it("uses enum-only detail reasons and never classifies prose as billing", async () => {
		const env = await envWithAuth();
		let detail = true;
		const fetchImpl = async (url, init) => {
			if (String(init?.body ?? "").includes("assertion=")) {
				return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
			}
			const error = detail
				? { status: "PERMISSION_DENIED", details: [{ reason: "BILLING_DISABLED" }] }
				: { status: "PERMISSION_DENIED", details: [{ reason: "billing disabled because SENTINEL" }] };
			return new Response(JSON.stringify({ error }), { status: 403 });
		};
		const billed = await googleFetch(env, { url: apiUrl(env), body: {}, timeoutMs: 5000 }, { fetch: fetchImpl }).catch((e) => e);
		expect(billed.aiErrorClass).toBe("billing");
		expect(billed.googleReason).toBe("BILLING_DISABLED");

		resetGoogleAuthForTests();
		detail = false;
		const prose = await googleFetch(env, { url: apiUrl(env), body: {}, timeoutMs: 5000 }, { fetch: fetchImpl }).catch((e) => e);
		expect(prose.aiErrorClass).toBe("provider_misconfigured");
		expect(prose.googleReason).toBeNull();
		expect(String(prose.message)).not.toContain("SENTINEL");
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

	it("supports only the documented, type-checked responseSchema subset", () => {
		expect(translateJsonSchema({
			anyOf: [
				{ type: "string", enum: ["active", "archived"], description: "state" },
				{ type: "integer", minimum: 0, maximum: 10 },
			],
		})).toEqual({
			anyOf: [
				{ type: "string", enum: ["active", "archived"], description: "state" },
				{ type: "integer", minimum: 0, maximum: 10 },
			],
		});
		expect(() => translateJsonSchema({ type: "string", const: "x" })).toThrow("keyword const");
		expect(() => translateJsonSchema({ type: ["string", "number", "null"] })).toThrow("type arrays");
		expect(() => translateJsonSchema({ type: "string", enum: ["ok", 7] })).toThrow("array of strings");
		expect(() => translateJsonSchema({ type: "string", format: "email" })).toThrow("format email");
		expect(() => translateJsonSchema({ type: "array", minItems: 4, maxItems: 2, items: { type: "string" } })).toThrow("minItems");
	});

	it("censuses every production schema root against the adapter allowlist", () => {
		const { keywords, roots } = productionSchemaCensus();
		expect(roots.sort()).toEqual([
			"atomic:ATOMIC_CAPTURE_JSON_SCHEMA",
			"engine_v2:EDGE_SCHEMA",
			"engine_v2:REFLEXION_SCHEMA",
			"rules:schema.json_schema",
		]);
		expect([...keywords].sort()).toEqual([
			"additionalProperties",
			"anyOf",
			"enum",
			"items",
			"maxItems",
			"maximum",
			"minimum",
			"properties",
			"required",
			"type",
		]);
		for (const keyword of keywords) expect(GOOGLE_RESPONSE_SCHEMA_KEYWORDS).toContain(keyword);
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

	it("embeddings assert dimension, surface truncation, and are L2-normalized", () => {
		const raw = { predictions: [{ embeddings: { values: [3, 4, 0, ...Array(765).fill(0)], statistics: { token_count: 5, truncated: true } } }] };
		const mapped = parseEmbed(raw, { expectedDim: 768 });
		const vec = mapped.data[0];
		expect(vec.length).toBe(768);
		const norm = Math.sqrt(vec.reduce((a, v) => a + v * v, 0));
		expect(norm).toBeCloseTo(1, 6);
		expect(mapped.truncated).toBe(true);
		expect(mapped.usage.embedding_truncated).toBe(true);
		expect(readUsage(mapped).raw.embedding_truncated).toBe(true);

		expect(() => parseEmbed({ predictions: [{ embeddings: { values: [1, 2, 3] } }] }, { expectedDim: 768 }))
			.toThrow("embedding_dim_mismatch");
		expect(() => parseEmbed({ predictions: [{ embeddings: { values: [Number.NaN, ...Array(767).fill(0)] } }] }, { expectedDim: 768 }))
			.toThrow("non-finite");
		expect(() => parseEmbed({ predictions: [{ embeddings: { values: Array(768).fill(0) } }] }, { expectedDim: 768 }))
			.toThrow("zero magnitude");
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

	describe("provider declaration", () => {
		it("resolves the same concrete model for admission and transport", () => {
			expect(resolveGoogleModel({ capability: "embed_query", model: null, meta: { task: "embed" } }))
				.toBe(GOOGLE_DEFAULT_MODELS.embed);
			expect(resolveGoogleModel({ capability: "rerank", model: null, requestedModel: "@cf/rerank" }))
				.toBe(GOOGLE_DEFAULT_MODELS.rerank);
			expect(resolveGoogleModel({ capability: "generate_structured", model: "gemini-2.5-pro", requestedModel: "@cf/model", meta: { task: "edges" } }))
				.toBe("gemini-2.5-pro");
			expect(resolveGoogleModel({ capability: "chat", model: GOOGLE_DEFAULT_MODELS.playground_chat, requestedModel: GOOGLE_DEFAULT_MODELS.playground_chat, meta: { task: "provider_health" } }))
				.toBe(GOOGLE_DEFAULT_MODELS.playground_chat);
			expect(googleProvider.resolveModel).toBe(resolveGoogleModel);
		});

		it("rejects moving aliases, unknown cards, and cross-capability model ids", () => {
			for (const model of ["gemini-2.5-flash-latest", "gemini-future-ultra", "../publishers/evil", "@cf/model"]) {
				expect(() => resolveGoogleModel({ capability: "generate_text", model, meta: { task: "summary" } }))
					.toThrow();
			}
			expect(() => resolveGoogleModel({ capability: "generate_structured", model: "gemini-embedding-001", meta: { task: "extract" } }))
				.toThrow();
			expect(() => resolveGoogleModel({ capability: "embed_query", model: "gemini-2.5-flash", meta: { task: "embed" } }))
				.toThrow();
			expect(() => resolveGoogleModel({ capability: "rerank", model: "semantic-ranker-custom" }))
				.toThrow();
		});

	it("describes health as a normal admitted call and performs no direct transport", () => {
		const call = googleProvider.healthCall();
		expect(call).toMatchObject({
			model: GOOGLE_DEFAULT_MODELS.playground_chat,
			inputs: { temperature: 0, max_tokens: 8 },
			meta: { task: "provider_health", capability: "chat" },
		});
		expect(resolveGoogleModel({ ...call, capability: "chat" })).toBe(call.model);
		expect(googleProvider.health).toBeUndefined();
	});
});
