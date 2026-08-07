/**
 * A2B — the server's shared scrub lane vs the canonical security corpus.
 *
 * src/pipeline/scrub.js runs BEFORE anything durable (packet, staging, DO,
 * model, vectors — ingest.js order pin), so this is the authoritative
 * boundary. The same corpus drives both plugin scrubbers in
 * test/security_corpus_plugins.spec.js.
 */

import { describe, expect, it } from "vitest";

import { scrubMessages } from "../src/pipeline/scrub.js";
import { FALSE_POSITIVE_ENTRIES, SECRET_ENTRIES } from "./fixtures/security_corpus.mjs";

function scrubText(text) {
	const { messages } = scrubMessages([{ id: "m1", role: "user", content: text }]);
	return String(messages[0]?.content ?? "");
}

describe("server scrub lane vs canonical security corpus", () => {
	for (const entry of SECRET_ENTRIES) {
		const obligation = entry.expect.server;
		if (obligation !== "must") continue;
		it(`redacts ${entry.id} (${entry.class})`, () => {
			const out = scrubText(entry.text);
			for (const canary of entry.mustNotSurvive) {
				expect(out, `${entry.id}: canary survived`).not.toContain(canary);
			}
			for (const keep of entry.mustSurvive) {
				expect(out, `${entry.id}: over-redaction ate context`).toContain(keep);
			}
		});
	}

	for (const entry of FALSE_POSITIVE_ENTRIES) {
		it(`leaves ${entry.id} untouched`, () => {
			const out = scrubText(entry.text);
			expect(out).toBe(entry.text);
		});
	}
});
