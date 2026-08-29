/* Launch truthfulness pins (pre-Hacker-News copy audit).
 *
 * Each assertion here corresponds to a claim that was FALSE or materially
 * MISLEADING against the deployed product and was corrected. The negative
 * assertions are the important half: they stop the old, flattering wording
 * from coming back.
 */
import { describe, it, expect } from "vitest";
import html from "../public/index.html?raw";
import docs from "../public/docs/index.html?raw";
import readme from "../README.md?raw";

describe("open-source claims match what is actually published", () => {
	it("no longer claims every commit and migration is public", () => {
		// Production runs a development line ahead of the public repository:
		// at the time of this pass, 65 commits, 9 migrations and 7 modules
		// existed only in the deployed tree.
		expect(html).not.toContain("Every commit and schema migration is public");
		expect(html).not.toContain("Every migration and commit is public");
		expect(html).not.toContain("The repository is <b>public</b>, including every schema migration");
		expect(html).not.toContain("the code that enforces every claim on this page is public");
	});

	it("states the publication lag on the marketing page, not only in SECURITY.md", () => {
		expect(html).toContain("Publication runs behind deployment");
		expect(html).toContain("Publication lags deployment");
	});
});

describe("export claims match the nine collections the export actually contains", () => {
	it("does not promise sources, or 'everything'", () => {
		// EXPORT_TABLES = nodes, slices, events, edges, memory_pages,
		// candidates, receipts, memory_rules, memory_revisions. Source packets
		// and episodes are NOT exported.
		expect(html).not.toContain("memories, sources, and revisions");
		expect(readme).not.toContain("Everything you own, streamed as one JSON file");
		expect(docs).not.toContain("One request, one JSON download, everything in that memory space");
		expect(docs).not.toContain("Download everything you own.");
		expect(docs).not.toContain("Everything, in one response.");
	});

	it("describes the real payload and the single-space scope", () => {
		expect(html).toContain("its memories, receipts, rules and revision history");
		expect(readme).toContain("One resolved memory space");
		expect(readme).toContain("sibling subtenant spaces are not included");
	});

	it("no longer claims a job-lane size ceiling that R2 removed", () => {
		expect(docs).not.toContain("The job lane has a size ceiling the one-shot route does not");
		expect(docs).toContain("Neither lane has a size ceiling");
	});
});

describe("telemetry wording matches what is collected", () => {
	it("does not claim the visit beacon stores no identifier", () => {
		// It stores a keyed, truncated, daily-rotated fingerprint of IP+UA —
		// aggregate and short-lived, but still a pseudonymous per-day value.
		expect(docs).not.toContain("It sets no cookie and stores no identifier");
		expect(docs).toContain("keyed, one-way fingerprint of IP plus user agent");
	});

	it("does not claim the session cookie is the only cookie", () => {
		expect(docs).not.toContain("it is the only cookie in play");
	});

	it("does not overstate what hashing an IP address buys", () => {
		expect(html).not.toContain("enough to detect abuse, not to track you");
		expect(html).toContain("a hash of one is not strong anonymisation");
	});
});

describe("the vault is never described as deletion", () => {
	it("says plainly that shelving is not erasure", () => {
		expect(html).toContain("This is NOT deletion");
		expect(html).toContain("Shelving is not erasure");
	});

	it("discloses shelved accounts in the retention table", () => {
		expect(html).toContain("Shelved accounts");
		expect(html).toContain("reverses on next sign-in");
	});
});

describe("deletion claims admit the by-design residue", () => {
	it("no longer claims deletion is complete everywhere within 30 days", () => {
		expect(html).not.toContain("deletion is complete everywhere within about 30 days");
		expect(html).toContain("What remains after that is by design and content-free");
	});

	it("discloses that the mail log retains addresses already emailed", () => {
		expect(html).toContain("remains in our mail log");
	});
});

describe("docs numbers match the code", () => {
	it("states the real MCP tool count", () => {
		expect(readme).toContain("MCP server (11 tools)");
		expect(readme).not.toContain("MCP server (3 tools)");
	});

	it("states the real SDK versions", () => {
		expect(readme).not.toContain("matching Node and Python `0.2.1`");
		expect(readme).toContain("Node SDK `0.3.0`");
	});

	it("states Huba's real cost and that it is exempt from the save allowance", () => {
		expect(docs).not.toContain("Roughly 20–35 neurons per answer");
		expect(docs).toContain("excluded from the daily save allowance");
	});
});
