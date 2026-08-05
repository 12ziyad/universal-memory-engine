import { spawnSync } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	open,
	readFile,
	readdir,
	rename,
	rm,
	stat,
	unlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
	OUTBOX_LIMITS,
	OUTBOX_SCHEMA,
	STATE_SCHEMA,
	TOMBSTONE_SCHEMA,
	bindOutbox,
	credentialFingerprint,
	drainOutbox,
	enqueueSession,
	inspectOutbox,
	pluginDataFromArgs,
	sanitizeMemoryScope,
} from "../hooks/outbox.mjs";

const API_KEY = "itsuki_live_outbox_test_key_123456";
const ROTATED_KEY = "itsuki_live_outbox_rotated_654321";
const BASE_URL = "https://outbox-test.invalid/private-base";
const ALTERNATE_BASE_URL = "https://alternate-outbox-test.invalid/memory";
const FIXED_NOW = 1_800_000_000_000;
const WINDOWS_SECURITY = {
	platform: "win32",
	securityRunner: async () => ({ ok: true, protected: true, principals: 3 }),
};

const roots = new Set();

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
	roots.clear();
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "itsuki-hook-outbox-"));
	const pluginData = join(root, "private-plugin-data");
	await mkdir(pluginData, { recursive: true });
	roots.add(root);
	return {
		root,
		pluginData,
		outbox: join(pluginData, "outbox", "v1"),
	};
}

function message(suffix = "one", content = `Remember durable outbox decision ${suffix}.`) {
	return { id: `message-${suffix}`, role: "user", content, ts: FIXED_NOW };
}

async function enqueue(data, {
	apiKey = API_KEY,
	fingerprint = apiKey === null ? null : credentialFingerprint(apiKey, BASE_URL),
	suffix = "one",
	content,
	now = FIXED_NOW,
	memoryScope = { projectId: "project-atlas", projectName: "Atlas", appId: "claude-code-plugin" },
} = {}) {
	return enqueueSession({
		pluginData: data.pluginData,
		messages: [message(suffix, content)],
		sessionId: "session-outbox-regression",
		memoryScope,
		credentialFingerprint: fingerprint,
		now: () => now,
		...WINDOWS_SECURITY,
	});
}

function acceptedResponse({
	status = 202,
	sourcePacketId = "src_11111111-1111-4111-8111-111111111111",
	receiptId = "receipt_22222222-2222-4222-8222-222222222222",
	jobId = "job_33333333-3333-4333-8333-333333333333",
	body = {},
	headers = {},
} = {}) {
	return new Response(JSON.stringify({
		ok: true,
		status: "queued",
		source_packet_id: sourcePacketId,
		receipt_id: receiptId,
		job_id: jobId,
		...body,
	}), { status, headers: { "content-type": "application/json", ...headers } });
}

function response(status, body = { ok: false }, headers = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

async function directoryFiles(path) {
	return (await readdir(path)).sort();
}

async function onlyJson(path) {
	const names = (await directoryFiles(path)).filter((name) => name.endsWith(".json"));
	expect(names).toHaveLength(1);
	return {
		name: names[0],
		value: JSON.parse(await readFile(join(path, names[0]), "utf8")),
	};
}

async function allFileText(root) {
	const chunks = [];
	async function visit(path) {
		for (const entry of await readdir(path, { withFileTypes: true })) {
			const child = join(path, entry.name);
			if (entry.isDirectory()) await visit(child);
			else if (entry.isFile()) chunks.push(await readFile(child, "utf8"));
		}
	}
	await visit(root);
	return chunks.join("\n");
}

async function stateFor(data, queueId) {
	return JSON.parse(await readFile(join(data.outbox, "state", `${queueId}.json`), "utf8"));
}

function contentDigestFromEnvelope(envelope) {
	const match = /^claude-outbox:v1:([a-f0-9]{64})$/.exec(envelope?.request?.body?.idempotencyKey ?? "");
	if (!match) throw new Error("test envelope does not contain a canonical content digest");
	return match[1];
}

function drain(data, overrides = {}) {
	return drainOutbox({
		pluginData: data.pluginData,
		apiKey: API_KEY,
		baseUrl: BASE_URL,
		fetchFn: async () => acceptedResponse(),
		now: () => FIXED_NOW,
		maxDurationMs: 1_000,
		requestTimeoutMs: 100,
		...WINDOWS_SECURITY,
		...overrides,
	});
}

describe("protected hook outbox", () => {
	it("rejects broad, reserved, or contradictory plugin-data paths before filesystem mutation", () => {
		const configRoot = join(tmpdir(), "itsuki-plugin-data-validation", "claude-config");
		const safe = join(configRoot, "plugins", "data", "itsuki");
		const other = join(configRoot, "plugins", "data", "different-plugin-data");
		const baseEnv = { CLAUDE_CONFIG_DIR: configRoot };
		const filesystemRoot = parse(process.cwd()).root;

		expect(pluginDataFromArgs(["--plugin-data", filesystemRoot], baseEnv)).toBeNull();
		expect(pluginDataFromArgs(["--plugin-data", homedir()], baseEnv)).toBeNull();
		expect(pluginDataFromArgs(["--plugin-data", process.cwd()], baseEnv)).toBeNull();
		expect(pluginDataFromArgs(["--plugin-data", join(process.cwd(), "nested")], baseEnv)).toBeNull();
		expect(pluginDataFromArgs(["--plugin-data", join(configRoot, "plugins", "data", "nested", "itsuki")], baseEnv)).toBeNull();
		expect(pluginDataFromArgs(["--plugin-data", safe], { ...baseEnv, CLAUDE_PLUGIN_DATA: other })).toBeNull();
		expect(pluginDataFromArgs(["--plugin-data", safe], { ...baseEnv, CLAUDE_PLUGIN_DATA: safe })).toBe(safe);
		expect(pluginDataFromArgs([], { ...baseEnv, CLAUDE_PLUGIN_DATA: safe })).toBe(safe);
		if (process.platform === "win32") {
			expect(pluginDataFromArgs(["--plugin-data", "\\\\server\\share\\itsuki"], baseEnv)).toBeNull();
			expect(pluginDataFromArgs(["--plugin-data", join(process.env.SystemRoot, "System32", "itsuki")], process.env)).toBeNull();
		}
	});

	it("accepts Claude's documented default plugin-data child even when launched from the user home", () => {
		const previous = process.cwd();
		const canonical = join(homedir(), ".claude", "plugins", "data", "itsuki");
		try {
			process.chdir(homedir());
			expect(pluginDataFromArgs(["--plugin-data", canonical], { CLAUDE_PLUGIN_DATA: canonical })).toBe(canonical);
		} finally {
			process.chdir(previous);
		}
	});

	it("scopes Windows ACL verification to the dedicated outbox/v1 tree", async () => {
		const data = await fixture();
		const securityRunner = vi.fn(async () => ({ ok: true, protected: true, principals: 3 }));
		await enqueueSession({
			pluginData: data.pluginData,
			messages: [message("acl-scope")],
			sessionId: "acl-scope-session",
			memoryScope: { projectId: "acl-scope" },
			credentialFingerprint: credentialFingerprint(API_KEY, BASE_URL),
			platform: "win32",
			securityRunner,
		});

		expect(securityRunner).toHaveBeenCalledWith(join(data.pluginData, "outbox", "v1"), "EnsureDirectories");
	});

	it("persists only scrubbed content and one-way transport metadata", async () => {
		const data = await fixture();
		const privatePath = join(data.root, "company", "atlas");
		const secret = "sk-abcdefghijklmnopQRSTUV123456";
		const first = await enqueue(data, {
			content: `Use ${secret} for the synthetic request.`,
			memoryScope: { projectId: "opaque-project-id", projectName: "Atlas" },
		});
		const raw = await allFileText(data.outbox);

		expect(first).toMatchObject({ queued: true, duplicate: false, bound: true });
		expect(raw).toContain("[REDACTED:api-key]");
		expect(raw).toContain(credentialFingerprint(API_KEY, BASE_URL));
		expect(raw).not.toContain(secret);
		expect(raw).not.toContain(API_KEY);
		expect(raw).not.toContain(BASE_URL);
		expect(raw).not.toContain(data.root);
		expect(raw).not.toContain(data.pluginData);
		expect(raw).not.toContain(privatePath);
	});

	it("scrubs secret-like scope values into deterministic non-secret identities", async () => {
		const data = await fixture();
		const projectId = "itsuki_live_project_scope_secret_123456";
		const projectName = "sk-abcdefghijklmnopQRSTUV123456";
		const workspaceId = "postgres://admin:hunter2@database.example.invalid";
		const queued = await enqueue(data, {
			suffix: "secret-scope",
			memoryScope: { projectId, projectName, workspaceId, appId: "claude-code-plugin" },
		});
		const stored = JSON.parse(await readFile(
			join(data.outbox, "pending", `${queued.queueId}.json`),
			"utf8",
		));
		const scope = stored.request.body.memoryScope;
		const disk = await allFileText(data.outbox);

		expect(scope.projectId).toMatch(/^opaque_[a-f0-9]{32}$/);
		expect(scope.projectName).toBe("[REDACTED:api-key]");
		expect(scope.workspaceId).toMatch(/^opaque_[a-f0-9]{32}$/);
		expect(scope.appId).toBe("claude-code-plugin");
		expect(scope.projectId).not.toBe(scope.projectName);
		expect(scope).toEqual(sanitizeMemoryScope({ projectId, projectName, workspaceId, appId: "claude-code-plugin" }));
		expect(sanitizeMemoryScope({ projectId: "local_0123456789abcdef0123456789abcdef" }).projectId)
			.toBe("local_0123456789abcdef0123456789abcdef");
		expect(disk).not.toContain(projectId);
		expect(disk).not.toContain(projectName);
		expect(disk).not.toContain("hunter2");
	});

	it("does not trust a raw credential passed in the fingerprint field", async () => {
		const data = await fixture();
		await expect(enqueue(data, { fingerprint: API_KEY })).rejects.toMatchObject({
			code: "invalid_credential_fingerprint",
		});
		expect(await allFileText(data.outbox)).not.toContain(API_KEY);
	});

	it("deduplicates the same scrubbed session deterministically", async () => {
		const data = await fixture();
		const first = await enqueue(data, { now: FIXED_NOW });
		const replay = await enqueue(data, { now: FIXED_NOW + 60_000 });
		const renamedProject = await enqueue(data, {
			now: FIXED_NOW + 120_000,
			memoryScope: { projectId: "project-atlas", projectName: "Atlas Renamed", appId: "claude-code-plugin" },
		});

		expect(replay).toMatchObject({ duplicate: true, state: "pending", queueId: first.queueId });
		expect(renamedProject).toMatchObject({ duplicate: true, state: "pending", queueId: first.queueId });
		expect(await directoryFiles(join(data.outbox, "pending"))).toEqual([`${first.queueId}.json`]);
	});

	it("replaces accepted raw content with a metadata-only tombstone", async () => {
		const data = await fixture();
		const queued = await enqueue(data, { content: "A private durable decision that must leave no raw success copy." });
		const queuedEnvelope = JSON.parse(await readFile(
			join(data.outbox, "pending", `${queued.queueId}.json`),
			"utf8",
		));
		const result = await drain(data);
		const done = await onlyJson(join(data.outbox, "done"));
		const disk = await allFileText(data.outbox);

		expect(result).toMatchObject({
			delivered: 1,
			retried: 0,
			permanentFailures: 0,
			accepted: [{
				queueId: queued.queueId,
				sourcePacketId: "src_11111111-1111-4111-8111-111111111111",
				receiptId: "receipt_22222222-2222-4222-8222-222222222222",
				jobId: "job_33333333-3333-4333-8333-333333333333",
				status: "queued",
			}],
		});
		expect(done.name).toBe(`${queued.queueId}.json`);
		expect(done.value).toEqual({
			accepted_at: FIXED_NOW,
			content_digest: contentDigestFromEnvelope(queuedEnvelope),
			credential_fingerprint: credentialFingerprint(API_KEY, BASE_URL),
			duplicate: false,
			http_status: 202,
			job_id: "job_33333333-3333-4333-8333-333333333333",
			queue_id: queued.queueId,
			receipt_id: "receipt_22222222-2222-4222-8222-222222222222",
			schema: TOMBSTONE_SCHEMA,
			source_packet_id: "src_11111111-1111-4111-8111-111111111111",
			status: "queued",
		});
		for (const name of ["pending", "inflight", "accepted", "failed", "state"]) {
			expect(await directoryFiles(join(data.outbox, name))).toEqual([]);
		}
		expect(disk).not.toContain("private durable decision");
		expect(disk).not.toContain(API_KEY);
		expect(disk).not.toContain(BASE_URL);
	});

	it.each([
		["network error", async () => { throw Object.assign(new Error("offline"), { code: "ECONNRESET" }); }, "ECONNRESET"],
		["DNS error", async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }); }, "ENOTFOUND"],
		["request timeout", async () => new Promise(() => {}), "timeout"],
	])("retains raw data and schedules retry after a %s", async (_label, fetchFn, errorCode) => {
		const data = await fixture();
		const queued = await enqueue(data);
		const result = await drain(data, { fetchFn, requestTimeoutMs: 15 });
		const state = await stateFor(data, queued.queueId);

		expect(result).toMatchObject({ retried: 1, transportUnavailable: true, delivered: 0 });
		expect(state).toMatchObject({
			schema: STATE_SCHEMA,
			queue_id: queued.queueId,
			attempts: 1,
			last_error_code: errorCode,
			binding_fingerprint: credentialFingerprint(API_KEY, BASE_URL),
		});
		expect(state.next_attempt_at).toBeGreaterThan(FIXED_NOW);
		expect(await directoryFiles(join(data.outbox, "pending"))).toEqual([`${queued.queueId}.json`]);
		expect(await directoryFiles(join(data.outbox, "inflight"))).toEqual([]);
		const disk = await allFileText(data.outbox);
		expect(disk).not.toContain(API_KEY);
		expect(disk).not.toContain(BASE_URL);
	});

	it("times out a response whose headers arrive but body never completes", async () => {
		const data = await fixture();
		const queued = await enqueue(data);
		const requestTimeoutMs = 40;
		const startedAt = Date.now();
		const fetchFn = vi.fn(async () => new Response(new ReadableStream({
			start() {
				// Headers are available immediately, but the body intentionally never
				// closes. The request deadline must cover body consumption too.
			},
		}), { status: 202, headers: { "content-type": "application/json" } }));
		const completion = drain(data, { fetchFn, requestTimeoutMs })
			.then((value) => ({ kind: "completed", value }));
		let guardTimer;
		const guard = new Promise((resolve) => {
			guardTimer = setTimeout(() => resolve({ kind: "hung" }), 300);
		});
		const outcome = await Promise.race([completion, guard]);
		clearTimeout(guardTimer);
		const elapsedMs = Date.now() - startedAt;

		expect(outcome.kind, "drain remained stuck after its request timeout").toBe("completed");
		if (outcome.kind !== "completed") return;
		expect(elapsedMs).toBeLessThan(250);
		expect(outcome.value).toMatchObject({
			delivered: 0,
			retried: 1,
			transportUnavailable: true,
		});
		expect(fetchFn).toHaveBeenCalledTimes(1);
		expect(await directoryFiles(join(data.outbox, "pending"))).toEqual([`${queued.queueId}.json`]);
		expect(await directoryFiles(join(data.outbox, "inflight"))).toEqual([]);
		expect(await stateFor(data, queued.queueId)).toMatchObject({
			attempts: 1,
			last_error_code: "timeout",
		});
	}, 2_000);

	it.each([401, 403])("blocks the rejected credential after HTTP %i without losing raw data", async (status) => {
		const data = await fixture();
		const queued = await enqueue(data);
		const fetchFn = vi.fn(async () => response(status));
		const first = await drain(data, { fetchFn });
		const second = await drain(data, { fetchFn });
		const state = await stateFor(data, queued.queueId);

		expect(first).toMatchObject({ authBlocked: true, delivered: 0, retried: 0 });
		expect(second).toMatchObject({ authBlocked: true, delivered: 0 });
		expect(fetchFn).toHaveBeenCalledTimes(1);
		expect(state).toMatchObject({ attempts: 1, last_error_code: "credential_rejected" });
		expect(await directoryFiles(join(data.outbox, "pending"))).toEqual([`${queued.queueId}.json`]);
		expect(JSON.parse(await readFile(join(data.outbox, "control", "auth-block.json"), "utf8"))).toMatchObject({
			credential_fingerprint: credentialFingerprint(API_KEY, BASE_URL),
			http_status: status,
		});
	});

	it("fails closed on corrupt retry or authentication control state", async () => {
		const data = await fixture();
		const queued = await enqueue(data, { suffix: "corrupt-control" });
		const fetchFn = vi.fn(async () => acceptedResponse());
		await writeFile(join(data.outbox, "state", `${queued.queueId}.json`), JSON.stringify({
			schema: STATE_SCHEMA,
			queue_id: queued.queueId,
			attempts: -1,
			next_attempt_at: "forever",
		}), "utf8");

		await expect(drain(data, { fetchFn })).rejects.toMatchObject({ code: "outbox_insecure" });
		expect(fetchFn).not.toHaveBeenCalled();
		expect(await directoryFiles(join(data.outbox, "pending"))).toEqual([`${queued.queueId}.json`]);

		await unlink(join(data.outbox, "state", `${queued.queueId}.json`));
		await writeFile(join(data.outbox, "control", "auth-block.json"), "{}", "utf8");
		await expect(drain(data, { fetchFn })).rejects.toMatchObject({ code: "outbox_insecure" });
		expect(fetchFn).not.toHaveBeenCalled();
		const health = await inspectOutbox({
			pluginData: data.pluginData,
			apiKey: API_KEY,
			baseUrl: BASE_URL,
			...WINDOWS_SECURITY,
		});
		expect(health).toMatchObject({ healthy: false, corruptEntries: 1, authBlocked: false });
	});

	it("honors Retry-After for HTTP 429", async () => {
		const data = await fixture();
		const queued = await enqueue(data);
		const result = await drain(data, { fetchFn: async () => response(429, { ok: false }, { "retry-after": "2" }) });
		const state = await stateFor(data, queued.queueId);

		expect(result).toMatchObject({ retried: 1, delivered: 0, transportUnavailable: false });
		expect(state).toMatchObject({ attempts: 1, last_error_code: "rate_limited", last_http_status: 429 });
		expect(state.next_attempt_at).toBe(FIXED_NOW + 2_000);
	});

	it("backs off HTTP 500 and does not retry before it is due", async () => {
		const data = await fixture();
		const queued = await enqueue(data);
		const fetchFn = vi.fn()
			.mockResolvedValueOnce(response(500))
			.mockResolvedValueOnce(acceptedResponse());
		const first = await drain(data, { fetchFn });
		const state = await stateFor(data, queued.queueId);
		const early = await drain(data, { fetchFn, now: () => state.next_attempt_at - 1 });
		const due = await drain(data, { fetchFn, now: () => state.next_attempt_at });

		expect(first).toMatchObject({ retried: 1, delivered: 0 });
		expect(state).toMatchObject({ attempts: 1, last_error_code: "server_error", last_http_status: 500 });
		expect(state.next_attempt_at).toBeGreaterThanOrEqual(FIXED_NOW + 4_000);
		expect(state.next_attempt_at).toBeLessThanOrEqual(FIXED_NOW + 6_000);
		expect(early).toMatchObject({ backoffSkipped: 1, delivered: 0 });
		expect(due).toMatchObject({ delivered: 1 });
		expect(fetchFn).toHaveBeenCalledTimes(2);
	});

	it("atomically replaces an existing retry sidecar on Windows", async () => {
		const data = await fixture();
		const queued = await enqueue(data);
		const fetchFn = vi.fn(async () => response(500));
		await drain(data, { fetchFn });
		const firstState = await stateFor(data, queued.queueId);
		const second = await drain(data, { fetchFn, now: () => firstState.next_attempt_at });
		const secondState = await stateFor(data, queued.queueId);

		expect(second).toMatchObject({ retried: 1, delivered: 0 });
		expect(fetchFn).toHaveBeenCalledTimes(2);
		expect(secondState).toMatchObject({
			attempts: 2,
			last_error_code: "server_error",
			last_http_status: 500,
		});
		expect(secondState.next_attempt_at).toBeGreaterThan(firstState.next_attempt_at);
		expect(await directoryFiles(join(data.outbox, "pending"))).toEqual([`${queued.queueId}.json`]);
	});

	it("quarantines a permanent HTTP failure with its diagnostic sidecar", async () => {
		const data = await fixture();
		const queued = await enqueue(data);
		const result = await drain(data, { fetchFn: async () => response(422, { ok: false, error: "invalid" }) });
		const state = await stateFor(data, queued.queueId);

		expect(result).toMatchObject({ permanentFailures: 1, retried: 0, delivered: 0 });
		expect(state).toMatchObject({
			attempts: 1,
			permanent: true,
			last_error_code: "http_422",
			last_http_status: 422,
		});
		expect(await directoryFiles(join(data.outbox, "failed"))).toEqual([`${queued.queueId}.json`]);
		expect(await directoryFiles(join(data.outbox, "pending"))).toEqual([]);
	});

	it.each([
		["malformed JSON", new Response("not-json", { status: 202 })],
		["an uncorrelated ok body", response(200, { ok: true, status: "accepted" })],
	])("quarantines a 2xx response with %s instead of deleting raw data", async (_label, invalidResponse) => {
		const data = await fixture();
		const queued = await enqueue(data);
		const result = await drain(data, { fetchFn: async () => invalidResponse.clone() });
		const state = await stateFor(data, queued.queueId);

		expect(result).toMatchObject({ permanentFailures: 1, delivered: 0, retried: 0 });
		expect(state).toMatchObject({
			permanent: true,
			last_error_code: "invalid_acceptance_response",
			last_http_status: invalidResponse.status,
		});
		expect(await directoryFiles(join(data.outbox, "failed"))).toEqual([`${queued.queueId}.json`]);
	});

	it("does not treat a bare duplicate flag as evidence that raw data is durable", async () => {
		const data = await fixture();
		const privateContent = "Preserve this raw decision until a correlated acceptance exists.";
		const queued = await enqueue(data, { content: privateContent });
		const result = await drain(data, {
			fetchFn: async () => response(202, { ok: true, duplicate: true }),
		});
		const state = await stateFor(data, queued.queueId);

		expect(result).toMatchObject({ delivered: 0, retried: 0, permanentFailures: 1 });
		expect(state).toMatchObject({
			permanent: true,
			last_error_code: "invalid_acceptance_response",
			last_http_status: 202,
		});
		expect(await directoryFiles(join(data.outbox, "done"))).toEqual([]);
		expect(await directoryFiles(join(data.outbox, "accepted"))).toEqual([]);
		expect(await directoryFiles(join(data.outbox, "failed"))).toEqual([`${queued.queueId}.json`]);
		expect(await allFileText(join(data.outbox, "failed"))).toContain(privateContent);
	});

	it("refuses unbound and mismatched entries until an explicit bind", async () => {
		const data = await fixture();
		const unbound = await enqueue(data, { apiKey: null, suffix: "unbound" });
		const oldKey = await enqueue(data, { apiKey: API_KEY, suffix: "old-key" });
		const fetchFn = vi.fn(async () => acceptedResponse());

		const refused = await drain(data, { apiKey: ROTATED_KEY, fetchFn });
		expect(refused).toMatchObject({
			delivered: 0,
			bindingRequired: 2,
			credentialMismatch: 1,
		});
		expect(fetchFn).not.toHaveBeenCalled();

		const bound = await bindOutbox({
			pluginData: data.pluginData,
			apiKey: ROTATED_KEY,
			baseUrl: BASE_URL,
			queueIds: [unbound.queueId, oldKey.queueId],
			...WINDOWS_SECURITY,
		});
		const delivered = await drain(data, { apiKey: ROTATED_KEY, fetchFn });

		expect(bound).toEqual({ ok: true, bound: 2 });
		expect(delivered).toMatchObject({ delivered: 2, bindingRequired: 0, credentialMismatch: 0 });
		expect(fetchFn).toHaveBeenCalledTimes(2);
	});

	it("binds the same key to an explicit delivery origin", async () => {
		const data = await fixture();
		const queued = await enqueue(data, { suffix: "origin-bound" });
		const originalEnvelope = JSON.parse(await readFile(
			join(data.outbox, "pending", `${queued.queueId}.json`),
			"utf8",
		));
		const fetchFn = vi.fn(async () => acceptedResponse());
		const refused = await drain(data, {
			apiKey: API_KEY,
			baseUrl: ALTERNATE_BASE_URL,
			fetchFn,
		});

		expect(credentialFingerprint(API_KEY, BASE_URL)).not.toBe(
			credentialFingerprint(API_KEY, ALTERNATE_BASE_URL),
		);
		expect(refused).toMatchObject({
			delivered: 0,
			bindingRequired: 1,
			credentialMismatch: 1,
		});
		expect(fetchFn).not.toHaveBeenCalled();

		const rebound = await bindOutbox({
			pluginData: data.pluginData,
			apiKey: API_KEY,
			baseUrl: ALTERNATE_BASE_URL,
			queueIds: [queued.queueId],
			...WINDOWS_SECURITY,
		});
		expect(rebound).toEqual({ ok: true, bound: 1 });
		const reboundFiles = await directoryFiles(join(data.outbox, "pending"));
		expect(reboundFiles).toHaveLength(1);
		const reboundQueueId = reboundFiles[0].replace(/\.json$/, "");
		const reboundEnvelope = JSON.parse(await readFile(
			join(data.outbox, "pending", reboundFiles[0]),
			"utf8",
		));
		expect(reboundQueueId).not.toBe(queued.queueId);
		expect(reboundEnvelope).toMatchObject({
			queue_id: reboundQueueId,
			credential_fingerprint: credentialFingerprint(API_KEY, ALTERNATE_BASE_URL),
			request: originalEnvelope.request,
			request_sha256: originalEnvelope.request_sha256,
		});
		expect(await directoryFiles(join(data.outbox, "state"))).toEqual([`${reboundQueueId}.json`]);
		expect(await stateFor(data, reboundQueueId)).toMatchObject({
			binding_fingerprint: credentialFingerprint(API_KEY, ALTERNATE_BASE_URL),
		});

		const delivered = await drain(data, {
			apiKey: API_KEY,
			baseUrl: ALTERNATE_BASE_URL,
			fetchFn,
		});
		expect(delivered).toMatchObject({ delivered: 1, credentialMismatch: 0 });
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});

	it("keeps destination-bound tombstones from suppressing a fresh enqueue for the original origin", async () => {
		const data = await fixture();
		const original = await enqueue(data, { suffix: "origin-round-trip", now: Date.now() });
		const rebound = await bindOutbox({
			pluginData: data.pluginData,
			apiKey: API_KEY,
			baseUrl: ALTERNATE_BASE_URL,
			queueIds: [original.queueId],
			...WINDOWS_SECURITY,
		});
		expect(rebound).toEqual({ ok: true, bound: 1 });
		const reboundFile = (await directoryFiles(join(data.outbox, "pending")))[0];
		const reboundQueueId = reboundFile.replace(/\.json$/, "");
		expect(reboundQueueId).not.toBe(original.queueId);

		const delivered = await drain(data, {
			apiKey: API_KEY,
			baseUrl: ALTERNATE_BASE_URL,
			fetchFn: async () => acceptedResponse(),
			now: Date.now,
		});
		expect(delivered).toMatchObject({ delivered: 1 });
		expect(await directoryFiles(join(data.outbox, "done"))).toEqual([`${reboundQueueId}.json`]);

		const backAtOriginalOrigin = await enqueue(data, {
			suffix: "origin-round-trip",
			now: Date.now(),
		});
		expect(backAtOriginalOrigin).toMatchObject({
			queued: true,
			duplicate: false,
			state: "pending",
			queueId: original.queueId,
		});
		expect(await directoryFiles(join(data.outbox, "pending"))).toEqual([`${original.queueId}.json`]);
		expect(await directoryFiles(join(data.outbox, "done"))).toEqual([`${reboundQueueId}.json`]);
	});

	it("serializes explicit binding against an in-flight delivery", async () => {
		const data = await fixture();
		await enqueue(data);
		let announceFetch;
		let completeFetch;
		const fetchStarted = new Promise((resolve) => { announceFetch = resolve; });
		const fetchResponse = new Promise((resolve) => { completeFetch = resolve; });
		const fetchFn = vi.fn(async () => {
			announceFetch();
			return fetchResponse;
		});
		const draining = drain(data, { fetchFn, requestTimeoutMs: 1_000 });
		await fetchStarted;

		await expect(bindOutbox({
			pluginData: data.pluginData,
			apiKey: ROTATED_KEY,
			baseUrl: BASE_URL,
			...WINDOWS_SECURITY,
		})).rejects.toMatchObject({ code: "outbox_busy" });

		completeFetch(acceptedResponse());
		expect(await draining).toMatchObject({ delivered: 1 });
		expect(fetchFn).toHaveBeenCalledTimes(1);
		expect(await directoryFiles(join(data.outbox, "pending"))).toEqual([]);
		expect(await directoryFiles(join(data.outbox, "state"))).toEqual([]);
	});

	it("preserves a concurrent enqueue while drain is between claim and completion", async () => {
		const data = await fixture();
		const first = await enqueue(data, { suffix: "draining-first" });
		let announceFetch;
		let completeFetch;
		const fetchStarted = new Promise((resolve) => { announceFetch = resolve; });
		const fetchResponse = new Promise((resolve) => { completeFetch = resolve; });
		const firstFetch = vi.fn(async () => {
			announceFetch();
			return fetchResponse;
		});
		const draining = drain(data, { fetchFn: firstFetch, requestTimeoutMs: 1_000 });
		await fetchStarted;

		const second = await enqueue(data, { suffix: "enqueued-during-network" });
		expect(second).toMatchObject({ queued: true, duplicate: false, state: "pending" });
		expect(await directoryFiles(join(data.outbox, "inflight"))).toEqual([`${first.queueId}.json`]);
		expect(await directoryFiles(join(data.outbox, "pending"))).toEqual([`${second.queueId}.json`]);

		completeFetch(acceptedResponse());
		expect(await draining).toMatchObject({ delivered: 1 });
		expect(await directoryFiles(join(data.outbox, "done"))).toEqual([`${first.queueId}.json`]);
		expect(await directoryFiles(join(data.outbox, "pending"))).toEqual([`${second.queueId}.json`]);

		const secondFetch = vi.fn(async () => acceptedResponse({
			sourcePacketId: "src_77777777-7777-4777-8777-777777777777",
			receiptId: "receipt_88888888-8888-4888-8888-888888888888",
			jobId: "job_99999999-9999-4999-8999-999999999999",
		}));
		expect(await drain(data, { fetchFn: secondFetch, now: Date.now })).toMatchObject({ delivered: 1 });
		expect(secondFetch).toHaveBeenCalledTimes(1);
		expect(await directoryFiles(join(data.outbox, "pending"))).toEqual([]);
		expect(await directoryFiles(join(data.outbox, "inflight"))).toEqual([]);
		expect(await directoryFiles(join(data.outbox, "done"))).toEqual([
			`${first.queueId}.json`,
			`${second.queueId}.json`,
		].sort());
	});

	it("recovers a raw envelope left in inflight by a crashed sender", async () => {
		const data = await fixture();
		const queued = await enqueue(data);
		await rename(
			join(data.outbox, "pending", `${queued.queueId}.json`),
			join(data.outbox, "inflight", `${queued.queueId}.json`),
		);
		const fetchFn = vi.fn(async () => acceptedResponse());
		const result = await drain(data, { fetchFn });

		expect(result).toMatchObject({ delivered: 1 });
		expect(fetchFn).toHaveBeenCalledTimes(1);
		expect(await directoryFiles(join(data.outbox, "inflight"))).toEqual([]);
		expect(await directoryFiles(join(data.outbox, "done"))).toEqual([`${queued.queueId}.json`]);
	});

	it("finalizes an acceptance tombstone after a crash without replaying the request", async () => {
		const data = await fixture();
		const queued = await enqueue(data, { content: "Raw content already accepted before the crash." });
		await rename(
			join(data.outbox, "pending", `${queued.queueId}.json`),
			join(data.outbox, "inflight", `${queued.queueId}.json`),
		);
		const inflightEnvelope = JSON.parse(await readFile(
			join(data.outbox, "inflight", `${queued.queueId}.json`),
			"utf8",
		));
		await writeFile(join(data.outbox, "accepted", `${queued.queueId}.json`), JSON.stringify({
			schema: TOMBSTONE_SCHEMA,
			queue_id: queued.queueId,
			credential_fingerprint: credentialFingerprint(API_KEY, BASE_URL),
			content_digest: contentDigestFromEnvelope(inflightEnvelope),
			accepted_at: FIXED_NOW - 1,
			http_status: 202,
			source_packet_id: "src_44444444-4444-4444-8444-444444444444",
			receipt_id: "receipt_55555555-5555-4555-8555-555555555555",
			job_id: "job_66666666-6666-4666-8666-666666666666",
			status: "queued",
			duplicate: false,
		}), "utf8");
		const fetchFn = vi.fn(async () => acceptedResponse());
		const result = await drain(data, { fetchFn, now: Date.now });

		expect(result).toMatchObject({ delivered: 0 });
		expect(fetchFn).not.toHaveBeenCalled();
		expect(await directoryFiles(join(data.outbox, "inflight"))).toEqual([]);
		expect(await directoryFiles(join(data.outbox, "accepted"))).toEqual([]);
		expect(await directoryFiles(join(data.outbox, "done"))).toEqual([`${queued.queueId}.json`]);
		expect(await allFileText(data.outbox)).not.toContain("Raw content already accepted");
	});

	it("fails closed on an accepted tombstone with a traversal queue ID", async () => {
		const data = await fixture();
		const queued = await enqueue(data, { suffix: "traversal-guard" });
		const sentinelPath = join(data.root, "sentinel.json");
		const sentinel = "outside-outbox-sentinel-must-survive";
		await writeFile(sentinelPath, sentinel, "utf8");
		await writeFile(join(data.outbox, "accepted", "malicious.json"), JSON.stringify({
			schema: TOMBSTONE_SCHEMA,
			queue_id: "../../../../sentinel",
			credential_fingerprint: credentialFingerprint(API_KEY, BASE_URL),
			content_digest: "c".repeat(64),
			accepted_at: FIXED_NOW,
			http_status: 202,
			source_packet_id: "src_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			receipt_id: "receipt_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			status: "queued",
		}), "utf8");
		const fetchFn = vi.fn(async () => acceptedResponse());

		await expect(drain(data, { fetchFn })).rejects.toMatchObject({ code: "outbox_insecure" });
		expect(fetchFn).not.toHaveBeenCalled();
		expect(await readFile(sentinelPath, "utf8")).toBe(sentinel);
		expect(await directoryFiles(join(data.outbox, "pending"))).toEqual([`${queued.queueId}.json`]);
		expect(await directoryFiles(join(data.outbox, "accepted"))).toEqual(["malicious.json"]);
	});

	it("recovers a complete envelope left in tmp by an interrupted atomic rename", async () => {
		const data = await fixture();
		const queued = await enqueue(data);
		await rename(
			join(data.outbox, "pending", `${queued.queueId}.json`),
			join(data.outbox, "tmp", `${queued.queueId}-interrupted.tmp`),
		);
		const fetchFn = vi.fn(async () => acceptedResponse());
		const result = await drain(data, { fetchFn });

		expect(result).toMatchObject({ delivered: 1 });
		expect(fetchFn).toHaveBeenCalledTimes(1);
		expect(await directoryFiles(join(data.outbox, "tmp"))).toEqual([]);
	});

	it("preserves and drains a valid tmp envelope older than the metadata GC window", async () => {
		const data = await fixture();
		const crashed = await enqueue(data, { suffix: "old-valid-tmp", now: Date.now() - (48 * 60 * 60 * 1_000) });
		const pendingPath = join(data.outbox, "pending", `${crashed.queueId}.json`);
		const tmpPath = join(data.outbox, "tmp", `${crashed.queueId}-old-valid.tmp`);
		await rename(pendingPath, tmpPath);
		const oldMtime = new Date(Date.now() - OUTBOX_LIMITS.tmpRetentionMs - (60 * 60 * 1_000));
		await utimes(tmpPath, oldMtime, oldMtime);

		const trigger = await enqueue(data, { suffix: "trigger-valid-tmp-gc", now: Date.now() });
		expect(await directoryFiles(join(data.outbox, "tmp"))).toEqual([`${crashed.queueId}-old-valid.tmp`]);
		expect(await directoryFiles(join(data.outbox, "pending"))).toEqual([`${trigger.queueId}.json`]);

		const fetchFn = vi.fn(async () => acceptedResponse());
		const result = await drain(data, { fetchFn, now: Date.now });
		expect(result).toMatchObject({ delivered: 2 });
		expect(fetchFn).toHaveBeenCalledTimes(2);
		expect(await directoryFiles(join(data.outbox, "tmp"))).toEqual([]);
		expect(await directoryFiles(join(data.outbox, "pending"))).toEqual([]);
		expect(await directoryFiles(join(data.outbox, "done"))).toEqual([
			`${crashed.queueId}.json`,
			`${trigger.queueId}.json`,
		].sort());
	});

	it("takes over a stale drain lock", async () => {
		const data = await fixture();
		await enqueue(data);
		const lock = join(data.outbox, "locks", "drain.lock");
		await mkdir(lock);
		const stale = new Date(Date.now() - OUTBOX_LIMITS.staleLockMs - 1_000);
		await utimes(lock, stale, stale);
		const fetchFn = vi.fn(async () => acceptedResponse());
		const result = await drain(data, { fetchFn });

		expect(result).toMatchObject({ busy: false, delivered: 1 });
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});

	it("does not steal a stale-looking lock owned by the current live process", async () => {
		const data = await fixture();
		const queued = await enqueue(data, { suffix: "live-lock-owner" });
		const lock = join(data.outbox, "locks", "drain.lock");
		const ownerPath = join(lock, "owner.json");
		const token = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		await mkdir(lock);
		await writeFile(ownerPath, JSON.stringify({
			schema: "itsuki.outbox-lock/v1",
			token,
			pid: process.pid,
			process_started_at: Math.round(Date.now() - process.uptime() * 1_000),
			created_at: Date.now() - OUTBOX_LIMITS.staleLockMs - 60_000,
		}), "utf8");
		const fetchFn = vi.fn(async () => acceptedResponse());

		const result = await drain(data, { fetchFn });
		expect(result).toMatchObject({ busy: true, delivered: 0 });
		expect(fetchFn).not.toHaveBeenCalled();
		expect(JSON.parse(await readFile(ownerPath, "utf8"))).toMatchObject({ token, pid: process.pid });
		expect(await directoryFiles(join(data.outbox, "pending"))).toEqual([`${queued.queueId}.json`]);
	});

	it("does not repeat full Windows ACL verification on the busy drain path", async () => {
		const data = await fixture();
		const securityRunner = vi.fn(async () => ({ ok: true, protected: true, principals: 3 }));
		await enqueue(data, { suffix: "busy-single-security-pass" });
		const lock = join(data.outbox, "locks", "drain.lock");
		await mkdir(lock);
		await writeFile(join(lock, "owner.json"), JSON.stringify({
			schema: "itsuki.outbox-lock/v1",
			token: "ffffffff-ffff-4fff-8fff-ffffffffffff",
			pid: process.pid,
			process_started_at: Math.round(Date.now() - process.uptime() * 1_000),
			created_at: Date.now(),
		}), "utf8");

		const result = await drain(data, { securityRunner });
		expect(result).toMatchObject({ busy: true, delivered: 0 });
		expect(securityRunner).toHaveBeenCalledTimes(1);
		expect(securityRunner).toHaveBeenCalledWith(data.outbox, "EnsureAll");
	});

	it("reclaims a lock whose recorded owner PID is dead", async () => {
		const data = await fixture();
		await enqueue(data, { suffix: "dead-lock-owner" });
		const lock = join(data.outbox, "locks", "drain.lock");
		await mkdir(lock);
		await writeFile(join(lock, "owner.json"), JSON.stringify({
			schema: "itsuki.outbox-lock/v1",
			token: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			pid: 2_147_483_647,
			process_started_at: 1,
			created_at: Date.now(),
		}), "utf8");
		const fetchFn = vi.fn(async () => acceptedResponse());

		const result = await drain(data, { fetchFn });
		expect(result).toMatchObject({ busy: false, delivered: 1 });
		expect(fetchFn).toHaveBeenCalledTimes(1);
		await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("reclaims a stale lock whose PID was reused by an unrelated live process", async () => {
		const data = await fixture();
		await enqueue(data, { suffix: "reused-live-pid" });
		const lock = join(data.outbox, "locks", "drain.lock");
		await mkdir(lock);
		await writeFile(join(lock, "owner.json"), JSON.stringify({
			schema: "itsuki.outbox-lock/v1",
			token: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
			pid: process.ppid,
			process_started_at: 1,
			created_at: Date.now() - OUTBOX_LIMITS.staleLockMs - 60_000,
		}), "utf8");
		const fetchFn = vi.fn(async () => acceptedResponse());

		const result = await drain(data, { fetchFn });
		expect(result).toMatchObject({ busy: false, delivered: 1 });
		expect(fetchFn).toHaveBeenCalledTimes(1);
		await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it.each([
		["reaped owner", "reaped-dddddddd-dddd-4ddd-8ddd-dddddddddddd.json", JSON.stringify({
			schema: "itsuki.outbox-lock/v1",
			token: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
			pid: 2_147_483_647,
			process_started_at: 1,
			created_at: 1,
		})],
		["ownerless claim", "reap-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.claim", "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"],
	])("recovers a crash-left stale-reaper %s artifact", async (_label, artifactName, artifactContent) => {
		const data = await fixture();
		await enqueue(data, { suffix: `stale-reaper-${artifactName}` });
		const lock = join(data.outbox, "locks", "drain.lock");
		await mkdir(lock);
		const artifact = join(lock, artifactName);
		await writeFile(artifact, artifactContent, "utf8");
		const stale = new Date(Date.now() - OUTBOX_LIMITS.staleLockMs - 60_000);
		await utimes(artifact, stale, stale);
		await utimes(lock, stale, stale);
		const fetchFn = vi.fn(async () => acceptedResponse());

		const result = await drain(data, { fetchFn });
		expect(result).toMatchObject({ busy: false, delivered: 1 });
		expect(fetchFn).toHaveBeenCalledTimes(1);
		await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("recovers a stale corrupt lock owner without spinning", async () => {
		const data = await fixture();
		await enqueue(data, { suffix: "corrupt-lock-owner" });
		const lock = join(data.outbox, "locks", "drain.lock");
		await mkdir(lock);
		await writeFile(join(lock, "owner.json"), "{not valid lock owner JSON", "utf8");
		const stale = new Date(Date.now() - OUTBOX_LIMITS.staleLockMs - 1_000);
		await utimes(lock, stale, stale);
		const fetchFn = vi.fn(async () => acceptedResponse());
		const startedAt = Date.now();

		const result = await drain(data, { fetchFn });
		expect(Date.now() - startedAt).toBeLessThan(500);
		expect(result).toMatchObject({ busy: false, delivered: 1 });
		expect(fetchFn).toHaveBeenCalledTimes(1);
		await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
	}, 1_000);

	it("leaves a fresh ownerless lock busy during its recovery grace period", async () => {
		const data = await fixture();
		const queued = await enqueue(data, { suffix: "fresh-ownerless-lock" });
		const lock = join(data.outbox, "locks", "drain.lock");
		await mkdir(lock);
		const fetchFn = vi.fn(async () => acceptedResponse());

		const result = await drain(data, { fetchFn });
		expect(result).toMatchObject({ busy: true, delivered: 0 });
		expect(fetchFn).not.toHaveBeenCalled();
		expect((await stat(lock)).isDirectory()).toBe(true);
		expect(await directoryFiles(join(data.outbox, "pending"))).toEqual([`${queued.queueId}.json`]);
	});

	it("rejects a single envelope over the 2 MiB cap", async () => {
		const data = await fixture();
		await expect(enqueue(data, {
			content: "x".repeat(OUTBOX_LIMITS.maxEnvelopeBytes + 1),
		})).rejects.toMatchObject({ code: "envelope_too_large" });
		expect(await directoryFiles(join(data.outbox, "pending"))).toEqual([]);
	});

	it("rejects enqueue when 128 raw files already occupy the outbox", async () => {
		const data = await fixture();
		await enqueue(data, { suffix: "initial" });
		await Promise.all(Array.from({ length: OUTBOX_LIMITS.maxRawCount - 1 }, (_, index) =>
			writeFile(join(data.outbox, "failed", `capacity-${String(index).padStart(3, "0")}.json`), "{}", "utf8")));

		await expect(enqueue(data, { suffix: "overflow" })).rejects.toMatchObject({
			code: "outbox_count_full",
		});
	});

	it("rejects enqueue when raw files already occupy the 64 MiB byte cap", async () => {
		const data = await fixture();
		const initial = await enqueue(data, { suffix: "initial" });
		await unlink(join(data.outbox, "pending", `${initial.queueId}.json`));
		const fillerPath = join(data.outbox, "failed", "capacity.raw");
		const filler = await open(fillerPath, "w");
		try { await filler.truncate(OUTBOX_LIMITS.maxRawBytes); }
		finally { await filler.close(); }

		await expect(enqueue(data, { suffix: "overflow" })).rejects.toMatchObject({
			code: "outbox_bytes_full",
		});
	});

	it("reports health as metadata without content, locations, or credentials", async () => {
		const data = await fixture();
		const queued = await enqueue(data, {
			content: "Health must never echo this private sentence.",
			now: FIXED_NOW - 10_000,
		});
		await drain(data, { fetchFn: async () => response(500), now: () => FIXED_NOW });
		const state = await stateFor(data, queued.queueId);
		const health = await inspectOutbox({
			pluginData: data.pluginData,
			apiKey: ROTATED_KEY,
			baseUrl: BASE_URL,
			...WINDOWS_SECURITY,
		});
		const serialized = JSON.stringify(health);

		expect(health).toMatchObject({
			healthy: false,
			version: 1,
			counts: { pending: 1, inflight: 0, accepted: 0, done: 0, failed: 0 },
			oldestPendingAt: FIXED_NOW - 10_000,
			bindingRequired: 1,
			credentialMismatch: 1,
			authBlocked: false,
			permanentFailures: 0,
			nextAttemptAt: state.next_attempt_at,
			lastAccepted: null,
		});
		expect(health.rawBytes).toBeGreaterThan(0);
		expect(serialized).not.toContain("Health must never echo");
		expect(serialized).not.toContain(API_KEY);
		expect(serialized).not.toContain(ROTATED_KEY);
		expect(serialized).not.toContain(BASE_URL);
		expect(serialized).not.toContain(data.root);
	});

	it("includes crash-left tmp raw data in capacity health", async () => {
		const data = await fixture();
		const queued = await enqueue(data);
		const raw = join(data.outbox, "pending", `${queued.queueId}.json`);
		const tmp = join(data.outbox, "tmp", `${queued.queueId}-interrupted.tmp`);
		await rename(raw, tmp);
		const bytes = (await stat(tmp)).size;
		const health = await inspectOutbox({ pluginData: data.pluginData, apiKey: API_KEY, baseUrl: BASE_URL, ...WINDOWS_SECURITY });

		expect(health.counts.tmp).toBe(1);
		expect(health.rawBytes).toBe(bytes);
	});

	it("treats a crash-left metadata temp as recoverable rather than corrupt transcript data", async () => {
		const data = await fixture();
		const queued = await enqueue(data, { suffix: "metadata-temp-health" });
		await writeFile(join(data.outbox, "tmp", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.tmp"), JSON.stringify({
			schema: STATE_SCHEMA,
			queue_id: queued.queueId,
			attempts: 0,
		}), "utf8");

		const health = await inspectOutbox({ pluginData: data.pluginData, apiKey: API_KEY, baseUrl: BASE_URL, ...WINDOWS_SECURITY });
		expect(health).toMatchObject({ counts: { pending: 1, tmp: 1 }, corruptEntries: 0 });
	});

	it("counts, recovers, and rekeys a valid tmp envelope during explicit bind", async () => {
		const data = await fixture();
		const queued = await enqueue(data, { suffix: "tmp-origin-rebind" });
		const pendingPath = join(data.outbox, "pending", `${queued.queueId}.json`);
		const tmpPath = join(data.outbox, "tmp", `${queued.queueId}-crash-left.tmp`);
		await rename(pendingPath, tmpPath);

		const before = await inspectOutbox({
			pluginData: data.pluginData,
			apiKey: API_KEY,
			baseUrl: ALTERNATE_BASE_URL,
			...WINDOWS_SECURITY,
		});
		expect(before).toMatchObject({
			counts: { tmp: 1, pending: 0 },
			bindingRequired: 1,
			credentialMismatch: 1,
		});

		const bound = await bindOutbox({
			pluginData: data.pluginData,
			apiKey: API_KEY,
			baseUrl: ALTERNATE_BASE_URL,
			queueIds: [queued.queueId],
			...WINDOWS_SECURITY,
		});
		expect(bound).toEqual({ ok: true, bound: 1 });
		expect(await directoryFiles(join(data.outbox, "tmp"))).toEqual([]);
		const reboundFiles = await directoryFiles(join(data.outbox, "pending"));
		expect(reboundFiles).toHaveLength(1);
		const reboundQueueId = reboundFiles[0].replace(/\.json$/, "");
		expect(reboundQueueId).not.toBe(queued.queueId);
		const reboundEnvelope = JSON.parse(await readFile(
			join(data.outbox, "pending", reboundFiles[0]),
			"utf8",
		));
		expect(reboundEnvelope).toMatchObject({
			queue_id: reboundQueueId,
			credential_fingerprint: credentialFingerprint(API_KEY, ALTERNATE_BASE_URL),
		});

		const after = await inspectOutbox({
			pluginData: data.pluginData,
			apiKey: API_KEY,
			baseUrl: ALTERNATE_BASE_URL,
			...WINDOWS_SECURITY,
		});
		expect(after).toMatchObject({
			healthy: true,
			counts: { tmp: 0, pending: 1 },
			bindingRequired: 0,
			credentialMismatch: 0,
		});
	});

	it("does not report a prior credential's auth block against a rotated key", async () => {
		const data = await fixture();
		await enqueue(data);
		await drain(data, { fetchFn: async () => response(401) });
		const health = await inspectOutbox({
			pluginData: data.pluginData,
			apiKey: ROTATED_KEY,
			baseUrl: BASE_URL,
			...WINDOWS_SECURITY,
		});

		expect(health.authBlocked).toBe(false);
		expect(health.healthy).toBe(false);
		expect(health.credentialMismatch).toBe(1);
	});

	it.runIf(process.platform === "win32")("flushes Windows files successfully after atomic renames", async () => {
		const data = await fixture();
		const queued = await enqueue(data, { suffix: "windows-post-rename-fsync" });
		const pending = JSON.parse(await readFile(
			join(data.outbox, "pending", `${queued.queueId}.json`),
			"utf8",
		));
		expect(pending).toMatchObject({ schema: OUTBOX_SCHEMA, queue_id: queued.queueId });

		const result = await drain(data, { fetchFn: async () => acceptedResponse() });
		expect(result).toMatchObject({ delivered: 1 });
		const done = JSON.parse(await readFile(
			join(data.outbox, "done", `${queued.queueId}.json`),
			"utf8",
		));
		expect(done).toMatchObject({ schema: TOMBSTONE_SCHEMA, queue_id: queued.queueId });
		expect(await directoryFiles(join(data.outbox, "tmp"))).toEqual([]);
	});

	it.runIf(process.platform === "win32")("applies the exact Windows DACL allowlist to every persisted entry", async () => {
		const data = await fixture();
		const unrelated = join(data.pluginData, "unrelated-host-data", "nested");
		const sentinel = join(unrelated, "sentinel.txt");
		await mkdir(unrelated, { recursive: true });
		await writeFile(sentinel, "unrelated ACL and content must survive", "utf8");
		const readSddl = () => spawnSync("powershell.exe", [
			"-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
			"(Get-Acl -LiteralPath $env:ITSUKI_TEST_UNRELATED).Sddl",
		], {
			encoding: "utf8",
			windowsHide: true,
			env: { ...process.env, ITSUKI_TEST_UNRELATED: unrelated },
		});
		const beforeAcl = readSddl();
		expect(beforeAcl.status, beforeAcl.stderr).toBe(0);
		await enqueueSession({
			pluginData: data.pluginData,
			messages: [message("windows-acl")],
			sessionId: "windows-acl-session",
			memoryScope: { projectId: "windows-acl-project", projectName: "Windows ACL" },
			credentialFingerprint: credentialFingerprint(API_KEY, BASE_URL),
		});
		// EnsureAll is the SessionStart/doctor path and verifies every raw file,
		// while enqueue's protected parent DACL secures the file at creation time.
		await inspectOutbox({ pluginData: data.pluginData, apiKey: API_KEY, baseUrl: BASE_URL });
		const pending = join(data.outbox, "pending", (await directoryFiles(join(data.outbox, "pending")))[0]);
		const command = String.raw`
$targets = @($env:ITSUKI_TEST_ACL_ROOT, $env:ITSUKI_TEST_ACL_RAW)
$items = @()
foreach ($target in $targets) {
  $acl = Get-Acl -LiteralPath $target
  $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
    @{ sid = $_.IdentityReference.Value; inherited = $_.IsInherited; type = $_.AccessControlType.ToString() }
  })
  $items += @{ path_kind = if ((Get-Item -LiteralPath $target).PSIsContainer) { "directory" } else { "file" }; protected = $acl.AreAccessRulesProtected; rules = $rules }
}
@{ current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; items = $items } | ConvertTo-Json -Depth 8 -Compress
`;
		const acl = spawnSync("powershell.exe", [
			"-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command,
		], {
			encoding: "utf8",
			windowsHide: true,
			env: {
				...process.env,
				ITSUKI_TEST_ACL_ROOT: data.outbox,
				ITSUKI_TEST_ACL_RAW: pending,
			},
		});
		expect(acl.status, acl.stderr).toBe(0);
		const parsed = JSON.parse(acl.stdout);
		const allowed = [parsed.current, "S-1-5-18", "S-1-5-32-544"].sort();
		for (const item of parsed.items) {
			expect(item.protected).toBe(true);
			expect(item.rules.map((rule) => rule.sid).sort()).toEqual(allowed);
			expect(item.rules.every((rule) => rule.type === "Allow" && rule.inherited === false)).toBe(true);
		}
		const afterAcl = readSddl();
		expect(afterAcl.status, afterAcl.stderr).toBe(0);
		expect(afterAcl.stdout.trim()).toBe(beforeAcl.stdout.trim());
		expect(await readFile(sentinel, "utf8")).toBe("unrelated ACL and content must survive");
	});
});
