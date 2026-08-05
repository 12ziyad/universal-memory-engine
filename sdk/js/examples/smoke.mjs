/**
 * Live smoke test against a deployed worker. Each run uses a fresh isolated
 * userId and verifies dry-run/confirmed cleanup before reporting success.
 *   ITSUKI_API_KEY=itsuki_live_… ITSUKI_BASE_URL=https://… node examples/smoke.mjs
 */
import { randomUUID } from "node:crypto";

import { MemoryClient } from "../index.js";

const userId = `sdk-smoke-${randomUUID()}`;
const memory = new MemoryClient({
	apiKey: process.env.ITSUKI_API_KEY,
	userId,
	// No fallback here: the SDK's own DEFAULT_BASE_URL is the single source.
	...(process.env.ITSUKI_BASE_URL ? { baseUrl: process.env.ITSUKI_BASE_URL } : {}),
});

const stamp = Date.now();
let smokeError = null;
let sourcePacketId = null;
let terminalSettled = false;
try {
	const receipt = await memory.add(`SDK smoke test: I adopted a plant named Fern-${stamp}.`, {
		idempotencyKey: memory.newIdempotencyKey(),
	});
	console.log("add →", receipt.summary ?? receipt.receipt?.summary ?? "accepted");

	sourcePacketId = receipt.source_packet_id ?? null;
	if (!sourcePacketId) throw new Error("save response did not include source_packet_id");
	const terminal = await memory.waitFor(sourcePacketId, { timeoutMs: 60_000 });
	console.log("terminal →", terminal.status, terminal.timed_out ? "(poll timed out)" : "");
	terminalSettled = !terminal.timed_out && ["enriched", "failed", "completed"].includes(terminal.status);
	if (terminal.timed_out) {
		throw new Error("background enrichment did not reach a terminal state within 60 seconds");
	}
	if (terminal.status === "failed") {
		throw new Error(`background enrichment failed: ${terminal.error ?? "unknown error"}`);
	}
	if (!["enriched", "completed"].includes(terminal.status)) {
		throw new Error(`unexpected terminal status: ${terminal.status ?? "missing"}`);
	}

	const found = await memory.search(`plant named Fern-${stamp}`);
	console.log("search →", found.count, "matches; context:", String(found.context ?? "").slice(0, 120));
	if (found.ok !== true || !String(found.context ?? "").toLowerCase().includes(`fern-${stamp}`.toLowerCase())) {
		throw new Error("recall did not return the uniquely saved Fern fact");
	}

	const usage = await memory.usage({ range: "1d" });
	console.log("usage →", usage.totals);
	if (usage.ok !== true) throw new Error("usage endpoint did not return ok=true");
} catch (error) {
	smokeError = error;
}

try {
	let cleanupUncertain = null;
	if (sourcePacketId && !terminalSettled) {
		try {
			const terminal = await memory.waitFor(sourcePacketId, { timeoutMs: 60_000 });
			terminalSettled = !terminal.timed_out && ["enriched", "failed", "completed"].includes(terminal.status);
			if (!terminalSettled) cleanupUncertain = new Error("the accepted write did not settle before cleanup");
		} catch {
			cleanupUncertain = new Error("the accepted write's terminal state could not be confirmed before cleanup");
		}
	} else if (!sourcePacketId && smokeError) {
		cleanupUncertain = new Error("write acceptance is unknown, so later background memory cannot be ruled out");
	}

	// This userId is unique to the run, so an unfiltered delete avoids relying
	// on client/server clock alignment and cannot select another user's data.
	const preview = await memory.deleteBySource();
	if (preview.ok !== true || preview.dry_run !== true) throw new Error("cleanup dry-run was not accepted");
	const removed = await memory.deleteBySource({ confirm: true });
	if (removed.ok !== true || removed.dry_run !== false) throw new Error("cleanup confirmation was not accepted");
	const previewCounts = preview.would_delete ?? {};
	const deletedCounts = removed.deleted ?? {};
	if (Object.entries(previewCounts).some(([key, value]) => Number(deletedCounts[key] ?? -1) !== Number(value))) {
		throw new Error("cleanup confirmation did not match its dry-run");
	}
	const selected = Object.values(previewCounts).reduce((sum, value) => sum + Number(value || 0), 0);
	if (!smokeError && selected === 0) throw new Error("cleanup dry-run did not select the verified smoke write");
	const absent = await memory.search(`plant named Fern-${stamp}`);
	if (String(absent.context ?? "").toLowerCase().includes(`fern-${stamp}`.toLowerCase())) {
		throw new Error("the smoke-test fact remained recallable after cleanup");
	}
	if (cleanupUncertain) throw cleanupUncertain;
	console.log("cleanup → verified empty isolated user", userId);
} catch (cleanupError) {
	throw new AggregateError(
		smokeError ? [smokeError, cleanupError] : [cleanupError],
		`SDK smoke test cleanup failed for isolated user ${userId}`,
	);
}

if (smokeError) throw smokeError;
console.log("SMOKE OK");
