/**
 * Owner-only protection for the whole local state tree.
 *
 * Not just credentials: the spool holds conversation text, the watermarks
 * reveal session structure, and quarantine notes carry digests. On POSIX the
 * mode bits do the work. On Windows, mode bits are close to meaningless — the
 * only real control is an ACL — so we strip inheritance and grant the current
 * user alone, then VERIFY the result. A protection we cannot verify is not
 * claimed: the caller is told, and the frozen design holds the affected
 * feature rather than pretending.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, statSync } from "node:fs";

export type ProtectionMode = "posix" | "windows-dacl" | "unverified";

export interface ProtectionResult {
	mode: ProtectionMode;
	verified: boolean;
	detail: string;
}

function currentWindowsUser(env: NodeJS.ProcessEnv): string | null {
	const domain = env["USERDOMAIN"];
	const user = env["USERNAME"];
	if (!user) return null;
	return domain ? `${domain}\\${user}` : user;
}

/**
 * Create (if needed) and lock down the state root.
 * Never throws: a plugin that cannot secure its directory must still load and
 * report, rather than take the host session down.
 */
export function protectStateTree(root: string, env: NodeJS.ProcessEnv = process.env): ProtectionResult {
	try {
		mkdirSync(root, { recursive: true, mode: 0o700 });
	} catch (error) {
		return { mode: "unverified", verified: false, detail: `state directory unavailable: ${String(error)}` };
	}

	if (process.platform !== "win32") {
		try {
			chmodSync(root, 0o700);
			const mode = statSync(root).mode & 0o777;
			const verified = (mode & 0o077) === 0;
			return {
				mode: "posix",
				verified,
				detail: verified ? `mode ${mode.toString(8)}` : `mode ${mode.toString(8)} still grants group/other`,
			};
		} catch (error) {
			return { mode: "unverified", verified: false, detail: `chmod failed: ${String(error)}` };
		}
	}

	const account = currentWindowsUser(env);
	if (!account) {
		return { mode: "unverified", verified: false, detail: "USERNAME is not set; cannot build a DACL" };
	}
	try {
		// Break inheritance, then grant exactly one principal.
		execFileSync("icacls", [root, "/inheritance:r", "/grant:r", `${account}:(OI)(CI)F`], {
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 10_000,
		});
		const listing = execFileSync("icacls", [root], {
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 10_000,
			encoding: "utf8",
		});
		// Verify: the account appears, and no world-readable principal does.
		const lower = String(listing).toLowerCase();
		const grantsEveryone = lower.includes("everyone") || lower.includes("builtin\\users");
		const grantsUs = lower.includes(String(account).toLowerCase());
		const verified = grantsUs && !grantsEveryone;
		return {
			mode: "windows-dacl",
			verified,
			detail: verified
				? `DACL restricted to ${account}`
				: `DACL could not be verified as current-user-only for ${account}`,
		};
	} catch (error) {
		return { mode: "unverified", verified: false, detail: `icacls failed: ${String(error)}` };
	}
}
