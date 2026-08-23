/**
 * Credential-shape ban, extended to the provider campaign (the kernel-parity
 * precedent): no private-key material may exist in source, tests, fixtures,
 * or migrations. The Google auth module legitimately names the FIELD
 * "private_key" and builds the PEM header from parts at runtime; actual key
 * blocks are banned everywhere, including this spec's own fixtures (the
 * adapter spec GENERATES its throwaway key at runtime for exactly this
 * reason).
 */

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const SCAN_DIRS = ["src", "test", "eval", "evals", "migrations", "scripts"];
const SKIP_DIRS = new Set(["node_modules", "EasyLocomo", "results"]);
const KEY_BLOCK = /-----BEGIN (?:RSA )?PRIVATE KEY-----/;

async function walk(dir, out) {
	let entries;
	try {
		entries = await readdir(`${root}${dir}`, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (SKIP_DIRS.has(entry.name)) continue;
		const rel = `${dir}/${entry.name}`;
		if (entry.isDirectory()) await walk(rel, out);
		else if (/\.(js|mjs|json|sql|md|jsonc|txt)$/.test(entry.name)) out.push(rel);
	}
}

describe("credential scan", () => {
	it("quarantines the Workers test pool from developer and Google credentials", async () => {
		const config = JSON.parse(await readFile(`${root}test/wrangler.pool.jsonc`, "utf8"));
		const poolSource = await readFile(`${root}vitest.config.mjs`, "utf8");
		const testDirectoryEntries = await readdir(`${root}test`);
		expect(config.secrets).toEqual({ required: [] });
		expect(config.vars).toMatchObject({
			AI_ROUTING: "off",
			AI_ROUTING_KILL: "0",
		});
		for (const binding of [
			"API_KEY",
			"GOOGLE_CLIENT_ID",
			"GOOGLE_CLIENT_SECRET",
			"GCP_SERVICE_ACCOUNT",
			"GCP_PROJECT_ID",
		]) expect(config.vars).not.toHaveProperty(binding);
		expect(poolSource).toContain('configPath: "./test/wrangler.pool.jsonc"');
		expect(poolSource).toContain('API_KEY: "itsuki_test_only_not_a_secret"');
		expect(poolSource).toContain('GOOGLE_CLIENT_SECRET: "test-client-secret-not-a-secret"');
		expect(testDirectoryEntries.filter((name) => /^\.(?:dev\.vars|env)(?:\.|$)/.test(name))).toEqual([]);
	});

	it("no private-key block exists anywhere in the tree", async () => {
		const files = [];
		for (const dir of SCAN_DIRS) await walk(dir, files);
		expect(files.length).toBeGreaterThan(100);
		// Justified pattern/fixture references (each names its reason, mirroring
		// mutation_census's ALLOWLIST discipline). Anything else is an offense.
		const ALLOWLIST = new Set([
			"src/pipeline/scrub.js", // the secret scrubber DETECTS this pattern
			"test/scrub.spec.js", // scrubber fixtures prove key-shaped text is removed
			"test/scrub_classes.spec.js", // same
			"test/fixtures/security_corpus.mjs", // deliberate hostile-input corpus
			"test/google_adapter.spec.js", // builds a throwaway key AT RUNTIME; the header template matches
			"test/ai_credential_scan.spec.js",
		]);
		const offenders = [];
		for (const file of files) {
			if (ALLOWLIST.has(file)) continue;
			const text = await readFile(`${root}${file}`, "utf8").catch(() => "");
			if (KEY_BLOCK.test(text)) offenders.push(file);
		}
		expect(offenders).toEqual([]);
	});
});
