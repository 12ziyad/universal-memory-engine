// GENERATED FILE — do not edit here.
// Source: packages/_kernel/ts/scrub.ts
// Regenerate: node scripts/sync-kernel.mjs
/**
 * Deterministic, local-only text hygiene for the Pi lifecycle adapter.
 *
 * This is a faithful TypeScript port of the server's canonical lane
 * (src/pipeline/scrub.js), kept self-contained inside the published package so
 * the extension has zero runtime dependencies — the same "copy, do not import"
 * decision the Codex adapter documents. Copying is only safe because the copy
 * is pinned: test/scrub.spec.ts runs this implementation against the repo's ONE
 * canonical corpus (test/fixtures/security_corpus.mjs), which is what stopped
 * the earlier scrubber drift (SEC-01 / CDX-07) from recurring silently.
 *
 * The contract: meaning survives, the secret does not. Typed placeholders say
 * what WAS there, so recall can still answer "what did I store that as?".
 * Order matters: PEM first, then URIs, then known key shapes, then the generic
 * entropy net, and the label→value forms last.
 */

const KEY_PATTERNS: RegExp[] = [
	/\bsk-[A-Za-z0-9_-]{16,}\b/g,
	/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
	/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
	/\bpypi-[A-Za-z0-9_-]{20,}\b/g,
	// Our own keys — the product must never memorize its own credentials.
	/\bitsuki_live_[A-Za-z0-9_-]{8,}\b/g,
	/\buml_live_[A-Za-z0-9_-]{8,}\b/g,
	// AWS long-term (AKIA) and STS/SSO temporary (ASIA) identifiers.
	/\b(?:AKIA|ASIA)[0-9A-Z]{16,}/g,
	/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
	// JWTs: three base64url segments, the first always starts {"alg":… → eyJ
	/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g,
];

const PEM_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
const URI_CREDENTIAL_RE = /\b([a-z][a-z0-9+.-]{1,30}):\/\/([^\s/@:]{1,64}):([^\s@]{1,256})@/gi;
const QUERY_SECRET_RE = /([?&](?:api[_-]?key|token|secret|password|passwd|pwd|auth|access[_-]?token|apikey)=)([^\s&#]{6,})/gi;
const BEARER_RE = /\b(bearer\s+)([A-Za-z0-9._~+/=-]{12,})/gi;
const LONG_TOKEN_RE = /[A-Za-z0-9+/=_-]{32,}/g;

const SECRET_LABEL = "(?:pass(?:word|phrase|wd)?|pwd|secret|api[_-]?key|apikey|access[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|token|credential(?:s)?)";
const LABELED_SECRET_ASSIGN_RE = new RegExp(
	`\\b([A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)*?[_-]?${SECRET_LABEL})(["']?\\s*[:=]\\s*)(?:"([^"\\r\\n]{1,256})"|'([^'\\r\\n]{1,256})'|([^\\s"']{6,256}))`,
	"gi",
);
const LABELED_SECRET_PROSE_RE = new RegExp(
	`\\b([A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)*?[_-]?${SECRET_LABEL})(\\s+(?:is|was)\\s+)(?:"([^"\\r\\n]{1,256})"|'([^'\\r\\n]{1,256})'|([^\\s"']{6,256}))`,
	"gi",
);

export type Redactions = Record<string, number>;

function looksLikeSecretValue(value: string): boolean {
	if (value.length < 6 || value.startsWith("[REDACTED")) return false;
	return /[0-9]/.test(value) || /[^A-Za-z0-9]/.test(value);
}

function shannonBitsPerChar(value: string): number {
	const counts = new Map<string, number>();
	for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
	let bits = 0;
	for (const n of counts.values()) {
		const p = n / value.length;
		bits -= p * Math.log2(p);
	}
	return bits;
}

/**
 * Would a human call this a machine secret? Demands length, character-class
 * mixing AND measured entropy, so hashes, numbers and long words survive.
 */
export function looksSecret(token: string): boolean {
	if (token.length < 32) return false;
	if (/^[0-9a-f]+$/i.test(token) && token.length <= 64) return false;
	if (/^[0-9]+$/.test(token)) return false;
	const classes = [/[a-z]/.test(token), /[A-Z]/.test(token), /[0-9]/.test(token)].filter(Boolean).length;
	if (classes < 2) return false;
	return shannonBitsPerChar(token) >= 4.0;
}

/** Scrub one string. Returns the text plus counts by type — never the values. */
export function scrubText(input: unknown): { text: string; redactions: Redactions } {
	let text = String(input ?? "");
	const redactions: Redactions = {};
	const hit = (type: string) => { redactions[type] = (redactions[type] ?? 0) + 1; };

	text = text.replace(PEM_RE, () => { hit("private_key"); return "[REDACTED:private-key]"; });

	text = text.replace(URI_CREDENTIAL_RE, (_m, scheme: string, user: string) => {
		hit("connection_credentials");
		return `${scheme}://${user}:[REDACTED:password]@`;
	});

	text = text.replace(QUERY_SECRET_RE, (_m, prefix: string) => {
		hit("query_secret");
		return `${prefix}[REDACTED:secret]`;
	});

	for (const re of KEY_PATTERNS) {
		text = text.replace(re, () => { hit("api_key"); return "[REDACTED:api-key]"; });
	}

	text = text.replace(BEARER_RE, (m, prefix: string, token: string) => {
		if (token.startsWith("[REDACTED")) return m;
		hit("bearer_token");
		return `${prefix}[REDACTED:token]`;
	});

	text = text.replace(LONG_TOKEN_RE, (m) => {
		if (!looksSecret(m)) return m;
		hit("high_entropy");
		return "[REDACTED:secret]";
	});

	for (const re of [LABELED_SECRET_ASSIGN_RE, LABELED_SECRET_PROSE_RE]) {
		text = text.replace(re, (
			match: string,
			label: string,
			separator: string,
			doubleQuoted: string | undefined,
			singleQuoted: string | undefined,
			bare: string | undefined,
		) => {
			const value = doubleQuoted ?? singleQuoted ?? bare ?? "";
			const secretish = bare === undefined
				? looksLikeSecretValue(value) || (value.length >= 6 && /\s/.test(value) && !value.startsWith("[REDACTED"))
				: looksLikeSecretValue(value);
			if (!secretish) return match;
			hit("labeled_secret");
			return `${label}${separator}[REDACTED:secret]`;
		});
	}

	return { text, redactions };
}
