/**
 * Phase 0B semantics-preservation proof.
 *
 * The provider-dispatch layer sits UNDER runAi; its entire promise is that the
 * Cloudflare path is byte-identical to the pre-refactor code. This spec replays
 * one flow through every distinct AI input shape and structured-output
 * mechanism and compares the exact (argc, model, inputs, options) tuples the
 * binding sees against fixtures captured BEFORE the refactor
 * (scripts/capture-ai-golden.mjs). A mismatch here means the wrap changed what
 * a model receives — which is never a fix, always a defect (or a deliberate,
 * re-captured semantic change with its own review).
 */

import { describe, expect, it } from "vitest";
import { captureForwardingTuples } from "./helpers/ai_forwarding_flows.mjs";
import golden from "../eval/fixtures/ai_forwarding_golden.json";

describe("golden forwarding", () => {
	it("every flow hands the binding exactly the pre-refactor bytes", async () => {
		const captured = await captureForwardingTuples();
		expect(captured.map((f) => f.flow)).toEqual(golden.map((f) => f.flow));
		for (let i = 0; i < golden.length; i += 1) {
			// Compare via canonical JSON so a mismatch prints the offending flow
			// rather than a 400-line object diff of everything at once.
			expect(
				JSON.stringify(captured[i], null, "\t"),
				`flow ${golden[i].flow} must forward byte-identical arguments`,
			).toBe(JSON.stringify(golden[i], null, "\t"));
		}
	});
});
