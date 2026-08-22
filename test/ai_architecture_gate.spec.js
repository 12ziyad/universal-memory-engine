/**
 * The provider-architecture gate. If any of these fail, "detachable" stopped
 * being true: a business-code path grew its own binding call, a Google
 * endpoint leaked outside the adapter, or a provider module was imported
 * around the registry. The runAi importer set is pinned so the unmigrated
 * long tail shrinks deliberately instead of growing silently.
 */

import { describe, expect, it } from "vitest";
import { auditAiCalls, loadAiCensusSources, RUN_AI_IMPORTERS } from "../src/lib/ai_call_census.js";

describe("ai call architecture census", () => {
	it("holds all three invariants and the pinned importer set", async () => {
		const sources = await loadAiCensusSources();
		// Sanity: the census must actually be looking at the tree.
		expect(Object.keys(sources).length).toBeGreaterThan(50);
		expect(Object.keys(sources)).toContain("src/lib/ai_meter.js");

		const findings = auditAiCalls(sources);
		expect(findings.bindingEscapes, "only the Cloudflare provider may invoke env.AI.run").toEqual([]);
		expect(findings.googleEscapes, "Google AI endpoints only under src/ai/providers/google/").toEqual([]);
		expect(findings.providerImportEscapes, "providers are imported only via the registry").toEqual([]);
		expect(findings.runAiImporters, "a new direct runAi caller must be a deliberate decision").toEqual([...RUN_AI_IMPORTERS].sort());
	});
});
