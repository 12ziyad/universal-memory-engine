/**
 * Configuration resolution.
 *
 * OpenClaw hands each hook `event.context.pluginConfig` (and the entry
 * `api.pluginConfig`) — the operator-managed block under
 * `plugins.entries.itsuki.config`, validated against `openclaw.plugin.json`.
 *
 * The API key is accepted from the environment FIRST. A key in the config file
 * is honoured, because OpenClaw operators legitimately manage secrets there and
 * the manifest marks the field `sensitive`, but the environment wins so a
 * shared or exported config does not have to carry one at all.
 */

export const API_KEY_ENV = "ITSUKI_API_KEY";
export const BASE_URL_ENV = "ITSUKI_BASE_URL";
export const USER_ID_ENV = "ITSUKI_USER_ID";
export const STATE_DIR_ENV = "OPENCLAW_STATE_DIR";

export type Tenancy = "owner" | "per-sender";

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
	/** Where the key came from, for the doctor. Never the key itself. */
	apiKeySource: "environment" | "plugin config" | null;
	baseUrl: string;
	userId: string | undefined;
	tenancy: Tenancy;
	recall: RecallConfig;
	capture: CaptureConfig;
}

export const DEFAULTS = Object.freeze({
	baseUrl: "https://itsuki.app",
	tenancy: "owner" as Tenancy,
	recall: Object.freeze({ enabled: true, maxItems: 10, maxChars: 4_000, timeoutMs: 3_000 }),
	capture: Object.freeze({ enabled: true, timeoutMs: 10_000 }),
});

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

function trimmedString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function resolveConfig(
	pluginConfig: Record<string, unknown> | undefined,
	env: NodeJS.ProcessEnv = process.env,
): ItsukiConfig {
	const raw = pluginConfig ?? {};
	const recallRaw = (raw["recall"] ?? {}) as Record<string, unknown>;
	const captureRaw = (raw["capture"] ?? {}) as Record<string, unknown>;

	const envKey = trimmedString(env[API_KEY_ENV]);
	const configKey = trimmedString(raw["apiKey"]);
	const apiKey = envKey ?? configKey ?? null;
	const apiKeySource = envKey ? "environment" : configKey ? "plugin config" : null;

	const tenancyRaw = trimmedString(raw["tenancy"]);
	const tenancy: Tenancy = tenancyRaw === "per-sender" ? "per-sender" : DEFAULTS.tenancy;

	return {
		apiKey,
		apiKeySource,
		baseUrl: trimmedString(env[BASE_URL_ENV]) ?? trimmedString(raw["baseUrl"]) ?? DEFAULTS.baseUrl,
		userId: trimmedString(env[USER_ID_ENV]) ?? trimmedString(raw["userId"]),
		tenancy,
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
	};
}

/** The OpenClaw state root, per `OPENCLAW_STATE_DIR` (default `~/.openclaw`). */
export function stateRoot(env: NodeJS.ProcessEnv, homedir: () => string, join: (...p: string[]) => string): string {
	const configured = trimmedString(env[STATE_DIR_ENV]);
	return join(configured ?? join(homedir(), ".openclaw"), "itsuki");
}
