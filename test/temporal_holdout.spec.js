import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { resolveTemporalPhrase } from "../src/pipeline/temporal.js";
import { parseSourceTime } from "../src/lib/source_time.mjs";

const anchorAt = (text) => {
	const { time } = parseSourceTime(text);
	return { epoch_ms: time.epoch_ms, offset_minutes: time.offset_minutes ?? 0 };
};

/**
 * The frozen non-LoCoMo holdout drives this directly.
 *
 * Its temporal targets were written BEFORE any of this code existed (campaign
 * §3) and are hash-frozen in `holdout/holdout.sha256`, so this is a genuine
 * held-out check rather than a restatement of the implementation. No LoCoMo
 * content is involved at any point.
 *
 * The holdout lives in the campaign evidence directory rather than the repo,
 * deliberately: it is an evaluation asset with its own answers, and this
 * repository is public. When it is absent (a fresh clone, or a contributor who
 * never ran the campaign) these checks SKIP rather than silently pass — a
 * held-out suite that quietly evaluates nothing is worse than one that says so.
 */
describe("frozen non-LoCoMo holdout: temporal targets", () => {
	const REFS = join(process.cwd(), "tmp/itsuki-memory-v3-implementation-20260809/holdout/references");
	const present = existsSync(REFS);

	function holdoutTargets() {
		if (!present) return [];
		const targets = [];
		for (const file of readdirSync(REFS).filter((f) => f.endsWith(".json"))) {
			const reference = JSON.parse(readFileSync(join(REFS, file), "utf-8"));
			for (const target of reference.temporal ?? []) targets.push({ id: reference.id, ...target });
		}
		return targets;
	}

	const targets = holdoutTargets();

	it.skipIf(!present)("has targets to check", () => {
		expect(targets.length).toBeGreaterThan(0);
	});

	it.skipIf(present)("SKIPPED: the frozen holdout is not present in this checkout", () => {
		expect(present).toBe(false);
	});

	for (const target of targets) {
		const label = `${target.id}: "${target.phrase}" @ ${target.anchor}`;
		it(target.expected === null ? `${label} must NOT resolve` : label, () => {
			const resolved = resolveTemporalPhrase(target.phrase, anchorAt(target.anchor));
			if (target.expected === null) {
				expect(resolved).toBe(null);
				return;
			}
			expect(resolved?.date).toBe(target.expected.date);
			expect(resolved?.precision).toBe(target.expected.precision);
		});
	}
});
