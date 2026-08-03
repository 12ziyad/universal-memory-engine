/**
 * Part 8.3 — migrations are append-only, mechanically.
 *
 * The 0005 drift trap: a migration was edited AFTER it had been applied
 * remotely, so local and production schemas diverged silently and the next
 * prod-only D1 error took a PRAGMA diff to explain. A hash file committed
 * beside the migrations turns that class of mistake into a failing test:
 * editing an applied migration changes its hash, and CI stops.
 *
 * To add a migration: write the new file, then run
 *     node scripts/update-migration-checksums.mjs
 * which appends the NEW file's hash. It refuses to rewrite an existing one.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const DIR = join(process.cwd(), "migrations");

function sha256OfMigration(file) {
	// Normalized line endings: a CRLF checkout must not read as tampering.
	const text = readFileSync(join(DIR, file), "utf-8").replace(/\r\n/g, "\n");
	return createHash("sha256").update(text, "utf-8").digest("hex");
}

describe("migrations are append-only", () => {
	const committed = JSON.parse(readFileSync(join(DIR, "CHECKSUMS.json"), "utf-8"));
	const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();

	it("every committed checksum still matches its file (nothing was edited after the fact)", () => {
		const drifted = [];
		for (const [file, hash] of Object.entries(committed)) {
			if (!files.includes(file)) {
				drifted.push(`${file}: DELETED — applied migrations must never be removed`);
				continue;
			}
			const actual = sha256OfMigration(file);
			if (actual !== hash) {
				drifted.push(`${file}: EDITED after being applied (${hash.slice(0, 12)} → ${actual.slice(0, 12)})`);
			}
		}
		expect(drifted).toEqual([]);
	});

	it("every migration file has a committed checksum (new ones must be registered)", () => {
		const unregistered = files.filter((f) => !(f in committed));
		expect(unregistered).toEqual([]);
	});

	it("migration numbers are unique and strictly increasing", () => {
		const numbers = files.map((f) => Number(f.slice(0, 4)));
		expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
		expect(new Set(numbers).size).toBe(numbers.length);
	});
});
