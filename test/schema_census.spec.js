/**
 * Schema census — the lifecycle classification gate.
 *
 * Parses every CREATE TABLE in migrations/*.sql and requires each table to be
 * explicitly classified in src/lib/lifecycle_census.js. A future table that
 * carries project_id / user_id / memory_user_id / source content / vectors /
 * project artifacts cannot ship until someone states, in code, what the
 * project purge, permanent delete, and archive passes must do with it.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CENSUS, PURGE_SPACE_TABLES } from "../src/lib/lifecycle_census.js";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

function allTables() {
	const tables = new Map();
	for (const file of readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort()) {
		const sql = readFileSync(join(DIR, file), "utf-8");
		const create = /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_]+)([\s\S]*?)(?:;|$)/gi;
		for (const match of sql.matchAll(create)) {
			const name = match[1];
			const body = match[2] ?? "";
			const existing = tables.get(name) ?? { name, columns: new Set(), files: [] };
			existing.files.push(file);
			for (const column of body.matchAll(/^\s*([a-z_]+)\s+(?:TEXT|INTEGER|REAL|BLOB)/gim)) {
				existing.columns.add(column[1]);
			}
			tables.set(name, existing);
		}
		const alter = /ALTER\s+TABLE\s+([a-z_]+)\s+ADD\s+COLUMN\s+([a-z_]+)/gi;
		for (const match of sql.matchAll(alter)) {
			const existing = tables.get(match[1]) ?? { name: match[1], columns: new Set(), files: [] };
			existing.columns.add(match[2]);
			tables.set(match[1], existing);
		}
	}
	return tables;
}

describe("lifecycle schema census", () => {
	const tables = allTables();

	it("finds a plausible number of tables (the parser is not silently broken)", () => {
		expect(tables.size).toBeGreaterThan(50);
		expect(tables.has("managed_projects")).toBe(true);
		expect(tables.has("source_packets")).toBe(true);
		expect(tables.has("project_lifecycle_runs")).toBe(true);
	});

	it("every table in every migration is classified in the lifecycle census", () => {
		const unclassified = [...tables.keys()].filter((name) => !CENSUS[name]);
		expect(
			unclassified,
			`Unclassified table(s): ${unclassified.join(", ")}. Add each to src/lib/lifecycle_census.js with explicit purge / projectDelete / archive behavior before shipping.`,
		).toEqual([]);
	});

	it("every census entry corresponds to a real table", () => {
		const phantom = Object.keys(CENSUS).filter((name) => !tables.has(name));
		expect(phantom, `Census names table(s) that no migration creates: ${phantom.join(", ")}`).toEqual([]);
	});

	it("tenant-content tables carry a lifecycle-relevant classification, not a shrug", () => {
		for (const [name, table] of tables) {
			const entry = CENSUS[name];
			if (!entry) continue; // reported precisely by the classification test
			const tenantish = table.columns.has("user_id")
				|| table.columns.has("memory_user_id")
				|| table.columns.has("project_id");
			if (!tenantish) continue;
			expect(
				["memory_space", "project", "account", "mechanism", "global"].includes(entry.kind),
				`${name} carries tenant columns but has kind=${entry.kind}`,
			).toBe(true);
			if (entry.kind === "memory_space") {
				expect(
					["delete", "minimize", "retain", "shadow"].includes(entry.purge),
					`${name} is memory_space-scoped but has no explicit purge behavior`,
				).toBe(true);
			}
		}
	});

	it("every purge-swept table exists and is classified delete", () => {
		for (const name of PURGE_SPACE_TABLES) {
			expect(tables.has(name), `${name} is swept but does not exist`).toBe(true);
			expect(CENSUS[name]?.purge).toBe("delete");
		}
	});

	it("the resurrection fences are never classified for deletion", () => {
		expect(CENSUS.deletion_barriers.purge).toBe("retain");
		expect(CENSUS.deletion_barriers.projectDelete).toBe("retain");
		expect(CENSUS.retention_fences.projectDelete).toBe("retain");
		expect(CENSUS.source_packets.purge).toBe("minimize");
		expect(CENSUS.project_tombstones.projectDelete).toBe("retain");
	});
});
