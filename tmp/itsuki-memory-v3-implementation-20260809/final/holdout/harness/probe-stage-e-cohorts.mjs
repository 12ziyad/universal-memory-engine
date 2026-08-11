import path from "node:path";

import {
	CAMPAIGN,
	cohorts,
	d1Select,
	integer,
	memoryCountsAreZero,
	sqlQuote,
	stateCounts,
	writeJsonExclusive,
} from "../../harness/common.mjs";

const EVIDENCE = path.join(CAMPAIGN, "final", "holdout", "evidence");
const cohort = cohorts();

async function packetCounts(slots) {
	const ids = slots.map((slot) => sqlQuote(slot.memoryUserId)).join(",");
	const [result] = await d1Select([`SELECT COUNT(*) AS packets,
		SUM(CASE WHEN content_hash='itsuki-erased-source/v1' THEN 1 ELSE 0 END) AS minimized,
		SUM(CASE WHEN length(trim(coalesce(content_preview,'')))>0
			OR trim(coalesce(raw_meta_json,'{}')) NOT IN ('','{}')
			OR coalesce(message_count,0)<>0 THEN 1 ELSE 0 END) AS content_rows
		FROM source_packets WHERE user_id IN (${ids})`]);
	return Object.fromEntries(Object.entries(result.results?.[0] ?? {})
		.map(([key, value]) => [key, integer(value)]));
}

const cells = {};
for (const [name, slots] of Object.entries(cohort)) {
	const counts = await stateCounts(slots);
	const packets = await packetCounts(slots);
	cells[name] = {
		slots: slots.length,
		counts,
		packets,
		liveStateZero: memoryCountsAreZero(counts),
		packetContentZero: packets.content_rows === 0 && packets.packets === packets.minimized,
	};
}
const evidence = {
	schema: "itsuki.v3-stage-e-cohort-preflight-before/v1",
	at: new Date().toISOString(),
	nonMutating: true,
	cells,
	conclusion: cells.control.packetContentZero ? "CONTROL_CLEAN" : "CONTROL_LEGACY_PACKET_CONTENT_REQUIRES_API_ERASURE",
};
writeJsonExclusive(path.join(EVIDENCE, "stage-e-cohort-preflight-before.json"), evidence);
console.log(JSON.stringify(evidence, null, 2));
