/**
 * The doctor: what is configured, what is queued, and what is HELD and why.
 *
 * It never prints the API key, and it never claims a capability it has not
 * verified. "Held" lines are first-class output, not footnotes.
 */

import { existsSync } from "node:fs";

import {
	appDataDirs,
	detectHost,
	FLOORS,
	meetsFloor,
	pluginInstallDir,
	resolveConfig,
	stateRoot,
} from "./config.js";
import { VERIFIED_SUCCESS_TERMINATIONS } from "./hook.js";
import { readMarker } from "./install.js";
import { Spool } from "./spool.js";
import { protectStateTree } from "./statetree.js";
import { VERIFIED_SCHEMAS } from "./transcript.js";

export interface DoctorReport {
	lines: string[];
	healthy: boolean;
	held: string[];
}

export function runDoctor(env: NodeJS.ProcessEnv = process.env): DoctorReport {
	const lines: string[] = [];
	const held: string[] = [];
	const config = resolveConfig(env);
	const host = detectHost(env);
	const root = stateRoot(env);
	const dir = pluginInstallDir(env);

	lines.push("Itsuki — Antigravity integration");
	lines.push("");

	// --- credential (never the value)
	lines.push(
		config.apiKey
			? `credential: present (from ${config.apiKeySource === "env" ? "the environment" : "the protected file"})`
			: "credential: MISSING",
	);

	// --- host
	lines.push(`antigravity CLI: ${host.cliOnPath ? (host.cliVersion ?? "present, version unreadable") : "not found on PATH"}`);
	if (host.cliVersion) {
		const ok = meetsFloor(host.cliVersion, FLOORS.cli);
		lines.push(`  supported floor ${FLOORS.cli}: ${ok ? "met" : "NOT MET"}`);
		if (!ok) {
			held.push(
				`CLI ${host.cliVersion} is below ${FLOORS.cli}. Stop hooks were unreachable before 1.1.10 and the transcript could be corrupted by compaction before 1.1.13, so automatic lifecycle behaviour is disabled.`,
			);
		}
	}
	if (host.desktopVersion && host.desktopProduct === "ide") {
		lines.push(`antigravity desktop: Antigravity IDE ${host.desktopVersion} detected (unsupported)`);
		held.push(
			`Antigravity IDE ${host.desktopVersion} is installed but is NOT supported. Google's IDE changelog never documents hooks and their execution there is unverified at any version, so lifecycle behaviour stays disabled rather than silently doing nothing. Use the Antigravity CLI (>= ${FLOORS.cli}).`,
		);
	} else {
		lines.push("antigravity desktop: not detected");
		held.push(
			`Desktop (Antigravity 2.0, floor ${FLOORS.desktop}) is HELD: no installation was found to verify hook firing or environment propagation against.`,
		);
	}

	// --- install
	const marker = existsSync(dir) ? readMarker(dir) : null;
	lines.push(`plugin directory: ${existsSync(dir) ? dir : "not installed"}`);
	if (marker) lines.push(`  installed version ${marker.version}, ${marker.files.length} files`);
	else if (existsSync(dir)) lines.push("  present but NOT installed by Itsuki (will not be modified)");

	// --- state
	const protection = protectStateTree(root, env);
	lines.push(`state directory: ${root}`);
	lines.push(`  protection: ${protection.mode} — ${protection.verified ? "verified" : "NOT VERIFIED"} (${protection.detail})`);
	if (!protection.verified) {
		held.push(
			`Local state could not be verified as owner-only (${protection.detail}). Storing a credential on disk is disabled; use ${"ITSUKI_API_KEY"} in the environment instead.`,
		);
	}
	const stats = new Spool(root).stats();
	lines.push(`queued for delivery: ${stats.depth}`);
	lines.push(`dropped (spool full): ${stats.dropped}`);
	lines.push(`quarantined: ${stats.quarantined}`);

	// --- lifecycle capability, honestly
	lines.push(`transcript roots watched: ${appDataDirs(env).length}`);
	if (VERIFIED_SCHEMAS.length === 0) {
		held.push(
			"Automatic capture is HELD: no verified transcript schema. Google does not publish the transcript entry format, and probe P7 (which would record a real fixture) needs a signed-in host. Until a fixture is captured and registered, an unrecognised transcript yields no automatic capture.",
		);
	}
	if (VERIFIED_SUCCESS_TERMINATIONS.length === 0) {
		held.push(
			"Automatic capture is HELD: no verified terminationReason. The documented list is explicitly non-exhaustive, so no value is treated as success until probe P8 observes the real ones.",
		);
	}

	for (const problem of config.problems) lines.push(`problem: ${problem}`);

	if (held.length > 0) {
		lines.push("");
		lines.push("HELD (deliberately inactive, not broken):");
		for (const item of held) lines.push(`  - ${item}`);
	}

	const healthy = Boolean(config.apiKey) && held.length === 0;
	return { lines, healthy, held };
}
