/**
 * Build Huba AI's grounding corpus from the docs SPA.
 *
 *     node scripts/build-huba-corpus.mjs
 *
 * public/docs/index.html holds all 69 pages as JS template literals. This
 * script executes that script block in a sandbox (the page-building half runs
 * fine without a DOM; the router half is allowed to fail after PAGES/NAV are
 * assembled), strips the HTML to plain text, and emits
 * src/huba/corpus.generated.js — a committed module the Worker bundles, so
 * retrieval at request time costs zero I/O and zero inference.
 *
 * The emitted module records a SHA-256 of the docs file. test/huba.spec.js
 * recomputes it, so a docs edit without a corpus rebuild fails CI instead of
 * letting Huba answer from stale pages.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = join(ROOT, "public", "docs", "index.html");
const OUT = join(ROOT, "src", "huba", "corpus.generated.js");

const html = readFileSync(DOCS, "utf-8");
const docsHash = createHash("sha256").update(html.replace(/\r\n/g, "\n"), "utf-8").digest("hex");

// The docs SPA is one file with several <script> blocks; the page corpus
// lives in the largest inline block (the one that declares PAGES).
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const source = scripts.find((s) => s.includes("const PAGES")) ?? "";
if (!source) throw new Error("could not find the PAGES script block in docs/index.html");

const noop = () => {};
const fakeElement = new Proxy({}, {
	get: (t, key) => {
		if (key === "style" || key === "dataset" || key === "classList") {
			return new Proxy({ add: noop, remove: noop, toggle: noop, contains: () => false }, { get: (tt, kk) => tt[kk] ?? noop, set: () => true });
		}
		if (key === "addEventListener" || key === "removeEventListener" || key === "appendChild" || key === "setAttribute" || key === "focus" || key === "scrollIntoView") return noop;
		if (key === "querySelectorAll") return () => [];
		if (key === "querySelector" || key === "closest") return () => null;
		if (key === "children") return [];
		return undefined;
	},
	set: () => true,
});
const sandbox = {
	location: { origin: "https://itsuki.app", hash: "", pathname: "/docs/" },
	document: new Proxy({}, {
		get: (t, key) => {
			if (key === "getElementById" || key === "querySelector") return () => fakeElement;
			if (key === "querySelectorAll") return () => [];
			if (key === "createElement") return () => fakeElement;
			if (key === "addEventListener") return noop;
			if (key === "documentElement" || key === "body" || key === "head" || key === "title") return fakeElement;
			return undefined;
		},
		set: () => true,
	}),
	localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
	navigator: { clipboard: {} },
	console,
	addEventListener: noop,
	removeEventListener: noop,
	requestAnimationFrame: noop,
	setTimeout: noop,
	clearTimeout: noop,
	scrollTo: noop,
	matchMedia: () => ({ matches: false, addEventListener: noop }),
	history: { replaceState: noop, pushState: noop },
	IntersectionObserver: class { observe() {} disconnect() {} },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
// Top-level `const` in a vm script never lands on the context object, so the
// extraction tail must run in the SAME script, after the declarations. The
// docs script is expected to run to completion against the stubs above; if a
// future docs change trips a missing stub, add the stub — never ship a
// partial corpus.
vm.runInContext(
	`${source}\n;__extract({ PAGES: typeof PAGES !== "undefined" ? PAGES : null, NAV: typeof NAV !== "undefined" ? NAV : null });`,
	Object.assign(sandbox, { __extract: (payload) => { sandbox.__result = payload; } }),
	{ filename: "docs-inline-script.js" },
);

const PAGES = sandbox.__result?.PAGES;
const NAV = sandbox.__result?.NAV ?? [];
if (!PAGES || typeof PAGES !== "object") throw new Error("PAGES not found after executing the docs script");

function htmlToText(fragment) {
	return String(fragment)
		// keep code blocks readable as inline code
		.replace(/<pre[^>]*>[\s\S]*?<button[^>]*>Copy<\/button>/g, "<pre>")
		.replace(/<(h[1-4])[^>]*>/g, "\n\n")
		.replace(/<\/(h[1-4]|p|li|tr|pre|div)>/g, "\n")
		.replace(/<li[^>]*>/g, "- ")
		.replace(/<td[^>]*>|<th[^>]*>/g, " | ")
		.replace(/<[^>]+>/g, "")
		.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

const navLabel = new Map();
const navSection = new Map();
for (const section of NAV) {
	for (const [route, label] of section.items ?? []) {
		navLabel.set(route, label);
		navSection.set(route, section.sec);
	}
}

const corpus = Object.entries(PAGES).map(([route, page]) => ({
	route,
	title: page.title ?? navLabel.get(route) ?? route,
	section: navSection.get(route) ?? null,
	text: htmlToText(page.html ?? "").slice(0, 14000),
}));

const totalBytes = corpus.reduce((a, p) => a + p.text.length, 0);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `// GENERATED by scripts/build-huba-corpus.mjs — do not edit by hand.
// Rebuild after ANY docs edit; test/huba.spec.js pins the hash below to the
// current public/docs/index.html so a stale corpus fails CI.
export const HUBA_CORPUS_DOCS_HASH = ${JSON.stringify(docsHash)};
export const HUBA_CORPUS = ${JSON.stringify(corpus, null, "\t")};
`, "utf-8");
console.log(`wrote ${corpus.length} pages, ${(totalBytes / 1024).toFixed(0)} KB of text, docs hash ${docsHash.slice(0, 12)}…`);
