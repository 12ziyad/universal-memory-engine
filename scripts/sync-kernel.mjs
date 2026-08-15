#!/usr/bin/env node
/**
 * Copy the shared kernels into every package that vendors them.
 *
 * Vendoring is what keeps each published package at zero runtime dependencies
 * (the publish workflows enforce that by name) and keeps a Python package's
 * dependency list down to `itsuki` plus its host. The cost of vendoring is
 * drift, so this script is the only sanctioned way to move the files and
 * test/kernel-parity.spec.js proves nobody hand-edited a copy afterwards.
 *
 *   node scripts/sync-kernel.mjs           # write the copies
 *   node scripts/sync-kernel.mjs --check   # fail if any copy is stale
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

export const TS_KERNEL_DIR = join(repoRoot, "packages", "_kernel", "ts");
export const PY_KERNEL_DIR = join(repoRoot, "packages", "_kernel", "py");

/**
 * Who vendors what. The three adapters published before the kernel existed
 * (n8n, Pi, OpenClaw) are deliberately absent: they ship their own audited
 * copies and rewriting a published package to prove a point is not a
 * refactor, it is a risk.
 */
export const TS_CONSUMERS = ["ai-sdk-itsuki", "mastra-itsuki"];
export const PY_CONSUMERS = [
	{ pkg: "llama-index-memory-itsuki", module: join("llama_index", "memory", "itsuki") },
	{ pkg: "agno-itsuki", module: "agno_itsuki" },
	{ pkg: "camel-itsuki", module: "camel_itsuki" },
	{ pkg: "chatdev-itsuki", module: "chatdev_itsuki" },
];

const TS_BANNER = `// GENERATED FILE — do not edit here.
// Source: packages/_kernel/ts/%NAME%
// Regenerate: node scripts/sync-kernel.mjs
`;

const PY_BANNER = `# GENERATED FILE — do not edit here.
# Source: packages/_kernel/py/%NAME%
# Regenerate: node scripts/sync-kernel.mjs
`;

export function tsKernelFiles() {
	return readdirSync(TS_KERNEL_DIR).filter((name) => name.endsWith(".ts")).sort();
}

export function pyKernelFiles() {
	return readdirSync(PY_KERNEL_DIR).filter((name) => name.endsWith(".py")).sort();
}

export function expectedTs(name) {
	return TS_BANNER.replace("%NAME%", name) + readFileSync(join(TS_KERNEL_DIR, name), "utf8");
}

export function expectedPy(name) {
	return PY_BANNER.replace("%NAME%", name) + readFileSync(join(PY_KERNEL_DIR, name), "utf8");
}

export function tsDestination(pkg) {
	return join(repoRoot, "packages", pkg, "src", "kernel");
}

export function pyDestination(entry) {
	return join(repoRoot, "packages", entry.pkg, entry.module);
}

/** Every (target path, expected content) pair the kernels own. */
export function plannedCopies() {
	const planned = [];
	for (const pkg of TS_CONSUMERS) {
		if (!existsSync(join(repoRoot, "packages", pkg))) continue;
		for (const name of tsKernelFiles()) {
			planned.push({
				label: `${pkg}/src/kernel/${name}`,
				target: join(tsDestination(pkg), name),
				dir: tsDestination(pkg),
				content: expectedTs(name),
			});
		}
	}
	for (const entry of PY_CONSUMERS) {
		if (!existsSync(join(repoRoot, "packages", entry.pkg))) continue;
		for (const name of pyKernelFiles()) {
			planned.push({
				label: `${entry.pkg}/${entry.module.replace(/\\/g, "/")}/${name}`,
				target: join(pyDestination(entry), name),
				dir: pyDestination(entry),
				content: expectedPy(name),
			});
		}
	}
	return planned;
}

function main() {
	const check = process.argv.includes("--check");
	let stale = 0;
	let written = 0;

	for (const copy of plannedCopies()) {
		const actual = existsSync(copy.target) ? readFileSync(copy.target, "utf8") : null;
		if (actual === copy.content) continue;
		if (check) {
			stale += 1;
			console.error(`STALE  ${copy.label}`);
			continue;
		}
		mkdirSync(copy.dir, { recursive: true });
		writeFileSync(copy.target, copy.content, "utf8");
		written += 1;
		console.log(`wrote  ${copy.label}`);
	}

	if (check) {
		if (stale > 0) {
			console.error(`\n${stale} kernel copy/copies are stale. Run: node scripts/sync-kernel.mjs`);
			process.exit(1);
		}
		console.log("kernel copies are in sync");
		return;
	}
	console.log(written === 0 ? "kernel copies already in sync" : `synced ${written} file(s)`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
	main();
}
