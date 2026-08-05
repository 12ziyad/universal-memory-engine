import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
	ITSUKI_RECALL_CONTEXT_END_MARKER_V1,
	ITSUKI_RECALL_CONTEXT_MARKER_V1,
	stripItsukiRecallContext,
} from "../hooks/claude-transcript.mjs";
import { sanitizeItsukiRecallContextText } from "../hooks/claude-capture.mjs";
import { persistRecallEchoGuard, readRecallEchoGuard } from "../hooks/outbox.mjs";
import {
	RECALL_ECHO_MAX_FINGERPRINTS,
	RECALL_ECHO_STORE_FILENAME,
	RECALL_ECHO_STORE_SCHEMA,
	deriveRecallEchoCoverage,
	recallEchoFingerprintsForLine,
	recallEchoFingerprintsFromText,
	recallEchoSessionKey,
} from "../hooks/recall-echo.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SESSION_END = join(ROOT, "hooks", "session-end.mjs");
const SESSION_START = join(ROOT, "hooks", "session-start.mjs");
const API_KEY = "itsuki_live_session_start_delivery_test";
const WINDOWS_SECURITY = {
	platform: "win32",
	securityRunner: async () => ({ ok: true, protected: true, guard_trusted: true }),
};

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "itsuki-session-start-delivery-"));
	const pluginData = join(root, "claude-config", "plugins", "data", "itsuki");
	const projectDir = join(root, "project");
	const transcriptPath = join(root, "transcript.jsonl");
	await Promise.all([
		mkdir(pluginData, { recursive: true }),
		mkdir(projectDir, { recursive: true }),
		writeFile(transcriptPath, `${JSON.stringify({
			type: "assistant",
			uuid: "host-event-session-start-delivery",
			timestamp: "2026-08-05T01:00:00.000Z",
			message: { content: "Architecture decision: retry-safe local delivery stays in the protected outbox." },
		})}\n`, "utf8"),
	]);
	return {
		root,
		pluginData,
		payload: {
			cwd: projectDir,
			session_id: "session-start-delivery",
			transcript_path: transcriptPath,
		},
	};
}

function runHook(script, { payload, pluginData, baseUrl, apiKey = API_KEY }) {
	return new Promise((resolve, reject) => {
		const env = {
			...process.env,
			CLAUDE_PLUGIN_OPTION_ITSUKI_API_KEY: apiKey,
			CLAUDE_PLUGIN_DATA: pluginData,
			CLAUDE_CONFIG_DIR: join(pluginData, "..", "..", ".."),
			ITSUKI_API_KEY: "",
			ITSUKI_BASE_URL: baseUrl,
			ITSUKI_TIMEOUT_MS: "1500",
		};
		const child = spawn(process.execPath, [
			script,
			"--plugin-data", pluginData,
			"--service-url-for-test", baseUrl,
		], {
			cwd: ROOT,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		const timer = setTimeout(() => child.kill(), 14_000);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			let output;
			try { output = JSON.parse(stdout); }
			catch (error) { reject(Object.assign(error, { stdout, stderr })); return; }
			resolve({ code, signal, stdout, stderr, output });
		});
		child.stdin.end(JSON.stringify(script === SESSION_START
			? { source: "startup", ...payload }
			: payload));
	});
}

async function outboxFiles(pluginData, state) {
	try {
		return (await readdir(join(pluginData, "outbox", "v1", state))).filter((name) => name.endsWith(".json"));
	} catch (error) {
		if (error?.code === "ENOENT") return [];
		throw error;
	}
}

async function endpoint({ ingestStatus = 202, recallBody = { ok: true, context: "Remember the accepted outbox delivery." } } = {}) {
	const requests = [];
	const server = createServer(async (request, response) => {
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
		requests.push({ url: request.url, authorization: request.headers.authorization, body });
		response.setHeader("content-type", "application/json");
		if (request.url === "/v1/ingest") {
			response.statusCode = ingestStatus;
			response.end(ingestStatus === 202
				? JSON.stringify({
					ok: true,
					processing: true,
					status: "accepted",
					source_packet_id: "src_77777777-7777-4777-8777-777777777777",
					receipt_id: "receipt_88888888-8888-4888-8888-888888888888",
					job_id: "job_99999999-9999-4999-8999-999999999999",
				})
				: JSON.stringify({ ok: false, error: "rejected" }));
			return;
		}
		if (request.url === "/v1/recall") {
			response.statusCode = 200;
			response.end(JSON.stringify(recallBody));
			return;
		}
		response.statusCode = 404;
		response.end(JSON.stringify({ ok: false }));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return {
		url: `http://127.0.0.1:${server.address().port}`,
		requests,
		close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
	};
}

function expectVersionedRecallBlock(value) {
	expect(value.startsWith(`${ITSUKI_RECALL_CONTEXT_MARKER_V1}\n`)).toBe(true);
	expect(value.endsWith(`\n${ITSUKI_RECALL_CONTEXT_END_MARKER_V1}`)).toBe(true);
	expect(value.match(new RegExp(ITSUKI_RECALL_CONTEXT_MARKER_V1.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))).toHaveLength(1);
}

describe("SessionStart outbox delivery", () => {
	it("rejects partial recall-echo coverage above 128 variants and for lines above 4096 characters", () => {
		const sessionId = "bounded-recall-echo-coverage";
		const exactlyBounded = Array.from(
			{ length: RECALL_ECHO_MAX_FINGERPRINTS },
			(_, index) => `Unique recalled invariant number ${index} remains stable`,
		).join("\n");
		const overBounded = `${exactlyBounded}\nUnique recalled invariant beyond the bound`;
		const oversizedLine = `Architecture decision: ${"x".repeat(4_097)}`;

		expect(deriveRecallEchoCoverage(exactlyBounded, { sessionId })).toMatchObject({
			complete: true,
			candidateLineCount: RECALL_ECHO_MAX_FINGERPRINTS,
			reason: null,
		});
		expect(deriveRecallEchoCoverage(exactlyBounded, { sessionId }).fingerprints)
			.toHaveLength(RECALL_ECHO_MAX_FINGERPRINTS);
		expect(deriveRecallEchoCoverage(overBounded, { sessionId })).toEqual({
			fingerprints: [],
			complete: false,
			candidateLineCount: RECALL_ECHO_MAX_FINGERPRINTS + 1,
			reason: "fingerprint_limit",
		});
		expect(deriveRecallEchoCoverage(oversizedLine, { sessionId })).toEqual({
			fingerprints: [],
			complete: false,
			candidateLineCount: 1,
			reason: "unfingerprintable_line",
		});
	});

	it("unions same-session guards, never downgrades armed state, and preserves it on union overflow", async () => {
		const data = await fixture();
		const sessionId = "monotonic-recall-echo-session";
		const options = { pluginData: data.pluginData, sessionId, ...WINDOWS_SECURITY };
		try {
			const first = await persistRecallEchoGuard({
				...options,
				context: "Alpha recalled ledger remains stable",
				allowCreate: true,
			});
			const firstGuard = await readRecallEchoGuard(options);
			expect(first).toMatchObject({ persisted: true, status: "armed", coverageComplete: true });
			expect(firstGuard.fingerprints).toHaveLength(1);

			const second = await persistRecallEchoGuard({
				...options,
				context: "Beta recalled ledger remains stable",
			});
			const unionGuard = await readRecallEchoGuard(options);
			expect(second).toMatchObject({ persisted: true, status: "armed", coverageComplete: true });
			expect(unionGuard).toEqual({
				status: "armed",
				fingerprints: expect.arrayContaining(firstGuard.fingerprints),
			});
			expect(unionGuard.fingerprints).toHaveLength(2);

			const emptyUpdate = await persistRecallEchoGuard({ ...options, context: "" });
			expect(emptyUpdate).toMatchObject({
				persisted: true,
				status: "armed",
				coverageComplete: true,
				fingerprintCount: 2,
			});
			expect(await readRecallEchoGuard(options)).toEqual(unionGuard);

			const fillCount = RECALL_ECHO_MAX_FINGERPRINTS - unionGuard.fingerprints.length;
			const fillContext = Array.from(
				{ length: fillCount },
				(_, index) => `Bounded union recalled invariant number ${index} remains stable`,
			).join("\n");
			const filled = await persistRecallEchoGuard({ ...options, context: fillContext });
			expect(filled).toMatchObject({
				persisted: true,
				status: "armed",
				coverageComplete: true,
				fingerprintCount: RECALL_ECHO_MAX_FINGERPRINTS,
			});
			const beforeOverflow = await readRecallEchoGuard(options);

			const overflow = await persistRecallEchoGuard({
				...options,
				context: "Overflow recalled invariant remains separate",
			});
			expect(overflow).toEqual({
				persisted: true,
				status: "armed",
				coverageComplete: false,
				fingerprintCount: RECALL_ECHO_MAX_FINGERPRINTS,
				reason: "fingerprint_limit",
			});
			expect(await readRecallEchoGuard(options)).toEqual(beforeOverflow);
		} finally {
			await rm(data.root, { recursive: true, force: true });
		}
	}, 10_000);

	it("persists only bounded one-way recall fingerprints in protected plugin data", async () => {
		const data = await fixture();
		const sessionId = "recall-echo-sidecar-session";
		const secret = "SYNTHETIC_RECALLED_SECRET_VALUE_7f92";
		const context = `Architecture decision: keep the amber retry ledger.\nPrivate note: ${secret}`;
		const service = await endpoint({ recallBody: { ok: true, context } });
		try {
			const started = await runHook(SESSION_START, {
				payload: { cwd: data.payload.cwd, session_id: sessionId },
				pluginData: data.pluginData,
				baseUrl: service.url,
			});
			const sidecarPath = join(data.pluginData, "outbox", "v1", "control", RECALL_ECHO_STORE_FILENAME);
			const serialized = await readFile(sidecarPath, "utf8");
			const sidecar = JSON.parse(serialized);
			const expected = recallEchoFingerprintsFromText(context, { sessionId });
			const relabeled = [
				"We decided to keep the amber retry ledger.",
				"We chose to keep the amber retry ledger.",
				"We will keep the amber retry ledger.",
			].map((line) => recallEchoFingerprintsForLine(line, { sessionId }));

			expect(started.code).toBe(0);
			expect(sidecar).toEqual({
				schema: RECALL_ECHO_STORE_SCHEMA,
				sessions: [{
					session_key: recallEchoSessionKey(sessionId),
					status: "armed",
					fingerprints: expected,
				}],
			});
			expect(expected.length).toBeGreaterThan(0);
			expect(expected.length).toBeLessThanOrEqual(RECALL_ECHO_MAX_FINGERPRINTS);
			expect(expected.every((value) => /^sha256:[a-f0-9]{64}$/.test(value))).toBe(true);
			expect(relabeled.every((variants) => variants.some((value) => expected.includes(value)))).toBe(true);
			expect(serialized).not.toContain(context);
			expect(serialized).not.toContain("amber retry ledger");
			expect(serialized).not.toContain(secret);
		} finally {
			await service.close();
			await rm(data.root, { recursive: true, force: true });
		}
	}, 20_000);

	it("does not inject recalled context when its protected echo fingerprints cannot be persisted", async () => {
		const data = await fixture();
		const context = "Architecture decision: keep the fail-closed echo ledger.";
		const service = await endpoint({ recallBody: { ok: true, context } });
		try {
			await runHook(SESSION_START, {
				payload: { cwd: data.payload.cwd, session_id: "echo-store-bootstrap" },
				pluginData: data.pluginData,
				baseUrl: service.url,
			});
			const sidecarPath = join(data.pluginData, "outbox", "v1", "control", RECALL_ECHO_STORE_FILENAME);
			await writeFile(sidecarPath, "{corrupt", "utf8");

			const started = await runHook(SESSION_START, {
				payload: { cwd: data.payload.cwd, session_id: "echo-store-failure" },
				pluginData: data.pluginData,
				baseUrl: service.url,
			});
			expect(started.code).toBe(0);
			expect(started.output.systemMessage).toContain("was not injected");
			expect(started.output.hookSpecificOutput.additionalContext).toContain("memory is unavailable");
			expect(started.output.hookSpecificOutput.additionalContext).not.toContain(context);
		} finally {
			await service.close();
			await rm(data.root, { recursive: true, force: true });
		}
	}, 20_000);

	it("does not recreate a deleted guard or inject recall on resume and compact starts", async () => {
		const data = await fixture();
		const sessionId = "deleted-guard-resume-session";
		const context = "Architecture decision: keep deleted recall guards fail closed.";
		const service = await endpoint({ recallBody: { ok: true, context } });
		const sidecarPath = join(data.pluginData, "outbox", "v1", "control", RECALL_ECHO_STORE_FILENAME);
		try {
			const startup = await runHook(SESSION_START, {
				payload: { cwd: data.payload.cwd, session_id: sessionId, source: "startup" },
				pluginData: data.pluginData,
				baseUrl: service.url,
			});
			expect(startup.output.hookSpecificOutput.additionalContext).toContain(context);
			await rm(sidecarPath, { force: true });

			for (const source of ["resume", "compact"]) {
				const started = await runHook(SESSION_START, {
					payload: { cwd: data.payload.cwd, session_id: sessionId, source },
					pluginData: data.pluginData,
					baseUrl: service.url,
				});
				expect(started.code).toBe(0);
				expect(started.output.systemMessage).toContain("was not injected");
				expect(started.output.hookSpecificOutput.additionalContext).not.toContain(context);
				await expect(readFile(sidecarPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
			}
		} finally {
			await service.close();
			await rm(data.root, { recursive: true, force: true });
		}
	}, 30_000);

	it("suppresses recalled assistant echoes end to end while retaining new outcomes and user restatements", async () => {
		const data = await fixture();
		const sessionId = data.payload.session_id;
		const recalled = "Architecture decision: keep the amber retry ledger.";
		const service = await endpoint({ recallBody: { ok: true, context: recalled } });
		try {
			const started = await runHook(SESSION_START, {
				payload: { cwd: data.payload.cwd, session_id: sessionId },
				pluginData: data.pluginData,
				baseUrl: service.url,
			});
			expect(started.output.hookSpecificOutput.additionalContext).toContain(recalled);

			const rows = [
				{
					type: "assistant",
					uuid: "assistant-recalled-chose-echo",
					timestamp: "2026-08-05T01:00:00.000Z",
					message: { content: "We chose to keep the amber retry ledger." },
				},
				{
					type: "assistant",
					uuid: "assistant-recalled-will-echo",
					timestamp: "2026-08-05T01:00:00.500Z",
					message: { content: "We will keep the amber retry ledger." },
				},
				{
					type: "assistant",
					uuid: "assistant-new-outcome",
					timestamp: "2026-08-05T01:00:01.000Z",
					message: { content: "Architecture decision: keep the indigo checkpoint journal." },
				},
				{
					type: "user",
					uuid: "user-explicit-restatement",
					timestamp: "2026-08-05T01:00:02.000Z",
					message: { content: "I prefer to keep the amber retry ledger." },
				},
			];
			await writeFile(data.payload.transcript_path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");

			const ended = await runHook(SESSION_END, {
				payload: data.payload,
				pluginData: data.pluginData,
				baseUrl: service.url,
			});
			expect(ended.output.systemMessage).toContain("queued locally");
			const stagedNames = await outboxFiles(data.pluginData, "staged");
			expect(stagedNames).toHaveLength(1);
			const staged = JSON.parse(await readFile(
				join(data.pluginData, "outbox", "v1", "staged", stagedNames[0]),
				"utf8",
			));
			const architecture = staged.messages
				.filter((message) => message.source_event?.kind === "architecture_decision")
				.map((message) => message.content);
			const preferences = staged.messages
				.filter((message) => message.source_event?.kind === "user_preference")
				.map((message) => message.content);
			expect(architecture.join("\n")).toContain("indigo checkpoint journal");
			expect(architecture.join("\n")).not.toContain("amber retry ledger");
			expect(preferences.join("\n")).toContain("amber retry ledger");
		} finally {
			await service.close();
			await rm(data.root, { recursive: true, force: true });
		}
	}, 20_000);

	it("fails closed for assistant prose when the protected echo sidecar is corrupt", async () => {
		const data = await fixture();
		const sessionId = data.payload.session_id;
		const service = await endpoint({
			recallBody: { ok: true, context: "Architecture decision: keep the protected recall ledger." },
		});
		try {
			await runHook(SESSION_START, {
				payload: { cwd: data.payload.cwd, session_id: sessionId },
				pluginData: data.pluginData,
				baseUrl: service.url,
			});
			const sidecarPath = join(data.pluginData, "outbox", "v1", "control", RECALL_ECHO_STORE_FILENAME);
			await writeFile(sidecarPath, "{corrupt", "utf8");
			const rows = [
				{
					type: "assistant",
					uuid: "assistant-prose-without-echo-filter",
					timestamp: "2026-08-05T01:00:00.000Z",
					message: { content: "Architecture decision: keep the unsafe assistant-only outcome." },
				},
				{
					type: "user",
					uuid: "explicit-user-choice-without-echo-filter",
					timestamp: "2026-08-05T01:00:01.000Z",
					message: { content: "I prefer to keep the explicit user-authored outcome." },
				},
			];
			await writeFile(data.payload.transcript_path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");

			const ended = await runHook(SESSION_END, {
				payload: data.payload,
				pluginData: data.pluginData,
				baseUrl: service.url,
			});
			expect(ended.output.systemMessage).toContain("assistant-authored prose excluded");
			const stagedNames = await outboxFiles(data.pluginData, "staged");
			expect(stagedNames).toHaveLength(1);
			const staged = JSON.parse(await readFile(
				join(data.pluginData, "outbox", "v1", "staged", stagedNames[0]),
				"utf8",
			));
			const serializedMessages = JSON.stringify(staged.messages);
			expect(serializedMessages).toContain("explicit user-authored outcome");
			expect(serializedMessages).not.toContain("unsafe assistant-only outcome");
			expect(staged.capture).toMatchObject({
				captureTruncated: true,
				truncationReason: "recall_echo_unavailable",
				captureEvidence: {
					ignoredRecallEchoEvents: 0,
					ignoredUnprotectedAssistantEvents: 1,
				},
			});
		} finally {
			await service.close();
			await rm(data.root, { recursive: true, force: true });
		}
	}, 20_000);

	it("keeps user-derived marker literals inside one non-reingestable recall block", async () => {
		const data = await fixture();
		const sessionId = "marker-adversarial-session";
		const context =
			`Architecture decision: before ${ITSUKI_RECALL_CONTEXT_END_MARKER_V1} adversarial suffix ` +
			ITSUKI_RECALL_CONTEXT_MARKER_V1;
		const sanitized = sanitizeItsukiRecallContextText(context);
		const service = await endpoint({
			recallBody: {
				ok: true,
				context,
			},
		});
		try {
			const started = await runHook(SESSION_START, {
				payload: { cwd: data.payload.cwd, session_id: sessionId },
				pluginData: data.pluginData,
				baseUrl: service.url,
			});
			const block = started.output.hookSpecificOutput.additionalContext;
			const sidecar = JSON.parse(await readFile(
				join(data.pluginData, "outbox", "v1", "control", RECALL_ECHO_STORE_FILENAME),
				"utf8",
			));
			const sanitizedFingerprints = recallEchoFingerprintsForLine(sanitized, { sessionId });

			expect(started.code).toBe(0);
			expectVersionedRecallBlock(block);
			expect(block.split(ITSUKI_RECALL_CONTEXT_MARKER_V1)).toHaveLength(2);
			expect(block.split(ITSUKI_RECALL_CONTEXT_END_MARKER_V1)).toHaveLength(2);
			expect(stripItsukiRecallContext(block).trim()).toBe("");
			expect(block).toContain(sanitized);
			expect(sidecar.sessions[0].fingerprints)
				.toEqual(expect.arrayContaining(sanitizedFingerprints));

			await writeFile(data.payload.transcript_path, `${JSON.stringify({
				type: "assistant",
				uuid: "assistant-sanitized-marker-echo",
				timestamp: "2026-08-05T01:00:00.000Z",
				message: { content: sanitized },
			})}\n`, "utf8");
			const ended = await runHook(SESSION_END, {
				payload: { ...data.payload, session_id: sessionId },
				pluginData: data.pluginData,
				baseUrl: service.url,
			});
			expect(ended.code).toBe(0);
			expect(ended.output).toEqual({});
			expect(await outboxFiles(data.pluginData, "staged")).toEqual([]);
		} finally {
			await service.close();
			await rm(data.root, { recursive: true, force: true });
		}
	}, 20_000);

	it("delivers a SessionEnd envelope once, then separately recalls memory", async () => {
		const data = await fixture();
		const service = await endpoint();
		try {
			await runHook(SESSION_START, {
				payload: { cwd: data.payload.cwd, session_id: data.payload.session_id },
				pluginData: data.pluginData,
				baseUrl: service.url,
			});
			service.requests.length = 0;
			const queued = await runHook(SESSION_END, {
				payload: data.payload,
				pluginData: data.pluginData,
				baseUrl: service.url,
			});
			expect(queued).toMatchObject({ code: 0, output: { systemMessage: expect.stringContaining("queued locally") } });
			expect(await outboxFiles(data.pluginData, "staged")).toHaveLength(1);
			expect(await outboxFiles(data.pluginData, "pending")).toHaveLength(0);

			const started = await runHook(SESSION_START, {
				payload: { cwd: data.payload.cwd, session_id: "next-session" },
				pluginData: data.pluginData,
				baseUrl: service.url,
			});
			expect(started.code).toBe(0);
			expect(started.output.systemMessage).toContain("the server accepted it, and enrichment may continue");
			expect(started.output.systemMessage).toContain("src_77777777-7777-4777-8777-777777777777");
			expect(started.output.hookSpecificOutput.additionalContext).toContain("Remember the accepted outbox delivery.");
			expectVersionedRecallBlock(started.output.hookSpecificOutput.additionalContext);
			expect(service.requests.map((request) => request.url)).toEqual(["/v1/ingest", "/v1/recall"]);
			expect(service.requests[0].authorization).toBe(`Bearer ${API_KEY}`);
			expect(await outboxFiles(data.pluginData, "staged")).toHaveLength(0);
			expect(await outboxFiles(data.pluginData, "pending")).toHaveLength(0);
			expect(await outboxFiles(data.pluginData, "done")).toHaveLength(1);

			await runHook(SESSION_START, {
				payload: { cwd: data.payload.cwd, session_id: "third-session" },
				pluginData: data.pluginData,
				baseUrl: service.url,
			});
			expect(service.requests.filter((request) => request.url === "/v1/ingest")).toHaveLength(1);
		} finally {
			await service.close();
			await rm(data.root, { recursive: true, force: true });
		}
	}, 20_000);

	it("keeps a 401 response queued and suppresses repeated auth attempts", async () => {
		const data = await fixture();
		const service = await endpoint({ ingestStatus: 401 });
		try {
			await runHook(SESSION_START, {
				payload: { cwd: data.payload.cwd, session_id: data.payload.session_id },
				pluginData: data.pluginData,
				baseUrl: service.url,
			});
			service.requests.length = 0;
			await runHook(SESSION_END, {
				payload: data.payload,
				pluginData: data.pluginData,
				baseUrl: service.url,
			});

			const first = await runHook(SESSION_START, {
				payload: { cwd: data.payload.cwd },
				pluginData: data.pluginData,
				baseUrl: service.url,
			});
			expect(first).toMatchObject({ code: 0 });
			expect(first.output.systemMessage).toContain("delivery is paused because the API key was rejected");
			expect(first.output.hookSpecificOutput.additionalContext).toContain("Do not claim memory");
			expectVersionedRecallBlock(first.output.hookSpecificOutput.additionalContext);
			expect(await outboxFiles(data.pluginData, "pending")).toHaveLength(1);
			expect(service.requests.map((request) => request.url)).toEqual(["/v1/ingest"]);

			const second = await runHook(SESSION_START, {
				payload: { cwd: data.payload.cwd },
				pluginData: data.pluginData,
				baseUrl: service.url,
			});
			expect(second.output.systemMessage).toContain("delivery is paused because the API key was rejected");
			expect(service.requests.map((request) => request.url)).toEqual(["/v1/ingest"]);
			expect(await outboxFiles(data.pluginData, "pending")).toHaveLength(1);
		} finally {
			await service.close();
			await rm(data.root, { recursive: true, force: true });
		}
	}, 20_000);

	it("does not inject context from a syntactically valid failed recall receipt", async () => {
		const data = await fixture();
		const service = await endpoint({ recallBody: { ok: false, context: "Do not inject this." } });
		try {
			const started = await runHook(SESSION_START, {
				payload: { cwd: data.payload.cwd },
				pluginData: data.pluginData,
				baseUrl: service.url,
			});
			expect(started).toMatchObject({ code: 0 });
			expect(started.output.systemMessage).toContain("unsuccessful recall receipt");
			expect(started.output.hookSpecificOutput.additionalContext).toContain("Do not claim memory");
			expectVersionedRecallBlock(started.output.hookSpecificOutput.additionalContext);
			expect(JSON.stringify(started.output)).not.toContain("Do not inject this.");
		} finally {
			await service.close();
			await rm(data.root, { recursive: true, force: true });
		}
	}, 20_000);
});
