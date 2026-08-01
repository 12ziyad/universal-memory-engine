/**
 * Itsuki JavaScript SDK — a thin, dependency-free client for the Itsuki
 * memory API. Node 18+ (built-in fetch). Server-side use: keep API keys out
 * of browsers unless the deployment has CORS enabled and the key is scoped.
 *
 *   import { MemoryClient } from "itsuki";
 *   const memory = new MemoryClient({ apiKey: process.env.ITSUKI_API_KEY });
 *   await memory.add("I started learning Kotlin this week.");
 *   const { context } = await memory.search("what am I learning?");
 */

const DEFAULT_BASE_URL = "https://itsuki.app";
const VERSION = "0.1.1";

export class MemoryAPIError extends Error {
	constructor(message, { status = 0, code = null, body = null } = {}) {
		super(message);
		this.name = "MemoryAPIError";
		this.status = status;
		this.code = code;
		this.body = body;
	}
}

export class MemoryClient {
	/**
	 * @param {object} options
	 * @param {string} options.apiKey - itsuki_live_… Bearer key (uml_live_ keys also work).
	 * @param {string} [options.baseUrl] - deployment origin.
	 * @param {string|null} [options.userId] - optional sub-tenant selector: a stable
	 *   string per end user of YOUR app; each value maps to an isolated memory space.
	 * @param {number} [options.timeoutMs]
	 * @param {number} [options.maxRetries] - retries for GETs and idempotent POSTs.
	 */
	constructor({ apiKey, baseUrl = DEFAULT_BASE_URL, userId = null, timeoutMs = 30000, maxRetries = 2 } = {}) {
		if (!apiKey) throw new MemoryAPIError("apiKey is required");
		this.apiKey = apiKey;
		this.baseUrl = String(baseUrl).replace(/\/+$/, "");
		this.userId = userId;
		this.timeoutMs = timeoutMs;
		this.maxRetries = maxRetries;
	}

	/** Save one durable fact. Returns the write receipt. */
	add(content, opts = {}) {
		return this.#post("/v1/save", { content, ...opts });
	}
	save(content, opts = {}) { return this.add(content, opts); }

	/** Save a conversation (messages oldest first). */
	addConversation(messages, opts = {}) {
		return this.#post("/v1/save", { mode: "conversation", messages, ...opts });
	}

	/** Look up relevant memory. `context` on the result is the prompt-ready block. */
	search(query, opts = {}) {
		return this.#post("/v1/recall", { query, ...opts });
	}
	recall(query, opts = {}) { return this.search(query, opts); }

	/** Recall + auto-capture in one call — send the latest chat messages. */
	turn(messages, opts = {}) {
		return this.#post("/v1/turn", { messages, ...opts });
	}

	/** Bulk ingestion; pass { flush: true } to force digestion now. */
	ingest(messages, opts = {}) {
		return this.#post("/v1/ingest", { messages, ...opts });
	}

	graph() { return this.#get("/v1/graph"); }
	status() { return this.#get("/v1/status"); }
	receipts({ limit = 50 } = {}) { return this.#get(`/v1/receipts?limit=${limit}`); }
	usage({ range = "30d" } = {}) { return this.#get(`/v1/usage?range=${encodeURIComponent(range)}`); }
	getRules() { return this.#get("/v1/rules"); }
	setRules(rules) { return this.#request("PUT", "/v1/rules", { rules }); }
	exportAll() { return this.#get("/v1/export"); }

	/** A fresh idempotency key — pass it to writes to make retries safe. */
	newIdempotencyKey() {
		return `idem_${crypto.randomUUID()}`;
	}

	#get(path) { return this.#request("GET", path); }
	#post(path, body) { return this.#request("POST", path, body); }

	async #request(method, path, body = undefined) {
		const url = new URL(this.baseUrl + path);
		if (this.userId && !url.searchParams.has("userId")) url.searchParams.set("userId", this.userId);
		const payload = body === undefined ? undefined : JSON.stringify(
			this.userId && body.userId === undefined ? { ...body, userId: this.userId } : body,
		);
		// Writes retry only when the caller opted into idempotency; reads always may.
		const retryable = method === "GET" || (body && typeof body.idempotencyKey === "string");
		const attempts = retryable ? this.maxRetries + 1 : 1;

		let lastError;
		for (let attempt = 0; attempt < attempts; attempt++) {
			if (attempt > 0) {
				const backoff = 250 * 2 ** (attempt - 1) + Math.random() * 100;
				await new Promise((resolve) => setTimeout(resolve, lastError?.retryAfterMs ?? backoff));
			}
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), this.timeoutMs);
			try {
				const res = await fetch(url, {
					method,
					headers: {
						authorization: `Bearer ${this.apiKey}`,
						"content-type": "application/json",
						"user-agent": `itsuki-js/${VERSION}`,
					},
					body: payload,
					signal: controller.signal,
				});
				const data = await res.json().catch(() => null);
				if (res.ok) return data;
				const error = new MemoryAPIError(
					(data && (data.message || data.error)) || `${method} ${path} failed with ${res.status}`,
					{ status: res.status, code: data?.error ?? null, body: data },
				);
				if (res.status === 429 || res.status >= 500) {
					const retryAfter = Number(res.headers.get("retry-after"));
					if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfterMs = retryAfter * 1000;
					lastError = error;
					continue;
				}
				throw error;
			} catch (error) {
				if (error instanceof MemoryAPIError && !(error.status === 429 || error.status >= 500)) throw error;
				lastError = error instanceof MemoryAPIError ? error : new MemoryAPIError(
					error?.name === "AbortError" ? `request timed out after ${this.timeoutMs}ms` : String(error?.message ?? error),
					{ status: 0 },
				);
			} finally {
				clearTimeout(timer);
			}
		}
		throw lastError;
	}
}

export const Memory = MemoryClient;
export default MemoryClient;
