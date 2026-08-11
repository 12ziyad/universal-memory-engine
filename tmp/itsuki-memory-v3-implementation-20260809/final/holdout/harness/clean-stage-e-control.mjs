import path from "node:path";

import {
	CAMPAIGN,
	cohorts,
	d1Select,
	eraseCohort,
	integer,
	secret,
	sqlQuote,
	writeJsonExclusive,
} from "../../harness/common.mjs";

const EVIDENCE = path.join(CAMPAIGN, "final", "holdout", "evidence");
const slots = cohorts().control;
const token = secret("ITSUKI_API_KEY");
console.log("ITSUKI_API_KEY: LOADED");
const erased = await eraseCohort(token, slots);
const ids = slots.map((slot) => sqlQuote(slot.memoryUserId)).join(",");
const [packetResult] = await d1Select([`SELECT COUNT(*) AS packets,
	SUM(CASE WHEN content_hash='itsuki-erased-source/v1' THEN 1 ELSE 0 END) AS minimized,
	SUM(CASE WHEN length(trim(coalesce(content_preview,'')))>0
		OR trim(coalesce(raw_meta_json,'{}')) NOT IN ('','{}')
		OR coalesce(message_count,0)<>0 THEN 1 ELSE 0 END) AS content_rows
	FROM source_packets WHERE user_id IN (${ids})`]);
const packets = Object.fromEntries(Object.entries(packetResult.results?.[0] ?? {})
	.map(([key, value]) => [key, integer(value)]));
if (packets.content_rows !== 0 || packets.packets !== packets.minimized) {
	throw new Error(`control packet cleanup did not converge: ${JSON.stringify(packets)}`);
}
const evidence = {
	schema: "itsuki.v3-stage-e-control-cleanup/v1",
	at: new Date().toISOString(),
	throughProductErasureApi: true,
	slots: slots.length,
	erased,
	packets,
	pass: true,
};
writeJsonExclusive(path.join(EVIDENCE, "stage-e-control-cleanup.json"), evidence);
console.log(JSON.stringify(evidence, null, 2));
