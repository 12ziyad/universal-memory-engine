#!/usr/bin/env node
/**
 * `antigravity-itsuki` — install, update, doctor, uninstall.
 *
 * Deliberately small: it configures the host, reports honestly, and gets out
 * of the way. It never prints a credential and never edits a directory it does
 * not own.
 */

import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { credentialsPath, detectHost, FLOORS, meetsFloor, pluginInstallDir, stateRoot } from "./config.js";
import { runDoctor } from "./doctor.js";
import { install, uninstall } from "./install.js";
import { protectStateTree } from "./statetree.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");

function version(): string {
	try {
		return JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
}

/** Masked prompt: the key is never echoed to the terminal. */
async function promptSecret(question: string): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
	const output = process.stdout as NodeJS.WriteStream & { _writeToOutput?: (s: string) => void };
	return await new Promise<string>((resolveAnswer) => {
		const originalWrite = (rl as unknown as { _writeToOutput?: (s: string) => void })._writeToOutput;
		(rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = function (chunk: string) {
			if (chunk.includes(question)) output.write?.(chunk);
			else output.write?.("*");
		};
		rl.question(question, (answer) => {
			(rl as unknown as { _writeToOutput?: (s: string) => void })._writeToOutput = originalWrite;
			rl.close();
			process.stdout.write("\n");
			resolveAnswer(answer.trim());
		});
	});
}

async function doInstall(argv: string[]): Promise<number> {
	const env = process.env;
	const host = detectHost(env);
	if (host.cliVersion && !meetsFloor(host.cliVersion, FLOORS.cli)) {
		console.error(
			`Antigravity CLI ${host.cliVersion} is below the supported floor ${FLOORS.cli}.\n` +
				"Stop hooks were unreachable before 1.1.10 and compaction could corrupt the transcript before 1.1.13.\n" +
				"Upgrade the CLI, then run this again.",
		);
		return 2;
	}
	const major = Number(process.versions.node.split(".")[0]);
	if (Number.isFinite(major) && major < FLOORS.node) {
		console.error(`Node ${FLOORS.node}+ is required (found ${process.versions.node}).`);
		return 2;
	}

	if (!env["ITSUKI_API_KEY"] && !argv.includes("--no-prompt")) {
		const protection = protectStateTree(stateRoot(env), env);
		if (!protection.verified) {
			console.error(
				`Refusing to store a credential on disk: this machine's state directory could not be verified as owner-only (${protection.detail}).\n` +
					"Export ITSUKI_API_KEY in the environment that starts Antigravity instead.",
			);
		} else {
			const key = await promptSecret("Itsuki API key (input hidden, leave blank to use the environment): ");
			if (key) {
				const path = credentialsPath(env);
				mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
				writeFileSync(path, JSON.stringify({ apiKey: key }, null, 2), { mode: 0o600 });
				protectStateTree(dirname(path), env);
				console.log(`Stored, owner-only, at ${path}`);
			}
		}
	}

	const bundleDir = join(packageRoot, "plugin");
	if (!existsSync(bundleDir)) {
		console.error(`Bundle missing at ${bundleDir}. This package is not installed correctly.`);
		return 1;
	}
	const outcome = install({
		bundleDir,
		scriptPath: join(packageRoot, "dist", "hook-entry.js"),
		version: version(),
		env,
	});
	if (!outcome.ok) {
		console.error(outcome.reason);
		return 1;
	}
	console.log(`Installed to ${outcome.dir} (${outcome.files} files).`);
	console.log("Restart Antigravity, then run: npx antigravity-itsuki doctor");
	return 0;
}

async function main(): Promise<number> {
	const [command = "help", ...argv] = process.argv.slice(2);
	switch (command) {
		case "install":
		case "update":
			return await doInstall(argv);
		case "doctor": {
			const report = runDoctor();
			console.log(report.lines.join("\n"));
			return report.healthy ? 0 : 1;
		}
		case "uninstall": {
			const outcome = uninstall({
				purge: argv.includes("--purge"),
				force: argv.includes("--force"),
			});
			if (!outcome.ok) {
				console.error(outcome.reason);
				return 1;
			}
			console.log(
				`Removed ${outcome.removed} file(s) from ${pluginInstallDir()}. ` +
					(outcome.preservedState
						? "Your queued memories and credential were preserved (use --purge to remove them)."
						: "State and credential removed."),
			);
			return 0;
		}
		default:
			console.log(
				[
					"antigravity-itsuki — Itsuki memory for Google Antigravity",
					"",
					"  install            install the plugin for the current user",
					"  update             reinstall in place, preserving state",
					"  doctor             report configuration, queue depth and held behaviour",
					"  uninstall          remove the plugin (add --purge to also remove state)",
					"",
					"The API key is read from ITSUKI_API_KEY, or from an owner-only file",
					"written by `install`. It is never printed.",
				].join("\n"),
			);
			return 0;
	}
}

main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((error) => {
		console.error(String(error));
		process.exitCode = 1;
	});
