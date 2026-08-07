/**
 * A2B — both plugin capture scrubbers vs the canonical security corpus.
 *
 * The server (src/pipeline/scrub.js — see security_corpus_server.spec.js)
 * remains the authoritative boundary; plugin scrubbing is defense-in-depth.
 * Testing all three against ONE corpus is what makes coverage drift (the
 * SEC-01 class) visible instead of silent.
 */

import { describe, expect, it } from "vitest";

import { scrubCaptureText } from "../hooks/claude-capture.mjs";
import { scrubCodexText } from "../plugins/itsuki/hooks/codex-scrub.mjs";
import { FALSE_POSITIVE_ENTRIES, SECRET_ENTRIES } from "./fixtures/security_corpus.mjs";

const SCRUBBERS = {
	claude: (text) => {
		const result = scrubCaptureText(text);
		return String(result?.text ?? result ?? "");
	},
	codex: (text) => {
		const result = scrubCodexText(text);
		return String(result?.text ?? result ?? "");
	},
};

for (const [name, scrub] of Object.entries(SCRUBBERS)) {
	describe(`${name} capture scrubber vs canonical security corpus`, () => {
		for (const entry of SECRET_ENTRIES) {
			const obligation = entry.expect[name];
			if (obligation !== "must") {
				it(`${entry.id}: documented exemption — ${obligation?.exempt ?? "unspecified"}`, () => {
					expect(typeof obligation?.exempt, `${entry.id}: exemption must carry a reason`).toBe("string");
				});
				continue;
			}
			it(`redacts ${entry.id} (${entry.class})`, () => {
				const out = scrub(entry.text);
				for (const canary of entry.mustNotSurvive) {
					expect(out, `${entry.id}: canary survived`).not.toContain(canary);
				}
			});
		}

		for (const entry of FALSE_POSITIVE_ENTRIES) {
			it(`leaves ${entry.id} recognizably intact`, () => {
				const out = scrub(entry.text);
				for (const keep of entry.mustSurvive) {
					expect(out, `${entry.id}: over-redaction ate context`).toContain(keep);
				}
			});
		}
	});
}
