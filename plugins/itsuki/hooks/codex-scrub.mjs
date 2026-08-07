/**
 * Deterministic, local-only text hygiene for the Codex lifecycle adapter.
 *
 * This file is intentionally self-contained inside the installed plugin. It is
 * not shared with the Claude adapter: Codex transcripts are an explicitly
 * unstable format and must keep an independent fail-closed parser boundary.
 */

import { createHash } from "node:crypto";

export const RECALL_OPEN_MARKER = "<itsuki-codex-recalled-context-v1>";
export const RECALL_CLOSE_MARKER = "</itsuki-codex-recalled-context-v1>";

const PEM_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
const URI_CREDENTIAL_RE = /\b([a-z][a-z0-9+.-]{1,30}):\/\/([^\s/@:]{1,64}):([^\s@]{1,256})@/gi;
const QUERY_SECRET_RE = /([?&](?:api[_-]?key|token|secret|password|passwd|pwd|auth|access[_-]?token|apikey)=)([^\s&#]{6,})/gi;
// Labeled → value forms, kept semantically identical to the server lane
// (src/pipeline/scrub.js) and proven against the same corpus
// (test/fixtures/security_corpus.mjs). Copied, not imported: this file stays
// self-contained inside the installed plugin. CDX-07: the old single pattern
// missed prose ("password is …"), prefixed labels (DB_PASSWORD=…), and
// quoted JSON/YAML labels ("apiKey": "…").
const SECRET_LABEL = "(?:pass(?:word|phrase|wd)?|pwd|secret|api[_-]?key|apikey|access[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|token|credential(?:s)?)";
const LABELED_SECRET_ASSIGN_RE = new RegExp(
	`\\b([A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)*?[_-]?${SECRET_LABEL})(["']?\\s*[:=]\\s*)(?:"([^"\\r\\n]{1,256})"|'([^'\\r\\n]{1,256})'|([^\\s"']{6,256}))`,
	"gi",
);
const LABELED_SECRET_PROSE_RE = new RegExp(
	`\\b([A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)*?[_-]?${SECRET_LABEL})(\\s+(?:is|was)\\s+)(?:"([^"\\r\\n]{1,256})"|'([^'\\r\\n]{1,256})'|([^\\s"']{6,256}))`,
	"gi",
);
function looksLikeLabeledSecretValue(value) {
	if (value.length < 6 || value.startsWith("[REDACTED")) return false;
	return /[0-9]/.test(value) || /[^A-Za-z0-9]/.test(value);
}
const BEARER_RE = /\b(bearer\s+)([A-Za-z0-9._~+/=-]{12,})/gi;
const LONG_TOKEN_RE = /[A-Za-z0-9+/=_-]{32,}/g;
const KEY_PATTERNS = [
	/\bsk-[A-Za-z0-9_-]{16,}\b/g,
	/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
	/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
	/\bpypi-[A-Za-z0-9_-]{20,}\b/g,
	/\bitsuki_live_[A-Za-z0-9_-]{8,}\b/g,
	/\buml_live_[A-Za-z0-9_-]{8,}\b/g,
	// AKIA long-term + ASIA STS/temporary credentials, length-tolerant —
	// mirrors the server lane exactly (SEC-03; corpus-locked).
	/\b(?:AKIA|ASIA)[0-9A-Z]{16,}/g,
	/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
	/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g,
];

export const REDACTION_KEYS = Object.freeze([
	"private_key",
	"connection_credentials",
	"query_secret",
	"named_secret",
	"api_key",
	"bearer_token",
	"high_entropy",
]);

function entropyBitsPerCharacter(value) {
	const counts = new Map();
	for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
	let bits = 0;
	for (const count of counts.values()) {
		const probability = count / value.length;
		bits -= probability * Math.log2(probability);
	}
	return bits;
}

export function looksLikeSecret(value) {
	if (typeof value !== "string" || value.length < 32) return false;
	if (/^[0-9a-f]+$/i.test(value) && value.length <= 64) return false;
	if (/^[0-9]+$/.test(value)) return false;
	const classes = [/[a-z]/.test(value), /[A-Z]/.test(value), /[0-9]/.test(value)].filter(Boolean).length;
	return classes >= 2 && entropyBitsPerCharacter(value) >= 4;
}

export function emptyRedactions() {
	return Object.fromEntries(REDACTION_KEYS.map((key) => [key, 0]));
}

export function mergeRedactions(target, additions) {
	for (const key of REDACTION_KEYS) {
		const count = Number(additions?.[key] ?? 0);
		if (Number.isSafeInteger(count) && count > 0) {
			target[key] = Math.min(1_000_000, Number(target[key] ?? 0) + count);
		}
	}
	return target;
}

export function scrubCodexText(input) {
	let text = String(input ?? "");
	const redactions = emptyRedactions();
	const hit = (key) => { redactions[key] = Math.min(1_000_000, redactions[key] + 1); };

	text = text.replace(PEM_RE, () => {
		hit("private_key");
		return "[REDACTED:private-key]";
	});
	text = text.replace(URI_CREDENTIAL_RE, (_match, scheme, user) => {
		hit("connection_credentials");
		return `${scheme}://${user}:[REDACTED:password]@`;
	});
	text = text.replace(QUERY_SECRET_RE, (_match, prefix) => {
		hit("query_secret");
		return `${prefix}[REDACTED:secret]`;
	});
	for (const pattern of KEY_PATTERNS) {
		text = text.replace(pattern, () => {
			hit("api_key");
			return "[REDACTED:api-key]";
		});
	}
	text = text.replace(BEARER_RE, (match, prefix, token) => {
		if (token.startsWith("[REDACTED")) return match;
		hit("bearer_token");
		return `${prefix}[REDACTED:token]`;
	});
	text = text.replace(LONG_TOKEN_RE, (token) => {
		if (!looksLikeSecret(token)) return token;
		hit("high_entropy");
		return "[REDACTED:secret]";
	});

	// Last, mirroring the server lane: label→value forms run after the shape
	// families so already-redacted values are left alone, and the LABEL is
	// preserved because it carries the meaning.
	for (const re of [LABELED_SECRET_ASSIGN_RE, LABELED_SECRET_PROSE_RE]) {
		text = text.replace(re, (match, label, separator, doubleQuoted, singleQuoted, bare) => {
			const value = doubleQuoted ?? singleQuoted ?? bare;
			const secretish = bare === undefined
				? looksLikeLabeledSecretValue(value) || (value.length >= 6 && /\s/.test(value) && !value.startsWith("[REDACTED"))
				: looksLikeLabeledSecretValue(value);
			if (!secretish) return match;
			hit("named_secret");
			return `${label}${separator}[REDACTED:secret]`;
		});
	}

	return { text, redactions };
}

export function truncateCodePoints(input, limit) {
	const points = Array.from(String(input ?? ""));
	if (points.length <= limit) return { text: points.join(""), truncated: false };
	return { text: `${points.slice(0, Math.max(0, limit - 1)).join("")}…`, truncated: true };
}

export function truncateCodePointsHeadTail(input, limit) {
	const points = Array.from(String(input ?? ""));
	if (points.length <= limit) return { text: points.join(""), truncated: false };
	const marker = "\n…[bounded middle omitted]…\n";
	const markerPoints = Array.from(marker);
	const available = Math.max(2, limit - markerPoints.length);
	const head = Math.ceil(available * 0.6);
	const tail = available - head;
	return {
		text: `${points.slice(0, head).join("")}${marker}${points.slice(points.length - tail).join("")}`,
		truncated: true,
	};
}

/** Remove context previously injected by this hook before considering capture. */
export function stripRecalledContext(input) {
	let text = String(input ?? "");
	for (;;) {
		const opening = text.indexOf(RECALL_OPEN_MARKER);
		if (opening < 0) break;
		const closing = text.indexOf(RECALL_CLOSE_MARKER, opening + RECALL_OPEN_MARKER.length);
		if (closing < 0) {
			text = text.slice(0, opening);
			break;
		}
		text = `${text.slice(0, opening)}${text.slice(closing + RECALL_CLOSE_MARKER.length)}`;
	}
	return text
		.replaceAll(RECALL_OPEN_MARKER, "")
		.replaceAll(RECALL_CLOSE_MARKER, "");
}

export function sanitizeRecalledContext(input, limit = 4_000) {
	let text = String(input ?? "")
		.replace(/\r\n?/g, "\n")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
		.replaceAll(RECALL_OPEN_MARKER, "[context marker removed]")
		.replaceAll(RECALL_CLOSE_MARKER, "[context marker removed]")
		.trim();
	const scrubbed = scrubCodexText(text);
	const bounded = truncateCodePoints(scrubbed.text, limit);
	return { text: bounded.text.trim(), truncated: bounded.truncated, redactions: scrubbed.redactions };
}

function recallEchoPiece(input) {
	const normalized = String(input ?? "")
		.normalize("NFKC")
		.toLowerCase()
		.replace(/^\s*(?:[-*+>]|\d+[.)])\s+/, "")
		.replace(/\s+/g, " ")
		.replace(/^[\s'"`([{]+|[\s'"`\])}.!,;:]+$/g, "")
		.trim();
	return normalized;
}

function recallEchoFingerprint(input) {
	const piece = recallEchoPiece(input);
	return piece
		? createHash("sha256").update(`itsuki-codex-recall-echo:v1\0${piece}`, "utf8").digest("hex")
		: null;
}

function recallEchoCandidates(input) {
	const text = String(input ?? "").replace(/\r\n?/g, "\n");
	const candidates = [text];
	for (const line of text.split("\n")) {
		candidates.push(line);
		for (const sentence of line.match(/[^.!?]+(?:[.!?]+|$)/g) ?? []) candidates.push(sentence);
	}
	return candidates;
}

/** Content-free hashes persisted by SessionStart; raw recall text never lands in the guard. */
export function recallEchoFingerprintsFromText(input, limit = 128) {
	const fingerprints = new Set();
	for (const candidate of recallEchoCandidates(input)) {
		const fingerprint = recallEchoFingerprint(candidate);
		if (fingerprint) fingerprints.add(fingerprint);
		if (fingerprints.size >= limit) break;
	}
	return [...fingerprints];
}

/** Remove exact recalled lines/sentences from assistant prose using only one-way hashes. */
export function filterRecalledEchoText(input, fingerprints = []) {
	const protectedFingerprints = new Set(
		Array.isArray(fingerprints)
			? fingerprints.filter((value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)).slice(0, 128)
			: [],
	);
	if (!protectedFingerprints.size) return { text: String(input ?? ""), removed: 0 };
	let removed = 0;
	const retainedLines = [];
	for (const line of String(input ?? "").replace(/\r\n?/g, "\n").split("\n")) {
		const lineFingerprint = recallEchoFingerprint(line);
		if (lineFingerprint && protectedFingerprints.has(lineFingerprint)) {
			removed += 1;
			continue;
		}
		const pieces = line.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [line];
		const retainedPieces = pieces.filter((piece) => {
			const fingerprint = recallEchoFingerprint(piece);
			if (fingerprint && protectedFingerprints.has(fingerprint)) {
				removed += 1;
				return false;
			}
			return true;
		});
		if (retainedPieces.length) retainedLines.push(retainedPieces.join(" ").trim());
	}
	return { text: retainedLines.join("\n").trim(), removed };
}
