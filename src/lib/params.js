/**
 * Strict request-body validation.
 *
 * The rule: an unrecognised parameter is an ERROR, never a shrug. Silently
 * dropping one is how somebody ships a multi-tenant app believing isolation
 * worked — which is exactly what happened with `user_id`: the wire name is
 * `userId`, Python callers naturally write `user_id`, the key was ignored, and
 * every tenant's memory landed in one bucket behind an `ok: true`.
 *
 * Two mechanisms:
 *   ALIASES  — spellings we accept and rewrite, so already-published SDK
 *              versions keep working. snake_case is first-class here because
 *              a Python SDK will always tempt callers into it.
 *   allowed  — everything else must be on the endpoint's list or the request
 *              is refused with a message naming the offending key.
 */

/** Wire aliases → the canonical camelCase name. */
const ALIASES = {
	user_id: "userId",
	external_user_id: "userId",
	externalUserId: "userId",
	end_user_id: "userId",
	endUserId: "userId",
	tenant_id: "userId",
	tenantId: "userId",
	memory_scope: "memoryScope",
	source_scope: "sourceScope",
	conversation_id: "conversationId",
	thread_id: "threadId",
	source_id: "sourceId",
	idempotency_key: "idempotencyKey",
	capture_density: "captureDensity",
	metadata_only: "metadataOnly",
	run_id: "runId",
};

/** Fields every memory endpoint accepts, on top of its own list. */
const COMMON = [
	"userId", "memoryScope", "sourceScope", "conversationId", "threadId",
	"sourceId", "idempotencyKey", "source", "captureDensity", "rules", "_test",
];

export const ENDPOINT_PARAMS = {
	"/v1/save": [...COMMON, "mode", "content", "messages", "scope", "n", "topic", "recentContext", "contentScope"],
	"/v1/recall": [...COMMON, "query", "topic", "limit"],
	"/v1/ingest": [...COMMON, "messages", "flush"],
	"/v1/turn": [...COMMON, "messages", "query"],
};

// A save is a memory, not a file upload. Past this the extractor cannot do
// anything useful with it anyway, and an accidental 500KB paste should be
// told so rather than silently accepted and quietly truncated downstream.
const MAX_CONTENT_CHARS = 120_000;

/** Levenshtein-lite: is `a` plausibly a typo of `b`? Used only for hints. */
function closeTo(a, b) {
	const x = a.toLowerCase().replace(/[_-]/g, "");
	const y = b.toLowerCase().replace(/[_-]/g, "");
	if (x === y) return true;
	if (Math.abs(x.length - y.length) > 2) return false;
	let edits = 0;
	for (let i = 0, j = 0; i < x.length || j < y.length;) {
		if (x[i] === y[j]) { i++; j++; continue; }
		if (++edits > 2) return false;
		if (x.length > y.length) i++;
		else if (x.length < y.length) j++;
		else { i++; j++; }
	}
	return edits <= 2;
}

/**
 * Canonicalise aliases and refuse unknown keys.
 * Returns { body } on success or { error, message } for a 400.
 */
export function validateBody(path, raw) {
	const allowed = ENDPOINT_PARAMS[path];
	if (!allowed) return { body: raw };
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { error: "invalid_body", message: "The request body must be a JSON object." };
	}

	const body = {};
	const renamed = [];
	for (const [key, value] of Object.entries(raw)) {
		const canonical = ALIASES[key] ?? key;
		if (!allowed.includes(canonical)) {
			const hint = allowed.find((a) => closeTo(key, a));
			return {
				error: "unknown_parameter",
				message: hint
					? `"${key}" isn't a parameter of ${path}. Did you mean "${hint}"?`
					: `"${key}" isn't a parameter of ${path}. Accepted: ${allowed.slice().sort().join(", ")}.`,
			};
		}
		if (canonical !== key) {
			// Last writer wins is ambiguous — refuse rather than guess.
			if (Object.prototype.hasOwnProperty.call(body, canonical) || Object.prototype.hasOwnProperty.call(raw, canonical)) {
				return {
					error: "conflicting_parameters",
					message: `"${key}" and "${canonical}" mean the same thing — send only one.`,
				};
			}
			renamed.push(key);
		}
		body[canonical] = value;
	}

	const oversize = tooLarge(body);
	if (oversize) return { error: "payload_too_large", message: oversize };

	return { body, renamed };
}

/** Say which field is too big and by how much, rather than failing later. */
function tooLarge(body) {
	const describe = (field, len) =>
		`${field} is ${Math.round(len / 1000)}KB — the limit is ${MAX_CONTENT_CHARS / 1000}KB. Split it into separate saves, or send it as messages[].`;
	if (typeof body.content === "string" && body.content.length > MAX_CONTENT_CHARS) {
		return describe("content", body.content.length);
	}
	if (typeof body.query === "string" && body.query.length > 8000) {
		return "query is too long — a recall query should be a question, not a document.";
	}
	if (Array.isArray(body.messages)) {
		const total = body.messages.reduce((n, m) => n + (typeof m?.content === "string" ? m.content.length : 0), 0);
		if (total > MAX_CONTENT_CHARS) return describe("messages[]", total);
	}
	return null;
}

/**
 * A credential that is the wrong KIND of secret should say so. "unauthorized"
 * sends someone hunting a permissions problem they do not have.
 */
export function credentialShapeHint(token) {
	const value = String(token ?? "");
	if (!value) return null;
	if (value.startsWith("whsec_")) {
		return "That's a webhook signing secret, not an API key. Webhook secrets only verify incoming deliveries. Create an API key at https://itsuki.app → API keys.";
	}
	if (value.startsWith("itsuki_live_") || value.startsWith("uml_live_")) return null;
	if (/^https?:\/\//i.test(value)) {
		return "That looks like a URL, not an API key. If you copied an MCP link, the key is the last path segment.";
	}
	if (value.startsWith("sk-") || value.startsWith("sk_")) {
		return "That looks like an OpenAI or Stripe key. Itsuki API keys start with itsuki_live_.";
	}
	return "API keys start with itsuki_live_. Create one at https://itsuki.app → API keys.";
}
