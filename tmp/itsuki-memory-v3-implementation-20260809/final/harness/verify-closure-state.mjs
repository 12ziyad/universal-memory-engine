import fs from "node:fs";
import path from "node:path";

import {
	EVIDENCE,
	GLOBAL_LOCK,
	assert,
	cohorts,
	d1Select,
	integer,
	memoryCountsAreZero,
	sqlQuote,
	stateCounts,
	validateInputs,
	writeJsonExclusive,
} from "./common.mjs";

const RESULT = path.join(EVIDENCE, "stage-b-closure-state.json");

validateInputs();
assert(!fs.existsSync(GLOBAL_LOCK), "global benchmark lock remains held");
const slots = cohorts().treatment;
const ids = slots.map((slot) => sqlQuote(slot.memoryUserId)).join(",");
const counts = await stateCounts(slots);
const [packetResult] = await d1Select([`SELECT COUNT(*) AS packets,
	SUM(CASE WHEN content_hash='itsuki-erased-source/v1' THEN 1 ELSE 0 END) AS minimized,
	SUM(CASE WHEN length(trim(coalesce(content_preview,'')))>0
		OR trim(coalesce(raw_meta_json,'{}')) NOT IN ('','{}')
		OR coalesce(message_count,0)<>0 THEN 1 ELSE 0 END) AS content_rows
	FROM source_packets WHERE user_id IN (${ids})`]);
const rawPackets = packetResult.results?.[0] ?? {};
const packets = Object.fromEntries(Object.entries(rawPackets).map(([key, value]) => [key, integer(value)]));

assert(memoryCountsAreZero(counts), `closure live residue: ${JSON.stringify(counts)}`);
assert(packets.content_rows === 0, `closure packet content residue: ${JSON.stringify(packets)}`);
assert(packets.packets === packets.minimized, `closure packet fences not minimized: ${JSON.stringify(packets)}`);

const evidence = {
	schema: "itsuki.v3-final-stage-b-closure-state/v1",
	at: new Date().toISOString(),
	pass: true,
	productionPrimary: true,
	cohortSlots: slots.length,
	counts,
	packets,
	globalLockHeld: false,
};
writeJsonExclusive(RESULT, evidence);
console.log(JSON.stringify(evidence, null, 2));
