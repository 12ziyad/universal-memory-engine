/**
 * The secret scrubber — deterministic, no LLM, and it runs BEFORE any model,
 * vector store, or D1 row sees the text. Once a secret reaches a model or an
 * embedding you cannot take it back, so this is the first thing every save
 * door does to incoming content.
 *
 * The contract: meaning survives, the secret does not. "The app connects to
 * AuraDB at neo4j+s://neo4j:hunter2@abc123.databases.neo4j.io" keeps the fact
 * (they use AuraDB) and loses the credential. Typed placeholders say what WAS
 * there, so recall can still answer "what did I store the connection as?"
 * with "[a redacted connection credential]" rather than nothing.
 *
 * Order matters: PEM blocks first (they contain high-entropy lines that the
 * generic rule would shred into confetti), then URIs, then known key shapes,
 * then the generic high-entropy rule as the last net.
 */

// Known machine-credential prefixes. Anchored to word-ish boundaries so prose
// like "risky-business" never matches. Length floors keep "sk-8" (a plausible
// SKU) out while catching every real key of that family.
const KEY_PATTERNS = [
	// OpenAI / Anthropic / Stripe style
	/\bsk-[A-Za-z0-9_-]{16,}\b/g,
	// GitHub tokens (classic, oauth, fine-grained, actions)
	/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
	/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
	// PyPI
	/\bpypi-[A-Za-z0-9_-]{20,}\b/g,
	// Our own keys — the product must never memorize its own credentials.
	/\bitsuki_live_[A-Za-z0-9_-]{8,}\b/g,
	/\buml_live_[A-Za-z0-9_-]{8,}\b/g,
	// AWS access key id (fixed shape) + the secret that often travels beside it
	/\bAKIA[0-9A-Z]{16}\b/g,
	// Slack
	/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
	// JWTs: three base64url segments, first one is always {"alg":… → eyJ
	/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g,
];

const PEM_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;

// scheme://user:password@host — postgres://, mongodb+srv://, neo4j+s://, redis://…
// The scheme and host carry the meaning ("uses AuraDB"); the userinfo is the
// secret. Password is replaced, username kept (it is often just "neo4j"/"admin"
// and losing it would garble the sentence more than it protects).
const URI_CREDENTIAL_RE = /\b([a-z][a-z0-9+.-]{1,30}):\/\/([^\s/@:]{1,64}):([^\s@]{1,256})@/gi;

// Query-string secrets: ?api_key=…, &token=…, &secret=…, &password=…
const QUERY_SECRET_RE = /([?&](?:api[_-]?key|token|secret|password|passwd|pwd|auth|access[_-]?token|apikey)=)([^\s&#]{6,})/gi;

// "Bearer <token>" in prose — the shape people paste out of a curl command or
// a Postman tab. The word Bearer is the giveaway, so the token needs no
// entropy floor beyond being token-shaped: prose after "Bearer" that is 12+
// chars of key alphabet with no spaces is never an English sentence.
// (8.1: the load test proved sk-/ghp-/URI-creds; this is the shape it missed.)
const BEARER_RE = /\b(bearer\s+)([A-Za-z0-9._~+/=-]{12,})/gi;

// Generic high-entropy net: 32+ chars of key-alphabet with real character-class
// mixing. Ordinary long text — URLs, file paths, German compound nouns, hex
// commit hashes people paste in stack traces — must NOT match; see looksSecret.
const LONG_TOKEN_RE = /[A-Za-z0-9+/=_-]{32,}/g;

function shannonBitsPerChar(s) {
	const counts = new Map();
	for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
	let bits = 0;
	for (const n of counts.values()) {
		const p = n / s.length;
		bits -= p * Math.log2(p);
	}
	return bits;
}

/**
 * Would a human call this string a machine secret? Demands length, character
 * class mixing AND measured entropy, so prose and identifiers survive:
 *  - pure hex up to 64 chars is a hash (git SHA, digest) — meaning, not secret
 *  - a single case with no digits is a WORD (Donaudampfschifffahrt…) — keep
 *  - low entropy means repetition ("aaaa…", "abcabc…") — keep
 */
export function looksSecret(token) {
	if (token.length < 32) return false;
	if (/^[0-9a-f]+$/i.test(token) && token.length <= 64) return false; // hashes
	if (/^[0-9]+$/.test(token)) return false;
	const hasLower = /[a-z]/.test(token);
	const hasUpper = /[A-Z]/.test(token);
	const hasDigit = /[0-9]/.test(token);
	const classes = [hasLower, hasUpper, hasDigit].filter(Boolean).length;
	if (classes < 2) return false;
	return shannonBitsPerChar(token) >= 4.0;
}

/**
 * Scrub one string. Returns { text, redactions } where redactions counts what
 * was removed by type — receipts surface the counts, never the values.
 */
export function scrubText(input) {
	let text = String(input ?? "");
	const redactions = {};
	const hit = (type) => { redactions[type] = (redactions[type] ?? 0) + 1; };

	text = text.replace(PEM_RE, () => { hit("private_key"); return "[REDACTED:private-key]"; });

	text = text.replace(URI_CREDENTIAL_RE, (_m, scheme, user) => {
		hit("connection_credentials");
		return `${scheme}://${user}:[REDACTED:password]@`;
	});

	text = text.replace(QUERY_SECRET_RE, (_m, prefix) => {
		hit("query_secret");
		return `${prefix}[REDACTED:secret]`;
	});

	for (const re of KEY_PATTERNS) {
		text = text.replace(re, () => { hit("api_key"); return "[REDACTED:api-key]"; });
	}

	// After the named families: a token already replaced above leaves
	// "[REDACTED:api-key]" here, which this pattern must not re-wrap.
	text = text.replace(BEARER_RE, (m, prefix, token) => {
		if (token.startsWith("[REDACTED")) return m;
		hit("bearer_token");
		return `${prefix}[REDACTED:token]`;
	});

	text = text.replace(LONG_TOKEN_RE, (m) => {
		if (!looksSecret(m)) return m;
		hit("high_entropy");
		return "[REDACTED:secret]";
	});

	return { text, redactions };
}

/** Scrub a message array in place-shape: same objects back, content scrubbed. */
export function scrubMessages(messages) {
	const redactions = {};
	const out = (messages ?? []).map((m) => {
		if (!m || typeof m.content !== "string") return m;
		const r = scrubText(m.content);
		for (const [k, v] of Object.entries(r.redactions)) redactions[k] = (redactions[k] ?? 0) + v;
		return r.text === m.content ? m : { ...m, content: r.text };
	});
	return { messages: out, redactions, redacted: Object.keys(redactions).length > 0 };
}
