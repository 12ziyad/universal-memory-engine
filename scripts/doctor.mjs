/**
 * Itsuki doctor — the after-install connection check.
 *
 *     node scripts/doctor.mjs        (or /itsuki:doctor inside Claude Code)
 *
 * Four checks, each isolating one failure the hooks can only report tersely:
 * the key's shape, the network path, the REST door the hooks use, and the MCP
 * door the in-session tools use. Prints PASS/FAIL per check with the concrete
 * fix. Never prints the key. Exit 0 = everything works.
 */

const API_KEY = process.env.ITSUKI_API_KEY;
const BASE_URL = (process.env.ITSUKI_BASE_URL || "https://itsuki.app").replace(/\/+$/, "");
const TIMEOUT_MS = Number(process.env.ITSUKI_TIMEOUT_MS) > 0 ? Number(process.env.ITSUKI_TIMEOUT_MS) : 10000;

let failures = 0;
const pass = (name, detail) => console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
const fail = (name, detail, fix) => {
	failures += 1;
	console.log(`FAIL  ${name} — ${detail}`);
	if (fix) console.log(`      fix: ${fix}`);
};

async function timedFetch(url, init = {}) {
	const started = Date.now();
	const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
	return { res, ms: Date.now() - started };
}

function causeOf(error) {
	if (error?.name === "TimeoutError" || error?.name === "AbortError") return `no answer within ${TIMEOUT_MS / 1000}s`;
	return error?.cause?.code || error?.cause?.message || error?.message || String(error);
}

// ---- 1. the key itself, before it touches the network --------------------
if (!API_KEY) {
	fail("key", "ITSUKI_API_KEY is not set in this shell.",
		"Create a key at https://itsuki.app under API keys, set ITSUKI_API_KEY, restart your shell.");
} else if (!/^[!-~]+$/.test(API_KEY)) {
	fail("key", `set but not header-safe (length ${API_KEY.length} — contains control or non-ASCII characters, usually a paste that didn't paste).`,
		"Re-set ITSUKI_API_KEY with the real key. In cmd.exe use right-click to paste, not Ctrl-V.");
} else if (!/^(itsuki_live_|uml_live_)/.test(API_KEY)) {
	fail("key", `set and header-safe, but does not start with itsuki_live_ (length ${API_KEY.length}) — this is probably a placeholder, not a key.`,
		"Copy the real key from https://itsuki.app under API keys (shown once at creation).");
} else {
	pass("key", `header-safe, ${API_KEY.length} chars, prefix ${API_KEY.slice(0, 12)}…`);
}

// ---- 2. can we reach the host at all? ------------------------------------
let reachable = false;
try {
	const { res, ms } = await timedFetch(`${BASE_URL}/`, { method: "HEAD" });
	reachable = true;
	pass("network", `${BASE_URL} answered HTTP ${res.status} in ${ms}ms`);
} catch (error) {
	fail("network", `${BASE_URL} unreachable (${causeOf(error)})`,
		"DNS, VPN, proxy, or firewall. The two checks below will fail until this is fixed.");
}

// ---- 3. the REST door (what the session hooks call) ----------------------
if (API_KEY && /^[!-~]+$/.test(API_KEY) && reachable) {
	try {
		const { res, ms } = await timedFetch(`${BASE_URL}/v1/recall`, {
			method: "POST",
			headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
			body: JSON.stringify({ userId: "project:doctor", query: "connection check" }),
		});
		if (res.ok) pass("hooks door (/v1/recall)", `HTTP 200 in ${ms}ms — session-start/session-end will work`);
		else if (res.status === 401 || res.status === 403) {
			fail("hooks door (/v1/recall)", `HTTP ${res.status} — the server rejected this key.`,
				"The key is revoked or mistyped. Create a fresh one at https://itsuki.app under API keys.");
		} else fail("hooks door (/v1/recall)", `HTTP ${res.status}`, "Server-side problem — nothing to fix locally.");
	} catch (error) {
		fail("hooks door (/v1/recall)", causeOf(error));
	}
} else {
	console.log("SKIP  hooks door (/v1/recall) — blocked by an earlier failure");
}

// ---- 4. the MCP door (what the in-session memory tools use) --------------
if (API_KEY && /^[!-~]+$/.test(API_KEY) && reachable) {
	try {
		const { res, ms } = await timedFetch(`${BASE_URL}/mcp`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${API_KEY}`,
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0", id: 1, method: "initialize",
				params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "itsuki-doctor", version: "1" } },
			}),
		});
		const text = await res.text();
		if (res.ok && text.includes("serverInfo")) {
			pass("MCP door (/mcp)", `HTTP 200 in ${ms}ms — save_memory / recall_memory tools will work`);
		} else if (res.status === 401) {
			let message = "";
			try { message = JSON.parse(text)?.message ?? ""; } catch { /* SSE or non-JSON body */ }
			fail("MCP door (/mcp)", `HTTP 401${message ? ` — ${message}` : ""}`);
		} else fail("MCP door (/mcp)", `HTTP ${res.status}`, "Server-side problem — nothing to fix locally.");
	} catch (error) {
		fail("MCP door (/mcp)", causeOf(error));
	}
} else {
	console.log("SKIP  MCP door (/mcp) — blocked by an earlier failure");
}

console.log(failures === 0
	? "\nAll checks passed. Itsuki is fully connected."
	: `\n${failures} check(s) failed — fixes above, in order.`);
process.exit(failures === 0 ? 0 : 1);
