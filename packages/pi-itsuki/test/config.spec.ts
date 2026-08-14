/**
 * Configuration, and the one rule that matters most about it: the API key
 * comes from the environment and nowhere else. A key in a JSON file the
 * adapter manages ends up in dotfile backups, screen shares and git.
 */

import { describe, expect, it } from "vitest";

import { API_KEY_ENV, DEFAULTS, loadConfig } from "../src/config.js";

const read = (files: Record<string, string>) => async (path: string) => {
	const normalized = path.replace(/\\/g, "/");
	for (const [name, contents] of Object.entries(files)) {
		if (normalized.endsWith(name)) return contents;
	}
	throw new Error("ENOENT");
};

describe("credentials", () => {
	it("reads the key from the environment", async () => {
		const config = await loadConfig({
			env: { [API_KEY_ENV]: "itsuki_live_abcdefghij" },
			searchPaths: [],
			readFileImpl: read({}),
		});
		expect(config.apiKey).toBe("itsuki_live_abcdefghij");
	});

	it("REFUSES a key placed in the config file, rather than honouring it", async () => {
		const config = await loadConfig({
			env: {},
			searchPaths: ["/data"],
			readFileImpl: read({ "itsuki.json": JSON.stringify({ apiKey: "itsuki_live_fromfile" }) }),
		});
		// Honouring it would teach people to keep credentials in a shareable file.
		expect(config.apiKey).toBeNull();
	});

	it("trims surrounding whitespace so a copy-paste newline does not break the header", async () => {
		const config = await loadConfig({
			env: { [API_KEY_ENV]: "  itsuki_live_abcdefghij \n" },
			searchPaths: [],
			readFileImpl: read({}),
		});
		expect(config.apiKey).toBe("itsuki_live_abcdefghij");
	});

	it("treats an empty key as absent", async () => {
		const config = await loadConfig({ env: { [API_KEY_ENV]: "   " }, searchPaths: [], readFileImpl: read({}) });
		expect(config.apiKey).toBeNull();
	});
});

describe("defaults and bounds", () => {
	it("is fully usable with no config file at all", async () => {
		const config = await loadConfig({ env: {}, searchPaths: ["/nowhere"], readFileImpl: read({}) });
		expect(config.baseUrl).toBe(DEFAULTS.baseUrl);
		expect(config.recall).toEqual(DEFAULTS.recall);
		expect(config.capture).toEqual(DEFAULTS.capture);
		expect(config.configSource).toBeNull();
	});

	it("clamps absurd values instead of trusting them", async () => {
		const config = await loadConfig({
			env: {},
			searchPaths: ["/data"],
			readFileImpl: read({
				"itsuki.json": JSON.stringify({
					recall: { maxItems: 10_000, maxChars: 10_000_000, timeoutMs: 1 },
					capture: { timeoutMs: 999_999 },
				}),
			}),
		});
		expect(config.recall.maxItems).toBeLessThanOrEqual(50);
		expect(config.recall.maxChars).toBeLessThanOrEqual(8_000);
		expect(config.recall.timeoutMs).toBeGreaterThanOrEqual(500);
		expect(config.capture.timeoutMs).toBeLessThanOrEqual(60_000);
	});

	it("allows recall or capture to be switched off", async () => {
		const config = await loadConfig({
			env: {},
			searchPaths: ["/data"],
			readFileImpl: read({ "itsuki.json": JSON.stringify({ recall: { enabled: false }, capture: { enabled: false } }) }),
		});
		expect(config.recall.enabled).toBe(false);
		expect(config.capture.enabled).toBe(false);
	});

	it("survives a corrupt config file by falling back to defaults", async () => {
		const config = await loadConfig({
			env: {},
			searchPaths: ["/data"],
			readFileImpl: read({ "itsuki.json": "{ not json" }),
		});
		expect(config.recall).toEqual(DEFAULTS.recall);
		expect(config.configSource).toBeNull();
	});
});

describe("scope", () => {
	it("takes a sub-tenant from the environment or the file, environment winning", async () => {
		const fromFile = await loadConfig({
			env: {},
			searchPaths: ["/data"],
			readFileImpl: read({ "itsuki.json": JSON.stringify({ userId: "from-file" }) }),
		});
		expect(fromFile.userId).toBe("from-file");

		const fromEnv = await loadConfig({
			env: { ITSUKI_USER_ID: "from-env" },
			searchPaths: ["/data"],
			readFileImpl: read({ "itsuki.json": JSON.stringify({ userId: "from-file" }) }),
		});
		expect(fromEnv.userId).toBe("from-env");
	});

	it("has no sub-tenant unless one is configured", async () => {
		const config = await loadConfig({ env: {}, searchPaths: [], readFileImpl: read({}) });
		expect(config.userId).toBeUndefined();
	});
});
