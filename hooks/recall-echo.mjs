import { createHash } from "node:crypto";

export const RECALL_ECHO_STORE_SCHEMA = "itsuki.recall-echo/v2";
export const RECALL_ECHO_STORE_FILENAME = "recall-echo.json";
export const RECALL_ECHO_MAX_SESSIONS = 32;
export const RECALL_ECHO_MAX_FINGERPRINTS = 128;
export const RECALL_ECHO_MAX_STORE_BYTES = 384 * 1024;

const FINGERPRINT_RE = /^sha256:[a-f0-9]{64}$/;
const MAX_SESSION_ID_CHARACTERS = 1_024;
const MAX_LINE_CHARACTERS = 4_096;
const MIN_LINE_CHARACTERS = 6;
const MIN_ALPHANUMERIC_CHARACTERS = 4;
const STORE_KEYS = new Set(["schema", "sessions"]);
const SESSION_KEYS = new Set(["session_key", "status", "fingerprints"]);
const GUARD_STATUSES = new Set(["armed", "no_context"]);
const LEADING_LABELS = [
	/^(?:architecture\s+decision|design\s+decision|decision)\s*:\s*/iu,
	/^we\s+decided\s+to\s+/iu,
	/^we\s+chose\s+to\s+/iu,
	/^we\s+will\s+/iu,
	/^(?:outcome|resolution|resolved|convention|user\s+preference|preference)\s*:\s*/iu,
];

function sha256(value) {
	return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function exactKeys(value, expected) {
	return Object.keys(value).length === expected.size
		&& Object.keys(value).every((key) => expected.has(key));
}

function stripMarkdownPrefix(value) {
	let line = value;
	for (let pass = 0; pass < 4; pass += 1) {
		const next = line
			.replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d{1,4}[.)]|\[[ xX]\])\s+/u, "")
			.trim();
		if (next === line) break;
		line = next;
	}
	return line;
}

/**
 * Canonicalize one candidate line without retaining it. Matching deliberately
 * remains near-exact: Unicode/case/spacing and presentation-only Markdown are
 * normalized, while the semantic word sequence is preserved.
 */
export function canonicalRecallEchoLine(value) {
	const raw = String(value ?? "").replace(/\r\n?/g, "\n");
	if (raw.includes("\n")) return "";
	const points = Array.from(raw);
	if (points.length > MAX_LINE_CHARACTERS) return "";
	const canonical = stripMarkdownPrefix(raw
		.normalize("NFKC")
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/gu, " ")
		.trim())
		.toLocaleLowerCase("en-US");
	const alphanumeric = canonical.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
	if (canonical.length < MIN_LINE_CHARACTERS || alphanumeric < MIN_ALPHANUMERIC_CHARACTERS) return "";
	return canonical;
}

/** Return deterministic exact and presentation-label-stripped variants. */
export function recallEchoLineVariants(value) {
	const canonical = canonicalRecallEchoLine(value);
	if (!canonical) return [];
	const variants = new Set([canonical]);
	for (const label of LEADING_LABELS) {
		const stripped = canonicalRecallEchoLine(canonical.replace(label, ""));
		if (stripped) variants.add(stripped);
	}
	for (const variant of [...variants]) {
		const punctuationless = canonicalRecallEchoLine(variant.replace(/[.!?;:]+$/u, ""));
		if (punctuationless) variants.add(punctuationless);
	}
	return [...variants];
}

/** The on-disk session key is itself one-way and never contains a host ID. */
export function recallEchoSessionKey(sessionId) {
	const value = String(sessionId ?? "").trim();
	if (!value || Array.from(value).length > MAX_SESSION_ID_CHARACTERS) return null;
	return `sha256:${sha256(`itsuki-recall-echo-session:v1\0${value}`)}`;
}

function validSessionKey(value) {
	return typeof value === "string" && FINGERPRINT_RE.test(value);
}

/** Fingerprint one already-canonical line inside a session-specific domain. */
export function fingerprintRecallEchoLine(value, { sessionId, sessionKey = recallEchoSessionKey(sessionId) } = {}) {
	const canonical = canonicalRecallEchoLine(value);
	if (!canonical || !validSessionKey(sessionKey)) return null;
	return `sha256:${sha256(`itsuki-recall-echo-line:v1\0${sessionKey}\0${canonical}`)}`;
}

/** Fingerprint every deterministic near-exact variant of one line. */
export function recallEchoFingerprintsForLine(value, options = {}) {
	const fingerprints = [];
	for (const variant of recallEchoLineVariants(value)) {
		const fingerprint = fingerprintRecallEchoLine(variant, options);
		if (fingerprint && !fingerprints.includes(fingerprint)) fingerprints.push(fingerprint);
	}
	return fingerprints;
}

/**
 * Derive a bounded set of one-way fingerprints from recalled context. The raw
 * context is never returned and therefore cannot be serialized accidentally.
 */
export function recallEchoFingerprintsFromText(value, options = {}) {
	return deriveRecallEchoCoverage(value, options).fingerprints;
}

/**
 * Derive complete, content-free coverage for every potentially capturable
 * recalled line. Partial coverage is never returned as safe: an oversized line
 * or a fingerprint set beyond the bound rejects the whole new injection.
 */
export function deriveRecallEchoCoverage(value, options = {}) {
	const sessionKey = options.sessionKey ?? recallEchoSessionKey(options.sessionId);
	if (!validSessionKey(sessionKey)) {
		return { fingerprints: [], complete: false, candidateLineCount: 0, reason: "invalid_session" };
	}
	const fingerprints = new Set();
	let candidateLineCount = 0;
	for (const line of String(value ?? "").replace(/\r\n?/g, "\n").split("\n")) {
		const raw = line.trim();
		if (!raw) continue;
		const alphanumeric = raw.normalize("NFKC").match(/[\p{L}\p{N}]/gu)?.length ?? 0;
		// Presentation-only separators cannot become durable assistant prose.
		if (alphanumeric < MIN_ALPHANUMERIC_CHARACTERS) continue;
		candidateLineCount += 1;
		const variants = recallEchoFingerprintsForLine(line, { sessionKey });
		if (variants.length === 0) {
			return { fingerprints: [], complete: false, candidateLineCount, reason: "unfingerprintable_line" };
		}
		for (const fingerprint of variants) {
			fingerprints.add(fingerprint);
			if (fingerprints.size > RECALL_ECHO_MAX_FINGERPRINTS) {
				return { fingerprints: [], complete: false, candidateLineCount, reason: "fingerprint_limit" };
			}
		}
	}
	return { fingerprints: [...fingerprints], complete: true, candidateLineCount, reason: null };
}

/** Strictly validate and copy the content-free bounded sidecar shape. */
export function normalizeRecallEchoStore(value) {
	if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, STORE_KEYS)) return null;
	if (value.schema !== RECALL_ECHO_STORE_SCHEMA || !Array.isArray(value.sessions)) return null;
	if (value.sessions.length > RECALL_ECHO_MAX_SESSIONS) return null;
	const seenSessions = new Set();
	const sessions = [];
	for (const session of value.sessions) {
		if (!session || typeof session !== "object" || Array.isArray(session) || !exactKeys(session, SESSION_KEYS)) return null;
		if (!validSessionKey(session.session_key) || seenSessions.has(session.session_key)) return null;
		if (!GUARD_STATUSES.has(session.status)) return null;
		if (!Array.isArray(session.fingerprints) || session.fingerprints.length > RECALL_ECHO_MAX_FINGERPRINTS) return null;
		if (session.status === "armed" && session.fingerprints.length < 1) return null;
		if (session.status === "no_context" && session.fingerprints.length !== 0) return null;
		const seenFingerprints = new Set();
		for (const fingerprint of session.fingerprints) {
			if (!validSessionKey(fingerprint) || seenFingerprints.has(fingerprint)) return null;
			seenFingerprints.add(fingerprint);
		}
		seenSessions.add(session.session_key);
		sessions.push({ session_key: session.session_key, status: session.status, fingerprints: [...seenFingerprints] });
	}
	return { schema: RECALL_ECHO_STORE_SCHEMA, sessions };
}

export function updateRecallEchoStore(value, { sessionId, status, fingerprints = [] } = {}) {
	const sessionKey = recallEchoSessionKey(sessionId);
	if (!sessionKey) return normalizeRecallEchoStore(value) ?? { schema: RECALL_ECHO_STORE_SCHEMA, sessions: [] };
	const prior = normalizeRecallEchoStore(value) ?? { schema: RECALL_ECHO_STORE_SCHEMA, sessions: [] };
	const previous = prior.sessions.find((session) => session.session_key === sessionKey) ?? null;
	const uniqueFingerprints = [...new Set(fingerprints)];
	const validProposed = GUARD_STATUSES.has(status)
		&& uniqueFingerprints.length <= RECALL_ECHO_MAX_FINGERPRINTS
		&& uniqueFingerprints.every(validSessionKey)
		&& ((status === "armed" && uniqueFingerprints.length > 0) || (status === "no_context" && uniqueFingerprints.length === 0));
	const proposed = GUARD_STATUSES.has(status)
		&& validProposed
		? { session_key: sessionKey, status, fingerprints: uniqueFingerprints }
		: null;
	if (!proposed) return prior;
	let next = proposed;
	if (previous?.status === "armed") {
		const union = proposed.status === "armed"
			? [...new Set([...previous.fingerprints, ...proposed.fingerprints])]
			: previous.fingerprints;
		if (union.length > RECALL_ECHO_MAX_FINGERPRINTS) return prior;
		next = { session_key: sessionKey, status: "armed", fingerprints: union };
	}
	const sessions = prior.sessions.filter((session) => session.session_key !== sessionKey);
	sessions.push(next);
	return {
		schema: RECALL_ECHO_STORE_SCHEMA,
		sessions: sessions.slice(-RECALL_ECHO_MAX_SESSIONS),
	};
}

export function recallEchoGuardForSession(value, sessionId) {
	const sessionKey = recallEchoSessionKey(sessionId);
	if (!sessionKey) return { status: "missing", fingerprints: [] };
	const store = normalizeRecallEchoStore(value);
	const session = store?.sessions.find((candidate) => candidate.session_key === sessionKey);
	return session
		? { status: session.status, fingerprints: [...session.fingerprints] }
		: { status: "missing", fingerprints: [] };
}

export function recallEchoFingerprintsForSession(value, sessionId) {
	return recallEchoGuardForSession(value, sessionId).fingerprints;
}
