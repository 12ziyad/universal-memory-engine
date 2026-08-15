/**
 * The kernel copies must be exactly the kernel.
 *
 * Vendoring buys zero runtime dependencies at the cost of drift: the moment
 * someone fixes a bug in one package's copy of transport.ts and not the
 * others, the taxonomy, the retry budget or the redirect refusal quietly
 * differ per host. This suite is what makes that impossible to merge — it
 * fails the repository suite, not just the package's own.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";

import { plannedCopies, tsKernelFiles, pyKernelFiles } from "../scripts/sync-kernel.mjs";

describe("shared kernel", () => {
	it("ships the modules every adapter is entitled to", () => {
		expect(tsKernelFiles()).toEqual([
			"batching.ts",
			"errors.ts",
			"events.ts",
			"hash.ts",
			"idempotency.ts",
			"index.ts",
			"inject.ts",
			"memory.ts",
			"scrub.ts",
			"transport.ts",
			"types.ts",
		]);
		expect(pyKernelFiles()).toEqual(["_kernel.py"]);
	});

	it("has at least one consumer, or it is not a kernel", () => {
		expect(plannedCopies().length).toBeGreaterThan(0);
	});
});

describe("vendored copies", () => {
	for (const copy of plannedCopies()) {
		it(`${copy.label} is byte-identical to the kernel`, () => {
			expect(existsSync(copy.target)).toBe(true);
			expect(readFileSync(copy.target, "utf8")).toBe(copy.content);
		});
	}

	it("marks every copy as generated so nobody edits one by hand", () => {
		for (const copy of plannedCopies()) {
			const head = copy.content.slice(0, 200);
			expect(head).toContain("GENERATED FILE");
			expect(head).toContain("scripts/sync-kernel.mjs");
		}
	});
});

describe("kernel hygiene", () => {
	it("never hard-codes a credential-shaped string", () => {
		for (const copy of plannedCopies()) {
			// The scrub module names key PREFIXES on purpose; a real key would
			// have at least 8 more characters after the underscore.
			const matches = copy.content.match(/(itsuki|uml)_live_[A-Za-z0-9_-]{8,}/g) ?? [];
			expect(matches, `${copy.label} contains a credential-shaped string`).toEqual([]);
		}
	});

	it("keeps the TypeScript kernel free of Node built-ins so it runs on edge runtimes", () => {
		for (const copy of plannedCopies()) {
			if (!copy.label.endsWith(".ts")) continue;
			expect(copy.content, `${copy.label} imports a Node built-in`).not.toMatch(/from "node:/);
		}
	});
});
