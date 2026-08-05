import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { posix, win32 } from "node:path";

export const CLAUDE_CODE_APP_ID = "claude-code-plugin";
export const PROJECT_SOURCE_SCOPE = "project";
export const PROJECT_RECALL_SCOPE = "project_then_global";

/** Claude's event `cwd` can change after a mid-session `cd`. Its documented
 * project-root environment variable is stable for the lifetime of the session,
 * so prefer it and use event cwd only as a compatibility fallback. */
export function claudeProjectDirectory(eventCwd, env = process.env) {
	const stableRoot = typeof env?.CLAUDE_PROJECT_DIR === "string" ? env.CLAUDE_PROJECT_DIR.trim() : "";
	if (stableRoot) return stableRoot;
	const cwd = typeof eventCwd === "string" ? eventCwd.trim() : "";
	return cwd || process.cwd();
}

function sha256(value) {
	return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function pathApiFor(platform) {
	return platform === "win32" ? win32 : posix;
}

/**
 * Resolve a local project without returning its path. The canonical path is
 * identity material only; callers receive an opaque ID and a basename for UI.
 */
export async function resolveProjectIdentity(cwd, options = {}) {
	const platform = options.platform ?? process.platform;
	const pathApi = pathApiFor(platform);
	const input = typeof cwd === "string" && cwd.trim() ? cwd.trim() : process.cwd();
	const absolute = pathApi.resolve(input);
	const projectName = pathApi.basename(pathApi.normalize(absolute)) || "project";
	const realpathFn = options.realpathFn ?? realpath;

	let canonicalPath;
	try {
		canonicalPath = await realpathFn(absolute);
	} catch {
		// A disappearing cwd must not break the host session. The absolute path is
		// still opaque-hashed and remains a deterministic best-effort identity.
		canonicalPath = absolute;
	}

	const displayPath = pathApi.normalize(String(canonicalPath));
	const identityPath = platform === "win32" ? displayPath.toLowerCase() : displayPath;
	const override = String(options.projectIdOverride ?? process.env.ITSUKI_PROJECT_ID ?? "").trim();

	return {
		projectId: override || `local_${sha256(`itsuki-project:v1\0${identityPath}`).slice(0, 32)}`,
		projectName,
	};
}

export function projectMemoryScope(identity) {
	return {
		projectId: identity.projectId,
		projectName: identity.projectName,
		appId: CLAUDE_CODE_APP_ID,
		sourceScope: PROJECT_SOURCE_SCOPE,
	};
}
