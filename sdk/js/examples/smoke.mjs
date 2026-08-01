/**
 * Live smoke test against a deployed worker.
 *   ITSUKI_API_KEY=itsuki_live_… ITSUKI_BASE_URL=https://… node examples/smoke.mjs
 */
import { MemoryClient } from "../index.js";

const memory = new MemoryClient({
	apiKey: process.env.ITSUKI_API_KEY,
	baseUrl: process.env.ITSUKI_BASE_URL || "https://uml.gpmai.workers.dev",
});

const stamp = Date.now();
const receipt = await memory.add(`SDK smoke test: I adopted a plant named Fern-${stamp}.`, {
	idempotencyKey: memory.newIdempotencyKey(),
});
console.log("add →", receipt.summary ?? receipt.receipt?.summary ?? "accepted");

await new Promise((r) => setTimeout(r, 12000)); // extraction settles in background

const found = await memory.search(`plant named Fern-${stamp}`);
console.log("search →", found.count, "matches; context:", String(found.context ?? "").slice(0, 120));

const usage = await memory.usage({ range: "1d" });
console.log("usage →", usage.totals);
if (!usage.ok) process.exit(1);
console.log("SMOKE OK");
