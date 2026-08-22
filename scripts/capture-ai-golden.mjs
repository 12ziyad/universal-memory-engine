/**
 * One-time golden capture for the provider-dispatch refactor (Phase 0B).
 *
 * Run BEFORE the refactor lands:  node scripts/capture-ai-golden.mjs
 * Writes eval/fixtures/ai_forwarding_golden.json. The spec
 * test/ai_golden_forwarding.spec.js replays the same driver and fails if the
 * binding ever sees different bytes. Re-running this script against changed
 * code and committing the diff is a DELIBERATE semantic change, never a fix.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { captureForwardingTuples } from "../test/helpers/ai_forwarding_flows.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "eval", "fixtures", "ai_forwarding_golden.json");

const tuples = await captureForwardingTuples();
await mkdir(path.dirname(target), { recursive: true });
await writeFile(target, `${JSON.stringify(tuples, null, "\t")}\n`, "utf8");
console.log(`captured ${tuples.length} flows -> ${path.relative(root, target)}`);
for (const { flow, calls } of tuples) console.log(`  ${flow}: ${calls.length} call(s)`);
