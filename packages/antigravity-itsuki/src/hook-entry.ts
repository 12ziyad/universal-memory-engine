#!/usr/bin/env node
/**
 * The executable Antigravity actually runs, once per hook event.
 *
 * Order matters and is the whole design: read, decide, STAGE LOCALLY, write the
 * response, flush, and only then attempt delivery. If the host kills us at its
 * timeout, everything that mattered is already durable on disk.
 */

import { drainAfterResponse, readStdin, runHook } from "./hook.js";

async function main(): Promise<void> {
	const event = process.argv[2] ?? "";
	let raw = "";
	try {
		raw = await readStdin(process.stdin);
	} catch {
		raw = "";
	}

	const { stdout } = await runHook(event, raw);

	// Answer first, and make sure it has actually left the process.
	await new Promise<void>((resolve) => {
		process.stdout.write(stdout, () => resolve());
	});

	// Best effort, bounded. Anything unfinished stays spooled.
	await drainAfterResponse();
}

main().catch(() => {
	// A hook must always answer. `Stop` in particular must never block the loop.
	const event = process.argv[2] ?? "";
	process.stdout.write(event === "Stop" ? JSON.stringify({ decision: "stop" }) : "{}");
});
