import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";

const headers = { "x-api-key": env.API_KEY, "content-type": "application/json" };

async function call(path, init) {
	const request = new Request(`http://example.com${path}`, init);
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return { status: response.status, headers: response.headers, body: await response.json() };
}

function save(body) {
	return call("/v1/save", { method: "POST", headers, body: JSON.stringify(body) });
}

async function all(table, userId) {
	const { results } = await env.DB.prepare(`SELECT * FROM ${table} WHERE user_id = ? ORDER BY created_at DESC`)
		.bind(userId)
		.all();
	return results ?? [];
}

function cookieFrom(result) {
	return result.headers.get("set-cookie")?.split(";")[0] || "";
}

async function signupAccount(prefix) {
	const result = await call("/auth/signup", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			email: `${prefix}-${crypto.randomUUID()}@example.com`,
			password: "correct-horse",
			name: prefix,
		}),
	});
	expect(result.status).toBe(201);
	return { user: result.body.user, cookie: cookieFrom(result) };
}

describe("Auto Mode Phase 2 architecture ledger", () => {
	it("normalizes direct saves into idempotent source packets linked to runs, receipts, and jobs", async () => {
		const userId = "phase2-direct";
		const llmResponse = {
			objects: [
				{ kind: "node", label: "Boxing", category: "skill", confidence: 0.95 },
				{ kind: "event", on: "Boxing", action: "started", text: "Started boxing", importance: "ordinary", confidence: 0.95 },
			],
			notes: "",
		};

		const first = await save({
			userId,
			mode: "memory",
			content: "I started boxing",
			memoryScope: { app: "codex", sessionId: "phase2-session" },
			_test: { llmResponse },
		});
		expect(first.status).toBe(200);
		expect(first.body.receipt.source_packet_id).toMatch(/^src_/);

		const packets = await all("source_packets", userId);
		expect(packets).toHaveLength(1);
		expect(packets[0]).toMatchObject({
			source_type: "message",
			source_mode: "manual_direct",
			app_id: "codex",
			session_id: "phase2-session",
			message_count: 1,
		});
		expect(packets[0].content_hash).toMatch(/^[a-f0-9]{64}$/);
		const raw = JSON.parse(packets[0].raw_meta_json);
		expect(raw.messages[0].id).toMatch(/^msg_/);
		expect(raw.messages[0].content_hash).toMatch(/^[a-f0-9]{64}$/);

		const runs = await all("extraction_runs", userId);
		expect(runs[0]).toMatchObject({
			source_mode: "manual_direct",
			source_packet_id: packets[0].id,
			idempotency_key: packets[0].idempotency_key,
		});

		const receipts = await all("receipts", userId);
		expect(receipts[0]).toMatchObject({
			source: "save_memory",
			source_packet_id: packets[0].id,
			extraction_run_id: runs[0].id,
		});
		const detail = JSON.parse(receipts[0].detail);
		expect(detail.source_packet_id).toBe(packets[0].id);

		const jobs = await all("memory_jobs", userId);
		expect(jobs[0]).toMatchObject({
			type: "pass2_rollup",
			status: "completed",
			source_packet_id: packets[0].id,
			extraction_run_id: runs[0].id,
		});
		const jobPayload = JSON.parse(jobs[0].payload_json);
		expect(jobPayload.pass2).toMatchObject({ ran: true, profileUpdated: true });
		const profile = await env.DB.prepare("SELECT * FROM memory_profiles WHERE user_id = ?").bind(userId).first();
		expect(JSON.parse(profile.profile_json)).toMatchObject({ node_count: 1 });

		await save({
			userId,
			mode: "memory",
			content: "I started boxing",
			memoryScope: { app: "codex", sessionId: "phase2-session" },
			_test: { llmResponse },
		});
		const packetsAfterResend = await all("source_packets", userId);
		expect(packetsAfterResend).toHaveLength(1);
		expect(packetsAfterResend[0].seen_count).toBeGreaterThan(1);
	});

	it("stores manual_collect page evidence against the normalized source packet", async () => {
		const userId = "phase2-page";
		const result = await save({
			userId,
			mode: "conversation",
			conversationId: "phase2-conv",
			memoryScope: { app: "claude", workspaceId: "personal" },
			messages: [
				{ role: "assistant", content: "What should I save?" },
				{ role: "user", content: "UML runs on D1 and Vectorize for my memory project." },
			],
			_test: {
				digestResponse: "UML runs on D1 and Vectorize for the user's memory project.",
			},
		});
		expect(result.status).toBe(200);
		expect(result.body.receipt.source_packet_id).toMatch(/^src_/);

		const [page] = await all("memory_pages", userId);
		expect(page.source_packet_id).toBe(result.body.receipt.source_packet_id);
		expect(page.input_hash).toMatch(/^[a-f0-9]{64}$/);
		const evidence = JSON.parse(page.evidence_json);
		const userEvidence = evidence.find((item) => item.source_type === "user_message");
		expect(userEvidence.source_packet_id).toBe(page.source_packet_id);
		expect(userEvidence.source_message_id).toMatch(/^msg_/);
		expect(userEvidence.content_hash).toMatch(/^[a-f0-9]{64}$/);

		const [packet] = await all("source_packets", userId);
		expect(packet.app_id).toBe("claude");
		expect(packet.workspace_id).toBe("personal");
		expect(packet.conversation_id).toBe("phase2-conv");

		const [job] = await all("memory_jobs", userId);
		expect(job).toMatchObject({ type: "pass2_rollup", status: "completed", source_packet_id: packet.id });
		const profile = await env.DB.prepare("SELECT * FROM memory_profiles WHERE user_id = ?").bind(userId).first();
		expect(JSON.parse(profile.profile_json)).toMatchObject({ page_count: 1 });
	});

	it("uses deep recall fallback for broad before-answer queries", async () => {
		const userId = "phase2-recall-deep";
		const now = Date.now();
		await env.DB.prepare(
			"INSERT INTO nodes (id, user_id, label, category, role, state, summary, created_at, updated_at, heat_score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		)
			.bind("phase2-node", userId, "UML", "project", null, "active", "Universal Memory Layer project.", now, now, 3)
			.run();

		const recalled = await call("/v1/recall", {
			method: "POST",
			headers,
			body: JSON.stringify({ userId, query: "what do you know about me?" }),
		});
		expect(recalled.status).toBe(200);
		expect(recalled.body.nodes).toHaveLength(1);
		expect(recalled.body.context).toContain("UML (project, state: active)");
	});

	it("reports recall gate modes and expands locally through graph edges", async () => {
		const userId = "phase2-recall-modes";
		const now = Date.now();
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO nodes
				 (id, user_id, label, category, role, state, summary, aliases_json, cluster, created_at, updated_at, heat_score)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).bind("phase2-alpha", userId, "Project Alpha", "project", null, "active", "Alpha uses D1.", JSON.stringify(["Alpha"]), "projects_systems", now, now, 5),
			env.DB.prepare(
				`INSERT INTO nodes
				 (id, user_id, label, category, role, state, summary, cluster, created_at, updated_at, heat_score)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).bind("phase2-d1", userId, "D1", "tool", null, "active", "Cloudflare database.", "skills_tech", now, now, 1),
			env.DB.prepare(
				"INSERT INTO edges (id, user_id, from_node, to_node, type, created_at, weight) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).bind("phase2-edge", userId, "phase2-alpha", "phase2-d1", "uses", now, 1),
		]);

		const noRecall = await call("/v1/recall", {
			method: "POST",
			headers,
			body: JSON.stringify({ userId, query: "hi" }),
		});
		expect(noRecall.body).toMatchObject({ recall_mode: "no_recall", count: 0, compressed: false });

		const light = await call("/v1/recall", {
			method: "POST",
			headers,
			body: JSON.stringify({ userId, query: "Alpha" }),
		});
		expect(light.body).toMatchObject({
			recall_mode: "light_recall",
			lexical_used: true,
			graph_expansion_used: true,
			compressed: true,
		});
		expect(light.body.nodes.map((node) => node.label)).toEqual(expect.arrayContaining(["Project Alpha", "D1"]));

		const update = await call("/v1/recall", {
			method: "POST",
			headers,
			body: JSON.stringify({ userId, query: "what changed lately with Alpha?" }),
		});
		expect(update.body.recall_mode).toBe("update_mode");
	});

	it("historicalizes old slices during correction/update mode writes", async () => {
		const userId = "phase2-update-mode";
		const now = Date.now();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO nodes (id, user_id, label, category, role, state, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			).bind("phase2-boxing", userId, "Boxing", "skill", null, "active", "Boxing practice", now, now),
			env.DB.prepare(
				"INSERT INTO slices (id, user_id, node_id, text, kind, is_current, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).bind("phase2-old-slice", userId, "phase2-boxing", "Trains three days a week", "progress", 1, now),
		]);

		const saved = await save({
			userId,
			mode: "memory",
			content: "Actually I train boxing five days a week now.",
			_test: {
				llmResponse: {
					objects: [
						{
							kind: "slice",
							on: "Boxing",
							text: "Trains five days a week",
							kind_detail: "progress",
							confidence: 0.96,
						},
					],
					notes: "",
				},
			},
		});
		expect(saved.status).toBe(200);
		expect(saved.body.receipt.saved.supersededSlices).toBe(1);

		const { results } = await env.DB.prepare(
			"SELECT id, text, is_current FROM slices WHERE user_id = ? AND node_id = ? ORDER BY created_at ASC",
		)
			.bind(userId, "phase2-boxing")
			.all();
		expect(results.map((slice) => [slice.text, slice.is_current])).toEqual([
			["Trains three days a week", 0],
			["Trains five days a week", 1],
		]);
	});

	it("keeps authenticated owner scope separate from external app user scope", async () => {
		const account = await signupAccount("phase2-owner");
		const llmResponse = {
			objects: [
				{ kind: "node", label: "External User Project", category: "project", confidence: 0.95 },
			],
			notes: "",
		};

		const saved = await call("/v1/save", {
			method: "POST",
			headers: { "content-type": "application/json", cookie: account.cookie },
			body: JSON.stringify({
				userId: "app-user-123",
				mode: "memory",
				content: "External user is building a project.",
				memoryScope: { app: "test-app", workspaceId: "tenant-a" },
				_test: { llmResponse },
			}),
		});
		expect(saved.status).toBe(200);

		const packet = await env.DB.prepare("SELECT * FROM source_packets WHERE owner_user_id = ? AND external_user_id = ?")
			.bind(account.user.id, "app-user-123")
			.first();
		expect(packet).toMatchObject({
			owner_user_id: account.user.id,
			external_user_id: "app-user-123",
			workspace_id: "tenant-a",
			app_id: "test-app",
		});
		expect(packet.user_id).toBe(packet.memory_user_id);
		expect(packet.user_id).not.toBe(account.user.id);

		const defaultStatus = await call("/v1/status", { headers: { cookie: account.cookie } });
		expect(defaultStatus.body.nodes).toBe(0);
		const externalStatus = await call("/v1/status?userId=app-user-123", { headers: { cookie: account.cookie } });
		expect(externalStatus.body.nodes).toBe(1);
	});
});
