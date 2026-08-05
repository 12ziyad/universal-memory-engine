import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
	OUTBOX_SCHEMA,
	bindOutbox,
	credentialFingerprint,
	drainOutbox,
	enqueueSession,
} from "../hooks/outbox.mjs";
import { INGEST_LIMITS, unicodeLength, utf8Length } from "../src/lib/ingest_contract.mjs";

const API_KEY = "itsuki_live_stage4_batching_test_key";
const ROTATED_API_KEY = "itsuki_live_stage4_batching_rotated_key";
const BASE_URL = "https://stage4-batching.invalid";
const FIXED_NOW = 1_800_000_000_000;
const MEMORY_SCOPE = {
	projectId: "project-stage4-batching",
	projectName: "Stage 4 batching",
	appId: "claude-code-plugin",
};
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
	const root = await mkdtemp(join(tmpdir(), "itsuki-hook-batching-"));
	const pluginData = join(root, "private-plugin-data");
	await mkdir(pluginData, { recursive: true });
	roots.add(root);
	return {
		root,
		pluginData,
		outbox: join(pluginData, "outbox", "v1"),
	};
}

function fixedSizeMessages(count, characters = INGEST_LIMITS.maxMessageCharacters) {
	return Array.from({ length: count }, (_, index) => {
		const prefix = `${String(index).padStart(3, "0")}:`;
		return {
			id: `stage4-message-${String(index).padStart(3, "0")}`,
			role: index % 2 === 0 ? "user" : "assistant",
			content: `${prefix}${"x".repeat(characters - unicodeLength(prefix))}`,
			ts: FIXED_NOW + index,
		};
	});
}

async function enqueue(data, messages, overrides = {}) {
	return enqueueSession({
		pluginData: data.pluginData,
		messages,
		sessionId: overrides.sessionId ?? "stage4-batching-session",
		memoryScope: overrides.memoryScope ?? MEMORY_SCOPE,
		captureMetadata: overrides.captureMetadata ?? null,
		deferMaterialization: overrides.deferMaterialization ?? false,
		credentialFingerprint: credentialFingerprint(API_KEY, BASE_URL),
		now: overrides.now ?? (() => FIXED_NOW),
		...WINDOWS_SECURITY,
	});
}

async function jsonFiles(path) {
	return (await readdir(path))
		.filter((name) => name.endsWith(".json"))
		.sort();
}

async function envelopesIn(data, directory = "pending") {
	const path = join(data.outbox, directory);
	const values = await Promise.all((await jsonFiles(path)).map(async (name) => ({
		name,
		value: JSON.parse(await readFile(join(path, name), "utf8")),
	})));
	return values;
}

function orderedBatches(entries) {
	return entries.slice().sort((left, right) =>
		Number(left.value.request?.body?.delivery?.batchIndex ?? 0)
		- Number(right.value.request?.body?.delivery?.batchIndex ?? 0));
}

function expectWireContract(entries) {
	for (const { value } of entries) {
		const body = value.request.body;
		expect(body.messages.length).toBeLessThanOrEqual(INGEST_LIMITS.maxMessages);
		expect(body.messages.reduce((sum, message) => sum + unicodeLength(message.content), 0))
			.toBeLessThanOrEqual(INGEST_LIMITS.maxTotalCharacters);
		expect(utf8Length(JSON.stringify(body))).toBeLessThanOrEqual(INGEST_LIMITS.maxRequestBytes);
		expect(body.messages.every((message) =>
			unicodeLength(message.content) <= INGEST_LIMITS.maxMessageCharacters)).toBe(true);
	}
}

function uuidFor(index) {
	const ordinal = Number(index) + 1;
	return `${String(ordinal).padStart(8, "0")}-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
}

function acceptedResponse(index, { duplicate = false } = {}) {
	const uuid = uuidFor(index);
	return new Response(JSON.stringify({
		ok: true,
		status: "queued",
		duplicate,
		source_packet_id: `src_${uuid}`,
		receipt_id: `receipt_${uuid}`,
		job_id: `job_${uuid}`,
	}), { status: 202, headers: { "content-type": "application/json" } });
}

function drain(data, overrides = {}) {
	return drainOutbox({
		pluginData: data.pluginData,
		apiKey: API_KEY,
		baseUrl: BASE_URL,
		fetchFn: async (_url, init) => {
			const body = JSON.parse(init.body);
			return acceptedResponse(body.delivery?.batchIndex ?? 0);
		},
		now: () => FIXED_NOW,
		maxDurationMs: 2_000,
		requestTimeoutMs: 250,
		...WINDOWS_SECURITY,
		...overrides,
	});
}

function withoutSegmentLabel(content) {
	return content.replace(/^\[Itsuki segment \d+\/\d+; one original message, preserved in order\]\n/, "");
}

function hasUnpairedSurrogate(value) {
	for (let index = 0; index < value.length; index += 1) {
		const unit = value.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
			index += 1;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
	}
	return false;
}

function canonicalValue(value) {
	if (Array.isArray(value)) return value.map(canonicalValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function canonicalJson(value) {
	return JSON.stringify(canonicalValue(value));
}

function sha256(value) {
	return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function expectOptionalNumericCount(result, names, expected) {
	for (const name of names) {
		if (Object.prototype.hasOwnProperty.call(result, name)) expect(result[name]).toBe(expected);
	}
}

describe("ordered Claude outbox batching", () => {
	it("defers a protected group, then materializes the same bounded v2 batches on drain", async () => {
		const data = await fixture();
		const messages = fixedSizeMessages(80);
		const staged = await enqueue(data, messages, { deferMaterialization: true });
		const stagedFiles = await jsonFiles(join(data.outbox, "staged"));

		expect(staged).toMatchObject({ queued: true, duplicate: false, staged: true, sourceMessageCount: 80 });
		expect(staged.batchCount).toBeNull();
		expect(stagedFiles).toHaveLength(1);
		expect(await jsonFiles(join(data.outbox, "pending"))).toEqual([]);
		const aggregate = JSON.parse(await readFile(join(data.outbox, "staged", stagedFiles[0]), "utf8"));
		expect(aggregate.messages).toEqual(messages);
		expect(JSON.stringify(aggregate)).not.toContain("[Itsuki segment ");

		const order = [];
		const delivered = await drain(data, {
			fetchFn: async (_url, init) => {
				const body = JSON.parse(init.body);
				order.push(body.delivery.batchIndex);
				return acceptedResponse(body.delivery.batchIndex);
			},
		});
		expect(order).toEqual([0, 1, 2]);
		expect(delivered).toMatchObject({
			materializedGroups: 1,
			materializedBatches: 3,
			delivered: 3,
			completedDeliveryGroups: 1,
		});
		expect(await jsonFiles(join(data.outbox, "staged"))).toEqual([]);
		expect(await jsonFiles(join(data.outbox, "groups"))).toHaveLength(1);
		expect(await jsonFiles(join(data.outbox, "done"))).toHaveLength(3);

		const replay = await enqueue(data, messages, { deferMaterialization: true, now: () => FIXED_NOW + 60_000 });
		expect(replay).toMatchObject({ duplicate: true, batchCount: 3, acceptedBatches: 3, staged: false });
		expect(await jsonFiles(join(data.outbox, "staged"))).toEqual([]);
	});

	it("re-stages an exact aggregate to repair a crash-left missing materialized batch", async () => {
		const data = await fixture();
		const messages = fixedSizeMessages(31, 80);
		await enqueue(data, messages, { deferMaterialization: true });
		const materialized = await drain(data, { maxItems: 0 });
		expect(materialized).toMatchObject({ materializedGroups: 1, materializedBatches: 2, delivered: 0 });
		const initial = orderedBatches(await envelopesIn(data));
		await unlink(join(data.outbox, "pending", initial[0].name));

		const repaired = await enqueue(data, messages, { deferMaterialization: true, now: () => FIXED_NOW + 1 });
		expect(repaired).toMatchObject({ duplicate: false, staged: true, batchCount: 2, queuedBatches: 1 });
		const order = [];
		const delivered = await drain(data, {
			fetchFn: async (_url, init) => {
				const body = JSON.parse(init.body);
				order.push(body.delivery.batchIndex);
				return acceptedResponse(body.delivery.batchIndex);
			},
		});
		expect(order).toEqual([0, 1]);
		expect(delivered).toMatchObject({ materializedGroups: 1, delivered: 2, orderBlocked: 0 });
		expect(await jsonFiles(join(data.outbox, "staged"))).toEqual([]);
	});

	it("keeps an unbound staged group raw until explicit binding, then materializes it once", async () => {
		const data = await fixture();
		const staged = await enqueueSession({
			pluginData: data.pluginData,
			messages: fixedSizeMessages(31, 80),
			sessionId: "stage4-unbound-staged-group",
			memoryScope: MEMORY_SCOPE,
			deferMaterialization: true,
			credentialFingerprint: null,
			now: () => FIXED_NOW,
			...WINDOWS_SECURITY,
		});
		const fetchFn = vi.fn(async (_url, init) => {
			const body = JSON.parse(init.body);
			return acceptedResponse(body.delivery.batchIndex);
		});
		const refused = await drain(data, { fetchFn });
		expect(refused).toMatchObject({ delivered: 0, bindingRequired: 1, materializedGroups: 0 });
		expect(fetchFn).not.toHaveBeenCalled();
		expect(await jsonFiles(join(data.outbox, "staged"))).toHaveLength(1);

		const bound = await bindOutbox({
			pluginData: data.pluginData,
			apiKey: API_KEY,
			baseUrl: BASE_URL,
			queueIds: [staged.queueId],
			...WINDOWS_SECURITY,
		});
		const delivered = await drain(data, { fetchFn });
		expect(bound).toEqual({ ok: true, bound: 1 });
		expect(delivered).toMatchObject({ materializedGroups: 1, materializedBatches: 2, delivered: 2 });
		expect(fetchFn).toHaveBeenCalledTimes(2);
		expect(await jsonFiles(join(data.outbox, "staged"))).toEqual([]);
	});

	it("normalizes missing and duplicate source IDs before claiming the staged aggregate is durable", async () => {
		const data = await fixture();
		const staged = await enqueue(data, [
			{
				id: "",
				role: "assistant",
				content: "The durable outcome has no host-provided identifier.",
				ts: FIXED_NOW,
			},
			{
				id: "repeated-host-id",
				role: "user",
				content: "The first host event using this identifier.",
				ts: FIXED_NOW + 1,
			},
			{
				id: "repeated-host-id",
				role: "assistant",
				content: "A distinct event must not collide with the first.",
				ts: FIXED_NOW + 2,
			},
		], { deferMaterialization: true, sessionId: "missing-source-id" });
		const [aggregate] = await envelopesIn(data, "staged");
		expect(staged).toMatchObject({ queued: true, state: "staged" });
		expect(aggregate.value.messages[0].id).toMatch(/^msg_[a-f0-9]{48}$/);
		expect(new Set(aggregate.value.messages.map((message) => message.id)).size).toBe(3);

		const delivered = await drain(data);
		expect(delivered).toMatchObject({ materializedGroups: 1, delivered: 1, permanentFailures: 0 });
		expect(await jsonFiles(join(data.outbox, "staged"))).toEqual([]);
	});

	it("rebinds every materialized batch when a crash-repair aggregate is selected", async () => {
		const data = await fixture();
		const messages = fixedSizeMessages(31, 80);
		await enqueue(data, messages, { deferMaterialization: true });
		await drain(data, { maxItems: 0 });
		const initial = orderedBatches(await envelopesIn(data));
		await unlink(join(data.outbox, "pending", initial[0].name));

		const restaged = await enqueue(data, messages, {
			deferMaterialization: true,
			now: () => FIXED_NOW + 1,
		});
		expect(restaged).toMatchObject({ staged: true, batchCount: 2 });
		const bound = await bindOutbox({
			pluginData: data.pluginData,
			apiKey: ROTATED_API_KEY,
			baseUrl: BASE_URL,
			queueIds: [restaged.queueId],
			...WINDOWS_SECURITY,
		});

		const order = [];
		const delivered = await drain(data, {
			apiKey: ROTATED_API_KEY,
			fetchFn: async (_url, init) => {
				const body = JSON.parse(init.body);
				order.push(body.delivery.batchIndex);
				return acceptedResponse(body.delivery.batchIndex);
			},
		});
		expect(bound).toEqual({ ok: true, bound: 2 });
		expect(order).toEqual([0, 1]);
		expect(delivered).toMatchObject({ materializedGroups: 1, delivered: 2, bindingRequired: 0 });
		expect(await jsonFiles(join(data.outbox, "staged"))).toEqual([]);
	});

	it("merges a rebind target stage onto the oldest immutable delivery plan", async () => {
		const data = await fixture();
		const messages = fixedSizeMessages(31, 80);
		const original = await enqueue(data, messages, {
			deferMaterialization: true,
			sessionId: "rebind-target-collision",
			now: () => FIXED_NOW,
		});
		await drain(data, { maxItems: 0 });
		const initial = orderedBatches(await envelopesIn(data));
		await unlink(join(data.outbox, "pending", initial[1].name));
		await enqueue(data, messages, {
			deferMaterialization: true,
			sessionId: "rebind-target-collision",
			now: () => FIXED_NOW + 10,
		});
		await enqueueSession({
			pluginData: data.pluginData,
			messages,
			sessionId: "rebind-target-collision",
			memoryScope: MEMORY_SCOPE,
			deferMaterialization: true,
			credentialFingerprint: credentialFingerprint(ROTATED_API_KEY, BASE_URL),
			now: () => FIXED_NOW + 20,
			...WINDOWS_SECURITY,
		});

		const rebound = await bindOutbox({
			pluginData: data.pluginData,
			apiKey: ROTATED_API_KEY,
			baseUrl: BASE_URL,
			queueIds: [original.queueId],
			...WINDOWS_SECURITY,
		});
		expect(rebound).toEqual({ ok: true, bound: 2 });
		const [stage] = await envelopesIn(data, "staged");
		const [manifest] = await envelopesIn(data, "groups");
		expect(stage.value.delivery_order).toBe(FIXED_NOW * 1_000);
		expect(stage.value.created_at).toBe(FIXED_NOW);
		expect(manifest.value.delivery_order).toBe(stage.value.delivery_order);
		expect(manifest.value.created_at).toBe(stage.value.created_at);

		const calls = [];
		const delivered = await drain(data, {
			apiKey: ROTATED_API_KEY,
			fetchFn: async (_url, init) => {
				const body = JSON.parse(init.body);
				calls.push(body.delivery.batchIndex);
				return acceptedResponse(body.delivery.batchIndex);
			},
		});
		expect(calls).toEqual([0, 1]);
		expect(delivered).toMatchObject({ delivered: 2, bindingRequired: 0 });
	});

	it("expands an eager batch selection to every raw sibling before rebinding", async () => {
		const data = await fixture();
		await enqueue(data, fixedSizeMessages(31, 80));
		const initial = orderedBatches(await envelopesIn(data));
		expect(initial).toHaveLength(2);

		const rebound = await bindOutbox({
			pluginData: data.pluginData,
			apiKey: ROTATED_API_KEY,
			baseUrl: BASE_URL,
			queueIds: [initial[0].value.queue_id],
			...WINDOWS_SECURITY,
		});
		expect(rebound).toEqual({ ok: true, bound: 2 });

		const calls = [];
		const delivered = await drain(data, {
			apiKey: ROTATED_API_KEY,
			fetchFn: async (_url, init) => {
				const body = JSON.parse(init.body);
				calls.push(body.delivery.batchIndex);
				return acceptedResponse(body.delivery.batchIndex);
			},
		});
		expect(calls).toEqual([0, 1]);
		expect(delivered).toMatchObject({ delivered: 2, bindingRequired: 0 });
	});

	it("blocks both credentials in a crash-left mixed-key group until rebind completes", async () => {
		const data = await fixture();
		await enqueue(data, fixedSizeMessages(31, 80));
		const original = orderedBatches(await envelopesIn(data));
		await bindOutbox({
			pluginData: data.pluginData,
			apiKey: ROTATED_API_KEY,
			baseUrl: BASE_URL,
			queueIds: [original[0].value.queue_id],
			...WINDOWS_SECURITY,
		});
		const rebound = orderedBatches(await envelopesIn(data));
		await unlink(join(data.outbox, "pending", rebound[0].name));
		await writeFile(
			join(data.outbox, "pending", original[0].name),
			canonicalJson(original[0].value),
			{ encoding: "utf8", mode: 0o600 },
		);

		const oldFetch = vi.fn(async () => acceptedResponse(74));
		const oldDrain = await drain(data, { apiKey: API_KEY, maxItems: 1, fetchFn: oldFetch });
		expect(oldFetch).not.toHaveBeenCalled();
		expect(oldDrain).toMatchObject({ delivered: 0, orderBlocked: 1, bindingRequired: 1 });
		const newFetch = vi.fn(async () => acceptedResponse(75));
		const newDrain = await drain(data, { apiKey: ROTATED_API_KEY, maxItems: 1, fetchFn: newFetch });
		expect(newFetch).not.toHaveBeenCalled();
		expect(newDrain).toMatchObject({ delivered: 0, orderBlocked: 1, bindingRequired: 1 });

		const recovered = await bindOutbox({
			pluginData: data.pluginData,
			apiKey: ROTATED_API_KEY,
			baseUrl: BASE_URL,
			...WINDOWS_SECURITY,
		});
		expect(recovered).toEqual({ ok: true, bound: 1 });
		const calls = [];
		const delivered = await drain(data, {
			apiKey: ROTATED_API_KEY,
			fetchFn: async (_url, init) => {
				const body = JSON.parse(init.body);
				calls.push(body.delivery.batchIndex);
				return acceptedResponse(body.delivery.batchIndex);
			},
		});
		expect(calls).toEqual([0, 1]);
		expect(delivered).toMatchObject({ delivered: 2, bindingRequired: 0, orderBlocked: 0 });
	});

	it("allows a complete rotated-key incarnation after the old incarnation is terminal", async () => {
		const data = await fixture();
		const messages = [{
			id: "same-terminal-content",
			role: "assistant",
			content: "The same complete group may be intentionally replayed under a rotated key.",
			ts: FIXED_NOW,
		}];
		await enqueue(data, messages, { sessionId: "terminal-key-incarnation", now: () => FIXED_NOW });
		await drain(data);
		await enqueueSession({
			pluginData: data.pluginData,
			messages,
			sessionId: "terminal-key-incarnation",
			memoryScope: MEMORY_SCOPE,
			credentialFingerprint: credentialFingerprint(ROTATED_API_KEY, BASE_URL),
			now: () => FIXED_NOW + 1,
			...WINDOWS_SECURITY,
		});

		const calls = [];
		const delivered = await drain(data, {
			apiKey: ROTATED_API_KEY,
			fetchFn: async (_url, init) => {
				calls.push(JSON.parse(init.body).messages[0].id);
				return acceptedResponse(73);
			},
		});
		expect(calls).toEqual(["same-terminal-content"]);
		expect(delivered).toMatchObject({ delivered: 1, orderBlocked: 0, bindingRequired: 0 });
	});

	it("recovers a rebind crash after target batch zero was already accepted", async () => {
		const data = await fixture();
		await enqueue(data, fixedSizeMessages(31, 80));
		const original = orderedBatches(await envelopesIn(data));
		await bindOutbox({
			pluginData: data.pluginData,
			apiKey: ROTATED_API_KEY,
			baseUrl: BASE_URL,
			queueIds: [original[0].value.queue_id],
			...WINDOWS_SECURITY,
		});
		await drain(data, { apiKey: ROTATED_API_KEY, maxItems: 1 });
		await writeFile(
			join(data.outbox, "pending", original[0].name),
			canonicalJson(original[0].value),
			{ encoding: "utf8", mode: 0o600 },
		);

		const recovered = await bindOutbox({
			pluginData: data.pluginData,
			apiKey: ROTATED_API_KEY,
			baseUrl: BASE_URL,
			...WINDOWS_SECURITY,
		});
		expect(recovered).toEqual({ ok: true, bound: 1 });
		expect(await jsonFiles(join(data.outbox, "pending"))).toHaveLength(1);

		const calls = [];
		const delivered = await drain(data, {
			apiKey: ROTATED_API_KEY,
			fetchFn: async (_url, init) => {
				calls.push(JSON.parse(init.body).delivery.batchIndex);
				return acceptedResponse(76);
			},
		});
		expect(calls).toEqual([1]);
		expect(delivered).toMatchObject({ delivered: 1, completedDeliveryGroups: 1 });
	});

	it("refuses to split a partly accepted ordered group across credential destinations", async () => {
		const data = await fixture();
		const staged = await enqueue(data, fixedSizeMessages(31, 80), { deferMaterialization: true });
		const partial = await drain(data, { maxItems: 1 });
		expect(partial).toMatchObject({ delivered: 1, completedDeliveryGroups: 0 });
		expect(await jsonFiles(join(data.outbox, "done"))).toHaveLength(1);
		expect(await jsonFiles(join(data.outbox, "pending"))).toHaveLength(1);

		await expect(bindOutbox({
			pluginData: data.pluginData,
			apiKey: ROTATED_API_KEY,
			baseUrl: BASE_URL,
			queueIds: [staged.queueId],
			...WINDOWS_SECURITY,
		})).rejects.toMatchObject({ code: "partially_accepted_group" });
		expect(await jsonFiles(join(data.outbox, "done"))).toHaveLength(1);
		expect(await jsonFiles(join(data.outbox, "pending"))).toHaveLength(1);

		const calls = [];
		const resumed = await drain(data, {
			now: () => FIXED_NOW + 60_000,
			fetchFn: async (_url, init) => {
				const body = JSON.parse(init.body);
				calls.push(body.delivery.batchIndex);
				return acceptedResponse(70);
			},
		});
		expect(calls).toEqual([1]);
		expect(resumed).toMatchObject({ delivered: 1, completedDeliveryGroups: 1 });
	});

	it("bulk binding skips a partly accepted group but rebinds unrelated safe work", async () => {
		const data = await fixture();
		await enqueue(data, fixedSizeMessages(31, 80), {
			deferMaterialization: true,
			sessionId: "partly-accepted-old-key",
			now: () => FIXED_NOW,
		});
		await drain(data, { maxItems: 1 });
		await enqueue(data, [{
			id: "safe-rotation-work",
			role: "assistant",
			content: "This unrelated staged work can safely move to the rotated credential.",
			ts: FIXED_NOW + 1,
		}], {
			deferMaterialization: true,
			sessionId: "safe-rotation-work",
			now: () => FIXED_NOW + 1,
		});

		const rebound = await bindOutbox({
			pluginData: data.pluginData,
			apiKey: ROTATED_API_KEY,
			baseUrl: BASE_URL,
			...WINDOWS_SECURITY,
		});
		expect(rebound).toEqual({ ok: true, bound: 1, skippedPartiallyAcceptedGroups: 1 });
		const [safeStage] = await envelopesIn(data, "staged");
		expect(safeStage.value.credential_fingerprint).toBe(credentialFingerprint(ROTATED_API_KEY, BASE_URL));
		expect(await jsonFiles(join(data.outbox, "done"))).toHaveLength(1);
		expect(await jsonFiles(join(data.outbox, "pending"))).toHaveLength(1);

		const calls = [];
		const delivered = await drain(data, {
			apiKey: ROTATED_API_KEY,
			fetchFn: async (_url, init) => {
				calls.push(JSON.parse(init.body).messages[0].id);
				return acceptedResponse(78);
			},
		});
		expect(calls).toEqual(["safe-rotation-work"]);
		expect(delivered).toMatchObject({ delivered: 1, bindingRequired: 1 });
	});

	it.each([
		[31, [30, 1]],
		[80, [30, 30, 20]],
	])("packs %i maximum-sized messages into stable ordered batches", async (count, batchSizes) => {
		const data = await fixture();
		const messages = fixedSizeMessages(count);
		const first = await enqueue(data, messages);
		const firstEntries = orderedBatches(await envelopesIn(data));
		const firstQueueIds = firstEntries.map(({ value }) => value.queue_id);
		const firstKeys = firstEntries.map(({ value }) => value.request.body.idempotencyKey);

		expect(first).toMatchObject({
			queued: true,
			duplicate: false,
			batchCount: batchSizes.length,
			sourceMessageCount: count,
			segmentCount: count,
			splitSourceMessages: 0,
		});
		expect(firstEntries.map(({ value }) => value.request.body.messages.length)).toEqual(batchSizes);
		expect(firstEntries.map(({ value }) => value.request.body.delivery.batchIndex))
			.toEqual(batchSizes.map((_, index) => index));
		expect(new Set(firstEntries.map(({ value }) => value.request.body.delivery.groupId)).size).toBe(1);
		expect(firstEntries.every(({ value }) => value.request.body.delivery.batchCount === batchSizes.length)).toBe(true);
		expect(firstEntries.flatMap(({ value }) => value.request.body.messages).map((message) => message.id))
			.toEqual(messages.map((message) => message.id));
		expectWireContract(firstEntries);

		const replay = await enqueue(data, messages, { now: () => FIXED_NOW + 60_000 });
		const replayEntries = orderedBatches(await envelopesIn(data));
		expect(replay).toMatchObject({
			duplicate: true,
			batchCount: batchSizes.length,
			queuedBatches: 0,
			duplicateBatches: batchSizes.length,
		});
		expect(replay.queueIds).toEqual(first.queueIds);
		expect(replayEntries.map(({ value }) => value.queue_id)).toEqual(firstQueueIds);
		expect(replayEntries.map(({ value }) => value.request.body.idempotencyKey)).toEqual(firstKeys);
	});

	it("preserves every Unicode code point and the conclusion of one enormous logical message", async () => {
		const data = await fixture();
		const prefix = "BEGIN-UNICODE|";
		const conclusion = "|FINAL-CONCLUSION: keep the rollback checksum and release outcome";
		const targetCharacters = INGEST_LIMITS.maxTotalCharacters + 1;
		const fill = targetCharacters - unicodeLength(prefix) - unicodeLength(conclusion);
		const original = `${prefix}${"🙂".repeat(fill)}${conclusion}`;

		const queued = await enqueue(data, [{
			id: "enormous-unicode-message",
			role: "user",
			content: original,
			ts: FIXED_NOW,
		}]);
		const entries = orderedBatches(await envelopesIn(data));
		const segments = entries.flatMap(({ value }) => value.request.body.messages);
		const reconstructed = segments.map((message) => withoutSegmentLabel(message.content)).join("");

		expect(unicodeLength(original)).toBe(targetCharacters);
		expect(queued).toMatchObject({
			batchCount: 2,
			sourceMessageCount: 1,
			splitSourceMessages: 1,
		});
		expect(queued.segmentCount).toBeGreaterThan(INGEST_LIMITS.maxMessages);
		expect(segments).toHaveLength(queued.segmentCount);
		expect(new Set(segments.map((message) => message.id)).size).toBe(segments.length);
		expect(segments.every((message) => !hasUnpairedSurrogate(message.content))).toBe(true);
		expect(segments.every((message) => !message.content.includes("�"))).toBe(true);
		expect(reconstructed).toBe(original);
		expect(withoutSegmentLabel(segments.at(-1).content)).toContain(conclusion);
		expectWireContract(entries);
	});

	it("blocks an incomplete crash-left group, then exact replay commits only the missing batch", async () => {
		const data = await fixture();
		const messages = fixedSizeMessages(31, 80);
		const first = await enqueue(data, messages);
		const initial = orderedBatches(await envelopesIn(data));
		const batchZero = initial[0];
		await unlink(join(data.outbox, "pending", batchZero.name));

		const blockedFetch = vi.fn(async () => acceptedResponse(1));
		const blocked = await drain(data, { fetchFn: blockedFetch });
		expect(blocked).toMatchObject({ delivered: 0, orderBlocked: 1 });
		expect(blockedFetch).not.toHaveBeenCalled();
		expect((await envelopesIn(data)).map(({ value }) => value.request.body.delivery.batchIndex)).toEqual([1]);
		expectOptionalNumericCount(blocked, ["orderBlockedGroups", "blockedGroups"], 1);

		const recovered = await enqueue(data, messages, { now: () => FIXED_NOW + 1 });
		expect(recovered).toMatchObject({
			duplicate: false,
			batchCount: 2,
			queuedBatches: 1,
			duplicateBatches: 1,
		});
		expect(recovered.queueIds).toEqual(first.queueIds);

		const deliveredOrder = [];
		const delivered = await drain(data, {
			fetchFn: async (_url, init) => {
				const body = JSON.parse(init.body);
				deliveredOrder.push(body.delivery.batchIndex);
				return acceptedResponse(body.delivery.batchIndex);
			},
		});
		expect(deliveredOrder).toEqual([0, 1]);
		expect(delivered).toMatchObject({ delivered: 2, retried: 0, orderBlocked: 0 });
		expect(await jsonFiles(join(data.outbox, "pending"))).toEqual([]);
		expect(await jsonFiles(join(data.outbox, "done"))).toHaveLength(2);
		expectOptionalNumericCount(delivered, ["deliveredGroups", "deliveredGroupCount"], 1);
	});

	it("does not overtake a retrying middle batch and resumes from that exact request", async () => {
		const data = await fixture();
		const queued = await enqueue(data, fixedSizeMessages(80, 80));
		expect(queued.batchCount).toBe(3);
		const original = orderedBatches(await envelopesIn(data));
		const originalBodies = new Map(original.map(({ value }) => [
			value.request.body.delivery.batchIndex,
			JSON.stringify(value.request.body),
		]));

		const firstOrder = [];
		const firstBodies = new Map();
		const firstDrain = await drain(data, {
			fetchFn: async (_url, init) => {
				const body = JSON.parse(init.body);
				const index = body.delivery.batchIndex;
				firstOrder.push(index);
				firstBodies.set(index, init.body);
				return index === 1
					? new Response(JSON.stringify({ ok: false }), {
						status: 500,
						headers: { "content-type": "application/json" },
					})
					: acceptedResponse(index);
			},
		});

		expect(firstOrder).toEqual([0, 1]);
		expect(firstBodies.get(0)).toBe(originalBodies.get(0));
		expect(firstBodies.get(1)).toBe(originalBodies.get(1));
		expect(firstDrain).toMatchObject({ delivered: 1, retried: 1, orderBlocked: 1, completedDeliveryGroups: 0 });
		expect(firstDrain.accepted.map((item) => item.delivery.batchIndex)).toEqual([0]);
		expectOptionalNumericCount(firstDrain, ["deliveredGroups", "deliveredGroupCount"], 1);
		expectOptionalNumericCount(firstDrain, ["retriedGroups", "retriedGroupCount"], 1);

		const resumedOrder = [];
		const resumedBodies = new Map();
		const resumed = await drain(data, {
			now: () => FIXED_NOW + 60_000,
			fetchFn: async (_url, init) => {
				const body = JSON.parse(init.body);
				const index = body.delivery.batchIndex;
				resumedOrder.push(index);
				resumedBodies.set(index, init.body);
				return acceptedResponse(index, { duplicate: index === 1 });
			},
		});

		expect(resumedOrder).toEqual([1, 2]);
		expect(resumedBodies.get(1)).toBe(originalBodies.get(1));
		expect(resumedBodies.get(2)).toBe(originalBodies.get(2));
		expect(resumed).toMatchObject({ delivered: 2, retried: 0, orderBlocked: 0, completedDeliveryGroups: 1 });
		expect(resumed.accepted.map((item) => item.delivery.batchIndex)).toEqual([1, 2]);
		expect(await jsonFiles(join(data.outbox, "pending"))).toEqual([]);
		expect(await jsonFiles(join(data.outbox, "done"))).toHaveLength(3);
		expectOptionalNumericCount(resumed, ["deliveredGroups", "deliveredGroupCount"], 1);
	});

	it("does not let a newer group in the same conversation overtake an older nonterminal group", async () => {
		const data = await fixture();
		const older = await enqueue(data, fixedSizeMessages(80, 80), {
			sessionId: "same-conversation",
			now: () => FIXED_NOW,
			deferMaterialization: true,
		});
		const newer = await enqueue(data, [{
			id: "newer-conclusion",
			role: "user",
			content: "A newer final outcome that must not pass the older retry.",
			ts: FIXED_NOW + 100,
		}], {
			sessionId: "same-conversation",
			now: () => FIXED_NOW + 1,
			deferMaterialization: true,
		});
		const calls = [];
		const first = await drain(data, {
			fetchFn: async (_url, init) => {
				const body = JSON.parse(init.body);
				calls.push({ groupId: body.delivery.groupId, index: body.delivery.batchIndex });
				return body.delivery.groupId === calls[0].groupId && body.delivery.batchIndex === 1
					? new Response(JSON.stringify({ ok: false }), { status: 500 })
					: acceptedResponse(calls.length);
			},
		});
		expect(older.batchCount).toBeNull();
		expect(newer.batchCount).toBeNull();
		expect(calls.map((call) => call.index)).toEqual([0, 1]);
		expect(new Set(calls.map((call) => call.groupId)).size).toBe(1);
		expect(calls.every((call) => call.groupId === calls[0].groupId)).toBe(true);
		expect(first).toMatchObject({
			materializedGroups: 2,
			materializedBatches: 4,
			delivered: 1,
			retried: 1,
			orderBlocked: 2,
		});

		const resumed = [];
		const second = await drain(data, {
			now: () => FIXED_NOW + 60_000,
			fetchFn: async (_url, init) => {
				const body = JSON.parse(init.body);
				resumed.push({ groupId: body.delivery.groupId, index: body.delivery.batchIndex });
				return acceptedResponse(resumed.length + 10);
			},
		});
		expect(resumed.map((call) => call.index)).toEqual([1, 2, 0]);
		expect(resumed[0].groupId).toBe(resumed[1].groupId);
		expect(resumed[2].groupId).not.toBe(resumed[1].groupId);
		expect(second).toMatchObject({ delivered: 3, retried: 0, orderBlocked: 0 });
	});

	it("lets newer work proceed after an older group reaches permanent failure", async () => {
		const data = await fixture();
		await enqueue(data, [{
			id: "permanent-older",
			role: "user",
			content: "This malformed historical packet will be retained for intervention.",
			ts: FIXED_NOW,
		}], { sessionId: "permanent-failure-conversation", now: () => FIXED_NOW });
		await enqueue(data, [{
			id: "after-permanent-failure",
			role: "assistant",
			content: "This later valid outcome must not be disabled forever.",
			ts: FIXED_NOW + 1,
		}], { sessionId: "permanent-failure-conversation", now: () => FIXED_NOW + 1 });

		const firstCalls = [];
		const first = await drain(data, {
			maxItems: 1,
			fetchFn: async (_url, init) => {
				firstCalls.push(JSON.parse(init.body).messages[0].id);
				return new Response(JSON.stringify({ ok: false }), { status: 400 });
			},
		});
		expect(firstCalls).toEqual(["permanent-older"]);
		expect(first).toMatchObject({ permanentFailures: 1, delivered: 0 });

		const resumedCalls = [];
		const resumed = await drain(data, {
			fetchFn: async (_url, init) => {
				resumedCalls.push(JSON.parse(init.body).messages[0].id);
				return acceptedResponse(79);
			},
		});
		expect(resumedCalls).toEqual(["after-permanent-failure"]);
		expect(resumed).toMatchObject({ delivered: 1, orderBlocked: 0 });
	});

	it("does not rematerialize a crash-repair stage after its prefix permanently fails", async () => {
		const data = await fixture();
		const messages = fixedSizeMessages(31, 80);
		await enqueue(data, messages, {
			deferMaterialization: true,
			sessionId: "failed-prefix-conversation",
			now: () => FIXED_NOW,
		});
		await drain(data, { maxItems: 0 });
		const batches = orderedBatches(await envelopesIn(data));
		await unlink(join(data.outbox, "pending", batches[1].name));
		await enqueue(data, messages, {
			deferMaterialization: true,
			sessionId: "failed-prefix-conversation",
			now: () => FIXED_NOW,
		});
		await drain(data, {
			maxItems: 1,
			maxMaterializationGroups: 0,
			fetchFn: async () => new Response(JSON.stringify({ ok: false }), { status: 400 }),
		});
		await enqueue(data, [{
			id: "newer-after-failed-prefix",
			role: "assistant",
			content: "This later terminal outcome can proceed after the old group failed.",
			ts: FIXED_NOW + 1,
		}], {
			deferMaterialization: true,
			sessionId: "failed-prefix-conversation",
			now: () => FIXED_NOW + 1,
		});

		const calls = [];
		const resumed = await drain(data, {
			fetchFn: async (_url, init) => {
				calls.push(JSON.parse(init.body).messages[0].id);
				return acceptedResponse(77);
			},
		});
		expect(calls).toEqual(["newer-after-failed-prefix"]);
		expect(resumed).toMatchObject({ delivered: 1, terminalFailedGroups: 1, orderBlocked: 0 });
		expect(await jsonFiles(join(data.outbox, "staged"))).toHaveLength(1);
	});

	it("orders eager v2 groups by enqueue sequence even when their timestamps tie", async () => {
		const data = await fixture();
		await enqueue(data, [{
			id: "eager-older",
			role: "user",
			content: "The older eager outcome must be accepted first.",
			ts: FIXED_NOW,
		}], { sessionId: "same-eager-conversation", now: () => FIXED_NOW });
		await enqueue(data, [{
			id: "eager-newer",
			role: "user",
			content: "The newer eager outcome must wait behind any older retry.",
			ts: FIXED_NOW + 1,
		}], { sessionId: "same-eager-conversation", now: () => FIXED_NOW });

		const entries = await envelopesIn(data);
		const byMessage = new Map(entries.map(({ value }) => [value.request.body.messages[0].id, value]));
		expect(byMessage.get("eager-older").delivery_order).toBe(FIXED_NOW * 1_000);
		expect(byMessage.get("eager-newer").delivery_order).toBe(FIXED_NOW * 1_000 + 1);
		const firstCalls = [];
		const first = await drain(data, {
			fetchFn: async (_url, init) => {
				const body = JSON.parse(init.body);
				firstCalls.push(body.messages[0].id);
				return new Response(JSON.stringify({ ok: false }), { status: 500 });
			},
		});
		expect(firstCalls).toEqual(["eager-older"]);
		expect(first).toMatchObject({ retried: 1, orderBlocked: 1 });

		const resumedCalls = [];
		const resumed = await drain(data, {
			now: () => FIXED_NOW + 60_000,
			fetchFn: async (_url, init) => {
				const body = JSON.parse(init.body);
				resumedCalls.push(body.messages[0].id);
				return acceptedResponse(resumedCalls.length + 20);
			},
		});
		expect(resumedCalls).toEqual(["eager-older", "eager-newer"]);
		expect(resumed).toMatchObject({ delivered: 2, orderBlocked: 0 });
	});

	it("keeps a migrated pre-sequence group ahead when the wall clock rolls backward", async () => {
		const data = await fixture();
		const older = await enqueue(data, [{
			id: "migrated-older",
			role: "user",
			content: "This group was staged before durable sequence allocation existed.",
			ts: FIXED_NOW + 1_000,
		}], {
			sessionId: "migration-order-conversation",
			now: () => FIXED_NOW + 1_000,
			deferMaterialization: true,
		});
		const olderPath = join(data.outbox, "staged", `${older.queueId}.json`);
		const migrated = JSON.parse(await readFile(olderPath, "utf8"));
		delete migrated.delivery_order;
		await writeFile(olderPath, canonicalJson(migrated), { encoding: "utf8", mode: 0o600 });

		await enqueue(data, [{
			id: "sequenced-newer",
			role: "assistant",
			content: "This group must remain behind the migrated predecessor.",
			ts: FIXED_NOW + 1,
		}], {
			sessionId: "migration-order-conversation",
			now: () => FIXED_NOW,
			deferMaterialization: true,
		});

		const calls = [];
		const first = await drain(data, {
			fetchFn: async (_url, init) => {
				calls.push(JSON.parse(init.body).messages[0].id);
				return new Response(JSON.stringify({ ok: false }), { status: 500 });
			},
		});
		expect(calls).toEqual(["migrated-older"]);
		expect(first).toMatchObject({ retried: 1, orderBlocked: 1 });
	});

	it("makes ordered prefix progress with all 127 deferred slots full and one delivery slot reserved", async () => {
		const data = await fixture();
		const messages = fixedSizeMessages(31, 80);
		for (let index = 0; index < 127; index += 1) {
			await enqueue(data, messages, {
				deferMaterialization: true,
				sessionId: `capacity-session-${index}`,
				now: () => FIXED_NOW + index,
			});
		}
		expect(await jsonFiles(join(data.outbox, "staged"))).toHaveLength(127);
		expect(await jsonFiles(join(data.outbox, "pending"))).toEqual([]);
		expect(JSON.parse(await readFile(join(data.outbox, "control", "delivery-sequence.json"), "utf8")))
			.toMatchObject({ schema: "itsuki.outbox-delivery-sequence/v1", next_order: FIXED_NOW * 1_000 + 127 });
		await expect(enqueue(data, messages, {
			deferMaterialization: true,
			sessionId: "capacity-session-reserve-check",
			now: () => FIXED_NOW + 127,
		})).rejects.toMatchObject({ code: "outbox_count_full" });
		expect(await jsonFiles(join(data.outbox, "staged"))).toHaveLength(127);

		const firstCalls = [];
		let peakCommittedRawCount = 0;
		const first = await drain(data, {
			maxItems: 1,
			fetchFn: async (_url, init) => {
				const body = JSON.parse(init.body);
				firstCalls.push(body.delivery.batchIndex);
				const active = await Promise.all(
					["tmp", "staged", "pending", "inflight", "failed"].map((name) => jsonFiles(join(data.outbox, name))),
				);
				peakCommittedRawCount = Math.max(peakCommittedRawCount, active.reduce((sum, names) => sum + names.length, 0));
				return acceptedResponse(80);
			},
		});
		expect(firstCalls).toEqual([0]);
		expect(peakCommittedRawCount).toBe(128);
		expect(first).toMatchObject({ delivered: 1, materializedBatches: 1 });
		expect(first.materializationBlocked).toBeGreaterThan(0);
		expect(await jsonFiles(join(data.outbox, "staged"))).toHaveLength(127);
		expect(await jsonFiles(join(data.outbox, "pending"))).toEqual([]);
		expect(await jsonFiles(join(data.outbox, "done"))).toHaveLength(1);
		const [plan] = await envelopesIn(data, "groups");
		expect(plan.value).toMatchObject({ materializer_version: 1, batch_count: 2 });

		const secondCalls = [];
		const second = await drain(data, {
			maxItems: 2,
			now: () => FIXED_NOW + 60_000,
			fetchFn: async (_url, init) => {
				const body = JSON.parse(init.body);
				secondCalls.push(body.delivery.batchIndex);
				return acceptedResponse(81 + secondCalls.length);
			},
		});
		expect(secondCalls).toEqual([1, 0]);
		expect(second).toMatchObject({ delivered: 2, materializedGroups: 1 });
		expect(await jsonFiles(join(data.outbox, "staged"))).toHaveLength(126);
	}, 30_000);

	it("yields the mutation lock between large-group fsyncs so SessionEnd can append", async () => {
		const data = await fixture();
		await enqueue(data, fixedSizeMessages(32, 220_000), {
			deferMaterialization: true,
			sessionId: "large-materialization",
		});
		const materializing = drain(data, { maxItems: 0, maxDurationMs: 20_000 });
		const waitDeadline = Date.now() + 15_000;
		while ((await jsonFiles(join(data.outbox, "pending"))).length === 0) {
			if (Date.now() >= waitDeadline) throw new Error("materialization did not produce its first durable batch");
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
		}

		const appendStarted = Date.now();
		const concurrent = await enqueue(data, [{
			id: "concurrent-session-end",
			role: "assistant",
			content: "This overlapping shutdown capture must still become durable.",
			ts: FIXED_NOW + 1,
		}], {
			deferMaterialization: true,
			sessionId: "concurrent-session-end",
			now: () => FIXED_NOW + 1,
		});
		const appendElapsed = Date.now() - appendStarted;
		const materialized = await materializing;
		expect(concurrent).toMatchObject({ queued: true, state: "staged" });
		expect(appendElapsed).toBeLessThan(1_500);
		expect(materialized.materializedGroups).toBe(1);
		expect(await jsonFiles(join(data.outbox, "staged"))).toHaveLength(1);
	}, 30_000);

	it("bounds one startup materialization pass and resumes deferred aggregates", async () => {
		const data = await fixture();
		const older = await enqueue(data, fixedSizeMessages(31, 80), {
			deferMaterialization: true,
			sessionId: "bounded-materialization-older",
			now: () => FIXED_NOW,
		});
		await enqueue(data, [{
			id: "bounded-materialization-newer",
			role: "assistant",
			content: "This aggregate is intentionally deferred to the following pass.",
			ts: FIXED_NOW + 1,
		}], {
			deferMaterialization: true,
			sessionId: "bounded-materialization-newer",
			now: () => FIXED_NOW + 1,
		});
		const olderBytes = Buffer.byteLength(await readFile(
			join(data.outbox, "staged", `${older.queueId}.json`),
		));

		const first = await drain(data, {
			maxItems: 0,
			maxMaterializationGroups: 4,
			maxMaterializationInputBytes: olderBytes,
		});
		expect(first).toMatchObject({
			materializedGroups: 1,
			materializedBatches: 2,
			materializationDeferred: 1,
		});
		expect(await jsonFiles(join(data.outbox, "staged"))).toHaveLength(1);

		const resumed = await drain(data, { maxItems: 0 });
		expect(resumed).toMatchObject({ materializedGroups: 1, materializationDeferred: 0 });
		expect(await jsonFiles(join(data.outbox, "staged"))).toEqual([]);
	});

	it("keeps newer v2 work behind a retrying legacy v1 envelope in the same conversation", async () => {
		const data = await fixture();
		await enqueue(data, [{
			id: "newer-v2-message",
			role: "assistant",
			content: "The newer v2 result must wait for the older legacy write.",
			ts: FIXED_NOW,
		}], { sessionId: "legacy-order-conversation", now: () => FIXED_NOW });
		const [newer] = await envelopesIn(data);
		const conversationId = newer.value.request.body.conversationId;
		const fingerprint = credentialFingerprint(API_KEY, BASE_URL);
		const digest = sha256("stage4-legacy-order-predecessor");
		const request = {
			path: "/v1/ingest",
			body: {
				source: "plugin",
				flush: true,
				conversationId,
				memoryScope: MEMORY_SCOPE,
				idempotencyKey: `claude-outbox:v1:${digest}`,
				messages: [{
					id: "older-legacy-message",
					role: "user",
					content: "The older legacy write is retrying.",
					ts: FIXED_NOW - 1,
				}],
			},
		};
		const queueId = `q_${sha256(`${digest}\0${fingerprint}`).slice(0, 40)}`;
		await writeFile(join(data.outbox, "pending", `${queueId}.json`), canonicalJson({
			schema: OUTBOX_SCHEMA,
			queue_id: queueId,
			created_at: FIXED_NOW - 1,
			credential_fingerprint: fingerprint,
			request,
			request_sha256: sha256(canonicalJson(request)),
		}), { encoding: "utf8", mode: 0o600 });

		const firstCalls = [];
		const first = await drain(data, {
			fetchFn: async (_url, init) => {
				const body = JSON.parse(init.body);
				firstCalls.push(body.messages[0].id);
				return new Response(JSON.stringify({ ok: false }), { status: 500 });
			},
		});
		expect(firstCalls).toEqual(["older-legacy-message"]);
		expect(first).toMatchObject({ retried: 1, orderBlocked: 1 });

		const resumedCalls = [];
		const resumed = await drain(data, {
			now: () => FIXED_NOW + 60_000,
			fetchFn: async (_url, init) => {
				const body = JSON.parse(init.body);
				resumedCalls.push(body.messages[0].id);
				return acceptedResponse(90 + resumedCalls.length);
			},
		});
		expect(resumedCalls).toEqual(["older-legacy-message", "newer-v2-message"]);
		expect(resumed).toMatchObject({ delivered: 2, orderBlocked: 0 });
	});

	it("continues to drain a maximum-size legacy v1 envelope without requiring batch metadata", async () => {
		const data = await fixture();
		const initializer = await enqueue(data, fixedSizeMessages(1, 80));
		await unlink(join(data.outbox, "pending", `${initializer.queueId}.json`));

		const fingerprint = credentialFingerprint(API_KEY, BASE_URL);
		const digest = sha256("stage4-legacy-v1-envelope");
		const request = {
			path: "/v1/ingest",
			body: {
				source: "plugin",
				flush: true,
				conversationId: "legacy-stage4-conversation",
				memoryScope: MEMORY_SCOPE,
				idempotencyKey: `claude-outbox:v1:${digest}`,
				messages: fixedSizeMessages(80, INGEST_LIMITS.maxMessageCharacters + 1),
			},
		};
		const queueId = `q_${sha256(`${digest}\0${fingerprint}`).slice(0, 40)}`;
		const envelope = {
			schema: OUTBOX_SCHEMA,
			queue_id: queueId,
			created_at: FIXED_NOW - 1,
			credential_fingerprint: fingerprint,
			request,
			request_sha256: sha256(canonicalJson(request)),
		};
		await writeFile(
			join(data.outbox, "pending", `${queueId}.json`),
			canonicalJson(envelope),
			{ encoding: "utf8", mode: 0o600 },
		);

		const fetchFn = vi.fn(async (_url, init) => {
			const body = JSON.parse(init.body);
			expect(body.delivery).toBeUndefined();
			expect(body.idempotencyKey).toBe(request.body.idempotencyKey);
			expect(body.messages).toHaveLength(80);
			expect(body.messages.every((message) => unicodeLength(message.content) === 4_001)).toBe(true);
			return acceptedResponse(0);
		});
		const result = await drain(data, { fetchFn });

		expect(fetchFn).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({ delivered: 1, permanentFailures: 0 });
		expect(await jsonFiles(join(data.outbox, "pending"))).toEqual([]);
		expect(await jsonFiles(join(data.outbox, "done"))).toEqual([`${queueId}.json`]);
	});
});
