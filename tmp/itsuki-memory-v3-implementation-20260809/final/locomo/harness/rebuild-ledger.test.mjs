import assert from "node:assert/strict";
import test from "node:test";

import { overlayContainmentRebuild } from "./rebuild-ledger.mjs";

const historical = [
	{ sampleId: "conv-a", sessionIndex: 1, packet: "a" },
	{ sampleId: "conv-43", sessionIndex: 1, packet: "old-1" },
	{ sampleId: "conv-43", sessionIndex: 2, packet: "old-2" },
];
const rebuild = [
	{ sampleId: "conv-43", sessionIndex: 1, packet: "new-1" },
	{ sampleId: "conv-43", sessionIndex: 2, packet: "new-2" },
];

test("overlays only the explicitly rebuilt sample while preserving total rows", () => {
	const merged = overlayContainmentRebuild({ historicalRows: historical, rebuildRows: rebuild,
		expectedSessions: 2 });
	assert.deepEqual(merged, [historical[0], ...rebuild]);
	assert.equal(historical[1].packet, "old-1");
});

test("rejects a partial rebuild instead of falling back to erased historical packets", () => {
	assert.throws(() => overlayContainmentRebuild({ historicalRows: historical,
		rebuildRows: rebuild.slice(0, 1), expectedSessions: 2 }), /1\/2 sessions/);
});

test("rejects duplicate rebuild session identities", () => {
	assert.throws(() => overlayContainmentRebuild({ historicalRows: historical,
		rebuildRows: [rebuild[0], rebuild[0]], expectedSessions: 2 }), /duplicate\/out-of-range/);
});

test("permits the untouched historical ledger only when rebuild is not required", () => {
	const merged = overlayContainmentRebuild({ historicalRows: historical, rebuildRows: [],
		expectedSessions: 2, required: false });
	assert.deepEqual(merged, historical);
});
