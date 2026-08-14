/**
 * Configuration: environment first, then an optional JSON file.
 *
 * The API key is read ONLY from the environment (`ITSUKI_API_KEY`), which is
 * pi's documented convention for provider credentials. It is never read from,
 * nor written to, a config file the adapter manages — a key in a JSON file gets
 * copied into dotfiles, backups and screen shares. The config file carries
 * behaviour only, so it is safe to commit and safe to share.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_FILE_NAME = "itsuki.json";
export const API_KEY_ENV = "ITSUKI_API_KEY";
export const BASE_URL_ENV = "ITSUKI_BASE_URL";
export const USER_ID_ENV = "ITSUKI_USER_ID";

export interface RecallConfig {
	enabled: boolean;
	maxItems: number;
	maxChars: number;
	timeoutMs: number;
}

export interface CaptureConfig {
	enabled: boolean;
	timeoutMs: number;
}

export interface ItsukiConfig {
	apiKey: string | null;
	baseUrl: string;
	userId: string | undefined;
	recall: RecallConfig;
	capture: CaptureConfig;
	/** Where the spool and state live. */
	dataDir: string;
	/** Which file (if any) supplied non-default behaviour. */
	configSource: string | null;
}

export const DEFAULTS: Omit<ItsukiConfig, "apiKey" | "configSource" | "dataDir"> = Object.freeze({
	baseUrl: "https://itsuki.app",
	userId: undefined,
	recall: Object.freeze({ enabled: true, maxItems: 10, maxChars: 4_000, timeoutMs: 3_000 }),
	capture: Object.freeze({ enabled: true, timeoutMs: 10_000 }),
}) as Omit<ItsukiConfig, "apiKey" | "configSource" | "dataDir">;

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(Math.max(Math.round(n), min), max);
}

function asBoolean(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") return value;
	if (value === "true") return true;
	if (value === "false") return false;
	return fallback;
}

/** The adapter's own data directory, alongside pi's other agent state. */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
	const home = env["PI_AGENT_HOME"] ?? join(homedir(), ".pi", "agent");
	return join(home, "itsuki");
}

export interface LoadOptions {
	env?: NodeJS.ProcessEnv;
	/** Directories searched for itsuki.json, most specific last. */
	searchPaths?: string[];
	readFileImpl?: (path: string) => Promise<string>;
}

export async function loadConfig(options: LoadOptions = {}): Promise<ItsukiConfig> {
	const env = options.env ?? process.env;
	const read = options.readFileImpl ?? ((path: string) => readFile(path, "utf8"));

	let fileValues: Record<string, unknown> = {};
	let configSource: string | null = null;
	for (const dir of options.searchPaths ?? [defaultDataDir(env)]) {
		try {
			const parsed = JSON.parse(await read(join(dir, CONFIG_FILE_NAME))) as Record<string, unknown>;
			if (parsed && typeof parsed === "object") {
				fileValues = { ...fileValues, ...parsed };
				configSource = join(dir, CONFIG_FILE_NAME);
			}
		} catch {
			// Absent or unreadable config is not an error: defaults are complete.
		}
	}

	// A key in the config file is refused rather than honoured. Honouring it
	// would teach users to put credentials in a shareable file.
	if ("apiKey" in fileValues) delete fileValues["apiKey"];

	const recallRaw = (fileValues["recall"] ?? {}) as Record<string, unknown>;
	const captureRaw = (fileValues["capture"] ?? {}) as Record<string, unknown>;

	const rawKey = env[API_KEY_ENV];
	const apiKey = typeof rawKey === "string" && rawKey.trim() ? rawKey.trim() : null;
	const userIdRaw = env[USER_ID_ENV] ?? (fileValues["userId"] as string | undefined);
	const userId = typeof userIdRaw === "string" && userIdRaw.trim() ? userIdRaw.trim() : undefined;

	return {
		apiKey,
		baseUrl: String(env[BASE_URL_ENV] ?? fileValues["baseUrl"] ?? DEFAULTS.baseUrl),
		userId,
		recall: {
			enabled: asBoolean(recallRaw["enabled"], DEFAULTS.recall.enabled),
			maxItems: clampInt(recallRaw["maxItems"], 1, 50, DEFAULTS.recall.maxItems),
			maxChars: clampInt(recallRaw["maxChars"], 200, 8_000, DEFAULTS.recall.maxChars),
			timeoutMs: clampInt(recallRaw["timeoutMs"], 500, 15_000, DEFAULTS.recall.timeoutMs),
		},
		capture: {
			enabled: asBoolean(captureRaw["enabled"], DEFAULTS.capture.enabled),
			timeoutMs: clampInt(captureRaw["timeoutMs"], 1_000, 60_000, DEFAULTS.capture.timeoutMs),
		},
		dataDir: defaultDataDir(env),
		configSource,
	};
}
