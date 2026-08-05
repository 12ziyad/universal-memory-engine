/**
 * Protected, crash-recoverable local delivery for Claude lifecycle hooks.
 *
 * SessionEnd uses enqueueSession(), which has no network path. SessionStart
 * owns drainOutbox(). Raw envelopes are immutable; retry/binding state lives in
 * sidecars, and successful delivery replaces raw content with a body-free
 * tombstone.
 */

import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
	chmod,
	lstat,
	mkdir,
	open,
	opendir,
	readFile,
	realpath,
	rename,
	rmdir,
	stat,
	unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
	INGEST_CAPTURE_EVIDENCE_SCHEMA,
	INGEST_DELIVERY_SCHEMA,
	INGEST_LIMITS,
	normalizeCaptureEvidence,
	normalizeDeliveryMetadata,
	unicodeLength,
	utf8Length,
	validateIngestBody,
} from "../src/lib/ingest_contract.mjs";
import { normalizeSourceEvent } from "../src/lib/source_event.mjs";
import { scrubMessages, scrubText } from "../src/pipeline/scrub.js";
import {
	RECALL_ECHO_MAX_STORE_BYTES,
	RECALL_ECHO_STORE_FILENAME,
	RECALL_ECHO_STORE_SCHEMA,
	RECALL_ECHO_MAX_FINGERPRINTS,
	deriveRecallEchoCoverage,
	normalizeRecallEchoStore,
	recallEchoGuardForSession,
	recallEchoSessionKey,
	updateRecallEchoStore,
} from "./recall-echo.mjs";

export const OUTBOX_SCHEMA = "itsuki.outbox/v1";
export const TOMBSTONE_SCHEMA = "itsuki.outbox-tombstone/v1";
export const STATE_SCHEMA = "itsuki.outbox-state/v1";
export const STAGED_GROUP_SCHEMA = "itsuki.outbox-staged-group/v2";
const LEGACY_STAGED_GROUP_SCHEMA = "itsuki.outbox-staged-group/v1";
export const GROUP_MANIFEST_SCHEMA = "itsuki.outbox-group-manifest/v1";
const DELIVERY_SEQUENCE_SCHEMA = "itsuki.outbox-delivery-sequence/v1";
// Persisted plans pin the segmentation/batching implementation. A future
// implementation must keep a v1 reader/materializer until every v1 stage is
// terminal; changing this number in place would strand crash-left prefixes.
const MATERIALIZER_VERSION = 1;
export const OUTBOX_LIMITS = Object.freeze({
	maxEnvelopeBytes: 2 * 1024 * 1024,
	// A SessionEnd snapshot can legitimately approach the bounded 8 MiB tail
	// scan. It is spooled once, then expanded into wire-sized batches by the
	// longer-lived SessionStart hook. The extra headroom covers JSON metadata and
	// deterministic redaction placeholders without weakening the 64 MiB cap.
	maxStagedGroupBytes: 16 * 1024 * 1024,
	maxRawCount: 128,
	maxRawBytes: 64 * 1024 * 1024,
	// All enqueue paths retain one envelope slot/byte allowance. That reserve lets
	// SessionStart materialize a staged prefix and lets explicit key rebinding
	// copy-before-delete without ever exceeding the physical raw-data ceilings.
	materializationReserveEntries: 1,
	materializationReserveBytes: 16 * 1024 * 1024,
	doneRetentionMs: 7 * 24 * 60 * 60 * 1000,
	tmpRetentionMs: 24 * 60 * 60 * 1000,
	staleLockMs: 10 * 60 * 1000,
	maxDrainItems: 4,
	// SessionStart may have only 15 seconds in the host. Bound each pass by both
	// aggregate bytes and group count so several large snapshots cannot consume
	// the whole hook before any already-materialized batch reaches the network.
	maxMaterializationInputBytes: 8 * 1024 * 1024,
	maxMaterializationGroups: 4,
	drainBudgetMs: 3_500,
	requestTimeoutMs: 2_500,
});

const DIRECTORY_NAMES = [
	"tmp", "staged", "groups", "pending", "inflight", "accepted", "done", "failed", "state", "locks", "control",
];
const RAW_DIRECTORIES = ["pending", "inflight", "failed"];
const CAPACITY_DIRECTORIES = ["staged", ...RAW_DIRECTORIES];
const PROJECT_SCOPE_KEYS = new Set([
	"projectId", "projectName", "workspaceId", "appId", "agentId", "sessionId", "threadId", "topic", "sourceScope",
	"project_id", "project_name", "workspace_id", "app_id", "agent_id", "session_id", "thread_id", "source_scope",
]);
const TERMINAL_HTTP_ERRORS = new Set([400, 404, 409, 413, 422]);
const RETRY_HTTP_ERRORS = new Set([408, 425, 429]);
const AUTH_PAUSE_MS = 5 * 60 * 1000;
const CREDENTIAL_FINGERPRINT_RE = /^sha256:[a-f0-9]{64}$/;
const SECURITY_MARKER_SCHEMA = "itsuki.outbox-security/v1";
const SECURITY_MARKER_NAME = "security.json";
const SECURITY_VERIFICATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_MAINTENANCE_ENTRIES = 256;
const MAX_HEALTH_TOMBSTONES = 512;
export const DEFAULT_DELIVERY_BASE_URL = "https://itsuki.app";

export class OutboxError extends Error {
	constructor(code, message, options = {}) {
		super(message, options);
		this.name = "OutboxError";
		this.code = code;
	}
}

export class OutboxSecurityError extends OutboxError {
	constructor(message = "The local outbox could not be protected.", options = {}) {
		super("outbox_insecure", message, options);
		this.name = "OutboxSecurityError";
	}
}

export class OutboxCapacityError extends OutboxError {
	constructor(code, message) {
		super(code, message);
		this.name = "OutboxCapacityError";
	}
}

function sha256(value) {
	return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function canonicalValue(value) {
	if (Array.isArray(value)) return value.map(canonicalValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function canonicalJson(value) {
	return JSON.stringify(canonicalValue(value));
}

function headerSafeKey(key) {
	return typeof key === "string" && key.length > 0 && /^[!-~]+$/.test(key);
}

export function validItsukiApiKey(key) {
	return headerSafeKey(key) && /^(?:itsuki_live_|uml_live_)[A-Za-z0-9_-]{8,256}$/.test(key);
}

/** Canonicalize the credential destination without ever reflecting bad input. */
export function normalizeDeliveryBaseUrl(value = DEFAULT_DELIVERY_BASE_URL) {
	let parsed;
	try { parsed = new URL(String(value ?? "")); }
	catch { throw new OutboxError("invalid_base_url", "The configured memory service URL is invalid."); }
	if (parsed.username || parsed.password || parsed.search || parsed.hash) {
		throw new OutboxError("invalid_base_url", "The configured memory service URL must not contain credentials, a query, or a fragment.");
	}
	const localHttp = parsed.protocol === "http:"
		&& ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase());
	if (parsed.protocol !== "https:" && !localHttp) {
		throw new OutboxError("invalid_base_url", "The configured memory service URL must use HTTPS (except loopback development).");
	}
	return parsed.href.replace(/\/+$/, "");
}

/** A one-way key+origin binding marker. Neither value is written to disk. */
export function credentialFingerprint(apiKey, baseUrl = DEFAULT_DELIVERY_BASE_URL) {
	if (!validItsukiApiKey(apiKey)) return null;
	let destination;
	try { destination = normalizeDeliveryBaseUrl(baseUrl); }
	catch { return null; }
	return `sha256:${sha256(`itsuki-outbox-credential:v2\0${destination}\0${apiKey}`)}`;
}

function validCredentialFingerprint(value) {
	return value === null || CREDENTIAL_FINGERPRINT_RE.test(value ?? "");
}

function validQueueId(value) {
	return /^q_[a-f0-9]{40}$/.test(value ?? "");
}

function validLockToken(value) {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value ?? "");
}

function validFiniteTimestamp(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function safeErrorCode(value, fallback = "network_error") {
	const clean = safeIdentifier(value, 80);
	return clean && /^[A-Za-z0-9_.:-]+$/.test(clean) ? clean : fallback;
}

function safeIdentifier(value, maxLength = 240) {
	if (typeof value !== "string") return null;
	const clean = value.trim();
	return clean.length > 0 && clean.length <= maxLength && /^[!-~]+$/.test(clean) ? clean : null;
}

function serverIdentifier(value, prefix) {
	const clean = safeIdentifier(value, 64);
	const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
	return clean && new RegExp(`^${prefix}_${uuid}$`, "i").test(clean) ? clean : null;
}

function samePath(left, right, platform = process.platform) {
	const normalizedLeft = resolve(left);
	const normalizedRight = resolve(right);
	return platform === "win32"
		? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
		: normalizedLeft === normalizedRight;
}

/**
 * Refuse broad filesystem locations before creating or protecting anything.
 * The host owns pluginData, but a copied/malformed command must never turn a
 * filesystem root, home directory, or working tree into an outbox.
 */
function pathContains(root, target) {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function pathsRelated(left, right) {
	return pathContains(left, right) || pathContains(right, left);
}

function safePluginDataPath(value, { platform = process.platform, env = process.env } = {}) {
	if (typeof value !== "string" || !value.trim() || !isAbsolute(value) || value.includes("\0")) return null;
	const data = resolve(value.trim());
	if (platform === "win32" && data.startsWith("\\\\")) return null;
	const filesystemRoot = parse(data).root;
	const relativeParts = relative(filesystemRoot, data).split(/[\\/]+/).filter(Boolean);
	if (samePath(data, filesystemRoot, platform) || relativeParts.length < 2) return null;
	const homeLocation = homedir();
	if (homeLocation && isAbsolute(homeLocation) && pathContains(data, resolve(homeLocation))) return null;
	const reservedTrees = [
		env?.SystemRoot,
		env?.WINDIR,
		env?.ProgramFiles,
		env?.["ProgramFiles(x86)"],
		env?.ProgramData,
	]
		.filter((candidate) => typeof candidate === "string" && candidate && isAbsolute(candidate));
	if (reservedTrees.some((candidate) => pathsRelated(data, resolve(candidate)))) return null;
	return data;
}

function documentedPluginDataPath(value, env = process.env) {
	const data = safePluginDataPath(value, { env });
	if (!data) return null;
	const configRoot = resolve(env?.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"));
	const expectedParent = join(configRoot, "plugins", "data");
	const id = basename(data);
	if (!/^[A-Za-z0-9._-]{1,200}$/.test(id) || id === "." || id === "..") return null;
	return samePath(dirname(data), expectedParent) ? data : null;
}

/** Resolve only an explicitly supplied Claude plugin-data directory. */
export function pluginDataFromArgs(argv = process.argv.slice(2), env = process.env) {
	let explicit = null;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = String(argv[index] ?? "");
		if (arg === "--plugin-data") {
			explicit = argv[index + 1];
			break;
		}
		if (arg.startsWith("--plugin-data=")) {
			explicit = arg.slice("--plugin-data=".length);
			break;
		}
	}
	if (!explicit && argv.length === 1 && !String(argv[0]).startsWith("-")) explicit = argv[0];
	const fromArgs = explicit ? documentedPluginDataPath(explicit, env) : null;
	const fromEnvironment = env?.CLAUDE_PLUGIN_DATA
		? documentedPluginDataPath(env.CLAUDE_PLUGIN_DATA, env)
		: null;
	if (explicit && (!fromArgs || (env?.CLAUDE_PLUGIN_DATA && (!fromEnvironment || !samePath(fromArgs, fromEnvironment))))) {
		return null;
	}
	return fromArgs ?? fromEnvironment;
}

function pathsFor(pluginData, platform = process.platform) {
	const data = safePluginDataPath(pluginData, { platform });
	if (!data) {
		throw new OutboxSecurityError("Claude did not provide a safe, dedicated plugin-data directory.");
	}
	const root = join(data, "outbox", "v1");
	return {
		pluginData: data,
		root,
		...Object.fromEntries(DIRECTORY_NAMES.map((name) => [name, join(root, name)])),
	};
}

function isWithin(root, target) {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function pathKind(path) {
	try { return await lstat(path); }
	catch (error) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
}

async function ensurePlainDirectory(path, { platform, create = true, protect = true } = {}) {
	let info = await pathKind(path);
	if (!info && create) {
		await mkdir(path, { mode: 0o700 }).catch((error) => {
			if (error?.code !== "EEXIST") throw error;
		});
		info = await lstat(path);
	}
	if (!info?.isDirectory() || info.isSymbolicLink()) {
		throw new OutboxSecurityError("The local outbox contains a symlink, junction, or non-directory entry.");
	}
	if (protect && platform !== "win32") {
		await chmod(path, 0o700);
		const verified = await stat(path);
		if ((verified.mode & 0o077) !== 0) throw new OutboxSecurityError("The local outbox directory is not private.");
	}
}

function securityMarkerPath(paths) {
	return join(paths.control, SECURITY_MARKER_NAME);
}

async function directoryIdentity(paths) {
	const targets = {
		pluginData: paths.pluginData,
		outbox: join(paths.pluginData, "outbox"),
		root: paths.root,
		...Object.fromEntries(DIRECTORY_NAMES.map((name) => [name, paths[name]])),
	};
	const identity = {};
	for (const [name, path] of Object.entries(targets)) {
		const info = await lstat(path);
		if (!info.isDirectory() || info.isSymbolicLink()) throw new OutboxSecurityError();
		identity[name] = { dev: String(info.dev), ino: String(info.ino) };
	}
	return identity;
}

async function readValidSecurityMarker(paths) {
	const markerPath = securityMarkerPath(paths);
	const info = await pathKind(markerPath);
	if (!info) return null;
	if (!info.isFile() || info.isSymbolicLink()) throw new OutboxSecurityError("The outbox security marker is not a regular file.");
	const marker = await readJson(markerPath);
	if (
		marker?.schema !== SECURITY_MARKER_SCHEMA
		|| marker.path_sha256 !== sha256(resolve(paths.pluginData).toLowerCase())
		|| !SECURITY_VERIFICATION_ID_RE.test(marker.verification_id ?? "")
		|| typeof marker.guard_trusted !== "boolean"
		|| !Number.isSafeInteger(marker.verified_at)
		|| marker.verified_at < 1
		|| !marker.directories
	) return null;
	const current = await directoryIdentity(paths);
	return canonicalJson(current) === canonicalJson(marker.directories) ? marker : null;
}

async function writeSecurityMarker(paths, platform, attestation = {}) {
	const marker = {
		schema: SECURITY_MARKER_SCHEMA,
		path_sha256: sha256(resolve(paths.pluginData).toLowerCase()),
		directories: await directoryIdentity(paths),
		verification_id: randomUUID(),
		guard_trusted: attestation.guard_trusted !== false,
		verified_at: Date.now(),
	};
	try {
		await atomicJson(paths, platform, securityMarkerPath(paths), marker);
		return marker;
	} catch (error) {
		// Two first-use hooks may finish the same idempotent ACL verification
		// together. A concurrently durable marker for these exact directories is
		// equivalent to our write; any other failure still fails closed.
		const concurrent = await readValidSecurityMarker(paths).catch(() => null);
		if (!concurrent) throw error;
		return concurrent;
	}
}

function runWindowsSecurityHelper(command, args, { env, timeout }) {
	return new Promise((resolvePromise) => {
		const child = spawn(command, args, {
			windowsHide: true,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let spawnError = null;
		let timedOut = false;
		let outputOverflow = false;
		const append = (current, chunk) => {
			const next = current + String(chunk ?? "");
			if (Buffer.byteLength(next, "utf8") > 4_096) {
				outputOverflow = true;
				child.kill();
				return current;
			}
			return next;
		};
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
		child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
		child.once("error", (error) => { spawnError = error; });
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, timeout);
		child.once("close", (status, signal) => {
			clearTimeout(timer);
			resolvePromise({
				status,
				signal,
				stdout,
				stderr,
				error: outputOverflow
					? { code: "EOVERFLOW" }
					: timedOut
						? { code: "ETIMEDOUT" }
						: spawnError,
			});
		});
	});
}

async function defaultWindowsSecurityRunner(root, mode) {
	const helper = fileURLToPath(new URL("./outbox-security.ps1", import.meta.url));
	const systemRoot = resolve(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows");
	const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	const result = await runWindowsSecurityHelper(powershell, [
		"-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
		"-File", helper, "-Path", root, "-Mode", mode,
	], {
		env: {
			SystemRoot: systemRoot,
			WINDIR: systemRoot,
			TEMP: process.env.TEMP,
			TMP: process.env.TMP,
		},
		timeout: mode === "EnsureDirectories" ? 1_200 : 8_000,
	});
	const parsed = verifiedWindowsSecurityAttestation(result);
	if (!parsed) throw new OutboxSecurityError("Windows did not verify the private outbox ACL.");
	return parsed;
}

/** Validate the ACL helper's final, content-free post-verification record. */
export function verifiedWindowsSecurityAttestation(result) {
	let parsed;
	try { parsed = JSON.parse(String(result.stdout ?? "").trim()); } catch {}
	// On Windows, the bounded child can reach its timer a few milliseconds after
	// helper has already emitted its final attestation and is entering `exit 0`.
	// Accept only that exact boundary race; a killed helper without the complete
	// post-verification JSON, any other signal/error, or a non-zero exit fails.
	const verifiedExit = result.status === 0 || (
		result.status === null
		&& result.signal === "SIGTERM"
		&& result.error?.code === "ETIMEDOUT"
	);
	return verifiedExit
		&& parsed?.ok === true
		&& parsed?.protected === true
		&& typeof parsed?.guard_trusted === "boolean"
		? parsed
		: null;
}

async function ensureOutbox(pluginData, options = {}) {
	const platform = options.platform ?? process.platform;
	const paths = pathsFor(pluginData, platform);
	// Claude creates the plugin-data directory. Resolve it before creating or
	// protecting anything so a symlink/junction cannot redirect the operation.
	await ensurePlainDirectory(paths.pluginData, { platform, create: false, protect: false });
	const canonicalData = await realpath(paths.pluginData).catch(() => null);
	if (!canonicalData) throw new OutboxSecurityError("Claude's plugin-data directory could not be resolved safely.");
	const expectedData = resolve(paths.pluginData);
	const resolvedData = resolve(canonicalData);
	const sameData = platform === "win32"
		? resolvedData.toLowerCase() === expectedData.toLowerCase()
		: resolvedData === expectedData;
	if (!sameData) {
		throw new OutboxSecurityError("Claude's plugin-data directory resolves through a symlink or junction.");
	}
	// Shared ancestors are host-owned. Privacy begins at the dedicated v1 root;
	// never rewrite ACLs or modes on pluginData or an unrelated outbox sibling.
	await ensurePlainDirectory(join(paths.pluginData, "outbox"), { platform, protect: false });
	await ensurePlainDirectory(paths.root, { platform });
	for (const name of DIRECTORY_NAMES) await ensurePlainDirectory(paths[name], { platform });

	let securityMarker = null;
	if (platform === "win32") {
		const runner = options.securityRunner ?? defaultWindowsSecurityRunner;
		const initialMarker = await readValidSecurityMarker(paths);
		const requireFresh = options.requireFreshSecurity === true;
		const fastVerified = options.securityMode !== "all" && !requireFresh && Boolean(initialMarker);
		securityMarker = initialMarker;
		if (!fastVerified) {
			// Serialize first-use DACL mutation. Concurrent hooks may create the
			// directory tree together, but two Set-Acl passes must not race.
			const release = await acquireLock(paths, "security.lock", {
				waitMs: options.securityMode === "all" ? 8_000 : 1_300,
				// Must exceed the longest 8s helper plus marker fsync; otherwise a
				// live cross-process EnsureAll verifier could be reaped mid-Set-Acl.
				staleMs: 12_000,
			});
			if (!release) {
				const concurrent = await readValidSecurityMarker(paths).catch(() => null);
				const acceptable = concurrent && (!requireFresh || concurrent.verification_id !== initialMarker?.verification_id);
				if (!acceptable) {
					throw new OutboxSecurityError("The outbox security verifier is busy.");
				}
				securityMarker = concurrent;
			} else {
				try {
					const concurrent = await readValidSecurityMarker(paths).catch(() => null);
					const siblingFresh = requireFresh
						&& concurrent
						&& concurrent.verification_id !== initialMarker?.verification_id;
					if (options.securityMode === "all" || (!siblingFresh && (requireFresh || !concurrent))) {
						let attestation;
						try {
							attestation = await runner(paths.root, options.securityMode === "all" ? "EnsureAll" : "EnsureDirectories");
						} catch (error) {
							throw error;
						}
						securityMarker = await writeSecurityMarker(paths, platform, attestation);
					} else {
						securityMarker = concurrent;
					}
				} finally {
					await release();
				}
			}
		}
	} else {
		for (const name of DIRECTORY_NAMES) await ensurePlainDirectory(paths[name], { platform });
	}
	return {
		paths,
		platform,
		security: {
			guardTrusted: platform !== "win32" || securityMarker?.guard_trusted === true,
			verificationId: securityMarker?.verification_id ?? null,
		},
	};
}

/** Start the bounded directory-only protection pass used by SessionEnd. */
export async function prepareProtectedOutbox({
	pluginData,
	platform,
	securityRunner,
} = {}) {
	const opened = await ensureOutbox(pluginData, {
		platform,
		securityRunner,
		securityMode: "directories",
		requireFreshSecurity: true,
	});
	return { protected: true, guardTrusted: opened.security.guardTrusted };
}

async function safeEntries(directory, root, { maxEntries = Infinity, rejectOverflow = false } = {}) {
	const result = [];
	let directoryHandle;
	try { directoryHandle = await opendir(directory); }
	catch (error) {
		if (error?.code === "ENOENT") return result;
		throw error;
	}
	let seen = 0;
	for await (const directoryEntry of directoryHandle) {
		seen += 1;
		if (seen > maxEntries) {
			result.truncated = true;
			if (rejectOverflow) {
				throw new OutboxCapacityError("outbox_count_full", "The protected local outbox contains too many raw entries.");
			}
			break;
		}
		const name = directoryEntry.name;
		const path = join(directory, name);
		if (!isWithin(root, path)) throw new OutboxSecurityError();
		const info = await lstat(path);
		if (info.isSymbolicLink()) throw new OutboxSecurityError("The local outbox contains a symlink or junction.");
		result.push({ name, path, info });
	}
	return result;
}

async function syncDirectory(path, platform) {
	if (platform === "win32") return;
	let handle;
	try {
		handle = await open(path, "r");
		await handle.sync();
	} finally {
		await handle?.close().catch(() => {});
	}
}

async function syncFile(path) {
	let handle;
	try {
		// Windows requires a write-capable handle for FlushFileBuffers/fsync.
		handle = await open(path, "r+");
		await handle.sync();
	} finally {
		await handle?.close().catch(() => {});
	}
}

async function atomicJson(paths, platform, destination, value, { exclusive = false, serialized = null } = {}) {
	if (!isWithin(paths.root, destination)) throw new OutboxSecurityError();
	const bytes = Buffer.isBuffer(serialized) ? serialized : Buffer.from(canonicalJson(value), "utf8");
	const temporary = join(paths.tmp, `${randomUUID()}.tmp`);
	let handle;
	try {
		handle = await open(temporary, "wx", 0o600);
		await handle.writeFile(bytes);
		if (platform !== "win32") await handle.chmod(0o600);
		await handle.sync();
	} finally {
		await handle?.close().catch(() => {});
	}
	try {
		if (exclusive && await pathKind(destination)) throw Object.assign(new Error("destination exists"), { code: "EEXIST" });
		await rename(temporary, destination);
		// On Windows this supplies the closest available FlushFileBuffers barrier
		// after the metadata rename; raw content is never deleted before it.
		await syncFile(destination);
		await syncDirectory(dirname(destination), platform);
		await syncDirectory(paths.root, platform);
	} catch (error) {
		await unlink(temporary).catch(() => {});
		throw error;
	}
	return bytes.length;
}

function recallEchoStorePath(paths) {
	const target = join(paths.control, RECALL_ECHO_STORE_FILENAME);
	if (!isWithin(paths.root, target)) throw new OutboxSecurityError();
	return target;
}

async function readRecallEchoStore(paths) {
	const target = recallEchoStorePath(paths);
	const info = await pathKind(target);
	if (!info) return { schema: RECALL_ECHO_STORE_SCHEMA, sessions: [] };
	if (!info.isFile() || info.isSymbolicLink() || info.size > RECALL_ECHO_MAX_STORE_BYTES) {
		throw new OutboxSecurityError("The protected recall-echo sidecar is invalid.");
	}
	const value = normalizeRecallEchoStore(await readJson(target));
	if (!value) throw new OutboxSecurityError("The protected recall-echo sidecar is corrupt.");
	return value;
}

/**
 * Persist an explicit, content-free recall guard. Raw recalled text is consumed
 * transiently by the hashing helper and never enters a JSON value. A resumed
 * session may update an existing guard, but only a proven fresh startup may
 * create one from absence.
 */
export async function persistRecallEchoGuard({
	pluginData,
	sessionId,
	context,
	allowCreate = false,
	platform,
	securityRunner,
} = {}) {
	const sessionKey = recallEchoSessionKey(sessionId);
	const coverage = deriveRecallEchoCoverage(context, { sessionKey });
	if (!sessionKey) {
		return { persisted: false, status: "missing", coverageComplete: false, fingerprintCount: 0, reason: "invalid_session" };
	}
	const opened = await ensureOutbox(pluginData, { platform, securityRunner });
	const release = await acquireMutationLock(opened.paths, 250);
	if (!release) throw new OutboxSecurityError("The protected recall-echo sidecar is busy.");
	try {
		const current = await readRecallEchoStore(opened.paths);
		const previous = recallEchoGuardForSession(current, sessionId);
		if (previous.status === "missing" && allowCreate !== true) {
			return { persisted: false, status: "missing", coverageComplete: false, fingerprintCount: 0, reason: "missing_guard" };
		}

		let coverageComplete = coverage.complete;
		let reason = coverage.reason;
		let status = coverage.complete && coverage.fingerprints.length > 0 ? "armed" : "no_context";
		let fingerprints = coverage.complete ? coverage.fingerprints : [];
		if (previous.status === "armed" && status === "armed") {
			const union = [...new Set([...previous.fingerprints, ...fingerprints])];
			if (union.length > RECALL_ECHO_MAX_FINGERPRINTS) {
				coverageComplete = false;
				reason = "fingerprint_limit";
				status = "no_context";
				fingerprints = [];
			}
		}

		const next = updateRecallEchoStore(current, { sessionId, status, fingerprints });
		const serialized = Buffer.from(canonicalJson(next), "utf8");
		if (serialized.length > RECALL_ECHO_MAX_STORE_BYTES) {
			throw new OutboxCapacityError("recall_echo_full", "The protected recall-echo sidecar reached its size bound.");
		}
		await atomicJson(
			opened.paths,
			opened.platform,
			recallEchoStorePath(opened.paths),
			next,
			{ serialized },
		);
		const persistedGuard = recallEchoGuardForSession(next, sessionId);
		return {
			persisted: persistedGuard.status !== "missing",
			status: persistedGuard.status,
			coverageComplete,
			fingerprintCount: persistedGuard.fingerprints.length,
			reason,
		};
	} finally {
		await release();
	}
}

/** Read one session's explicit guard without exposing any other session key. */
export async function readRecallEchoGuard({
	pluginData,
	sessionId,
	platform,
	securityRunner,
} = {}) {
	if (!recallEchoSessionKey(sessionId)) return { status: "missing", fingerprints: [] };
	// Absence is an explicit fail-closed state. If a file exists, verify the full
	// protected root before reading any byte from it.
	const preliminary = pathsFor(pluginData, platform ?? process.platform);
	if (!await pathKind(recallEchoStorePath(preliminary))) return { status: "missing", fingerprints: [] };
	const opened = await ensureOutbox(pluginData, { platform, securityRunner });
	return recallEchoGuardForSession(await readRecallEchoStore(opened.paths), sessionId);
}

const SAFE_DERIVED_PROJECT_ID_RE = /^local_[a-f0-9]{32}$/;

/** Keep both hook doors on exactly the same scrubbed scope identity. */
export function sanitizeMemoryScope(scope) {
	if (!scope || typeof scope !== "object" || Array.isArray(scope)) return {};
	const out = {};
	for (const [key, value] of Object.entries(scope)) {
		if (!PROJECT_SCOPE_KEYS.has(key)) continue;
		if (!["string", "number", "boolean"].includes(typeof value)) continue;
		const normalizedFull = typeof value === "string"
			? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim()
			: null;
		let clean = normalizedFull === null ? value : normalizedFull.slice(0, 200);
		if (typeof clean === "string") {
			const trustedDerivedId = (key === "projectId" || key === "project_id")
				&& SAFE_DERIVED_PROJECT_ID_RE.test(clean);
			if (!trustedDerivedId) {
				const scrubbed = scrubText(clean);
				if (scrubbed.text !== clean) {
					const identityField = /(?:Id|_id)$/.test(key);
					clean = identityField
						? `opaque_${sha256(`itsuki-scope:v1\0${key}\0${normalizedFull}`).slice(0, 32)}`
						: scrubbed.text.slice(0, 200);
				}
			}
		}
		if (clean !== "") out[key] = clean;
	}
	return out;
}

function cleanMessage(message, index, sessionHash) {
	const rawId = String(message?.id ?? "");
	const sourceEvent = normalizeSourceEvent(message?.source_event ?? message?.sourceEvent);
	return {
		id: !rawId.trim()
			? `msg_${sha256(`itsuki-message-id:v1\0missing\0${sessionHash}\0${index}`).slice(0, 48)}`
			: (rawId.length <= 200 ? rawId : `msg_${sha256(`itsuki-message-id:v1\0${rawId}`).slice(0, 48)}`),
		role: message?.role === "assistant" ? "assistant" : "user",
		content: String(message?.content ?? ""),
		...(Number.isFinite(Number(message?.ts)) ? { ts: Number(message.ts) } : {}),
		...(sourceEvent ? { source_event: sourceEvent } : {}),
	};
}

function messageDigestSeed(message) {
	return {
		id: message.id,
		role: message.role,
		ts: message.ts ?? null,
		content_sha256: sha256(message.content),
		...(message.source_event ? { source_event: message.source_event } : {}),
	};
}

// Persisted v1 staged groups and their materialized request identities predate
// source_event metadata. Keep this exact historical digest shape until every
// protected v1 group has reached a terminal state.
function legacyMessageDigestSeed(message) {
	return {
		id: message.id,
		role: message.role,
		ts: message.ts ?? null,
		content_sha256: sha256(message.content),
	};
}

function sessionIdentity(sessionId) {
	const raw = String(sessionId ?? "session");
	return {
		sessionHash: sha256(`claude-session:v1\0${raw}`),
		conversationId: `claude_session_v1_${sha256(raw).slice(0, 32)}`,
	};
}

function envelopeSeed({ sessionHash, memoryScope, messages }) {
	return {
		session: sessionHash,
		project: memoryScope?.projectId ?? memoryScope?.project_id ?? null,
		messages: messages.map(messageDigestSeed),
	};
}

function legacyEnvelopeSeed({ sessionHash, memoryScope, messages, capture }) {
	return {
		session: sessionHash,
		project: memoryScope?.projectId ?? memoryScope?.project_id ?? null,
		capture,
		messages: messages.map(legacyMessageDigestSeed),
	};
}

const CAPTURE_REDACTION_KEYS = new Set([
	"private_key",
	"connection_credentials",
	"query_secret",
	"api_key",
	"bearer_token",
	"high_entropy",
	"named_secret",
]);
const MAX_CAPTURE_EVIDENCE_COUNTER = 64 * 1024 * 1024;

function captureCounter(value) {
	return Number.isSafeInteger(value) && value >= 0 && value <= MAX_CAPTURE_EVIDENCE_COUNTER ? value : 0;
}

function captureEvidenceSummary(metadata) {
	const capture = metadata?.capture;
	if (!capture || capture.schema !== "itsuki.claude-capture/v1") return null;
	const capturedEvents = captureCounter(capture.capturedEvents);
	const returnedEvents = capture.returnedEvents == null
		? capturedEvents
		: Math.min(capturedEvents, captureCounter(capture.returnedEvents));
	const redactions = {};
	for (const [key, value] of Object.entries(capture.redactions ?? {})) {
		const count = captureCounter(value);
		if (CAPTURE_REDACTION_KEYS.has(key) && count > 0) redactions[key] = count;
	}
	return normalizeCaptureEvidence({
		schema: INGEST_CAPTURE_EVIDENCE_SCHEMA,
		inputRows: captureCounter(capture.inputRows),
		capturedEvents,
		returnedEvents,
		omittedEvents: capturedEvents - returnedEvents,
		malformedRows: Math.min(captureCounter(capture.malformedRows), captureCounter(capture.inputRows)),
		ineligibleRows: captureCounter(capture.ineligibleRows),
		ignoredThinkingBlocks: captureCounter(capture.ignoredThinkingBlocks),
		ignoredMetaRows: captureCounter(capture.ignoredMetaRows),
		ignoredToolEvents: captureCounter(capture.ignoredToolEvents),
		ignoredRecallEvents: captureCounter(capture.ignoredRecallEvents),
		ignoredRecallEchoEvents: captureCounter(capture.ignoredRecallEchoEvents),
		ignoredUnprotectedAssistantEvents: captureCounter(capture.ignoredUnprotectedAssistantEvents),
		ignoredNoiseEvents: captureCounter(capture.ignoredNoiseEvents),
		ambiguousOutcomeRows: captureCounter(metadata?.ambiguousOutcomeRows),
		companionLimitRejectedOutcomeRows: captureCounter(metadata?.companionLimitRejectedOutcomeRows),
		closureEventLimitRejectedOutcomeRows: captureCounter(metadata?.closureEventLimitRejectedOutcomeRows),
		truncatedEvents: captureCounter(capture.truncatedEvents),
		redactions,
		tailReturnedRecords: captureCounter(metadata?.returnedRows ?? metadata?.returnedEvents),
		tailScannedBytes: captureCounter(metadata?.scannedBytes),
		tailOversizedLines: captureCounter(metadata?.oversizedLines),
		tailMalformedLines: captureCounter(metadata?.malformedLines),
		tailIneligibleLines: captureCounter(metadata?.ineligibleLines),
		tailEmptyLines: captureCounter(metadata?.emptyLines),
	});
}

function captureSummary(metadata) {
	const captureEvidence = captureEvidenceSummary(metadata);
	const rawReason = String(metadata?.truncationReason ?? "").trim();
	let reason = /^[a-z_]{1,40}$/.test(rawReason) ? rawReason : null;
	if (!reason && Number(captureEvidence?.ambiguousOutcomeRows ?? 0) > 0) reason = "ambiguous_tool_result";
	if (!reason && Number(captureEvidence?.companionLimitRejectedOutcomeRows ?? 0) > 0) reason = "companion_limit";
	if (!reason && Number(captureEvidence?.closureEventLimitRejectedOutcomeRows ?? 0) > 0) reason = "closure_event_limit";
	if (!reason && Number(captureEvidence?.omittedEvents ?? 0) > 0) reason = "max_capture_events";
	if (!reason && Number(captureEvidence?.truncatedEvents ?? 0) > 0) reason = "capture_abbreviated";
	if (!reason && metadata?.recallEchoProtectionUnavailable) reason = "recall_echo_unavailable";
	const captureTruncated = Boolean(
		metadata?.scanTruncated
		|| metadata?.oversizedLines > 0
		|| metadata?.malformedLines > 0
		|| metadata?.fileChangedDuringScan
		|| metadata?.fileGrew
		|| metadata?.fileShrank
		|| metadata?.recallEchoProtectionUnavailable
		|| captureEvidence?.ambiguousOutcomeRows > 0
		|| captureEvidence?.companionLimitRejectedOutcomeRows > 0
		|| captureEvidence?.closureEventLimitRejectedOutcomeRows > 0
		|| captureEvidence?.omittedEvents > 0
		|| captureEvidence?.truncatedEvents > 0,
	);
	return {
		captureTruncated,
		truncationReason: captureTruncated ? (reason ?? "bounded_scan") : null,
		...(captureEvidence ? { captureEvidence } : {}),
	};
}

function prepareSession({ messages, sessionId, memoryScope, captureMetadata = null }) {
	const identity = sessionIdentity(sessionId);
	const seenIds = new Set();
	const cleaned = (messages ?? []).map((message, index) => {
		const value = cleanMessage(message, index, identity.sessionHash);
		if (!seenIds.has(value.id)) {
			seenIds.add(value.id);
			return value;
		}
		const stableDuplicateSeed = [
			"itsuki-message-id:v1",
			"duplicate",
			identity.sessionHash,
			value.id,
			value.role,
			value.ts ?? "",
			sha256(value.content),
		].join("\0");
		let id = `msg_${sha256(stableDuplicateSeed).slice(0, 48)}`;
		if (seenIds.has(id)) id = `msg_${sha256(`${stableDuplicateSeed}\0occurrence\0${index}`).slice(0, 48)}`;
		seenIds.add(id);
		return { ...value, id };
	});
	const scrubbed = scrubMessages(cleaned);
	const safeMessages = scrubbed.messages.filter((message) => message.content.trim());
	if (!safeMessages.length) throw new OutboxError("empty_envelope", "There are no messages to queue.");
	const safeScope = sanitizeMemoryScope(memoryScope);
	const capture = captureSummary(captureMetadata);
	return {
		...identity,
		safeMessages,
		safeScope,
		capture,
		redactions: scrubbed.redactions,
	};
}

function graphemeUnits(text) {
	if (typeof Intl?.Segmenter !== "function") return Array.from(text);
	const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
	const units = [];
	for (const item of segmenter.segment(text)) {
		if (unicodeLength(item.segment) <= INGEST_LIMITS.maxMessageCharacters) units.push(item.segment);
		else units.push(...Array.from(item.segment));
	}
	return units;
}

function naturalBoundary(units, start, hardEnd) {
	const floor = start + Math.floor((hardEnd - start) * 0.7);
	for (const rank of [4, 3, 2, 1]) {
		for (let index = hardEnd; index > floor; index -= 1) {
			const previous = units[index - 1] ?? "";
			const before = units[index - 2] ?? "";
			const next = units[index] ?? "";
			const boundaryRank = previous === "\n" && before === "\n"
				? 4
				: previous === "\n"
					? 3
					: /[.!?]/u.test(previous) && /^\s/u.test(next)
						? 2
						: /\s/u.test(previous)
							? 1
							: 0;
			if (boundaryRank !== rank) continue;
			// Keep whitespace at the start of the following labeled segment. The
			// server trims the complete message string; because the segment label
			// precedes this whitespace, retaining it on the right preserves the
			// original scrubbed content byte-for-byte after labels are removed.
			if (rank === 4 && index - 2 > start) return index - 2;
			if ((rank === 3 || rank === 1) && index - 1 > start) return index - 1;
			return index;
		}
	}
	return hardEnd;
}

function splitContent(text, maxCodePoints) {
	const units = graphemeUnits(text);
	const lengths = units.map((unit) => unicodeLength(unit));
	const chunks = [];
	let start = 0;
	while (start < units.length) {
		let hardEnd = start;
		let count = 0;
		while (hardEnd < units.length && count + lengths[hardEnd] <= maxCodePoints) {
			count += lengths[hardEnd];
			hardEnd += 1;
		}
		if (hardEnd === start) hardEnd += 1;
		const end = hardEnd < units.length ? naturalBoundary(units, start, hardEnd) : hardEnd;
		chunks.push(units.slice(start, end).join(""));
		start = end;
	}
	return chunks;
}

function splitMessagesForIngest(messages) {
	const output = [];
	let splitSourceMessages = 0;
	const contentCapacity = INGEST_LIMITS.maxMessageCharacters - 96;
	if (contentCapacity < 1) throw new OutboxError("invalid_ingest_contract", "The ingest message limit cannot hold segment labels.");
	for (const message of messages) {
		if (unicodeLength(message.content) <= INGEST_LIMITS.maxMessageCharacters) {
			output.push(message);
			continue;
		}
		splitSourceMessages += 1;
		const chunks = splitContent(message.content, contentCapacity);
		const total = chunks.length;
		for (let offset = 0; offset < total; offset += 1) {
			const index = offset + 1;
			const label = `[Itsuki segment ${index}/${total}; one original message, preserved in order]\n`;
			const content = `${label}${chunks[offset]}`;
			if (unicodeLength(content) > INGEST_LIMITS.maxMessageCharacters) {
				throw new OutboxError("invalid_ingest_contract", "A labeled message segment exceeds the ingest character limit.");
			}
			output.push({
				...message,
				id: `segment_${sha256(`${message.id}\0${index}\0${total}\0${sha256(chunks[offset])}`).slice(0, 48)}`,
				content,
			});
		}
	}
	return { messages: output, splitSourceMessages };
}

function deliveryFor({ groupId, batchIndex, batchCount, sourceMessageCount, segmentCount, splitSourceMessages, capture }) {
	return {
		schema: INGEST_DELIVERY_SCHEMA,
		groupId,
		batchIndex,
		batchCount,
		sourceMessageCount,
		segmentCount,
		splitSourceMessages,
		captureTruncated: capture.captureTruncated,
		truncationReason: capture.truncationReason,
		...(capture.captureEvidence ? { captureEvidence: capture.captureEvidence } : {}),
	};
}

function deliveryIdentity(delivery) {
	return {
		schema: delivery.schema,
		groupId: delivery.groupId,
		batchIndex: delivery.batchIndex,
		batchCount: delivery.batchCount,
		sourceMessageCount: delivery.sourceMessageCount,
		segmentCount: delivery.segmentCount,
		splitSourceMessages: delivery.splitSourceMessages,
	};
}

const CAPTURE_DELIVERY_RESERVE_BYTES = 4 * 1024;

function requestForBatch({ messages, conversationId, memoryScope, common, batchIndex, batchCount, legacyCaptureIdentity = false }) {
	const delivery = deliveryFor({ ...common, batchIndex, batchCount });
	const identityDelivery = legacyCaptureIdentity ? delivery : deliveryIdentity(delivery);
	if (
		!legacyCaptureIdentity
		&& utf8Length(JSON.stringify(delivery)) - utf8Length(JSON.stringify(identityDelivery)) > CAPTURE_DELIVERY_RESERVE_BYTES
	) throw new OutboxError("capture_evidence_too_large", "Capture evidence exceeds its reserved wire bound.");
	const digest = sha256(canonicalJson({
		schema: "itsuki.outbox-request/v2",
		delivery: identityDelivery,
		messages: messages.map(legacyCaptureIdentity ? legacyMessageDigestSeed : messageDigestSeed),
	}));
	return {
		path: "/v1/ingest",
		body: {
			source: "plugin",
			flush: true,
			conversationId,
			memoryScope,
			idempotencyKey: `claude-outbox:v2:${digest}`,
			delivery,
			messages,
		},
	};
}

function requestFitsIngest(request, { legacyCaptureIdentity = false } = {}) {
	const identityBody = legacyCaptureIdentity
		? request.body
		: { ...request.body, delivery: deliveryIdentity(request.body.delivery) };
	const bodyBytes = utf8Length(JSON.stringify(identityBody))
		+ (legacyCaptureIdentity ? 0 : CAPTURE_DELIVERY_RESERVE_BYTES);
	return bodyBytes <= INGEST_LIMITS.maxRequestBytes
		&& request.body.messages.length <= INGEST_LIMITS.maxMessages
		&& request.body.messages.every((message) => unicodeLength(message.content) <= INGEST_LIMITS.maxMessageCharacters)
		&& request.body.messages.reduce((total, message) => total + unicodeLength(message.content), 0) <= INGEST_LIMITS.maxTotalCharacters;
}

function contentDigestFromRequest(request) {
	const match = /^claude-outbox:v(?:1|2):([a-f0-9]{64})$/.exec(request?.body?.idempotencyKey ?? "");
	return match?.[1] ?? null;
}

function requestVersion(request) {
	return /^claude-outbox:v2:/.test(request?.body?.idempotencyKey ?? "") ? 2 : 1;
}

function queueIdFor(contentDigest, fingerprint) {
	if (!/^[a-f0-9]{64}$/.test(contentDigest ?? "") || !validCredentialFingerprint(fingerprint)) {
		throw new OutboxSecurityError("An outbox queue identity is invalid.");
	}
	return `q_${sha256(`${contentDigest}\0${fingerprint ?? "unbound"}`).slice(0, 40)}`;
}

function buildEnvelopes({
	messages,
	sessionId,
	memoryScope,
	fingerprint,
	captureMetadata = null,
	now = Date.now,
	prepared = null,
	createdAt: suppliedCreatedAt = null,
	deliveryOrder = null,
	legacyCaptureIdentity = false,
}) {
	if (!validCredentialFingerprint(fingerprint)) {
		throw new OutboxError(
			"invalid_credential_fingerprint",
			"The outbox credential binding must be a one-way fingerprint.",
		);
	}
	const material = prepared ?? prepareSession({ messages, sessionId, memoryScope, captureMetadata });
	const {
		safeMessages,
		safeScope,
		capture,
		redactions,
		sessionHash,
		conversationId,
	} = material;
	const segmented = splitMessagesForIngest(safeMessages);
	const groupDigest = sha256(canonicalJson((legacyCaptureIdentity ? legacyEnvelopeSeed : envelopeSeed)({
		sessionHash,
		memoryScope: safeScope,
		messages: segmented.messages,
		capture,
	})));
	const groupId = `claude_delivery_v1_${groupDigest.slice(0, 40)}`;
	const common = {
		groupId,
		sourceMessageCount: safeMessages.length,
		segmentCount: segmented.messages.length,
		splitSourceMessages: segmented.splitSourceMessages,
		capture,
	};
	const batches = [];
	let batch = [];
	for (const message of segmented.messages) {
		const candidate = [...batch, message];
		const provisional = requestForBatch({
			messages: candidate,
			conversationId,
			memoryScope: safeScope,
			common,
			batchIndex: Math.min(batches.length, OUTBOX_LIMITS.maxRawCount - 1),
			batchCount: OUTBOX_LIMITS.maxRawCount,
			legacyCaptureIdentity,
		});
		if (batch.length > 0 && !requestFitsIngest(provisional, { legacyCaptureIdentity })) {
			batches.push(batch);
			batch = [message];
			continue;
		}
		if (!requestFitsIngest(provisional, { legacyCaptureIdentity })) {
			throw new OutboxCapacityError("message_unbatchable", "One protected message segment cannot fit the ingest request limit.");
		}
		batch = candidate;
	}
	if (batch.length) batches.push(batch);
	if (batches.length > OUTBOX_LIMITS.maxRawCount) {
		throw new OutboxCapacityError("session_batch_count_full", "This session needs more ordered batches than the protected outbox can hold.");
	}
	const createdAt = suppliedCreatedAt === null ? Number(now()) : Number(suppliedCreatedAt);
	const built = batches.map((batchMessages, batchIndex) => {
		const request = requestForBatch({
			messages: batchMessages,
			conversationId,
			memoryScope: safeScope,
			common,
			batchIndex,
			batchCount: batches.length,
			legacyCaptureIdentity,
		});
		const violation = validateIngestBody(request.body, { requestBytes: utf8Length(JSON.stringify(request.body)) });
		if (violation) throw new OutboxError("invalid_ingest_batch", "An ordered outbox batch violates the ingest contract.");
		const digest = contentDigestFromRequest(request);
		const queueId = queueIdFor(digest, fingerprint);
		return {
			envelope: {
				schema: OUTBOX_SCHEMA,
				queue_id: queueId,
				created_at: createdAt,
				...(Number.isSafeInteger(deliveryOrder) && deliveryOrder >= 0 ? { delivery_order: deliveryOrder } : {}),
				credential_fingerprint: fingerprint ?? null,
				request,
				request_sha256: sha256(canonicalJson(request)),
			},
			bytes: Buffer.byteLength(canonicalJson({ request }), "utf8"),
		};
	});
	return {
		built,
		redactions,
		stats: {
			batchCount: built.length,
			sourceMessageCount: safeMessages.length,
			segmentCount: segmented.messages.length,
			splitSourceMessages: segmented.splitSourceMessages,
			captureTruncated: capture.captureTruncated,
		},
	};
}

function validCaptureSummary(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	if (Object.keys(value).some((key) => !["captureTruncated", "truncationReason", "captureEvidence"].includes(key))) return false;
	if (typeof value.captureTruncated !== "boolean") return false;
	if (value.captureEvidence != null && !normalizeCaptureEvidence(value.captureEvidence)) return false;
	if (value.captureTruncated) return /^[a-z_]{1,40}$/.test(value.truncationReason ?? "");
	return value.truncationReason === null;
}

function stagedGroupSeed({ sessionHash, conversationId, memoryScope, messages }) {
	return {
		schema: STAGED_GROUP_SCHEMA,
		sessionHash,
		conversationId,
		memoryScope,
		messages: messages.map(messageDigestSeed),
	};
}

function legacyStagedGroupSeed({ sessionHash, conversationId, memoryScope, capture, messages }) {
	return {
		schema: LEGACY_STAGED_GROUP_SCHEMA,
		sessionHash,
		conversationId,
		memoryScope,
		capture,
		messages: messages.map(legacyMessageDigestSeed),
	};
}

function buildStagedGroup({ prepared, fingerprint, now = Date.now, deliveryOrder = null, legacyCaptureIdentity = false }) {
	if (!validCredentialFingerprint(fingerprint)) {
		throw new OutboxError(
			"invalid_credential_fingerprint",
			"The outbox credential binding must be a one-way fingerprint.",
		);
	}
	const seed = legacyCaptureIdentity ? legacyStagedGroupSeed : stagedGroupSeed;
	const schema = legacyCaptureIdentity ? LEGACY_STAGED_GROUP_SCHEMA : STAGED_GROUP_SCHEMA;
	const persistedMessages = legacyCaptureIdentity
		? prepared.safeMessages.map(({ source_event: _sourceEvent, ...message }) => message)
		: prepared.safeMessages;
	const digest = sha256(canonicalJson(seed({
		sessionHash: prepared.sessionHash,
		conversationId: prepared.conversationId,
		memoryScope: prepared.safeScope,
		capture: prepared.capture,
		messages: persistedMessages,
	})));
	const queueId = queueIdFor(digest, fingerprint);
	const value = {
		schema,
		queue_id: queueId,
		created_at: Number(now()),
		...(Number.isSafeInteger(deliveryOrder) && deliveryOrder >= 0 ? { delivery_order: deliveryOrder } : {}),
		credential_fingerprint: fingerprint ?? null,
		content_digest: digest,
		session_hash: prepared.sessionHash,
		conversation_id: prepared.conversationId,
		memory_scope: prepared.safeScope,
		capture: prepared.capture,
		messages: persistedMessages,
	};
	return {
		value,
		queueId,
		redactions: prepared.redactions,
		stats: {
			staged: true,
			batchCount: null,
			sourceMessageCount: persistedMessages.length,
			segmentCount: null,
			splitSourceMessages: null,
			captureTruncated: prepared.capture.captureTruncated,
		},
	};
}

function validateStagedGroup(value, queueId = value?.queue_id) {
	if (
		!value
		|| ![STAGED_GROUP_SCHEMA, LEGACY_STAGED_GROUP_SCHEMA].includes(value.schema)
		|| !validQueueId(queueId)
		|| value.queue_id !== queueId
	) return false;
	const topLevelKeys = new Set([
		"schema", "queue_id", "created_at", "delivery_order", "credential_fingerprint",
		"content_digest", "session_hash", "conversation_id", "memory_scope", "capture", "messages",
	]);
	if (Object.keys(value).some((key) => !topLevelKeys.has(key))) return false;
	if (!validFiniteTimestamp(value.created_at) || !validCredentialFingerprint(value.credential_fingerprint)) return false;
	if (value.delivery_order != null && (!Number.isSafeInteger(value.delivery_order) || value.delivery_order < 0)) return false;
	if (!/^[a-f0-9]{64}$/.test(value.content_digest ?? "")) return false;
	if (!/^[a-f0-9]{64}$/.test(value.session_hash ?? "")) return false;
	if (!/^claude_session_v1_[a-f0-9]{32}$/.test(value.conversation_id ?? "")) return false;
	if (!validCaptureSummary(value.capture)) return false;
	if (!value.memory_scope || typeof value.memory_scope !== "object" || Array.isArray(value.memory_scope)) return false;
	if (canonicalJson(sanitizeMemoryScope(value.memory_scope)) !== canonicalJson(value.memory_scope)) return false;
	if (!Array.isArray(value.messages) || value.messages.length < 1) return false;
	const messageIds = new Set();
	for (const message of value.messages) {
		if (!message || typeof message !== "object" || Array.isArray(message)) return false;
		const messageKeys = new Set(value.schema === LEGACY_STAGED_GROUP_SCHEMA
			? ["id", "role", "content", "ts"]
			: ["id", "role", "content", "ts", "source_event"]);
		if (Object.keys(message).some((key) => !messageKeys.has(key))) return false;
		if (
			typeof message.id !== "string"
			|| !message.id.trim()
			|| message.id.length > 200
			|| messageIds.has(message.id)
		) return false;
		messageIds.add(message.id);
		if (!["user", "assistant"].includes(message.role) || typeof message.content !== "string" || !message.content.trim()) return false;
		if (message.ts != null && (typeof message.ts !== "number" || !Number.isFinite(message.ts))) return false;
		if (value.schema === LEGACY_STAGED_GROUP_SCHEMA && message.source_event != null) return false;
		if (message.source_event != null) {
			const sourceEvent = normalizeSourceEvent(message.source_event);
			if (!sourceEvent || canonicalJson(sourceEvent) !== canonicalJson(message.source_event)) return false;
		}
	}
	const seed = value.schema === LEGACY_STAGED_GROUP_SCHEMA ? legacyStagedGroupSeed : stagedGroupSeed;
	const digest = sha256(canonicalJson(seed({
		sessionHash: value.session_hash,
		conversationId: value.conversation_id,
		memoryScope: value.memory_scope,
		capture: value.capture,
		messages: value.messages,
	})));
	return digest === value.content_digest
		&& queueId === queueIdFor(digest, value.credential_fingerprint);
}

function manifestFromMaterialized(staged, group, now = Date.now) {
	const first = group.built[0]?.envelope;
	return {
		schema: GROUP_MANIFEST_SCHEMA,
		materializer_version: MATERIALIZER_VERSION,
		queue_id: staged.queue_id,
		created_at: staged.created_at,
		materialized_at: Number(now()),
		...(staged.delivery_order == null ? {} : { delivery_order: staged.delivery_order }),
		credential_fingerprint: staged.credential_fingerprint,
		content_digest: staged.content_digest,
		conversation_id: staged.conversation_id,
		group_id: first?.request?.body?.delivery?.groupId ?? null,
		batch_count: group.built.length,
		queue_ids: group.built.map((item) => item.envelope.queue_id),
		stats: group.stats,
	};
}

function validateGroupManifest(value, queueId = value?.queue_id) {
	return Boolean(
		value
		&& value.schema === GROUP_MANIFEST_SCHEMA
		&& value.materializer_version === MATERIALIZER_VERSION
		&& validQueueId(queueId)
		&& value.queue_id === queueId
		&& validFiniteTimestamp(value.created_at)
		&& validFiniteTimestamp(value.materialized_at)
		&& (value.delivery_order == null || (Number.isSafeInteger(value.delivery_order) && value.delivery_order >= 0))
		&& validCredentialFingerprint(value.credential_fingerprint)
		&& /^[a-f0-9]{64}$/.test(value.content_digest ?? "")
		&& queueId === queueIdFor(value.content_digest, value.credential_fingerprint)
		&& /^claude_session_v1_[a-f0-9]{32}$/.test(value.conversation_id ?? "")
		&& /^claude_delivery_v1_[a-f0-9]{40}$/.test(value.group_id ?? "")
		&& Number.isSafeInteger(value.batch_count)
		&& value.batch_count >= 1
		&& value.batch_count <= OUTBOX_LIMITS.maxRawCount
		&& Array.isArray(value.queue_ids)
		&& value.queue_ids.length === value.batch_count
		&& new Set(value.queue_ids).size === value.queue_ids.length
		&& value.queue_ids.every(validQueueId)
		&& value.stats
		&& Number(value.stats.batchCount) === value.batch_count,
	);
}

function validateEnvelope(value) {
	if (!value || value.schema !== OUTBOX_SCHEMA || !validQueueId(value.queue_id)) return false;
	if (value.request?.path !== "/v1/ingest" || !Array.isArray(value.request?.body?.messages)) return false;
	if (!validFiniteTimestamp(value.created_at)) return false;
	if (value.delivery_order != null && (!Number.isSafeInteger(value.delivery_order) || value.delivery_order < 0)) return false;
	if (!validCredentialFingerprint(value.credential_fingerprint)) return false;
	const contentDigest = contentDigestFromRequest(value.request);
	if (!contentDigest || value.queue_id !== queueIdFor(contentDigest, value.credential_fingerprint)) return false;
	if (requestVersion(value.request) === 2) {
		if (!normalizeDeliveryMetadata(value.request.body.delivery)) return false;
		const violation = validateIngestBody(value.request.body, {
			requestBytes: utf8Length(JSON.stringify(value.request.body)),
		});
		if (violation) return false;
	}
	return value.request_sha256 === sha256(canonicalJson(value.request));
}

function validateTombstone(value, queueId = value?.queue_id) {
	const sourcePacketId = serverIdentifier(value?.source_packet_id, "src");
	const receiptId = serverIdentifier(value?.receipt_id, "receipt");
	const contentDigest = typeof value?.content_digest === "string" && /^[a-f0-9]{64}$/.test(value.content_digest)
		? value.content_digest
		: null;
	const delivery = value?.delivery == null ? null : normalizeDeliveryMetadata(value.delivery);
	return Boolean(
		value
		&& value.schema === TOMBSTONE_SCHEMA
		&& validQueueId(queueId)
		&& value.queue_id === queueId
		&& validFiniteTimestamp(value.accepted_at)
		&& Number.isInteger(value.http_status)
		&& value.http_status >= 200
		&& value.http_status <= 299
		&& CREDENTIAL_FINGERPRINT_RE.test(value.credential_fingerprint ?? "")
		&& contentDigest
		&& queueId === queueIdFor(contentDigest, value.credential_fingerprint)
		&& (value.delivery == null || delivery)
		&& (value.delivery == null || (
			(value.conversation_id == null && value.group_created_at == null)
			|| (
				/^claude_session_v1_[a-f0-9]{32}$/.test(value.conversation_id ?? "")
				&& validFiniteTimestamp(value.group_created_at)
			)
		))
		&& (value.delivery_order == null || (Number.isSafeInteger(value.delivery_order) && value.delivery_order >= 0))
		&& (sourcePacketId || receiptId),
	);
}

function validateState(value, queueId = value?.queue_id) {
	return Boolean(
		value
		&& value.schema === STATE_SCHEMA
		&& validQueueId(queueId)
		&& value.queue_id === queueId
		&& Number.isSafeInteger(value.attempts)
		&& value.attempts >= 0
		&& (value.binding_fingerprint == null || CREDENTIAL_FINGERPRINT_RE.test(value.binding_fingerprint))
		&& (value.binding_updated_at == null || validFiniteTimestamp(value.binding_updated_at))
		&& (value.updated_at == null || validFiniteTimestamp(value.updated_at))
		&& (value.next_attempt_at == null || validFiniteTimestamp(value.next_attempt_at))
		&& (value.last_http_status == null
			|| (Number.isInteger(value.last_http_status) && value.last_http_status >= 100 && value.last_http_status <= 599))
		&& (value.last_error_code == null || safeErrorCode(value.last_error_code, null) === value.last_error_code)
		&& (value.permanent == null || typeof value.permanent === "boolean"),
	);
}

function validateAuthBlock(value) {
	return Boolean(
		value
		&& value.schema === "itsuki.outbox-auth-block/v1"
		&& CREDENTIAL_FINGERPRINT_RE.test(value.credential_fingerprint ?? "")
		&& validFiniteTimestamp(value.created_at)
		&& (value.http_status === 401 || value.http_status === 403),
	);
}

function validateDeliverySequence(value) {
	return Boolean(
		value
		&& value.schema === DELIVERY_SEQUENCE_SCHEMA
		&& Number.isSafeInteger(value.next_order)
		&& value.next_order >= 0
		&& validFiniteTimestamp(value.updated_at),
	);
}

function validExpectedTemporary(value) {
	if (
		validateEnvelope(value)
		|| validateStagedGroup(value)
		|| validateGroupManifest(value)
		|| validateState(value)
		|| validateTombstone(value)
		|| validateAuthBlock(value)
		|| validateDeliverySequence(value)
		|| normalizeRecallEchoStore(value)
	) {
		return true;
	}
	if (value?.schema === SECURITY_MARKER_SCHEMA) {
		return /^[a-f0-9]{64}$/.test(value.path_sha256 ?? "")
			&& value.directories && typeof value.directories === "object"
			&& validFiniteTimestamp(value.verified_at);
	}
	return Boolean(
		value?.schema === "itsuki.outbox-lock/v1"
		&& validLockToken(value.token)
		&& Number.isSafeInteger(value.pid)
		&& value.pid > 0
		&& validFiniteTimestamp(value.process_started_at)
		&& validFiniteTimestamp(value.created_at),
	);
}

function queuePath(paths, directory, queueId) {
	if (!DIRECTORY_NAMES.includes(directory) || !validQueueId(queueId)) throw new OutboxSecurityError();
	const target = join(paths[directory], `${queueId}.json`);
	if (!isWithin(paths.root, target)) throw new OutboxSecurityError();
	return target;
}

async function readJson(path) {
	try { return JSON.parse(await readFile(path, "utf8")); }
	catch { return null; }
}

async function lifecyclePath(paths, queueId) {
	if (!validQueueId(queueId)) throw new OutboxSecurityError();
	for (const name of ["pending", "inflight", "accepted", "done", "failed"]) {
		const path = queuePath(paths, name, queueId);
		const info = await pathKind(path);
		if (!info) continue;
		if (!info.isFile() || info.isSymbolicLink()) throw new OutboxSecurityError("An outbox lifecycle entry is not a regular file.");
		const value = await readJson(path);
		const valid = name === "accepted" || name === "done"
			? validateTombstone(value, queueId)
			: validateEnvelope(value) && value.queue_id === queueId;
		if (!valid) throw new OutboxSecurityError("An outbox lifecycle entry is corrupt.");
		return { name, path, value };
	}
	return null;
}

async function rawUsage(paths) {
	let count = 0;
	let bytes = 0;
	for (const name of CAPACITY_DIRECTORIES) {
		for (const entry of await safeEntries(paths[name], paths.root, {
			maxEntries: OUTBOX_LIMITS.maxRawCount - count,
			rejectOverflow: true,
		})) {
			if (!entry.info.isFile()) throw new OutboxSecurityError("The raw outbox contains a non-file entry.");
			count += 1;
			bytes += entry.info.size;
		}
	}
	for (const entry of await safeEntries(paths.tmp, paths.root, {
		maxEntries: OUTBOX_LIMITS.maxRawCount - count,
		rejectOverflow: true,
	})) {
		if (!entry.info.isFile()) throw new OutboxSecurityError("The raw outbox contains a non-file entry.");
		count += 1;
		bytes += entry.info.size;
	}
	return { count, bytes };
}

async function claimDeliveryOrder(paths, platform, now = Date.now) {
	const sequencePath = join(paths.control, "delivery-sequence.json");
	const info = await pathKind(sequencePath);
	if (info && (!info.isFile() || info.isSymbolicLink())) {
		throw new OutboxSecurityError("The protected delivery sequence is not a regular file.");
	}
	const existing = info ? await readJson(sequencePath) : null;
	if (info && !validateDeliverySequence(existing)) {
		throw new OutboxSecurityError("The protected delivery sequence is corrupt.");
	}
	const observedAt = Number(now());
	const timestamp = Number.isFinite(observedAt) && observedAt >= 0 ? observedAt : Date.now();
	const clock = Math.floor(timestamp);
	const initial = clock >= 0 && Number.isSafeInteger(clock * 1_000)
		? clock * 1_000
		: Math.floor(Date.now()) * 1_000;
	const order = existing?.next_order ?? initial;
	if (!Number.isSafeInteger(order) || order >= Number.MAX_SAFE_INTEGER) {
		throw new OutboxCapacityError("delivery_sequence_full", "The protected delivery sequence is exhausted.");
	}
	await atomicJson(paths, platform, sequencePath, {
		schema: DELIVERY_SEQUENCE_SCHEMA,
		next_order: order + 1,
		updated_at: timestamp,
	});
	return order;
}

async function acquireLock(paths, name, { waitMs = 0, staleMs = OUTBOX_LIMITS.staleLockMs } = {}) {
	if (!/^[a-z-]+\.lock$/.test(name)) throw new OutboxSecurityError("An outbox lock name is invalid.");
	const lockPath = join(paths.locks, name);
	if (!isWithin(paths.root, lockPath)) throw new OutboxSecurityError();
	const deadline = Date.now() + waitMs;
	const token = randomUUID();
	const ownerPath = join(lockPath, "owner.json");
	const processStartedAt = Math.round(Date.now() - process.uptime() * 1_000);
	const ownerValue = () => ({
		schema: "itsuki.outbox-lock/v1",
		token,
		pid: process.pid,
		process_started_at: processStartedAt,
		created_at: Date.now(),
	});
	const releaseOwnedLock = async () => {
		const owner = await readJson(ownerPath);
		if (owner?.token !== token) return;
		await unlink(ownerPath).catch(() => {});
		await rmdir(lockPath).catch((error) => {
			if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") throw error;
		});
	};
	const processIsAlive = (pid) => {
		if (!Number.isSafeInteger(pid) || pid <= 0) return false;
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			return error?.code === "EPERM";
		}
	};
	for (;;) {
		let created = false;
		try {
			await mkdir(lockPath, { mode: 0o700 });
			created = true;
			try {
				await atomicJson(paths, process.platform, ownerPath, ownerValue());
			} catch (error) {
				await unlink(ownerPath).catch(() => {});
				await rmdir(lockPath).catch(() => {});
				throw error;
			}
			return releaseOwnedLock;
		} catch (error) {
			if (created) throw error;
			if (error?.code !== "EEXIST") throw error;
			const info = await lstat(lockPath).catch(() => null);
			if (!info?.isDirectory() || info.isSymbolicLink()) throw new OutboxSecurityError("An outbox lock is not a plain directory.");
			const owner = await readJson(ownerPath);
			const age = Date.now() - Number(owner?.created_at ?? info.mtimeMs);
			const hasOwner = owner?.schema === "itsuki.outbox-lock/v1" && validLockToken(owner?.token);
			const ownerPid = Number(owner?.pid);
			const sameCurrentProcessGeneration = ownerPid === process.pid
				&& Math.abs(Number(owner?.process_started_at) - processStartedAt) < 5_000;
			// Cross-process start times are not portably observable. Trust another
			// live PID only within the bounded lease; after staleLockMs it may be a
			// reused PID from a crashed hook and must not stall delivery forever.
			const liveOwner = hasOwner
				&& processIsAlive(ownerPid)
				&& (sameCurrentProcessGeneration || (ownerPid !== process.pid && age <= staleMs));
			const threshold = hasOwner ? staleMs : Math.min(staleMs, 5_000);
			if (!liveOwner && Number.isFinite(age) && (Number.isSafeInteger(ownerPid) || age > threshold)) {
				if (await pathKind(ownerPath)) {
					// Claim the exact observed owner file (valid or corrupt) before
					// removing its directory. This prevents two stale-lock reapers
					// from deleting a replacement lock.
					const reapedOwner = join(lockPath, `reaped-${randomUUID()}.json`);
					try {
						await rename(ownerPath, reapedOwner);
						const claimed = await readJson(reapedOwner);
						if (hasOwner && claimed?.token !== owner.token) {
							throw new OutboxSecurityError("An outbox lock owner changed during recovery.");
						}
					} catch (reapError) {
						if (!["ENOENT", "EEXIST"].includes(reapError?.code)) throw reapError;
					}
				}
				const claimPath = join(lockPath, "reaper.claim");
				let claim;
				try {
					claim = await open(claimPath, "wx", 0o600);
					await claim.writeFile(canonicalJson(ownerValue()), "utf8");
					if (process.platform !== "win32") await claim.chmod(0o600);
					await claim.sync();
					await claim.close();
					claim = null;
					if (await pathKind(ownerPath)) {
						await unlink(claimPath).catch(() => {});
						continue;
					}
					const artifacts = await safeEntries(lockPath, paths.root, { maxEntries: 17, rejectOverflow: true });
					let ownerAppeared = false;
					for (const artifact of artifacts) {
						if (artifact.name === "reaper.claim") continue;
						if (artifact.name === "owner.json") { ownerAppeared = true; break; }
						const legacyReaped = /^reaped-[0-9a-f-]{36}\.json$/i.test(artifact.name);
						const legacyClaim = /^reap-[0-9a-f-]{36}\.claim$/i.test(artifact.name);
						if (!artifact.info.isFile() || (!legacyReaped && !legacyClaim)) {
							throw new OutboxSecurityError("An outbox lock contains an unexpected recovery artifact.");
						}
						await unlink(artifact.path);
					}
					if (ownerAppeared) {
						await unlink(claimPath).catch(() => {});
						continue;
					}
					await rename(claimPath, ownerPath);
					await syncDirectory(lockPath, process.platform);
					return releaseOwnedLock;
				} catch (reapError) {
					await claim?.close().catch(() => {});
					if (reapError?.code === "EEXIST") {
						const claimInfo = await pathKind(claimPath);
						if (!claimInfo?.isFile() || claimInfo.isSymbolicLink()) throw new OutboxSecurityError("An outbox reaper claim is invalid.");
						if (Date.now() - claimInfo.mtimeMs > threshold) {
							await unlink(claimPath).catch(() => {});
							continue;
						}
					} else {
						const ours = await readJson(claimPath);
						if (ours?.token === token) await unlink(claimPath).catch(() => {});
						if (!["ENOENT"].includes(reapError?.code)) throw reapError;
					}
				}
			}
			if (Date.now() >= deadline) return null;
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 15));
		}
	}
}

function acquireMutationLock(paths, waitMs = 250) {
	return acquireLock(paths, "mutation.lock", { waitMs });
}

function envelopeDelivery(envelope) {
	return requestVersion(envelope?.request) === 2
		? normalizeDeliveryMetadata(envelope?.request?.body?.delivery)
		: null;
}

function orderingDelivery(envelope) {
	const delivery = envelopeDelivery(envelope);
	if (delivery) return delivery;
	const conversationId = envelope?.request?.body?.conversationId;
	if (
		requestVersion(envelope?.request) === 1
		&& typeof conversationId === "string"
		&& conversationId.length > 0
		&& conversationId.length <= 240
	) {
		return {
			groupId: `legacy:${envelope.queue_id}`,
			batchIndex: 0,
			batchCount: 1,
			legacy: true,
		};
	}
	return null;
}

function stagedCaptureFromDelivery(value) {
	const delivery = normalizeDeliveryMetadata(value);
	if (!delivery) return null;
	const capture = {
		captureTruncated: delivery.captureTruncated,
		truncationReason: delivery.truncationReason,
		...(delivery.captureEvidence ? { captureEvidence: delivery.captureEvidence } : {}),
	};
	return validCaptureSummary(capture) ? capture : null;
}

function legacyReplayDigest(prepared, capture) {
	return sha256(canonicalJson(legacyStagedGroupSeed({
		sessionHash: prepared.sessionHash,
		conversationId: prepared.conversationId,
		memoryScope: prepared.safeScope,
		capture,
		messages: prepared.safeMessages,
	})));
}

async function manifestCaptureSummary(paths, manifest) {
	const summaries = [];
	for (const [batchIndex, queueId] of manifest.queue_ids.entries()) {
		const lifecycle = await lifecyclePath(paths, queueId);
		if (!lifecycle) continue;
		const tombstone = lifecycle.name === "accepted" || lifecycle.name === "done";
		const delivery = tombstone
			? normalizeDeliveryMetadata(lifecycle.value.delivery)
			: envelopeDelivery(lifecycle.value);
		const conversationId = tombstone
			? lifecycle.value.conversation_id
			: lifecycle.value.request?.body?.conversationId;
		if (
			!delivery
			|| delivery.groupId !== manifest.group_id
			|| delivery.batchCount !== manifest.batch_count
			|| delivery.batchIndex !== batchIndex
			|| conversationId !== manifest.conversation_id
			|| lifecycle.value.credential_fingerprint !== manifest.credential_fingerprint
		) {
			throw new OutboxSecurityError("A delivery-group manifest cross-links inconsistent lifecycle metadata.");
		}
		const capture = stagedCaptureFromDelivery(delivery);
		if (capture) summaries.push(capture);
	}
	if (!summaries.length) return null;
	const first = canonicalJson(summaries[0]);
	if (summaries.some((summary) => canonicalJson(summary) !== first)) {
		throw new OutboxSecurityError("A delivery group's persisted capture summaries disagree.");
	}
	return summaries[0];
}

/**
 * Locate a shipped-v1 delivery whose immutable non-capture payload matches the
 * current retry. The candidate's own persisted capture summary is supplied to
 * the historical digest, so volatile scan counters may drift without a second
 * local group being created. All scans are bounded by the physical outbox cap
 * and run under the mutation lock.
 */
async function findLegacyReplay(paths, prepared) {
	const matches = new Map();
	for (const entry of await safeEntries(paths.staged, paths.root, {
		maxEntries: OUTBOX_LIMITS.maxRawCount,
		rejectOverflow: true,
	})) {
		if (!entry.info.isFile() || !entry.name.endsWith(".json")) {
			throw new OutboxSecurityError("A staged delivery group entry is invalid.");
		}
		const queueId = entry.name.slice(0, -5);
		const value = await readJson(entry.path);
		if (!validateStagedGroup(value, queueId)) {
			throw new OutboxSecurityError("A staged delivery group is corrupt.");
		}
		if (value.schema !== LEGACY_STAGED_GROUP_SCHEMA) continue;
		if (legacyReplayDigest(prepared, value.capture) !== value.content_digest) continue;
		matches.set(queueId, {
			queueId,
			capture: value.capture,
			credentialFingerprint: value.credential_fingerprint,
			createdAt: value.created_at,
			deliveryOrder: value.delivery_order ?? null,
		});
	}

	for (const entry of await safeEntries(paths.groups, paths.root, {
		maxEntries: OUTBOX_LIMITS.maxRawCount,
		rejectOverflow: true,
	})) {
		if (!entry.info.isFile() || !entry.name.endsWith(".json")) {
			throw new OutboxSecurityError("A delivery-group manifest entry is invalid.");
		}
		const queueId = entry.name.slice(0, -5);
		const manifest = await readJson(entry.path);
		if (!validateGroupManifest(manifest, queueId)) {
			throw new OutboxSecurityError("A delivery-group manifest is corrupt.");
		}
		const capture = await manifestCaptureSummary(paths, manifest);
		if (!capture || legacyReplayDigest(prepared, capture) !== manifest.content_digest) continue;
		const prior = matches.get(queueId);
		if (prior && canonicalJson(prior.capture) !== canonicalJson(capture)) {
			throw new OutboxSecurityError("A v1 staged group and manifest disagree about capture evidence.");
		}
		matches.set(queueId, prior ?? {
			queueId,
			capture,
			credentialFingerprint: manifest.credential_fingerprint,
			createdAt: manifest.created_at,
			deliveryOrder: manifest.delivery_order ?? null,
		});
	}

	return [...matches.values()].sort((left, right) => (
		Number(left.deliveryOrder ?? left.createdAt) - Number(right.deliveryOrder ?? right.createdAt)
		|| left.queueId.localeCompare(right.queueId)
	))[0] ?? null;
}

function deliveryLifecycleKey(groupId, credentialFingerprint) {
	return `${groupId}\0${CREDENTIAL_FINGERPRINT_RE.test(credentialFingerprint ?? "") ? credentialFingerprint : "unbound"}`;
}

function lifecycleGroup(groups, delivery, credentialFingerprint) {
	return delivery ? groups.get(deliveryLifecycleKey(delivery.groupId, credentialFingerprint)) : null;
}

async function activeDeliveryGroups(paths) {
	const groups = new Set();
	for (const entry of await safeEntries(paths.staged, paths.root)) {
		if (!entry.info.isFile()) continue;
		const queueId = entry.name.endsWith(".json") ? entry.name.slice(0, -5) : null;
		if (!validQueueId(queueId)) continue;
		const manifestPath = queuePath(paths, "groups", queueId);
		const manifestInfo = await pathKind(manifestPath);
		if (!manifestInfo) continue;
		if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) {
			throw new OutboxSecurityError("A staged delivery plan is not a regular file.");
		}
		const manifest = await readJson(manifestPath);
		if (!validateGroupManifest(manifest, queueId)) {
			throw new OutboxSecurityError("A staged delivery plan is corrupt.");
		}
		groups.add(manifest.group_id);
	}
	for (const directory of RAW_DIRECTORIES) {
		for (const entry of await safeEntries(paths[directory], paths.root)) {
			if (!entry.info.isFile()) continue;
			const value = await readJson(entry.path);
			const delivery = validateEnvelope(value) ? envelopeDelivery(value) : null;
			if (delivery) groups.add(delivery.groupId);
		}
	}
	return groups;
}

async function deliveryLifecycle(paths) {
	const groups = new Map();
	const add = (delivery, state, metadata = {}) => {
		if (!delivery) return;
		const key = deliveryLifecycleKey(delivery.groupId, metadata.credentialFingerprint);
		let group = groups.get(key);
		if (!group) {
			group = {
				groupId: delivery.groupId,
				batchCount: delivery.batchCount,
				states: new Map(),
				inconsistent: false,
				conversationId: metadata.conversationId ?? null,
				createdAt: Number(metadata.createdAt ?? Number.MAX_SAFE_INTEGER),
				deliveryOrder: Number.isSafeInteger(metadata.deliveryOrder) ? metadata.deliveryOrder : null,
				acceptedFingerprints: new Set(),
			};
			groups.set(key, group);
		}
		if (group.batchCount !== delivery.batchCount) group.inconsistent = true;
		if (metadata.conversationId && group.conversationId && metadata.conversationId !== group.conversationId) group.inconsistent = true;
		if (metadata.conversationId && !group.conversationId) group.conversationId = metadata.conversationId;
		if (Number.isFinite(Number(metadata.createdAt))) group.createdAt = Math.min(group.createdAt, Number(metadata.createdAt));
		if (Number.isSafeInteger(metadata.deliveryOrder)) {
			if (group.deliveryOrder != null && group.deliveryOrder !== metadata.deliveryOrder) group.inconsistent = true;
			group.deliveryOrder = metadata.deliveryOrder;
		}
		const prior = group.states.get(delivery.batchIndex);
		if (prior && prior !== state) group.inconsistent = true;
		group.states.set(delivery.batchIndex, state);
		if (
			(state === "accepted" || state === "done")
			&& CREDENTIAL_FINGERPRINT_RE.test(metadata.credentialFingerprint ?? "")
		) group.acceptedFingerprints.add(metadata.credentialFingerprint);
	};
	for (const entry of await safeEntries(paths.staged, paths.root)) {
		if (!entry.info.isFile()) continue;
		const value = await readJson(entry.path);
		if (!validateStagedGroup(value)) continue;
		const manifestPath = queuePath(paths, "groups", value.queue_id);
		const manifestInfo = await pathKind(manifestPath);
		const manifest = manifestInfo ? await readJson(manifestPath) : null;
		if (manifestInfo) {
			if (
				!manifestInfo.isFile()
				|| manifestInfo.isSymbolicLink()
				|| !validateGroupManifest(manifest, value.queue_id)
				|| manifest.content_digest !== value.content_digest
				|| manifest.conversation_id !== value.conversation_id
			) throw new OutboxSecurityError("A staged delivery plan is corrupt or inconsistent.");
			groups.set(deliveryLifecycleKey(manifest.group_id, value.credential_fingerprint), {
				groupId: manifest.group_id,
				batchCount: manifest.batch_count,
				states: new Map(),
				inconsistent: false,
				conversationId: value.conversation_id,
				createdAt: value.created_at,
				deliveryOrder: Number.isSafeInteger(value.delivery_order) ? value.delivery_order : null,
				acceptedFingerprints: new Set(),
				stagedAnchor: true,
				recoverablePlan: true,
			});
		} else {
			const groupId = `staged:${value.queue_id}`;
			groups.set(deliveryLifecycleKey(groupId, value.credential_fingerprint), {
				groupId,
				batchCount: 1,
				states: new Map([[0, "staged"]]),
				inconsistent: false,
				conversationId: value.conversation_id,
				createdAt: value.created_at,
				deliveryOrder: Number.isSafeInteger(value.delivery_order) ? value.delivery_order : null,
				acceptedFingerprints: new Set(),
				stagedAnchor: true,
				aggregateOnly: true,
			});
		}
	}
	for (const directory of RAW_DIRECTORIES) {
		for (const entry of await safeEntries(paths[directory], paths.root)) {
			if (!entry.info.isFile()) continue;
			const value = await readJson(entry.path);
			if (validateEnvelope(value)) add(orderingDelivery(value), directory, {
				conversationId: value.request?.body?.conversationId,
				createdAt: value.created_at,
				deliveryOrder: value.delivery_order,
				credentialFingerprint: value.credential_fingerprint,
			});
		}
	}
	for (const directory of ["accepted", "done"]) {
		for (const entry of await safeEntries(paths[directory], paths.root)) {
			if (!entry.info.isFile()) continue;
			const value = await readJson(entry.path);
			if (validateTombstone(value)) add(normalizeDeliveryMetadata(value.delivery), directory === "done" ? "done" : "accepted", {
				conversationId: value.conversation_id,
				createdAt: value.group_created_at,
				deliveryOrder: value.delivery_order,
				credentialFingerprint: value.credential_fingerprint,
			});
		}
	}
	return groups;
}

function groupIsNonterminal(group) {
	// A permanent HTTP failure terminalizes the ordered group. Its protected raw
	// files remain for operator intervention, but it must not disable every newer
	// session in the same conversation forever.
	if ([...group.states.values()].includes("failed")) return false;
	return Boolean(group.stagedAnchor)
		|| [...group.states.values()].some((state) => state === "staged" || state === "pending" || state === "inflight");
}

function compareGroupPosition(left, right) {
	if (left.deliveryOrder != null && right.deliveryOrder != null && left.deliveryOrder !== right.deliveryOrder) {
		return left.deliveryOrder - right.deliveryOrder;
	}
	// Any entry without a sequence predates sequence allocation. If its timestamp
	// conflicts with newly sequenced work (including after wall-clock rollback),
	// keep the migrated entry first.
	if ((left.deliveryOrder == null) !== (right.deliveryOrder == null)) {
		return left.deliveryOrder == null ? -1 : 1;
	}
	if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
	return left.groupId.localeCompare(right.groupId);
}

function groupPrecedes(left, right) {
	return compareGroupPosition(left, right) < 0;
}

function deliveryReady(delivery, groups, credentialFingerprint) {
	if (!delivery) return true;
	const group = lifecycleGroup(groups, delivery, credentialFingerprint);
	if (!group || group.inconsistent || group.batchCount !== delivery.batchCount) return false;
	if ([...group.states.values()].includes("failed")) return false;
	if (!group.states.has(delivery.batchIndex)) return false;
	if (!group.recoverablePlan) {
		for (let index = 0; index < delivery.batchCount; index += 1) {
			if (!group.states.has(index)) return false;
		}
	}
	for (let index = 0; index < delivery.batchIndex; index += 1) {
		if (!["done", "accepted"].includes(group.states.get(index))) return false;
	}
	if (group.conversationId) {
		for (const candidate of groups.values()) {
			if (candidate === group || candidate.conversationId !== group.conversationId) continue;
			if (groupIsNonterminal(candidate) && groupPrecedes(candidate, group)) return false;
		}
	}
	return true;
}

function deliveryGroupKey(delivery, queueId) {
	return delivery?.groupId ?? `legacy:${String(queueId ?? "unknown")}`;
}

function summarizeDeliveryGroups(groups) {
	const summary = {
		active: 0,
		incomplete: 0,
		waitingOnPredecessor: 0,
		failed: 0,
	};
	for (const group of groups.values()) {
		if (group.aggregateOnly) continue;
		const states = [...group.states.values()];
		if (!group.stagedAnchor && !states.some((state) => RAW_DIRECTORIES.includes(state))) continue;
		summary.active += 1;
		const terminalFailed = states.includes("failed");
		const complete = !group.inconsistent
			&& Array.from({ length: group.batchCount }, (_unused, index) => group.states.has(index)).every(Boolean);
		if (!complete && !terminalFailed) summary.incomplete += 1;
		if (terminalFailed) summary.failed += 1;
		let waiting = !complete && !terminalFailed;
		if (!terminalFailed && complete && !waiting) {
			for (let index = 1; index < group.batchCount && !waiting; index += 1) {
				if (!["pending", "inflight"].includes(group.states.get(index))) continue;
				for (let prior = 0; prior < index; prior += 1) {
					if (!["done", "accepted"].includes(group.states.get(prior))) {
						waiting = true;
						break;
					}
				}
			}
		}
		if (!terminalFailed && !waiting && group.conversationId) {
			for (const candidate of groups.values()) {
				if (candidate === group || candidate.conversationId !== group.conversationId) continue;
				if (groupIsNonterminal(candidate) && groupPrecedes(candidate, group)) {
					waiting = true;
					break;
				}
			}
		}
		if (waiting) summary.waitingOnPredecessor += 1;
	}
	return summary;
}

async function materializeStagedGroups(paths, platform, currentFingerprint, now = Date.now(), {
	maxGroups = OUTBOX_LIMITS.maxMaterializationGroups,
	maxInputBytes = OUTBOX_LIMITS.maxMaterializationInputBytes,
} = {}) {
	const groupLimit = Math.max(0, Math.min(
		OUTBOX_LIMITS.maxRawCount,
		Number.isFinite(Number(maxGroups)) ? Math.floor(Number(maxGroups)) : OUTBOX_LIMITS.maxMaterializationGroups,
	));
	const inputLimit = Math.max(1, Number.isFinite(Number(maxInputBytes))
		? Math.floor(Number(maxInputBytes))
		: OUTBOX_LIMITS.maxMaterializationInputBytes);
	const result = { groups: 0, batches: 0, blocked: 0, deferred: 0, terminalFailed: 0, awaitingBinding: 0 };
	const blockedConversations = new Set();
	const stagedEntries = [];
	let attemptedGroups = 0;
	let attemptedBytes = 0;
	for (const entry of await safeEntries(paths.staged, paths.root)) {
		if (!entry.info.isFile()) throw new OutboxSecurityError("A staged delivery group is not a regular file.");
		if (entry.info.size > OUTBOX_LIMITS.maxStagedGroupBytes) throw new OutboxSecurityError("A staged delivery group exceeds its protected size bound.");
		const value = await readJson(entry.path);
		if (!validateStagedGroup(value) || entry.name !== `${value.queue_id}.json`) {
			throw new OutboxSecurityError("A staged delivery group is corrupt.");
		}
		stagedEntries.push({ entry, value });
	}
	stagedEntries.sort((left, right) => compareGroupPosition(
		{
			deliveryOrder: left.value.delivery_order,
			createdAt: Number(left.value.created_at),
			groupId: left.entry.name,
		},
		{
			deliveryOrder: right.value.delivery_order,
			createdAt: Number(right.value.created_at),
			groupId: right.entry.name,
		},
	));

	for (let stagedIndex = 0; stagedIndex < stagedEntries.length; stagedIndex += 1) {
		const staged = stagedEntries[stagedIndex];
		if (blockedConversations.has(staged.value.conversation_id)) {
			result.blocked += 1;
			continue;
		}
		if (!staged.value.credential_fingerprint || staged.value.credential_fingerprint !== currentFingerprint) {
			result.awaitingBinding += 1;
			blockedConversations.add(staged.value.conversation_id);
			continue;
		}
		try {
			const manifestPath = queuePath(paths, "groups", staged.value.queue_id);
			const readCompatibleManifest = async (expectedQueueIds = null, expectedGroupId = null) => {
				const info = await pathKind(manifestPath);
				if (!info) return null;
				if (!info.isFile() || info.isSymbolicLink()) throw new OutboxSecurityError("A delivery-group manifest is not a regular file.");
				const value = await readJson(manifestPath);
				if (!validateGroupManifest(value, staged.value.queue_id)) throw new OutboxSecurityError("A delivery-group manifest is corrupt.");
				if (
					value.content_digest !== staged.value.content_digest
					|| value.conversation_id !== staged.value.conversation_id
					|| value.credential_fingerprint !== staged.value.credential_fingerprint
					|| Number(value.created_at) !== Number(staged.value.created_at)
					|| (value.delivery_order ?? null) !== (staged.value.delivery_order ?? null)
					|| (expectedGroupId && value.group_id !== expectedGroupId)
					|| (expectedQueueIds && canonicalJson(value.queue_ids) !== canonicalJson(expectedQueueIds))
				) throw new OutboxSecurityError("A staged delivery group conflicts with its materialized manifest.");
				return value;
			};
			let manifest = await readCompatibleManifest();
			if (manifest) {
				let terminalFailed = false;
				for (const queueId of manifest.queue_ids) {
					if ((await lifecyclePath(paths, queueId))?.name === "failed") {
						terminalFailed = true;
						break;
					}
				}
				if (terminalFailed) {
					result.terminalFailed += 1;
					continue;
				}
			}
			if (
				attemptedGroups >= groupLimit
				|| (attemptedGroups > 0 && attemptedBytes + staged.entry.info.size > inputLimit)
			) {
				result.deferred += stagedEntries.length - stagedIndex;
				break;
			}
			attemptedGroups += 1;
			attemptedBytes += staged.entry.info.size;
			const prepared = {
				sessionHash: staged.value.session_hash,
				conversationId: staged.value.conversation_id,
				safeMessages: staged.value.messages,
				safeScope: staged.value.memory_scope,
				capture: staged.value.capture,
				redactions: {},
			};
			const group = buildEnvelopes({
				prepared,
				fingerprint: staged.value.credential_fingerprint,
				createdAt: staged.value.created_at,
				deliveryOrder: staged.value.delivery_order,
				legacyCaptureIdentity: staged.value.schema === LEGACY_STAGED_GROUP_SCHEMA,
			});
			const items = group.built.map((built) => ({
				...built,
				serializedBytes: Buffer.byteLength(canonicalJson(built.envelope), "utf8"),
			}));
			if (items.some((item) => item.serializedBytes > OUTBOX_LIMITS.maxEnvelopeBytes)) {
				throw new OutboxCapacityError("envelope_too_large", "A materialized local envelope exceeds 2 MiB.");
			}

			const expectedQueueIds = items.map((item) => item.envelope.queue_id);
			const expectedGroupId = items[0]?.envelope.request.body.delivery?.groupId ?? null;
			manifest = await readCompatibleManifest(expectedQueueIds, expectedGroupId);
			const missing = [];
			for (const item of items) {
				if (!await lifecyclePath(paths, item.envelope.queue_id)) missing.push(item);
			}
			missing.sort((left, right) =>
				Number(left.envelope.request.body.delivery?.batchIndex ?? 0)
				- Number(right.envelope.request.body.delivery?.batchIndex ?? 0));

			// Make the immutable/versioned plan durable before the first envelope.
			// This turns a partial materialization into an explicitly recoverable
			// ordered prefix rather than an ambiguous collection of batch files.
			const releasePlan = await acquireMutationLock(paths, 250);
			if (!releasePlan) {
				result.blocked += 1;
				blockedConversations.add(staged.value.conversation_id);
				continue;
			}
			try {
				if (missing.length > 0) {
					const usage = await rawUsage(paths);
					if (usage.count + 1 > OUTBOX_LIMITS.maxRawCount) {
						throw new OutboxCapacityError("outbox_count_full", "Materializing the next protected batch would exceed 128 raw entries.");
					}
					if (usage.bytes + missing[0].serializedBytes > OUTBOX_LIMITS.maxRawBytes) {
						throw new OutboxCapacityError("outbox_bytes_full", "Materializing the next protected batch would exceed 64 MiB.");
					}
				}
				manifest = await readCompatibleManifest(expectedQueueIds, expectedGroupId);
				if (!manifest) {
					manifest = manifestFromMaterialized(staged.value, group, now);
					await atomicJson(paths, platform, manifestPath, manifest, { exclusive: true });
				}
			} finally {
				await releasePlan();
			}
			// Leave a window longer than the lock waiter's 15 ms poll interval so a
			// concurrent SessionEnd is guaranteed an opportunity to append.
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));

			let lockInterrupted = false;
			for (const item of missing) {
				const releaseBatch = await acquireMutationLock(paths, 250);
				if (!releaseBatch) {
					lockInterrupted = true;
					break;
				}
				try {
					if (await lifecyclePath(paths, item.envelope.queue_id)) continue;
					const usage = await rawUsage(paths);
					if (usage.count + 1 > OUTBOX_LIMITS.maxRawCount) {
						throw new OutboxCapacityError("outbox_count_full", "Materializing the next protected batch would exceed 128 raw entries.");
					}
					if (usage.bytes + item.serializedBytes > OUTBOX_LIMITS.maxRawBytes) {
						throw new OutboxCapacityError("outbox_bytes_full", "Materializing the next protected batch would exceed 64 MiB.");
					}
					await atomicJson(
						paths,
						platform,
						queuePath(paths, "pending", item.envelope.queue_id),
						item.envelope,
						{ exclusive: true },
					);
					result.batches += 1;
				} finally {
					await releaseBatch();
				}
				await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
			}
			if (lockInterrupted) {
				result.blocked += 1;
				blockedConversations.add(staged.value.conversation_id);
				continue;
			}

			const releaseFinalize = await acquireMutationLock(paths, 250);
			if (!releaseFinalize) {
				result.blocked += 1;
				blockedConversations.add(staged.value.conversation_id);
				continue;
			}
			try {
				await readCompatibleManifest(expectedQueueIds, expectedGroupId);
				// All pre-existing siblings were validated before planning, and every
				// missing sibling was either observed or durably written above while the
				// drain lock excluded another materializer. The aggregate can now retire.
				await unlink(staged.entry.path);
				await syncDirectory(paths.staged, platform);
				result.groups += 1;
			} finally {
				await releaseFinalize();
			}
		} catch (error) {
			if (error instanceof OutboxCapacityError) {
				result.blocked += 1;
				blockedConversations.add(staged.value.conversation_id);
				continue;
			}
			throw error;
		}
	}
	return result;
}

async function gcOutbox(paths, now = Date.now()) {
	const activeGroups = await activeDeliveryGroups(paths);
	for (const entry of await safeEntries(paths.done, paths.root, { maxEntries: MAX_MAINTENANCE_ENTRIES })) {
		if (!entry.info.isFile() || now - entry.info.mtimeMs <= OUTBOX_LIMITS.doneRetentionMs) continue;
		const tombstone = await readJson(entry.path);
		const delivery = validateTombstone(tombstone) ? normalizeDeliveryMetadata(tombstone.delivery) : null;
		if (delivery && activeGroups.has(delivery.groupId)) continue;
		await unlink(entry.path);
	}
	for (const entry of await safeEntries(paths.groups, paths.root, { maxEntries: MAX_MAINTENANCE_ENTRIES })) {
		if (!entry.info.isFile() || now - entry.info.mtimeMs <= OUTBOX_LIMITS.doneRetentionMs) continue;
		const manifest = await readJson(entry.path);
		if (!validateGroupManifest(manifest) || entry.name !== `${manifest.queue_id}.json`) {
			throw new OutboxSecurityError("A delivery-group manifest is corrupt.");
		}
		if (activeGroups.has(manifest.group_id)) continue;
		await unlink(entry.path);
	}
	for (const entry of await safeEntries(paths.tmp, paths.root, { maxEntries: MAX_MAINTENANCE_ENTRIES })) {
		if (!entry.info.isFile()) throw new OutboxSecurityError();
		// A complete envelope temp is a crash-recovery copy, never disposable
		// garbage. Metadata temps may expire because the authoritative raw entry
		// remains in pending/inflight.
		const value = await readJson(entry.path);
		if (!validateEnvelope(value) && now - entry.info.mtimeMs > OUTBOX_LIMITS.tmpRetentionMs) await unlink(entry.path);
	}
}

async function enqueueDeferredSession({
	paths,
	actualPlatform,
	messages,
	sessionId,
	memoryScope,
	captureMetadata,
	fingerprint,
	now,
}) {
	const prepared = prepareSession({ messages, sessionId, memoryScope, captureMetadata });
	let staged = buildStagedGroup({ prepared, fingerprint, now });
	const legacyStaged = buildStagedGroup({ prepared, fingerprint, now, legacyCaptureIdentity: true });
	let serializedBytes = 0;

	const release = await acquireMutationLock(paths, 250);
	if (!release) throw new OutboxError("outbox_busy", "Another hook is updating the local outbox.");
	try {
		let stagedPath = queuePath(paths, "staged", staged.queueId);
		let manifestPath = queuePath(paths, "groups", staged.queueId);
		let stagedInfo = await pathKind(stagedPath);
		let manifestInfo = await pathKind(manifestPath);
		if (!stagedInfo && !manifestInfo && legacyStaged.queueId !== staged.queueId) {
			const legacyStagedPath = queuePath(paths, "staged", legacyStaged.queueId);
			const legacyManifestPath = queuePath(paths, "groups", legacyStaged.queueId);
			const legacyStagedInfo = await pathKind(legacyStagedPath);
			const legacyManifestInfo = await pathKind(legacyManifestPath);
			if (legacyStagedInfo || legacyManifestInfo) {
				staged = legacyStaged;
				stagedPath = legacyStagedPath;
				manifestPath = legacyManifestPath;
				stagedInfo = legacyStagedInfo;
				manifestInfo = legacyManifestInfo;
			}
		}
		if (!stagedInfo && !manifestInfo) {
			const legacyReplay = await findLegacyReplay(paths, prepared);
			if (legacyReplay) {
				staged = buildStagedGroup({
					prepared: { ...prepared, capture: legacyReplay.capture },
					fingerprint: legacyReplay.credentialFingerprint,
					now,
					legacyCaptureIdentity: true,
				});
				if (staged.queueId !== legacyReplay.queueId) {
					throw new OutboxSecurityError("A v1 replay candidate failed its historical identity check.");
				}
				stagedPath = queuePath(paths, "staged", staged.queueId);
				manifestPath = queuePath(paths, "groups", staged.queueId);
				stagedInfo = await pathKind(stagedPath);
				manifestInfo = await pathKind(manifestPath);
			}
		}
		let existingStaged = null;
		let manifest = null;
		if (stagedInfo) {
			if (!stagedInfo.isFile() || stagedInfo.isSymbolicLink()) throw new OutboxSecurityError("A staged delivery group is not a regular file.");
			existingStaged = await readJson(stagedPath);
			if (!validateStagedGroup(existingStaged, staged.queueId)) throw new OutboxSecurityError("A staged delivery group is corrupt.");
			if (existingStaged.content_digest !== staged.value.content_digest) throw new OutboxSecurityError("A staged delivery identity conflicts with different content.");
		}
		if (manifestInfo) {
			if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) throw new OutboxSecurityError("A delivery-group manifest is not a regular file.");
			manifest = await readJson(manifestPath);
			if (!validateGroupManifest(manifest, staged.queueId)) throw new OutboxSecurityError("A delivery-group manifest is corrupt.");
			if (manifest.content_digest !== staged.value.content_digest) throw new OutboxSecurityError("A delivery-group manifest conflicts with different content.");
		}

		const lifecycle = [];
		for (const queueId of manifest?.queue_ids ?? []) lifecycle.push(await lifecyclePath(paths, queueId));
		const missingMaterialized = manifest
			? lifecycle.filter((entry) => !entry).length
			: 0;
		const needsStage = !existingStaged && (!manifest || missingMaterialized > 0);
		if (needsStage) {
			if (manifest) {
				// A crash-repair aggregate resumes the immutable materialization plan;
				// retry-time clocks must not create a second ordering identity.
				staged.value.created_at = manifest.created_at;
				if (manifest.delivery_order == null) delete staged.value.delivery_order;
				else staged.value.delivery_order = manifest.delivery_order;
			} else {
				staged.value.delivery_order = await claimDeliveryOrder(paths, actualPlatform, now);
			}
			const serialized = Buffer.from(canonicalJson(staged.value), "utf8");
			serializedBytes = serialized.length;
			if (serializedBytes > OUTBOX_LIMITS.maxStagedGroupBytes) {
				throw new OutboxCapacityError(
					"staged_group_too_large",
					"The protected shutdown snapshot exceeds the 16 MiB staged-group limit.",
				);
			}
			const usage = await rawUsage(paths);
			const deferredCountLimit = OUTBOX_LIMITS.maxRawCount - OUTBOX_LIMITS.materializationReserveEntries;
			const deferredByteLimit = OUTBOX_LIMITS.maxRawBytes - OUTBOX_LIMITS.materializationReserveBytes;
			if (usage.count + 1 > deferredCountLimit) {
				throw new OutboxCapacityError("outbox_count_full", "The protected local outbox has filled its 127 deferred-entry slots; one delivery slot remains reserved for safe materialization.");
			}
			if (usage.bytes + serializedBytes > deferredByteLimit) {
				throw new OutboxCapacityError("outbox_bytes_full", "The protected local outbox has filled its 48 MiB enqueue allowance; 16 MiB remains reserved for crash-safe staged-group mutation.");
			}
			await atomicJson(paths, actualPlatform, stagedPath, staged.value, { exclusive: true, serialized });
			existingStaged = staged.value;
		}

		const states = lifecycle.filter(Boolean).map((entry) => entry.name);
		const acceptedBatches = states.filter((state) => state === "accepted" || state === "done").length;
		const failedBatches = states.filter((state) => state === "failed").length;
		return {
			queued: Boolean(existingStaged) || states.some((state) => state === "pending" || state === "inflight"),
			duplicate: !needsStage,
			state: existingStaged ? "staged" : (new Set(states).size === 1 ? states[0] : "mixed"),
			queueId: staged.queueId,
			queueIds: manifest?.queue_ids ?? [staged.queueId],
			batchCount: manifest?.batch_count ?? null,
			queuedBatches: needsStage ? 1 : 0,
			duplicateBatches: needsStage ? 0 : (manifest?.batch_count ?? 1),
			failedBatches,
			acceptedBatches,
			bytes: needsStage ? serializedBytes : 0,
			bound: Boolean(fingerprint) && (existingStaged?.credential_fingerprint ?? manifest?.credential_fingerprint) === fingerprint,
			credentialMismatch: Boolean(
				fingerprint
				&& (existingStaged?.credential_fingerprint ?? manifest?.credential_fingerprint)
				&& (existingStaged?.credential_fingerprint ?? manifest?.credential_fingerprint) !== fingerprint
			),
			redactions: staged.redactions,
			...staged.stats,
			...(manifest?.stats ?? {}),
			staged: Boolean(existingStaged),
		};
	} catch (error) {
		if (error?.code === "ENOSPC" || error?.code === "EDQUOT") {
			throw new OutboxCapacityError("outbox_disk_full", "The disk has no room for the protected local group.");
		}
		throw error;
	} finally {
		await release();
	}
}

/** Atomically queue one scrubbed session. This function has no network path. */
export async function enqueueSession({
	pluginData,
	messages,
	sessionId,
	memoryScope,
	captureMetadata = null,
	deferMaterialization = false,
	credentialFingerprint: fingerprint = null,
	now = Date.now,
	platform,
	securityRunner,
} = {}) {
	const { paths, platform: actualPlatform } = await ensureOutbox(pluginData, {
		platform,
		securityRunner,
		securityMode: "directories",
	});
	if (deferMaterialization) {
		return enqueueDeferredSession({
			paths,
			actualPlatform,
			messages,
			sessionId,
			memoryScope,
			captureMetadata,
			fingerprint,
			now,
		});
	}
	const group = buildEnvelopes({ messages, sessionId, memoryScope, fingerprint, captureMetadata, now });
	const items = group.built.map((built) => ({
		...built,
		serializedBytes: Buffer.byteLength(canonicalJson(built.envelope), "utf8"),
	}));
	if (items.some((item) => item.serializedBytes > OUTBOX_LIMITS.maxEnvelopeBytes)) {
		throw new OutboxCapacityError("envelope_too_large", "A protected local envelope exceeds 2 MiB.");
	}

	const release = await acquireMutationLock(paths, 250);
	if (!release) throw new OutboxError("outbox_busy", "Another hook is updating the local outbox.");
	try {
		const existing = [];
		const missing = [];
		for (const item of items) {
			const lifecycle = await lifecyclePath(paths, item.envelope.queue_id);
			if (!lifecycle) {
				missing.push(item);
				continue;
			}
			let existingFingerprint = null;
			if (RAW_DIRECTORIES.includes(lifecycle.name)) {
				const envelope = await readJson(lifecycle.path);
				const state = await stateFor(paths, item.envelope.queue_id);
				existingFingerprint = state.binding_fingerprint ?? envelope?.credential_fingerprint ?? null;
			}
			existing.push({
				...lifecycle,
				queueId: item.envelope.queue_id,
				bound: lifecycle.name === "done" || lifecycle.name === "accepted" || Boolean(existingFingerprint),
				credentialMismatch: Boolean(fingerprint && existingFingerprint && fingerprint !== existingFingerprint),
			});
		}
		const existingOrders = new Set(existing
			.map((item) => item.value?.delivery_order)
			.filter((value) => Number.isSafeInteger(value) && value >= 0));
		if (existingOrders.size > 1) {
			throw new OutboxSecurityError("An ordered delivery group has conflicting local sequence numbers.");
		}
		// Eager v2 callers remain supported. Give every wholly new group a durable
		// enqueue order under the same mutation lock, and reuse a surviving sibling's
		// order during partial repair. Pre-order envelopes keep their created-at
		// fallback instead of being incorrectly promoted behind newer work.
		const groupOrder = existingOrders.size === 1
			? [...existingOrders][0]
			: (existing.length === 0 && missing.length > 0
				? await claimDeliveryOrder(paths, actualPlatform, now)
				: null);
		if (groupOrder != null) {
			for (const item of missing) {
				item.envelope = { ...item.envelope, delivery_order: groupOrder };
				item.serializedBytes = Buffer.byteLength(canonicalJson(item.envelope), "utf8");
			}
		}
		if (missing.some((item) => item.serializedBytes > OUTBOX_LIMITS.maxEnvelopeBytes)) {
			throw new OutboxCapacityError("envelope_too_large", "A protected local envelope exceeds 2 MiB.");
		}
		const usage = await rawUsage(paths);
		const eagerCountLimit = OUTBOX_LIMITS.maxRawCount - OUTBOX_LIMITS.materializationReserveEntries;
		const eagerByteLimit = OUTBOX_LIMITS.maxRawBytes - OUTBOX_LIMITS.materializationReserveBytes;
		if (usage.count + missing.length > eagerCountLimit) {
			throw new OutboxCapacityError("outbox_count_full", "The protected local outbox has filled its 127 enqueue slots; one slot remains reserved for crash-safe queue mutation.");
		}
		const addedBytes = missing.reduce((sum, item) => sum + item.serializedBytes, 0);
		if (usage.bytes + addedBytes > eagerByteLimit) {
			throw new OutboxCapacityError("outbox_bytes_full", "The protected local outbox has filled its 48 MiB enqueue allowance; 16 MiB remains reserved for crash-safe staged-group mutation.");
		}
		// Write the final batch first and batch zero (the commit marker) last. The
		// drainer requires a complete 0..N-1 group, so a killed SessionEnd can
		// never deliver a silently partial conversation.
		for (const item of missing.slice().sort((left, right) =>
			Number(right.envelope.request.body.delivery?.batchIndex ?? 0)
			- Number(left.envelope.request.body.delivery?.batchIndex ?? 0))) {
			const destination = queuePath(paths, "pending", item.envelope.queue_id);
			await atomicJson(paths, actualPlatform, destination, item.envelope, { exclusive: true });
		}
		const states = [...existing.map((item) => item.name), ...missing.map(() => "pending")];
		const distinctStates = [...new Set(states)];
		return {
			queued: states.some((state) => state === "pending" || state === "inflight"),
			duplicate: missing.length === 0,
			state: distinctStates.length === 1 ? distinctStates[0] : "mixed",
			queueId: items[0].envelope.queue_id,
			queueIds: items.map((item) => item.envelope.queue_id),
			batchCount: items.length,
			queuedBatches: missing.length,
			duplicateBatches: existing.length,
			failedBatches: states.filter((state) => state === "failed").length,
			acceptedBatches: states.filter((state) => state === "accepted" || state === "done").length,
			bytes: addedBytes,
			bound: Boolean(fingerprint) && existing.every((item) => item.bound),
			credentialMismatch: existing.some((item) => item.credentialMismatch),
			redactions: group.redactions,
			...group.stats,
		};
	} catch (error) {
		if (error?.code === "ENOSPC" || error?.code === "EDQUOT") {
			throw new OutboxCapacityError("outbox_disk_full", "The disk has no room for the protected local envelope.");
		}
		throw error;
	} finally {
		await release();
	}
}

async function recoverTmp(paths) {
	for (const entry of await safeEntries(paths.tmp, paths.root)) {
		if (!entry.info.isFile()) throw new OutboxSecurityError();
		const value = await readJson(entry.path);
		if (validateStagedGroup(value)) {
			const destination = queuePath(paths, "staged", value.queue_id);
			if (await pathKind(destination)) await unlink(entry.path);
			else await rename(entry.path, destination);
			continue;
		}
		if (validateGroupManifest(value)) {
			const destination = queuePath(paths, "groups", value.queue_id);
			if (await pathKind(destination)) await unlink(entry.path);
			else await rename(entry.path, destination);
			continue;
		}
		if (validateDeliverySequence(value)) {
			const destination = join(paths.control, "delivery-sequence.json");
			if (await pathKind(destination)) await unlink(entry.path);
			else await rename(entry.path, destination);
			continue;
		}
		if (validateEnvelope(value)) {
			const existing = await lifecyclePath(paths, value.queue_id);
			if (existing) await unlink(entry.path);
			else await rename(entry.path, queuePath(paths, "pending", value.queue_id));
		}
	}
}

async function finalizeAccepted(paths, platform) {
	let finalized = 0;
	for (const entry of await safeEntries(paths.accepted, paths.root)) {
		if (!entry.info.isFile()) throw new OutboxSecurityError();
		const tombstone = await readJson(entry.path);
		if (!validateTombstone(tombstone) || entry.name !== `${tombstone.queue_id}.json`) {
			throw new OutboxSecurityError("An acceptance tombstone is corrupt.");
		}
		await unlink(queuePath(paths, "inflight", tombstone.queue_id)).catch((error) => {
			if (error?.code !== "ENOENT") throw error;
		});
		const destination = queuePath(paths, "done", tombstone.queue_id);
		if (await pathKind(destination)) {
			const existing = await readJson(destination);
			if (!validateTombstone(existing, tombstone.queue_id)) throw new OutboxSecurityError("A completion tombstone is corrupt.");
			await unlink(entry.path);
		} else await rename(entry.path, destination);
		await syncFile(destination);
		await syncDirectory(paths.done, platform);
		await unlink(queuePath(paths, "state", tombstone.queue_id)).catch(() => {});
		finalized += 1;
	}
	return finalized;
}

async function recoverInflight(paths) {
	for (const entry of await safeEntries(paths.inflight, paths.root)) {
		if (!entry.info.isFile()) throw new OutboxSecurityError();
		const envelope = await readJson(entry.path);
		if (!validateEnvelope(envelope) || entry.name !== `${envelope.queue_id}.json`) {
			throw new OutboxSecurityError("An inflight envelope is corrupt.");
		}
		const destination = queuePath(paths, "pending", envelope.queue_id);
		if (await pathKind(destination)) await unlink(entry.path);
		else await rename(entry.path, destination);
	}
}

async function stateFor(paths, queueId) {
	const path = queuePath(paths, "state", queueId);
	const info = await pathKind(path);
	if (!info) return { schema: STATE_SCHEMA, queue_id: queueId, attempts: 0 };
	if (!info.isFile() || info.isSymbolicLink()) throw new OutboxSecurityError("An outbox state entry is not a regular file.");
	const value = await readJson(path);
	if (!validateState(value, queueId)) throw new OutboxSecurityError("An outbox state entry is corrupt.");
	return value;
}

async function writeState(paths, platform, queueId, value) {
	if (!validQueueId(queueId)) throw new OutboxSecurityError();
	await atomicJson(paths, platform, queuePath(paths, "state", queueId), {
		...value,
		schema: STATE_SCHEMA,
		queue_id: queueId,
	});
}

function retryAfterMs(response, now) {
	const raw = response?.headers?.get?.("retry-after");
	if (!raw) return null;
	let milliseconds;
	if (/^\d+(?:\.\d+)?$/.test(raw.trim())) milliseconds = Number(raw) * 1_000;
	else {
		const date = Date.parse(raw);
		milliseconds = Number.isFinite(date) ? date - now : NaN;
	}
	if (!Number.isFinite(milliseconds)) return null;
	return Math.max(1_000, Math.min(milliseconds, 24 * 60 * 60 * 1000));
}

function backoffMs(queueId, attempts) {
	const base = Math.min(5_000 * (2 ** Math.max(0, attempts - 1)), 60 * 60 * 1000);
	const unit = Number.parseInt(sha256(`${queueId}:${attempts}`).slice(0, 8), 16) / 0xffffffff;
	return Math.round(base * (0.8 + unit * 0.4));
}

async function readBoundedResponseText(response, controller, maxBytes = 64 * 1024) {
	if (!response.body?.getReader) {
		const text = await response.text();
		return Buffer.byteLength(text, "utf8") <= maxBytes ? text : null;
	}
	const reader = response.body.getReader();
	const chunks = [];
	let bytes = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		const chunk = Buffer.from(value);
		bytes += chunk.length;
		if (bytes > maxBytes) {
			controller.abort();
			void reader.cancel().catch(() => {});
			return null;
		}
		chunks.push(chunk);
	}
	return Buffer.concat(chunks, bytes).toString("utf8");
}

async function boundedFetch(fetchFn, url, init, timeoutMs) {
	const controller = new AbortController();
	let timer;
	const timeout = new Promise((_, rejectPromise) => {
		timer = setTimeout(() => {
			controller.abort();
			rejectPromise(Object.assign(new Error("request timeout"), { name: "TimeoutError", code: "timeout" }));
		}, timeoutMs);
	});
	try {
		return await Promise.race([
			Promise.resolve().then(async () => {
				const response = await fetchFn(url, { ...init, signal: controller.signal, redirect: "manual" });
				const text = await readBoundedResponseText(response, controller);
				return { response, text };
			}),
			timeout,
		]);
	} finally {
		clearTimeout(timer);
	}
}

function safeAcceptance(data, responseStatus) {
	if (!data || data.ok !== true) return null;
	const sourcePacketId = serverIdentifier(data.source_packet_id, "src");
	const receiptId = serverIdentifier(data.receipt_id, "receipt") ?? serverIdentifier(data.receipt?.id, "receipt");
	const jobId = serverIdentifier(data.job_id, "job");
	// A bare duplicate flag is not durable evidence: it can be emitted by a
	// proxy/error wrapper with no correlated accepted write. Keep raw data until
	// the service returns a packet or receipt identifier.
	if (!sourcePacketId && !receiptId) return null;
	return {
		schema: TOMBSTONE_SCHEMA,
		http_status: responseStatus,
		source_packet_id: sourcePacketId,
		receipt_id: receiptId,
		job_id: jobId,
		status: safeIdentifier(data.status, 80) ?? "accepted",
		duplicate: data.duplicate === true,
	};
}

function reasonForResponse(status) {
	if (status === 401 || status === 403) return "credential_rejected";
	if (status === 429) return "rate_limited";
	if (status >= 500) return "server_error";
	return `http_${status}`;
}

/**
 * Deliver a bounded number of entries. Transient failures never age out and
 * never have an attempt-count cutoff.
 */
export async function drainOutbox({
	pluginData,
	apiKey,
	baseUrl = DEFAULT_DELIVERY_BASE_URL,
	fetchFn = globalThis.fetch,
	maxItems = OUTBOX_LIMITS.maxDrainItems,
	maxDurationMs = OUTBOX_LIMITS.drainBudgetMs,
	requestTimeoutMs = OUTBOX_LIMITS.requestTimeoutMs,
	maxTotalDurationMs = Infinity,
	maxMaterializationGroups = OUTBOX_LIMITS.maxMaterializationGroups,
	maxMaterializationInputBytes = OUTBOX_LIMITS.maxMaterializationInputBytes,
	now = Date.now,
	platform,
	securityRunner,
} = {}) {
	const wallStartedAt = Date.now();
	const totalDuration = Number.isFinite(Number(maxTotalDurationMs))
		? Math.max(1, Number(maxTotalDurationMs))
		: Infinity;
	const wallDeadline = totalDuration === Infinity ? Infinity : wallStartedAt + totalDuration;
	const normalizedBaseUrl = normalizeDeliveryBaseUrl(baseUrl);
	const currentFingerprint = credentialFingerprint(apiKey, normalizedBaseUrl);
	const result = {
		delivered: 0,
		deliveredBatches: 0,
		deliveredGroups: 0,
		retried: 0,
		retriedBatches: 0,
		retriedGroups: 0,
		permanentFailures: 0,
		permanentFailureBatches: 0,
		permanentFailureGroups: 0,
		authBlocked: false,
		bindingRequired: 0,
		credentialMismatch: 0,
		backoffSkipped: 0,
		transportUnavailable: false,
		busy: false,
		orderBlocked: 0,
		orderBlockedBatches: 0,
		orderBlockedGroups: 0,
		materializedGroups: 0,
		materializedBatches: 0,
		materializationBlocked: 0,
		materializationDeferred: 0,
		terminalFailedGroups: 0,
		completedDeliveryGroups: 0,
		accepted: [],
	};
	const outcomeGroups = {
		delivered: new Set(),
		retried: new Set(),
		permanentFailure: new Set(),
		orderBlocked: new Set(),
	};
	const completedGroups = new Set();
	const markGroup = (outcome, delivery, queueId) => {
		const groupField = `${outcome}Groups`;
		const groups = outcomeGroups[outcome];
		const key = deliveryGroupKey(delivery, queueId);
		if (!groups.has(key)) {
			groups.add(key);
			result[groupField] += 1;
		}
	};
	const { paths, platform: actualPlatform } = await ensureOutbox(pluginData, {
		platform,
		securityRunner,
		securityMode: "all",
	});
	const release = await acquireLock(paths, "drain.lock", { waitMs: 0 });
	if (!release) return {
		...result,
		busy: true,
		health: await inspectOutbox({ pluginData, apiKey, baseUrl: normalizedBaseUrl, platform, securityRunner, _skipSecurity: true }),
	};
	try {
		const pending = [];
		let deliveryGroups = new Map();
		const authBlockPath = join(paths.control, "auth-block.json");
		const releaseInitialMutation = await acquireMutationLock(paths, 250);
		if (!releaseInitialMutation) {
			return { ...result, busy: true, health: await inspectOutbox({ pluginData, apiKey, baseUrl: normalizedBaseUrl, platform, securityRunner, _skipSecurity: true }) };
		}
		try {
			await recoverTmp(paths);
			await finalizeAccepted(paths, actualPlatform);
			await recoverInflight(paths);
			await gcOutbox(paths, Number(now()));

			if (!currentFingerprint) {
				const health = await inspectOutbox({ pluginData, apiKey, baseUrl: normalizedBaseUrl, platform, securityRunner, _skipSecurity: true });
				return { ...result, bindingRequired: health.bindingRequired, health };
			}

			const authBlockInfo = await pathKind(authBlockPath);
			if (authBlockInfo && (!authBlockInfo.isFile() || authBlockInfo.isSymbolicLink())) {
				throw new OutboxSecurityError("The outbox authentication pause is not a regular file.");
			}
			const authBlock = authBlockInfo ? await readJson(authBlockPath) : null;
			if (authBlockInfo && !validateAuthBlock(authBlock)) {
				throw new OutboxSecurityError("The outbox authentication pause is corrupt.");
			}
			if (authBlock?.credential_fingerprint && authBlock.credential_fingerprint !== currentFingerprint) {
				await unlink(authBlockPath).catch(() => {});
			} else if (
				authBlock?.credential_fingerprint === currentFingerprint
				&& Number(now()) - Number(authBlock.created_at ?? 0) < AUTH_PAUSE_MS
			) {
				result.authBlocked = true;
				return { ...result, health: await inspectOutbox({ pluginData, apiKey, baseUrl: normalizedBaseUrl, platform, securityRunner, _skipSecurity: true }) };
			} else if (authBlock?.credential_fingerprint === currentFingerprint) {
				await unlink(authBlockPath).catch(() => {});
			}

		} finally {
			await releaseInitialMutation();
		}

		// Unicode segmentation and request construction can be the dominant work
		// for an 8 MiB snapshot. Do it outside the short mutation critical section
		// so a concurrent SessionEnd can still durably append its one staged file.
		const materialized = await materializeStagedGroups(paths, actualPlatform, currentFingerprint, now, {
			maxGroups: maxMaterializationGroups,
			maxInputBytes: maxMaterializationInputBytes,
		});
		result.materializedGroups = materialized.groups;
		result.materializedBatches = materialized.batches;
		result.materializationBlocked = materialized.blocked;
		result.materializationDeferred = materialized.deferred;
		result.terminalFailedGroups = materialized.terminalFailed;
		result.bindingRequired += materialized.awaitingBinding;

		const releaseSnapshot = await acquireMutationLock(paths, 250);
		if (!releaseSnapshot) {
			return { ...result, busy: true, health: await inspectOutbox({ pluginData, apiKey, baseUrl: normalizedBaseUrl, platform, securityRunner, _skipSecurity: true }) };
		}
		try {
			deliveryGroups = await deliveryLifecycle(paths);
			for (const entry of await safeEntries(paths.pending, paths.root)) {
				if (!entry.info.isFile()) throw new OutboxSecurityError();
				const envelope = await readJson(entry.path);
				pending.push({
					entry,
					envelope,
					delivery: validateEnvelope(envelope) ? orderingDelivery(envelope) : null,
					createdAt: Number(envelope?.created_at ?? entry.info.mtimeMs),
					deliveryOrder: Number.isSafeInteger(envelope?.delivery_order) ? envelope.delivery_order : null,
				});
			}
		} finally {
			await releaseSnapshot();
		}
		const groupSortTimes = new Map();
		for (const item of pending) {
			if (!item.delivery) continue;
			const prior = groupSortTimes.get(item.delivery.groupId);
			groupSortTimes.set(item.delivery.groupId, prior === undefined ? item.createdAt : Math.min(prior, item.createdAt));
		}
		pending.sort((left, right) => {
			const byGroup = compareGroupPosition(
				{
					deliveryOrder: left.deliveryOrder,
					createdAt: left.delivery ? groupSortTimes.get(left.delivery.groupId) : left.createdAt,
					groupId: left.delivery?.groupId ?? `legacy:${left.entry.name}`,
				},
				{
					deliveryOrder: right.deliveryOrder,
					createdAt: right.delivery ? groupSortTimes.get(right.delivery.groupId) : right.createdAt,
					groupId: right.delivery?.groupId ?? `legacy:${right.entry.name}`,
				},
			);
			if (byGroup) return byGroup;
			return Number(left.delivery?.batchIndex ?? 0) - Number(right.delivery?.batchIndex ?? 0)
				|| left.entry.name.localeCompare(right.entry.name);
		});
		// Local security/recovery work is not charged against the bounded network
		// delivery window. The host-level SessionStart deadline still bounds both.
		const wallRemaining = Math.max(0, wallDeadline - Date.now());
		const networkBudget = Math.max(0, Math.min(Number(maxDurationMs), wallRemaining));
		const deadline = Number(now()) + networkBudget;

		let requests = 0;
		for (const item of pending) {
			if (
				requests >= Math.min(maxItems, OUTBOX_LIMITS.maxDrainItems)
				|| Number(now()) >= deadline
				|| Date.now() >= wallDeadline
			) break;
			const envelope = item.envelope;
			if (!validateEnvelope(envelope) || item.entry.name !== `${envelope.queue_id}.json`) {
				const quarantineName = `corrupt_${sha256(item.entry.name).slice(0, 16)}_${randomUUID()}.json`;
				const releaseMutation = await acquireMutationLock(paths, 250);
				if (!releaseMutation) { result.busy = true; break; }
				try { await rename(item.entry.path, join(paths.failed, quarantineName)); }
				finally { await releaseMutation(); }
				result.permanentFailures += 1;
				result.permanentFailureBatches += 1;
				markGroup("permanentFailure", null, item.entry.name);
				continue;
			}
			const delivery = item.delivery ?? orderingDelivery(envelope);
			const state = await stateFor(paths, envelope.queue_id);
			const effectiveFingerprint = state.binding_fingerprint ?? envelope.credential_fingerprint ?? null;
			if (!effectiveFingerprint) {
				result.bindingRequired += 1;
				continue;
			}
			const effectiveQueueId = queueIdFor(contentDigestFromRequest(envelope.request), effectiveFingerprint);
			if (effectiveQueueId !== envelope.queue_id) {
				// Older sidecar-only bindings are intentionally not deliverable. An
				// explicit bind atomically re-keys the immutable envelope first.
				result.bindingRequired += 1;
				continue;
			}
			if (effectiveFingerprint !== currentFingerprint) {
				result.bindingRequired += 1;
				result.credentialMismatch += 1;
				continue;
			}
			if (Number(state.next_attempt_at ?? 0) > Number(now())) {
				result.backoffSkipped += 1;
				continue;
			}
			if (!deliveryReady(delivery, deliveryGroups, envelope.credential_fingerprint)) {
				result.orderBlocked += 1;
				result.orderBlockedBatches += 1;
				markGroup("orderBlocked", delivery, envelope.queue_id);
				continue;
			}

			const inflightPath = queuePath(paths, "inflight", envelope.queue_id);
			const releaseClaim = await acquireMutationLock(paths, 250);
			if (!releaseClaim) { result.busy = true; break; }
			try {
				if (!await pathKind(item.entry.path)) continue;
				await rename(item.entry.path, inflightPath);
			} finally {
				await releaseClaim();
			}
			requests += 1;
			const attempts = Number(state.attempts ?? 0) + 1;
			let response;
			let responseData = null;
			let transportError = null;
			const remaining = Math.max(1, Math.min(deadline - Number(now()), wallDeadline - Date.now()));
			try {
				const fetched = await boundedFetch(fetchFn, `${normalizedBaseUrl}${envelope.request.path}`, {
					method: "POST",
					headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
					body: JSON.stringify(envelope.request.body),
				}, Math.min(requestTimeoutMs, remaining));
				response = fetched.response;
				if (fetched.text !== null) {
					try { responseData = JSON.parse(fetched.text); } catch {}
				}
			} catch (error) {
				transportError = error;
			}

			const releaseCompletion = await acquireMutationLock(paths, 250);
			if (!releaseCompletion) { result.busy = true; break; }
			try {
				if (transportError) {
					const retryMs = backoffMs(envelope.queue_id, attempts);
					await writeState(paths, actualPlatform, envelope.queue_id, {
						attempts,
						next_attempt_at: Number(now()) + retryMs,
						last_error_code: safeErrorCode(transportError?.code ?? transportError?.cause?.code),
						updated_at: Number(now()), binding_fingerprint: effectiveFingerprint,
					});
					await rename(inflightPath, queuePath(paths, "pending", envelope.queue_id));
					result.retried += 1;
					result.retriedBatches += 1;
					markGroup("retried", delivery, envelope.queue_id);
					result.transportUnavailable = true;
					break;
				}

				const accepted = response.ok ? safeAcceptance(responseData, response.status) : null;
				if (accepted) {
					const contentDigest = contentDigestFromRequest(envelope.request);
					const wireDelivery = delivery?.legacy ? null : delivery;
					const tombstone = {
						...accepted,
						...(wireDelivery ? { delivery: wireDelivery } : {}),
						...(wireDelivery ? {
							conversation_id: envelope.request.body.conversationId,
							group_created_at: envelope.created_at,
							...(envelope.delivery_order == null ? {} : { delivery_order: envelope.delivery_order }),
						} : {}),
						queue_id: envelope.queue_id,
						credential_fingerprint: effectiveFingerprint,
						content_digest: contentDigest,
						accepted_at: Number(now()),
					};
					await atomicJson(paths, actualPlatform, queuePath(paths, "accepted", envelope.queue_id), tombstone, { exclusive: true });
					await unlink(inflightPath);
					const donePath = queuePath(paths, "done", envelope.queue_id);
					await rename(queuePath(paths, "accepted", envelope.queue_id), donePath);
					await syncFile(donePath);
					await unlink(queuePath(paths, "state", envelope.queue_id)).catch(() => {});
					result.delivered += 1;
					result.deliveredBatches += 1;
					markGroup("delivered", delivery, envelope.queue_id);
					if (delivery) {
						const group = lifecycleGroup(deliveryGroups, delivery, envelope.credential_fingerprint);
						group?.states.set(delivery.batchIndex, "done");
						if (
							group
							&& !group.inconsistent
							&& group.states.size === group.batchCount
							&& [...group.states.values()].every((state) => state === "done" || state === "accepted")
							&& !completedGroups.has(delivery.groupId)
						) {
							completedGroups.add(delivery.groupId);
							result.completedDeliveryGroups += 1;
						}
					} else {
						const legacyGroup = deliveryGroupKey(null, envelope.queue_id);
						if (!completedGroups.has(legacyGroup)) {
							completedGroups.add(legacyGroup);
							result.completedDeliveryGroups += 1;
						}
					}
					result.accepted.push({
						queueId: envelope.queue_id,
						sourcePacketId: accepted.source_packet_id,
						receiptId: accepted.receipt_id,
						jobId: accepted.job_id,
						status: accepted.status,
						...(wireDelivery ? { delivery: wireDelivery } : {}),
					});
					continue;
				}

				const status = Number(response.status);
				if (status === 401 || status === 403) {
					await writeState(paths, actualPlatform, envelope.queue_id, {
						attempts, last_error_code: "credential_rejected", updated_at: Number(now()), binding_fingerprint: effectiveFingerprint,
					});
					await rename(inflightPath, queuePath(paths, "pending", envelope.queue_id));
					await atomicJson(paths, actualPlatform, authBlockPath, {
						schema: "itsuki.outbox-auth-block/v1",
						credential_fingerprint: currentFingerprint,
						created_at: Number(now()),
						http_status: status,
					});
					result.authBlocked = true;
					break;
				}

				if (RETRY_HTTP_ERRORS.has(status) || status >= 500) {
					const retryMs = retryAfterMs(response, Number(now())) ?? backoffMs(envelope.queue_id, attempts);
					await writeState(paths, actualPlatform, envelope.queue_id, {
						attempts, next_attempt_at: Number(now()) + retryMs, last_error_code: reasonForResponse(status),
						last_http_status: status, updated_at: Number(now()), binding_fingerprint: effectiveFingerprint,
					});
					await rename(inflightPath, queuePath(paths, "pending", envelope.queue_id));
					if (delivery) lifecycleGroup(deliveryGroups, delivery, envelope.credential_fingerprint)?.states.set(delivery.batchIndex, "pending");
					result.retried += 1;
					result.retriedBatches += 1;
					markGroup("retried", delivery, envelope.queue_id);
					continue;
				}

				const permanentCode = response.ok ? "invalid_acceptance_response" : reasonForResponse(status);
				await writeState(paths, actualPlatform, envelope.queue_id, {
					attempts, permanent: true, last_error_code: permanentCode,
					last_http_status: status, updated_at: Number(now()), binding_fingerprint: effectiveFingerprint,
				});
				await rename(inflightPath, queuePath(paths, "failed", envelope.queue_id));
				if (delivery) lifecycleGroup(deliveryGroups, delivery, envelope.credential_fingerprint)?.states.set(delivery.batchIndex, "failed");
				result.permanentFailures += 1;
				result.permanentFailureBatches += 1;
				markGroup("permanentFailure", delivery, envelope.queue_id);
				if (!TERMINAL_HTTP_ERRORS.has(status) && !response.ok) continue;
			} finally {
				await releaseCompletion();
			}
		}

		return { ...result, health: await inspectOutbox({ pluginData, apiKey, baseUrl: normalizedBaseUrl, platform, securityRunner, _skipSecurity: true }) };
	} finally {
		await release();
	}
}

/** Explicitly bind selected pending data after key setup/rotation. */
export async function bindOutbox({
	pluginData,
	apiKey,
	baseUrl = DEFAULT_DELIVERY_BASE_URL,
	queueIds = null,
	includeUnbound = true,
	platform,
	securityRunner,
} = {}) {
	const fingerprint = credentialFingerprint(apiKey, normalizeDeliveryBaseUrl(baseUrl));
	if (!fingerprint) throw new OutboxError("invalid_key", "A header-safe API key is required to bind the outbox.");
	const wanted = Array.isArray(queueIds) ? new Set(queueIds.map(String)) : null;
	if (wanted && [...wanted].some((queueId) => !validQueueId(queueId))) {
		throw new OutboxError("invalid_queue_id", "An explicitly selected outbox queue identifier is invalid.");
	}
	const { paths, platform: actualPlatform } = await ensureOutbox(pluginData, { platform, securityRunner, securityMode: "all" });
	const releaseDrain = await acquireLock(paths, "drain.lock", { waitMs: 250 });
	if (!releaseDrain) throw new OutboxError("outbox_busy", "Another hook is delivering the local outbox.");
	let releaseMutation;
	let bound = 0;
	const reboundIds = new Map();
	const reboundStagesByDigest = new Map();
	try {
		releaseMutation = await acquireMutationLock(paths, 250);
		if (!releaseMutation) throw new OutboxError("outbox_busy", "Another hook is updating the local outbox.");
		await recoverTmp(paths);
		await finalizeAccepted(paths, actualPlatform);
		await recoverInflight(paths);
		await gcOutbox(paths, Date.now());
		// A staged aggregate and its materialized batches are one credential-bound
		// delivery unit. Selecting either identity must rebind the whole unit;
		// otherwise a crash-repair stage could point at a manifest whose remaining
		// batch identities are still bound to the old credential.
		const effectiveWanted = wanted ? new Set(wanted) : null;
		const manifests = [];
		const manifestsByQueueId = new Map();
		for (const entry of await safeEntries(paths.groups, paths.root)) {
			const manifest = await readJson(entry.path);
			if (!validateGroupManifest(manifest) || entry.name !== `${manifest?.queue_id}.json`) {
				throw new OutboxSecurityError("A delivery-group manifest is corrupt and cannot be rebound.");
			}
			manifests.push({ entry, manifest });
			manifestsByQueueId.set(manifest.queue_id, manifest);
			if (effectiveWanted) {
				if (
					effectiveWanted.has(manifest.queue_id)
					|| manifest.queue_ids.some((queueId) => effectiveWanted.has(queueId))
				) {
					effectiveWanted.add(manifest.queue_id);
					for (const queueId of manifest.queue_ids) effectiveWanted.add(queueId);
				}
			}
		}
		const rawItems = [];
		const rawQueueIdsByGroup = new Map();
		for (const directory of RAW_DIRECTORIES) {
			for (const entry of await safeEntries(paths[directory], paths.root)) {
				const envelope = await readJson(entry.path);
				if (!validateEnvelope(envelope) || entry.name !== `${envelope?.queue_id}.json`) {
					throw new OutboxSecurityError("An outbox envelope is corrupt and cannot be rebound.");
				}
				rawItems.push({ directory, entry, envelope });
				const delivery = envelopeDelivery(envelope);
				if (!delivery) continue;
				const siblings = rawQueueIdsByGroup.get(delivery.groupId) ?? [];
				siblings.push(envelope.queue_id);
				rawQueueIdsByGroup.set(delivery.groupId, siblings);
			}
		}
		if (effectiveWanted) {
			for (const siblingQueueIds of rawQueueIdsByGroup.values()) {
				if (!siblingQueueIds.some((queueId) => effectiveWanted.has(queueId))) continue;
				for (const queueId of siblingQueueIds) effectiveWanted.add(queueId);
			}
		}
		const inactiveManifests = new Set();
		const credentialChangingGroups = new Set();
		for (const { manifest } of manifests) {
			if (
				effectiveWanted
				&& !effectiveWanted.has(manifest.queue_id)
				&& !manifest.queue_ids.some((queueId) => effectiveWanted.has(queueId))
			) continue;
			const stageInfo = await pathKind(queuePath(paths, "staged", manifest.queue_id));
			const lifecycles = [];
			for (const queueId of manifest.queue_ids) lifecycles.push(await lifecyclePath(paths, queueId));
			const hasRaw = lifecycles.some((lifecycle) => lifecycle && RAW_DIRECTORIES.includes(lifecycle.name));
			if (!stageInfo && !hasRaw) {
				inactiveManifests.add(manifest.queue_id);
				continue;
			}
			if (
				manifest.credential_fingerprint !== fingerprint
				&& (includeUnbound || manifest.credential_fingerprint)
			) credentialChangingGroups.add(manifest.group_id);
		}
		for (const { envelope } of rawItems) {
			if (effectiveWanted && !effectiveWanted.has(envelope.queue_id)) continue;
			const state = await stateFor(paths, envelope.queue_id);
			const current = state.binding_fingerprint ?? envelope.credential_fingerprint ?? null;
			if (current === fingerprint || (!includeUnbound && !current)) continue;
			const delivery = envelopeDelivery(envelope);
			if (delivery) credentialChangingGroups.add(delivery.groupId);
		}
		const unsafeGroups = new Set();
		if (credentialChangingGroups.size > 0) {
			const lifecycleGroups = await deliveryLifecycle(paths);
			for (const groupId of credentialChangingGroups) {
				const unsafeIncarnation = [...lifecycleGroups.values()]
					.filter((group) => group.groupId === groupId)
					.some((group) => {
						const hasAcceptedPrefix = [...group.states.values()]
							.some((state) => state === "accepted" || state === "done");
						const acceptedByForeignCredential = hasAcceptedPrefix && (
							group.acceptedFingerprints.size === 0
							|| [...group.acceptedFingerprints].some((acceptedFingerprint) => acceptedFingerprint !== fingerprint)
						);
						return groupIsNonterminal(group) && acceptedByForeignCredential;
					});
				if (unsafeIncarnation) {
					if (wanted) {
						throw new OutboxError(
							"partially_accepted_group",
							"An ordered delivery group is already partly accepted by another credential and cannot be split across destinations.",
						);
					}
					unsafeGroups.add(groupId);
				}
			}
		}
		for (const entry of await safeEntries(paths.staged, paths.root)) {
			const staged = await readJson(entry.path);
			if (!validateStagedGroup(staged) || entry.name !== `${staged?.queue_id}.json`) {
				throw new OutboxSecurityError("A staged delivery group is corrupt and cannot be rebound.");
			}
			if (effectiveWanted && !effectiveWanted.has(staged.queue_id)) continue;
			if (unsafeGroups.has(manifestsByQueueId.get(staged.queue_id)?.group_id)) continue;
			const current = staged.credential_fingerprint ?? null;
			if (!includeUnbound && !current) continue;
			const reboundQueueId = queueIdFor(staged.content_digest, fingerprint);
			const rebound = { ...staged, queue_id: reboundQueueId, credential_fingerprint: fingerprint };
			if (!validateStagedGroup(rebound, reboundQueueId)) throw new OutboxSecurityError("The rebound staged-group identity is invalid.");
			const targetPath = queuePath(paths, "staged", reboundQueueId);
			const targetInfo = await pathKind(targetPath);
			let retainedStage = rebound;
			if (targetInfo) {
				const target = await readJson(targetPath);
				if (!validateStagedGroup(target, reboundQueueId) || target.content_digest !== staged.content_digest) {
					throw new OutboxSecurityError("A rebound staged-group identity conflicts with different content.");
				}
				const sourceIsEarlier = compareGroupPosition(
					{ deliveryOrder: rebound.delivery_order, createdAt: rebound.created_at, groupId: staged.queue_id },
					{ deliveryOrder: target.delivery_order, createdAt: target.created_at, groupId: target.queue_id },
				) < 0;
				retainedStage = sourceIsEarlier ? rebound : target;
				if (sourceIsEarlier && canonicalJson(target) !== canonicalJson(rebound)) {
					await atomicJson(paths, actualPlatform, targetPath, rebound);
				}
			} else {
				await atomicJson(paths, actualPlatform, targetPath, rebound, { exclusive: true });
			}
			reboundStagesByDigest.set(rebound.content_digest, retainedStage);
			if (current === fingerprint && staged.queue_id === reboundQueueId) continue;
			if (staged.queue_id !== reboundQueueId) {
				await unlink(entry.path);
				await syncDirectory(paths.staged, actualPlatform);
			}
			bound += 1;
		}
		// A batch-zero identity is the group rebind commit point. Rekey every later
		// sibling first, so a crash can only leave an undeliverable mixed-key group;
		// rerunning bind safely completes it before batch zero can be accepted.
		const orderedRawItems = rawItems.slice().sort((left, right) =>
			Number(envelopeDelivery(right.envelope)?.batchIndex ?? 0)
			- Number(envelopeDelivery(left.envelope)?.batchIndex ?? 0));
		for (const { directory, entry, envelope } of orderedRawItems) {
			if (effectiveWanted && !effectiveWanted.has(envelope.queue_id)) continue;
			if (unsafeGroups.has(envelopeDelivery(envelope)?.groupId)) continue;
			const state = await stateFor(paths, envelope.queue_id);
			const current = state.binding_fingerprint ?? envelope.credential_fingerprint ?? null;
			if (!includeUnbound && !current) continue;
			const digest = contentDigestFromRequest(envelope.request);
			const reboundQueueId = queueIdFor(digest, fingerprint);
			reboundIds.set(envelope.queue_id, reboundQueueId);
			if (
				current === fingerprint
				&& envelope.credential_fingerprint === fingerprint
				&& envelope.queue_id === reboundQueueId
			) continue;

			const reboundEnvelope = {
				...envelope,
				queue_id: reboundQueueId,
				credential_fingerprint: fingerprint,
			};
			if (!validateEnvelope(reboundEnvelope)) throw new OutboxSecurityError("The rebound envelope identity is invalid.");
			const target = await lifecyclePath(paths, reboundQueueId);
			if (target && RAW_DIRECTORIES.includes(target.name)) {
				if (target.value.request_sha256 !== envelope.request_sha256) {
					throw new OutboxSecurityError("A rebound queue identity conflicts with different content.");
				}
				const delivery = envelopeDelivery(reboundEnvelope);
				const sourceIsEarlier = compareGroupPosition(
					{
						deliveryOrder: reboundEnvelope.delivery_order,
						createdAt: reboundEnvelope.created_at,
						groupId: delivery?.groupId ?? `legacy:${reboundEnvelope.queue_id}`,
					},
					{
						deliveryOrder: target.value.delivery_order,
						createdAt: target.value.created_at,
						groupId: delivery?.groupId ?? `legacy:${target.value.queue_id}`,
					},
				) < 0;
				if (sourceIsEarlier && canonicalJson(target.value) !== canonicalJson(reboundEnvelope)) {
					await atomicJson(paths, actualPlatform, target.path, reboundEnvelope);
				}
			} else if (!target) {
				await atomicJson(
					paths,
					actualPlatform,
					queuePath(paths, directory, reboundQueueId),
					reboundEnvelope,
					{ exclusive: true },
				);
			}

			const targetNeedsState = !target || RAW_DIRECTORIES.includes(target.name);
			const targetState = target && targetNeedsState ? await stateFor(paths, reboundQueueId) : null;
			if (envelope.queue_id !== reboundQueueId) {
				await unlink(entry.path);
				await unlink(queuePath(paths, "state", envelope.queue_id)).catch(() => {});
				await syncDirectory(paths[directory], actualPlatform);
			}
			if (targetNeedsState) {
				// Once the target envelope is durable its embedded fingerprint is enough
				// for crash recovery. Retire the source before the metadata temp write so
				// copy-before-delete never consumes a second raw-entry reserve.
				await writeState(paths, actualPlatform, reboundQueueId, {
					...state,
					...(targetState ?? {}),
					attempts: Math.max(Number(state.attempts ?? 0), Number(targetState?.attempts ?? 0)),
					binding_fingerprint: fingerprint,
					binding_updated_at: Date.now(),
					next_attempt_at: 0,
				});
			}
			bound += 1;
		}
		for (const entry of await safeEntries(paths.groups, paths.root)) {
			const manifest = await readJson(entry.path);
			if (!validateGroupManifest(manifest) || entry.name !== `${manifest?.queue_id}.json`) {
				throw new OutboxSecurityError("A delivery-group manifest is corrupt and cannot be rebound.");
			}
			if (
				effectiveWanted
				&& !effectiveWanted.has(manifest.queue_id)
				&& !manifest.queue_ids.some((queueId) => effectiveWanted.has(queueId))
			) continue;
			if (inactiveManifests.has(manifest.queue_id)) continue;
			if (unsafeGroups.has(manifest.group_id)) continue;
			const reboundQueueId = queueIdFor(manifest.content_digest, fingerprint);
			const reboundStage = reboundStagesByDigest.get(manifest.content_digest);
			let rebound;
			if (reboundStage) {
				const group = buildEnvelopes({
					prepared: {
						sessionHash: reboundStage.session_hash,
						conversationId: reboundStage.conversation_id,
						safeMessages: reboundStage.messages,
						safeScope: reboundStage.memory_scope,
						capture: reboundStage.capture,
						redactions: {},
					},
					fingerprint,
					createdAt: reboundStage.created_at,
					deliveryOrder: reboundStage.delivery_order,
				});
				rebound = manifestFromMaterialized(reboundStage, group, () => manifest.materialized_at);
			} else {
				rebound = {
					...manifest,
					queue_id: reboundQueueId,
					credential_fingerprint: fingerprint,
					queue_ids: manifest.queue_ids.map((queueId) => reboundIds.get(queueId) ?? queueId),
				};
			}
			if (!validateGroupManifest(rebound, reboundQueueId)) throw new OutboxSecurityError("The rebound delivery-group manifest is invalid.");
			const targetPath = queuePath(paths, "groups", reboundQueueId);
			if (reboundQueueId === manifest.queue_id) {
				if (canonicalJson(manifest) !== canonicalJson(rebound)) {
					await atomicJson(paths, actualPlatform, targetPath, rebound);
				}
			} else {
				const targetInfo = await pathKind(targetPath);
				if (targetInfo) {
					const target = await readJson(targetPath);
					if (!validateGroupManifest(target, reboundQueueId) || target.group_id !== rebound.group_id) {
						throw new OutboxSecurityError("A rebound delivery-group manifest conflicts with different content.");
					}
					if (canonicalJson(target) !== canonicalJson(rebound)) {
						await atomicJson(paths, actualPlatform, targetPath, rebound);
					}
				} else await atomicJson(paths, actualPlatform, targetPath, rebound, { exclusive: true });
				await unlink(entry.path);
				await syncDirectory(paths.groups, actualPlatform);
			}
		}
		await unlink(join(paths.control, "auth-block.json")).catch(() => {});
		return {
			ok: true,
			bound,
			...(unsafeGroups.size > 0 ? { skippedPartiallyAcceptedGroups: unsafeGroups.size } : {}),
		};
	} finally {
		await releaseMutation?.();
		await releaseDrain();
	}
}

/**
 * Open one verified diagnostic scope. The returned inspection closure reuses
 * that security verification and never persists diagnostic or credential data.
 */
export async function openHookDiagnostic({ pluginData, platform, securityRunner } = {}) {
	await ensureOutbox(pluginData, { platform, securityRunner, securityMode: "all" });
	return Object.freeze({
		inspect: ({ apiKey, baseUrl = DEFAULT_DELIVERY_BASE_URL } = {}) => inspectOutbox({
			pluginData,
			apiKey,
			baseUrl,
			platform,
			securityRunner,
			_skipSecurity: true,
		}),
	});
}

/** Metadata-only local health; never returns paths, content, or key material. */
export async function inspectOutbox({
	pluginData,
	apiKey,
	baseUrl = DEFAULT_DELIVERY_BASE_URL,
	platform,
	securityRunner,
	_skipSecurity = false,
} = {}) {
	const opened = _skipSecurity
		? { paths: pathsFor(pluginData), platform: platform ?? process.platform }
		: await ensureOutbox(pluginData, { platform, securityRunner, securityMode: "all" });
	const { paths } = opened;
	const counts = {};
	let rawBytes = 0;
	let oldestPendingAt = null;
	let bindingRequired = 0;
	let credentialMismatch = 0;
	let nextAttemptAt = null;
	let corruptEntries = 0;
	let countsTruncated = false;
	const fingerprint = credentialFingerprint(apiKey, normalizeDeliveryBaseUrl(baseUrl));
	const entriesByName = {};
	for (const name of ["tmp", "staged", "groups", "pending", "inflight", "accepted", "done", "failed"]) {
		const entries = await safeEntries(paths[name], paths.root, {
			maxEntries: name === "done" ? MAX_HEALTH_TOMBSTONES : Infinity,
		});
		entriesByName[name] = entries;
		if (entries.truncated) countsTruncated = true;
		counts[name] = entries.filter((entry) => entry.info.isFile()).length;
		for (const entry of entries) {
			if (!entry.info.isFile()) {
				corruptEntries += 1;
				continue;
			}
			if (name === "accepted" || name === "done") {
				const value = await readJson(entry.path);
				if (!validateTombstone(value) || entry.name !== `${value.queue_id}.json`) corruptEntries += 1;
			} else if (name === "staged") {
				const value = await readJson(entry.path);
				if (
					entry.info.size > OUTBOX_LIMITS.maxStagedGroupBytes
					|| !validateStagedGroup(value)
					|| entry.name !== `${value.queue_id}.json`
				) corruptEntries += 1;
			} else if (name === "groups") {
				const value = await readJson(entry.path);
				if (!validateGroupManifest(value) || entry.name !== `${value.queue_id}.json`) corruptEntries += 1;
			} else if (RAW_DIRECTORIES.includes(name)) {
				const value = await readJson(entry.path);
				if (!validateEnvelope(value) || entry.name !== `${value.queue_id}.json`) corruptEntries += 1;
			} else if (name === "tmp") {
				const value = await readJson(entry.path);
				if (!validExpectedTemporary(value)) corruptEntries += 1;
			}
		}
		if (name === "tmp" || name === "staged" || RAW_DIRECTORIES.includes(name)) {
			rawBytes += entries.reduce((sum, entry) => sum + (entry.info.isFile() ? entry.info.size : 0), 0);
		}
		if (!["tmp", "staged", "pending", "inflight"].includes(name)) continue;
		for (const entry of entries) {
			const envelope = await readJson(entry.path);
			if (name === "staged") {
				if (!validateStagedGroup(envelope) || entry.name !== `${envelope.queue_id}.json`) continue;
				oldestPendingAt = oldestPendingAt === null ? Number(envelope.created_at) : Math.min(oldestPendingAt, Number(envelope.created_at));
				const bound = envelope.credential_fingerprint ?? null;
				if (!bound || !fingerprint || bound !== fingerprint) {
					bindingRequired += 1;
					if (bound && fingerprint && bound !== fingerprint) credentialMismatch += 1;
				}
				continue;
			}
			if (!validateEnvelope(envelope)) continue;
			if (name !== "tmp" && entry.name !== `${envelope.queue_id}.json`) continue;
			oldestPendingAt = oldestPendingAt === null ? Number(envelope.created_at) : Math.min(oldestPendingAt, Number(envelope.created_at));
			const state = await stateFor(paths, envelope.queue_id);
			const bound = state.binding_fingerprint ?? envelope.credential_fingerprint ?? null;
			if (!bound) bindingRequired += 1;
			else if (queueIdFor(contentDigestFromRequest(envelope.request), bound) !== envelope.queue_id) {
				bindingRequired += 1;
			} else if (!fingerprint || bound !== fingerprint) {
				bindingRequired += 1;
				if (fingerprint) credentialMismatch += 1;
			}
			const due = Number(state.next_attempt_at ?? 0);
			if (due > 0) nextAttemptAt = nextAttemptAt === null ? due : Math.min(nextAttemptAt, due);
		}
	}
	const authBlockPath = join(paths.control, "auth-block.json");
	const authBlockInfo = await pathKind(authBlockPath);
	const authBlock = authBlockInfo?.isFile() && !authBlockInfo.isSymbolicLink()
		? await readJson(authBlockPath)
		: null;
	if (authBlockInfo && !validateAuthBlock(authBlock)) corruptEntries += 1;
	const authBlocked = Boolean(
		validateAuthBlock(authBlock)
		&& (!fingerprint || !authBlock.credential_fingerprint || authBlock.credential_fingerprint === fingerprint),
	);
	const doneEntries = entriesByName.done;
	const deliveryGroups = summarizeDeliveryGroups(await deliveryLifecycle(paths));
	let lastAccepted = null;
	for (const entry of doneEntries) {
		const value = await readJson(entry.path);
		if (!validateTombstone(value) || entry.name !== `${value.queue_id}.json`) continue;
		if (!lastAccepted || Number(value.accepted_at ?? 0) > Number(lastAccepted.acceptedAt ?? 0)) {
			lastAccepted = {
				acceptedAt: value.accepted_at ?? null,
				sourcePacketId: value.source_packet_id ?? null,
				receiptId: value.receipt_id ?? null,
				status: safeIdentifier(value.status, 80) ?? "accepted",
				...(value.delivery ? { delivery: normalizeDeliveryMetadata(value.delivery) } : {}),
			};
		}
	}
	return {
		healthy: counts.failed === 0
			&& corruptEntries === 0
			&& !authBlocked
			&& bindingRequired === 0
			&& deliveryGroups.incomplete === 0,
		version: 1,
		counts,
		rawBytes,
		limits: OUTBOX_LIMITS,
		oldestPendingAt,
		bindingRequired,
		credentialMismatch,
		authBlocked,
		permanentFailures: counts.failed,
		corruptEntries,
		countsTruncated,
		nextAttemptAt,
		deliveryGroups,
		lastAccepted,
	};
}
