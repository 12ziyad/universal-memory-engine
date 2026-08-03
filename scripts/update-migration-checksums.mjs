/**
 * Register NEW migrations in migrations/CHECKSUMS.json (Part 8.3).
 *
 *     node scripts/update-migration-checksums.mjs
 *
 * It appends hashes for files that have none. It deliberately REFUSES to
 * rewrite an existing hash: an applied migration that changed is the exact
 * drift this file exists to catch, and a script that papers over it would
 * make the guard decorative. Fix the migration back, or add a new one.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const FILE = join(DIR, "CHECKSUMS.json");

const hashOf = (name) =>
	createHash("sha256")
		.update(readFileSync(join(DIR, name), "utf-8").replace(/\r\n/g, "\n"), "utf-8")
		.digest("hex");

const committed = JSON.parse(readFileSync(FILE, "utf-8"));
const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();

const drifted = [];
const added = [];
for (const file of files) {
	const actual = hashOf(file);
	if (!(file in committed)) {
		committed[file] = actual;
		added.push(file);
	} else if (committed[file] !== actual) {
		drifted.push(file);
	}
}

if (drifted.length) {
	console.error("REFUSING to update: these applied migrations were edited after the fact:");
	for (const file of drifted) console.error(`  - ${file}`);
	console.error("\nNever edit an applied migration. Restore it and add a new one instead.");
	process.exit(1);
}

const ordered = Object.fromEntries(Object.keys(committed).sort().map((k) => [k, committed[k]]));
writeFileSync(FILE, `${JSON.stringify(ordered, null, 1)}\n`);
console.log(added.length ? `registered: ${added.join(", ")}` : "nothing new to register");
