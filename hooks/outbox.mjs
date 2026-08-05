/**
 * Protected, crash-recoverable local delivery for Claude lifecycle hooks.
 *
 * SessionEnd uses enqueueSession(), which has no network path. SessionStart
 * owns drainOutbox(). Raw envelopes are immutable; retry/binding state lives in
 * sidecars, and successful delivery replaces raw content with a body-free
 * tombstone.
 */

import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
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

import { scrubMessages, scrubText } from "../src/pipeline/scrub.js";

export const OUTBOX_SCHEMA = "itsuki.outbox/v1";
export const TOMBSTONE_SCHEMA = "itsuki.outbox-tombstone/v1";
export const STATE_SCHEMA = "itsuki.outbox-state/v1";
export const OUTBOX_LIMITS = Object.freeze({
	maxEnvelopeBytes: 2 * 1024 * 1024,
	maxRawCount: 128,
	maxRawBytes: 64 * 1024 * 1024,
	doneRetentionMs: 7 * 24 * 60 * 60 * 1000,
	tmpRetentionMs: 24 * 60 * 60 * 1000,
	staleLockMs: 10 * 60 * 1000,
	maxDrainItems: 4,
	drainBudgetMs: 3_500,
	requestTimeoutMs: 2_500,
});

const DIRECTORY_NAMES = [
	"tmp", "pending", "inflight", "accepted", "done", "failed", "state", "locks", "control",
];
const RAW_DIRECTORIES = ["pending", "inflight", "failed"];
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

async function validSecurityMarker(paths) {
	const markerPath = securityMarkerPath(paths);
	const info = await pathKind(markerPath);
	if (!info) return false;
	if (!info.isFile() || info.isSymbolicLink()) throw new OutboxSecurityError("The outbox security marker is not a regular file.");
	const marker = await readJson(markerPath);
	if (
		marker?.schema !== SECURITY_MARKER_SCHEMA
		|| marker.path_sha256 !== sha256(resolve(paths.pluginData).toLowerCase())
		|| !marker.directories
	) return false;
	const current = await directoryIdentity(paths);
	return canonicalJson(current) === canonicalJson(marker.directories);
}

async function writeSecurityMarker(paths, platform) {
	try {
		await atomicJson(paths, platform, securityMarkerPath(paths), {
			schema: SECURITY_MARKER_SCHEMA,
			path_sha256: sha256(resolve(paths.pluginData).toLowerCase()),
			directories: await directoryIdentity(paths),
			verified_at: Date.now(),
		});
	} catch (error) {
		// Two first-use hooks may finish the same idempotent ACL verification
		// together. A concurrently durable marker for these exact directories is
		// equivalent to our write; any other failure still fails closed.
		if (!await validSecurityMarker(paths).catch(() => false)) throw error;
	}
}

function defaultWindowsSecurityRunner(root, mode) {
	const helper = fileURLToPath(new URL("./outbox-security.ps1", import.meta.url));
	const systemRoot = resolve(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows");
	const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	const result = spawnSync(powershell, [
		"-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
		"-File", helper, "-Path", root, "-Mode", mode,
	], {
		encoding: "utf8",
		env: {
			SystemRoot: systemRoot,
			WINDIR: systemRoot,
			TEMP: process.env.TEMP,
			TMP: process.env.TMP,
		},
		windowsHide: true,
		timeout: mode === "EnsureDirectories" ? 1_000 : 8_000,
	});
	if (result.error || result.status !== 0) {
		throw new OutboxSecurityError("Windows could not apply and verify the private outbox ACL.");
	}
	let parsed;
	try { parsed = JSON.parse(String(result.stdout ?? "").trim()); } catch {}
	if (!parsed?.ok || parsed?.protected !== true) {
		throw new OutboxSecurityError("Windows did not verify the private outbox ACL.");
	}
	return parsed;
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

	if (platform === "win32") {
		const runner = options.securityRunner ?? defaultWindowsSecurityRunner;
		const fastVerified = options.securityMode !== "all" && await validSecurityMarker(paths);
		if (!fastVerified) {
			await runner(paths.root, options.securityMode === "all" ? "EnsureAll" : "EnsureDirectories");
			await writeSecurityMarker(paths, platform);
		}
	} else {
		for (const name of DIRECTORY_NAMES) await ensurePlainDirectory(paths[name], { platform });
	}
	return { paths, platform };
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

async function atomicJson(paths, platform, destination, value, { exclusive = false } = {}) {
	if (!isWithin(paths.root, destination)) throw new OutboxSecurityError();
	const bytes = Buffer.from(canonicalJson(value), "utf8");
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

function cleanMessage(message) {
	return {
		id: String(message?.id ?? "").slice(0, 240),
		role: message?.role === "assistant" ? "assistant" : "user",
		content: String(message?.content ?? ""),
		...(Number.isFinite(Number(message?.ts)) ? { ts: Number(message.ts) } : {}),
	};
}

function envelopeSeed({ sessionId, memoryScope, messages }) {
	return {
		session: sha256(`claude-session:v1\0${String(sessionId ?? "session")}`),
		project: memoryScope?.projectId ?? memoryScope?.project_id ?? null,
		messages: messages.map((message) => ({
			id: message.id,
			role: message.role,
			ts: message.ts ?? null,
			content_sha256: sha256(message.content),
		})),
	};
}

function contentDigestFromRequest(request) {
	const match = /^claude-outbox:v1:([a-f0-9]{64})$/.exec(request?.body?.idempotencyKey ?? "");
	return match?.[1] ?? null;
}

function queueIdFor(contentDigest, fingerprint) {
	if (!/^[a-f0-9]{64}$/.test(contentDigest ?? "") || !validCredentialFingerprint(fingerprint)) {
		throw new OutboxSecurityError("An outbox queue identity is invalid.");
	}
	return `q_${sha256(`${contentDigest}\0${fingerprint ?? "unbound"}`).slice(0, 40)}`;
}

function buildEnvelope({ messages, sessionId, memoryScope, fingerprint, now = Date.now }) {
	if (!validCredentialFingerprint(fingerprint)) {
		throw new OutboxError(
			"invalid_credential_fingerprint",
			"The outbox credential binding must be a one-way fingerprint.",
		);
	}
	const scrubbed = scrubMessages((messages ?? []).map(cleanMessage));
	const safeMessages = scrubbed.messages.filter((message) => message.content.trim());
	if (!safeMessages.length) throw new OutboxError("empty_envelope", "There are no messages to queue.");
	const safeScope = sanitizeMemoryScope(memoryScope);
	const digest = sha256(canonicalJson(envelopeSeed({ sessionId, memoryScope: safeScope, messages: safeMessages })));
	const queueId = queueIdFor(digest, fingerprint);
	const idempotencyKey = `claude-outbox:v1:${digest}`;
	const conversationId = `claude_session_v1_${sha256(String(sessionId ?? "session")).slice(0, 32)}`;
	const request = {
		path: "/v1/ingest",
		body: {
			source: "plugin",
			flush: true,
			conversationId,
			memoryScope: safeScope,
			idempotencyKey,
			messages: safeMessages,
		},
	};
	return {
		envelope: {
			schema: OUTBOX_SCHEMA,
			queue_id: queueId,
			created_at: Number(now()),
			credential_fingerprint: fingerprint ?? null,
			request,
			request_sha256: sha256(canonicalJson(request)),
		},
		redactions: scrubbed.redactions,
	};
}

function validateEnvelope(value) {
	if (!value || value.schema !== OUTBOX_SCHEMA || !validQueueId(value.queue_id)) return false;
	if (value.request?.path !== "/v1/ingest" || !Array.isArray(value.request?.body?.messages)) return false;
	if (!validFiniteTimestamp(value.created_at)) return false;
	if (!validCredentialFingerprint(value.credential_fingerprint)) return false;
	const contentDigest = contentDigestFromRequest(value.request);
	if (!contentDigest || value.queue_id !== queueIdFor(contentDigest, value.credential_fingerprint)) return false;
	return value.request_sha256 === sha256(canonicalJson(value.request));
}

function validateTombstone(value, queueId = value?.queue_id) {
	const sourcePacketId = serverIdentifier(value?.source_packet_id, "src");
	const receiptId = serverIdentifier(value?.receipt_id, "receipt");
	const contentDigest = typeof value?.content_digest === "string" && /^[a-f0-9]{64}$/.test(value.content_digest)
		? value.content_digest
		: null;
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

function validExpectedTemporary(value) {
	if (validateEnvelope(value) || validateState(value) || validateTombstone(value) || validateAuthBlock(value)) {
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
	for (const name of RAW_DIRECTORIES) {
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

async function gcOutbox(paths, now = Date.now()) {
	for (const entry of await safeEntries(paths.done, paths.root, { maxEntries: MAX_MAINTENANCE_ENTRIES })) {
		if (entry.info.isFile() && now - entry.info.mtimeMs > OUTBOX_LIMITS.doneRetentionMs) await unlink(entry.path);
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

/** Atomically queue one scrubbed session. This function has no network path. */
export async function enqueueSession({
	pluginData,
	messages,
	sessionId,
	memoryScope,
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
	const built = buildEnvelope({ messages, sessionId, memoryScope, fingerprint, now });
	const serializedBytes = Buffer.byteLength(canonicalJson(built.envelope), "utf8");
	if (serializedBytes > OUTBOX_LIMITS.maxEnvelopeBytes) {
		throw new OutboxCapacityError("envelope_too_large", "The protected local envelope exceeds 2 MiB.");
	}

	const release = await acquireMutationLock(paths, 250);
	if (!release) throw new OutboxError("outbox_busy", "Another hook is updating the local outbox.");
	try {
		const existing = await lifecyclePath(paths, built.envelope.queue_id);
		if (existing) {
			let existingFingerprint = null;
			if (RAW_DIRECTORIES.includes(existing.name)) {
				const envelope = await readJson(existing.path);
				const state = await stateFor(paths, built.envelope.queue_id);
				existingFingerprint = state.binding_fingerprint ?? envelope?.credential_fingerprint ?? null;
			}
			return {
				queued: existing.name === "pending" || existing.name === "inflight",
				duplicate: true,
				state: existing.name,
				queueId: built.envelope.queue_id,
				bound: existing.name === "done" || existing.name === "accepted" || Boolean(existingFingerprint),
				credentialMismatch: Boolean(fingerprint && existingFingerprint && fingerprint !== existingFingerprint),
				redactions: built.redactions,
			};
		}
		const usage = await rawUsage(paths);
		if (usage.count >= OUTBOX_LIMITS.maxRawCount) {
			throw new OutboxCapacityError("outbox_count_full", "The protected local outbox already has 128 undelivered entries.");
		}
		if (usage.bytes + serializedBytes > OUTBOX_LIMITS.maxRawBytes) {
			throw new OutboxCapacityError("outbox_bytes_full", "The protected local outbox would exceed 64 MiB.");
		}
		const destination = queuePath(paths, "pending", built.envelope.queue_id);
		await atomicJson(paths, actualPlatform, destination, built.envelope, { exclusive: true });
		return {
			queued: true,
			duplicate: false,
			state: "pending",
			queueId: built.envelope.queue_id,
			bytes: serializedBytes,
			bound: Boolean(fingerprint),
			redactions: built.redactions,
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
		if (!validateEnvelope(value)) continue;
		const existing = await lifecyclePath(paths, value.queue_id);
		if (existing) {
			await unlink(entry.path);
			continue;
		}
		await rename(entry.path, queuePath(paths, "pending", value.queue_id));
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
	now = Date.now,
	platform,
	securityRunner,
} = {}) {
	const normalizedBaseUrl = normalizeDeliveryBaseUrl(baseUrl);
	const currentFingerprint = credentialFingerprint(apiKey, normalizedBaseUrl);
	const result = {
		delivered: 0,
		retried: 0,
		permanentFailures: 0,
		authBlocked: false,
		bindingRequired: 0,
		credentialMismatch: 0,
		backoffSkipped: 0,
		transportUnavailable: false,
		busy: false,
		accepted: [],
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
				return { ...result, bindingRequired: health.counts.pending, health };
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

			for (const entry of await safeEntries(paths.pending, paths.root)) {
				if (!entry.info.isFile()) throw new OutboxSecurityError();
				const envelope = await readJson(entry.path);
				pending.push({ entry, envelope, createdAt: Number(envelope?.created_at ?? entry.info.mtimeMs) });
			}
		} finally {
			await releaseInitialMutation();
		}
		pending.sort((left, right) => left.createdAt - right.createdAt || left.entry.name.localeCompare(right.entry.name));
		// Local security/recovery work is not charged against the bounded network
		// delivery window. The host-level SessionStart deadline still bounds both.
		const deadline = Number(now()) + Math.max(1, maxDurationMs);

		let requests = 0;
		for (const item of pending) {
			if (requests >= Math.min(maxItems, OUTBOX_LIMITS.maxDrainItems) || Number(now()) >= deadline) break;
			const envelope = item.envelope;
			if (!validateEnvelope(envelope) || item.entry.name !== `${envelope.queue_id}.json`) {
				const quarantineName = `corrupt_${sha256(item.entry.name).slice(0, 16)}_${randomUUID()}.json`;
				const releaseMutation = await acquireMutationLock(paths, 250);
				if (!releaseMutation) { result.busy = true; break; }
				try { await rename(item.entry.path, join(paths.failed, quarantineName)); }
				finally { await releaseMutation(); }
				result.permanentFailures += 1;
				continue;
			}
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
			const remaining = Math.max(1, deadline - Number(now()));
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
					result.transportUnavailable = true;
					break;
				}

				const accepted = response.ok ? safeAcceptance(responseData, response.status) : null;
				if (accepted) {
					const contentDigest = contentDigestFromRequest(envelope.request);
					const tombstone = {
						...accepted,
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
					result.accepted.push({
						queueId: envelope.queue_id,
						sourcePacketId: accepted.source_packet_id,
						receiptId: accepted.receipt_id,
						jobId: accepted.job_id,
						status: accepted.status,
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
					result.retried += 1;
					continue;
				}

				const permanentCode = response.ok ? "invalid_acceptance_response" : reasonForResponse(status);
				await writeState(paths, actualPlatform, envelope.queue_id, {
					attempts, permanent: true, last_error_code: permanentCode,
					last_http_status: status, updated_at: Number(now()), binding_fingerprint: effectiveFingerprint,
				});
				await rename(inflightPath, queuePath(paths, "failed", envelope.queue_id));
				result.permanentFailures += 1;
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
	try {
		releaseMutation = await acquireMutationLock(paths, 250);
		if (!releaseMutation) throw new OutboxError("outbox_busy", "Another hook is updating the local outbox.");
		await recoverTmp(paths);
		await finalizeAccepted(paths, actualPlatform);
		await recoverInflight(paths);
		await gcOutbox(paths, Date.now());
		for (const directory of RAW_DIRECTORIES) {
			for (const entry of await safeEntries(paths[directory], paths.root)) {
				const envelope = await readJson(entry.path);
				if (!validateEnvelope(envelope) || entry.name !== `${envelope?.queue_id}.json`) {
					throw new OutboxSecurityError("An outbox envelope is corrupt and cannot be rebound.");
				}
				if (wanted && !wanted.has(envelope.queue_id)) continue;
				const state = await stateFor(paths, envelope.queue_id);
				const current = state.binding_fingerprint ?? envelope.credential_fingerprint ?? null;
				if (!includeUnbound && !current) continue;
				const digest = contentDigestFromRequest(envelope.request);
				const reboundQueueId = queueIdFor(digest, fingerprint);
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
				} else if (!target) {
					await atomicJson(
						paths,
						actualPlatform,
						queuePath(paths, directory, reboundQueueId),
						reboundEnvelope,
						{ exclusive: true },
					);
				}

				if (!target || RAW_DIRECTORIES.includes(target.name)) {
					const targetState = target ? await stateFor(paths, reboundQueueId) : null;
					await writeState(paths, actualPlatform, reboundQueueId, {
						...state,
						...(targetState ?? {}),
						attempts: Math.max(Number(state.attempts ?? 0), Number(targetState?.attempts ?? 0)),
						binding_fingerprint: fingerprint,
						binding_updated_at: Date.now(),
						next_attempt_at: 0,
					});
				}
				if (envelope.queue_id !== reboundQueueId) {
					await unlink(entry.path);
					await unlink(queuePath(paths, "state", envelope.queue_id)).catch(() => {});
					await syncDirectory(paths[directory], actualPlatform);
				}
				bound += 1;
			}
		}
		await unlink(join(paths.control, "auth-block.json")).catch(() => {});
		return { ok: true, bound };
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
	for (const name of ["tmp", "pending", "inflight", "accepted", "done", "failed"]) {
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
			} else if (RAW_DIRECTORIES.includes(name)) {
				const value = await readJson(entry.path);
				if (!validateEnvelope(value) || entry.name !== `${value.queue_id}.json`) corruptEntries += 1;
			} else if (name === "tmp") {
				const value = await readJson(entry.path);
				if (!validExpectedTemporary(value)) corruptEntries += 1;
			}
		}
		if (name === "tmp" || RAW_DIRECTORIES.includes(name)) {
			rawBytes += entries.reduce((sum, entry) => sum + (entry.info.isFile() ? entry.info.size : 0), 0);
		}
		if (!["tmp", "pending", "inflight"].includes(name)) continue;
		for (const entry of entries) {
			const envelope = await readJson(entry.path);
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
			};
		}
	}
	return {
		healthy: counts.failed === 0 && corruptEntries === 0 && !authBlocked && bindingRequired === 0,
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
		lastAccepted,
	};
}
