/**
 * Conversation Pages — the naming sweep, pinned.
 *
 * The conversation artifact has exactly one user-facing name: "Conversation
 * page". Earlier vocabulary — "notes page", "memory page", "capture pages",
 * "organized pages" — must never reappear on the docs site or the dashboard.
 * Internal identifiers are deliberately out of scope: the memory_pages table,
 * source modes, and the workspace kind key "page" keep their names (the wire
 * contract is unchanged), which is why the forbidden patterns all contain a
 * literal space — an underscore identifier like memory_pages cannot match.
 */

import { describe, it, expect } from "vitest";
import app from "../public/index.html?raw";
import docs from "../public/docs/index.html?raw";

const SURFACES = [
	["dashboard", app],
	["docs", docs],
];

// Forbidden names for the artifact. Word-spaced phrases only, so code
// identifiers (memory_pages, duplicate_memory_page, kind key "page") stay
// allowed while prose regressions are caught case-insensitively.
const FORBIDDEN = [
	/notes pages?/i,
	/memory pages?/i,
	/capture pages?/i,
	/organized pages?/i,
];

/** Every match with a little context, so a failure names its own location. */
function findAll(html, pattern) {
	const global = new RegExp(pattern.source, `${pattern.flags}g`);
	return [...html.matchAll(global)].map(
		(m) => `…${html.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40)}…`,
	);
}

describe("frozen vocabulary", () => {
	for (const [name, html] of SURFACES) {
		for (const pattern of FORBIDDEN) {
			it(`${name} never says ${pattern}`, () => {
				expect(findAll(html, pattern)).toEqual([]);
			});
		}

		it(`${name} has no Notes section heading`, () => {
			expect(html).not.toContain("<h2>Notes</h2>");
		});

		it(`${name} names the artifact "Conversation page"`, () => {
			expect(html).toMatch(/Conversation pages?/);
		});
	}
});
