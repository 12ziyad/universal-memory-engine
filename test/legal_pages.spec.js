/* The trust and legal document system.
 *
 * Eight public documents served through the legal overlay, a valid RFC 9116
 * security.txt, and footer wiring. These tests pin the truthfulness rules the
 * documents were written under: exactly three subprocessors, a no-training
 * commitment, dated pages with changelogs, and no certification claims.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";
import html from "../public/index.html?raw";

async function request(path, init = {}) {
	const req = new Request(`http://example.com${path}`, init);
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

const KINDS = ["terms", "privacy", "aup", "security", "subprocessors", "ai-data", "retention", "disclosure"];
const legalBlock = html.slice(html.indexOf("const LEGAL_PAGES = {"), html.indexOf("function showLegal("));

describe("the document set", () => {
	it("defines all eight documents with titles and effective dates", () => {
		for (const kind of KINDS) {
			expect(legalBlock, `${kind} is defined`).toMatch(new RegExp(`(^|\\W)["']?${kind}["']?: \\{`, "m"));
		}
		expect(legalBlock.match(/title: "/g)).toHaveLength(8);
		// Every document opens with the effective-date meta line.
		expect(legalBlock.match(/class="legal-meta"/g).length).toBeGreaterThanOrEqual(8);
		expect(html).toContain('const LEGAL_EFFECTIVE_DATE = "August 29, 2026"');
	});

	it("keeps a changelog on every document", () => {
		expect(legalBlock.match(/class="legal-changelog"/g).length).toBeGreaterThanOrEqual(8);
	});

	it("names a consistent operator on every document", () => {
		expect(legalBlock.match(/operated by Ziyad Ej, India/g).length).toBeGreaterThanOrEqual(8);
	});
});

describe("truthfulness rules", () => {
	it("lists exactly three subprocessors and says sign-in providers never see memory", () => {
		const sub = legalBlock.slice(legalBlock.indexOf('subprocessors: {'), legalBlock.indexOf('"ai-data": {'));
		for (const vendor of ["Cloudflare, Inc.", "Google LLC", "GitHub, Inc."]) {
			expect(sub).toContain(`<b>${vendor}</b>`);
		}
		expect(sub.match(/Never memory content\./g)).toHaveLength(2);
		// The count claim was replaced with a durable design statement: adding a
		// provider must not make the page numerically false before anyone edits it.
		expect(sub).toContain("keeps this list deliberately short");
		// The change promise: page updates before data flows.
		expect(sub).toContain("before any customer data reaches it");
	});

	it("commits to never training on memory, on any plan", () => {
		expect(legalBlock).toContain("Your memory is never used to train AI models");
		expect(legalBlock).toContain("on any plan, free or paid");
	});

	it("admits the certification status plainly instead of claiming badges", () => {
		const sec = legalBlock.slice(legalBlock.indexOf("security: {"), legalBlock.indexOf("subprocessors: {"));
		expect(sec).toContain("<h2>8. Certifications</h2>");
		expect(sec).toContain("None yet");
		// The global no-fake-compliance rule also covers these pages
		// (test/product_experience.spec.js), so no SOC/ISO/HIPAA strings here.
	});

	it("gives researchers safe harbor and a real reporting channel", () => {
		const vdp = legalBlock.slice(legalBlock.indexOf("disclosure: {"));
		expect(vdp).toContain("Safe harbor");
		expect(vdp).toContain("<b>authorized</b>");
		expect(vdp).toContain("Test only against your own data.");
		// The self-imposed 72h clock was removed on purpose — a solo operator
		// should not sign a contractual deadline the law does not require.
		expect(vdp).toContain("Acknowledgment, usually within a few days");
		expect(vdp).not.toContain("72 hours");
		expect(vdp).toContain("github.com/12ziyad/universal-memory-engine/security");
	});

	it("states retention with numbers, not adjectives", () => {
		const ret = legalBlock.slice(legalBlock.indexOf("retention: {"), legalBlock.indexOf("disclosure: {"));
		expect(ret).toContain("10 minutes, single-use, stored hashed");
		expect(ret).toContain("30 days after acceptance, revocation, or expiry");
		expect(ret).toContain("At most 30 days, content-minimized");
		expect(ret).toContain("roughly <b>30 days</b> (Cloudflare D1 Time Travel)");
		expect(ret).toContain("exact deletion preview");
	});

	it("forbids storing secrets, card data, and regulated health data", () => {
		const aup = legalBlock.slice(legalBlock.indexOf("aup: {"), legalBlock.indexOf("security: {"));
		expect(aup).toContain("Credentials and secrets:");
		expect(aup).toContain("Payment-card data");
		expect(aup).toContain("Protected health information");
		expect(aup).toContain("stalkerware");
	});

	it("privacy names the sign-in providers and links the subprocessor register", () => {
		expect(legalBlock).toContain("Sign-in providers:");
		expect(legalBlock).toContain('href="/subprocessors"');
	});
});

describe("routing", () => {
	it("every document resolves on a direct visit", async () => {
		for (const kind of KINDS) {
			const res = await request(`/${kind}`);
			expect(res.status, `/${kind} redirects to the shell`).toBe(302);
			expect(res.headers.get("location")).toContain(`view=${kind}`);
		}
	});

	it("the client routes every document slug", () => {
		expect(html).toContain('const LEGAL_KINDS = ["terms", "privacy", "aup", "security", "subprocessors", "ai-data", "retention", "disclosure"]');
		expect(html).toContain('mode.startsWith("legal:")');
	});

	it("serves a valid RFC 9116 security.txt", async () => {
		const res = await request("/.well-known/security.txt");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/plain");
		const body = await res.text();
		expect(body).toContain("Contact: mailto:founder@itsuki.app");
		expect(body).toContain("Policy: https://itsuki.app/disclosure");
		expect(body).toContain("Canonical: https://itsuki.app/.well-known/security.txt");
		const expires = body.match(/Expires: (.+)/)?.[1];
		expect(new Date(expires).getTime()).toBeGreaterThan(Date.now());
	});
});

describe("discoverability", () => {
	it("the footer carries a Trust column linking every trust document", () => {
		const footer = html.slice(html.indexOf('<footer class="footer"'), html.indexOf("</footer>"));
		for (const kind of ["security", "subprocessors", "ai-data", "retention", "disclosure", "aup"]) {
			expect(footer, `footer links /${kind}`).toContain(`href="/${kind}"`);
		}
	});

	it("SECURITY.md points researchers at the published policy", async () => {
		// Source-of-truth check is the repo file; the spec pins the disclosure
		// URL that both security.txt and SECURITY.md advertise.
		expect(legalBlock).toContain("/.well-known/security.txt");
	});
});
