import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SESSION_END = join(ROOT, "hooks", "session-end.mjs");
const SESSION_START = join(ROOT, "hooks", "session-start.mjs");
const API_KEY = "itsuki_live_session_start_delivery_test";

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
			message: { content: "The retry-safe local delivery design is the durable outcome." },
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
		child.stdin.end(JSON.stringify(payload));
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

describe("SessionStart outbox delivery", () => {
	it("delivers a SessionEnd envelope once, then separately recalls memory", async () => {
		const data = await fixture();
		const service = await endpoint();
		try {
			const queued = await runHook(SESSION_END, {
				payload: data.payload,
				pluginData: data.pluginData,
				baseUrl: service.url,
			});
			expect(queued).toMatchObject({ code: 0, output: { systemMessage: expect.stringContaining("queued locally") } });
			expect(await outboxFiles(data.pluginData, "pending")).toHaveLength(1);

			const started = await runHook(SESSION_START, {
				payload: { cwd: data.payload.cwd, session_id: "next-session" },
				pluginData: data.pluginData,
				baseUrl: service.url,
			});
			expect(started.code).toBe(0);
			expect(started.output.systemMessage).toContain("the server accepted it, and enrichment may continue");
			expect(started.output.systemMessage).toContain("src_77777777-7777-4777-8777-777777777777");
			expect(started.output.hookSpecificOutput.additionalContext).toContain("Remember the accepted outbox delivery.");
			expect(service.requests.map((request) => request.url)).toEqual(["/v1/ingest", "/v1/recall"]);
			expect(service.requests[0].authorization).toBe(`Bearer ${API_KEY}`);
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
			expect(JSON.stringify(started.output)).not.toContain("Do not inject this.");
		} finally {
			await service.close();
			await rm(data.root, { recursive: true, force: true });
		}
	}, 20_000);
});
