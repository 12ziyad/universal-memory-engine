/**
 * The Memory V3 feature flag.
 *
 * V3 changes what the product captures and how it retrieves. Existing users
 * stay on the proven path while it is developed, so the flag is OFF unless the
 * deployment explicitly says otherwise, and "otherwise" means naming accounts.
 *
 * This flag is the rollback mechanism for V3 behaviour. Three properties make
 * that true, and `test/memory_v3_flag.spec.js` holds them:
 *
 *   1. It fails CLOSED. An unset, empty, misspelt, or non-string value is `off`.
 *      There is no value a typo can produce that turns V3 on.
 *   2. It is resolved from `env` and an account id ONLY. There is no request
 *      body, header, query parameter, or scope object that reaches it — so a
 *      caller cannot opt themselves (or anybody else) in, and one account's
 *      setting cannot bleed into another's request.
 *   3. Allowlist membership is whole-string and case-sensitive, because account
 *      ids are. `user_1` never matches `user_10`.
 *
 * Modes:
 *   off        — everybody on the legacy path. THE PRODUCTION DEFAULT.
 *   allowlist  — only the accounts named in ITSUKI_MEMORY_V3_USERS.
 *   on         — every account. Global rollout only; enabling this in
 *                production is a deliberate act, never a side effect of a deploy.
 */

export const MEMORY_V3_FLAG_SCHEMA = "itsuki.memory-v3-flag/v1";

export const MEMORY_V3_MODES = new Set(["off", "allowlist", "on"]);

/** Split the allowlist var into exact account ids. Blank entries are dropped. */
function parseAllowlist(raw) {
	if (typeof raw !== "string") return new Set();
	const ids = new Set();
	for (const part of raw.split(",")) {
		const id = part.trim();
		if (id) ids.add(id);
	}
	return ids;
}

/**
 * Resolve the flag's configuration. Never throws: a broken value is `off`,
 * because a memory system that guesses at a rollout switch is worse than one
 * that stays on the path it already proved.
 */
export function memoryV3Config(env) {
	const raw = env?.ITSUKI_MEMORY_V3;
	const mode = typeof raw === "string" && MEMORY_V3_MODES.has(raw.trim().toLowerCase())
		? raw.trim().toLowerCase()
		: "off";
	const allowlist = mode === "allowlist" ? parseAllowlist(env?.ITSUKI_MEMORY_V3_USERS) : new Set();
	return { mode, allowlist, allowlistCount: allowlist.size };
}

/**
 * Is V3 active for this account? `userId` is the account that owns the rows —
 * the same identity every scoped query binds — so the answer cannot differ
 * between the write that stores something and the read that finds it.
 */
export function memoryV3Enabled(env, userId) {
	if (typeof userId !== "string" || !userId.trim()) return false;
	const { mode, allowlist } = memoryV3Config(env);
	if (mode === "on") return true;
	if (mode === "allowlist") return allowlist.has(userId);
	return false;
}

/**
 * E2-B1 changes extraction acceptance semantics, so it has its own nested
 * experiment switch. The parent V3 flag remains necessary: a B1 typo or stale
 * allowlist can never opt a legacy account into V3 behavior. Default OFF keeps
 * already-allowlisted benchmark accounts as the causal control until an
 * explicit treatment cohort is named.
 */
export function memoryV3ExtractionB1Config(env) {
	const raw = env?.ITSUKI_MEMORY_V3_EXTRACTION_B1;
	const mode = typeof raw === "string" && MEMORY_V3_MODES.has(raw.trim().toLowerCase())
		? raw.trim().toLowerCase()
		: "off";
	const allowlist = mode === "allowlist"
		? parseAllowlist(env?.ITSUKI_MEMORY_V3_EXTRACTION_B1_USERS)
		: new Set();
	return { mode, allowlist, allowlistCount: allowlist.size };
}

export function memoryV3ExtractionB1Enabled(env, userId) {
	if (!memoryV3Enabled(env, userId)) return false;
	const { mode, allowlist } = memoryV3ExtractionB1Config(env);
	if (mode === "on") return true;
	if (mode === "allowlist") return allowlist.has(userId);
	return false;
}

/**
 * E4's zero-to-many capture lane has an independent nested switch. It writes
 * append-only candidates and is intentionally OFF even for parent-V3 accounts
 * until a named treatment cohort is selected.
 */
export function memoryV3AtomicCaptureConfig(env) {
	const raw = env?.ITSUKI_MEMORY_V3_ATOMIC_CAPTURE;
	const mode = typeof raw === "string" && MEMORY_V3_MODES.has(raw.trim().toLowerCase())
		? raw.trim().toLowerCase()
		: "off";
	const allowlist = mode === "allowlist"
		? parseAllowlist(env?.ITSUKI_MEMORY_V3_ATOMIC_CAPTURE_USERS)
		: new Set();
	return { mode, allowlist, allowlistCount: allowlist.size };
}

export function memoryV3AtomicCaptureEnabled(env, userId) {
	if (!memoryV3Enabled(env, userId)) return false;
	const { mode, allowlist } = memoryV3AtomicCaptureConfig(env);
	if (mode === "on") return true;
	if (mode === "allowlist") return allowlist.has(userId);
	return false;
}

/**
 * E6's projection switch is nested below both parent V3 and atomic capture.
 * A projection allowlist can therefore never make an account start capturing
 * atoms, and a stale capture allowlist can never make them enter semantic state.
 */
export function memoryV3AtomicProjectionConfig(env) {
	const raw = env?.ITSUKI_MEMORY_V3_ATOMIC_PROJECTION;
	const mode = typeof raw === "string" && MEMORY_V3_MODES.has(raw.trim().toLowerCase())
		? raw.trim().toLowerCase()
		: "off";
	const allowlist = mode === "allowlist"
		? parseAllowlist(env?.ITSUKI_MEMORY_V3_ATOMIC_PROJECTION_USERS)
		: new Set();
	return { mode, allowlist, allowlistCount: allowlist.size };
}

export function memoryV3AtomicProjectionEnabled(env, userId) {
	if (!memoryV3AtomicCaptureEnabled(env, userId)) return false;
	const { mode, allowlist } = memoryV3AtomicProjectionConfig(env);
	if (mode === "on") return true;
	if (mode === "allowlist") return allowlist.has(userId);
	return false;
}

/**
 * E6M's source-aware coalescer is nested below governed projection. It can only
 * alter how two already-authorized same-batch assertions share one semantic
 * object; it cannot activate capture or projection for an account.
 */
export function memoryV3AtomicCoalescingConfig(env) {
	const raw = env?.ITSUKI_MEMORY_V3_ATOMIC_COALESCING;
	const mode = typeof raw === "string" && MEMORY_V3_MODES.has(raw.trim().toLowerCase())
		? raw.trim().toLowerCase()
		: "off";
	const allowlist = mode === "allowlist"
		? parseAllowlist(env?.ITSUKI_MEMORY_V3_ATOMIC_COALESCING_USERS)
		: new Set();
	return { mode, allowlist, allowlistCount: allowlist.size };
}

export function memoryV3AtomicCoalescingEnabled(env, userId) {
	if (!memoryV3AtomicProjectionEnabled(env, userId)) return false;
	const { mode, allowlist } = memoryV3AtomicCoalescingConfig(env);
	if (mode === "on") return true;
	if (mode === "allowlist") return allowlist.has(userId);
	return false;
}

/**
 * E7 changes only retrieval/fusion and is independently reversible. Unlike
 * projection it does not require a write-path flag to remain enabled after a
 * memory has been accepted, so it is nested directly below the parent V3 flag.
 */
export function memoryV3HybridRetrievalConfig(env) {
	const raw = env?.ITSUKI_MEMORY_V3_HYBRID_RETRIEVAL;
	const mode = typeof raw === "string" && MEMORY_V3_MODES.has(raw.trim().toLowerCase())
		? raw.trim().toLowerCase()
		: "off";
	const allowlist = mode === "allowlist"
		? parseAllowlist(env?.ITSUKI_MEMORY_V3_HYBRID_RETRIEVAL_USERS)
		: new Set();
	return { mode, allowlist, allowlistCount: allowlist.size };
}

export function memoryV3HybridRetrievalEnabled(env, userId) {
	if (!memoryV3Enabled(env, userId)) return false;
	const { mode, allowlist } = memoryV3HybridRetrievalConfig(env);
	if (mode === "on") return true;
	if (mode === "allowlist") return allowlist.has(userId);
	return false;
}

/**
 * E9A expands an already-selected semantic assertion to its exact permitted
 * source episode. It is a read-only layer nested under E7: a stale expansion
 * allowlist can neither opt a legacy account into V3 nor activate a different
 * retrieval path by itself.
 */
export function memoryV3SourceExpansionConfig(env) {
	const raw = env?.ITSUKI_MEMORY_V3_SOURCE_EXPANSION;
	const mode = typeof raw === "string" && MEMORY_V3_MODES.has(raw.trim().toLowerCase())
		? raw.trim().toLowerCase()
		: "off";
	const allowlist = mode === "allowlist"
		? parseAllowlist(env?.ITSUKI_MEMORY_V3_SOURCE_EXPANSION_USERS)
		: new Set();
	return { mode, allowlist, allowlistCount: allowlist.size };
}

export function memoryV3SourceExpansionEnabled(env, userId) {
	if (!memoryV3HybridRetrievalEnabled(env, userId)) return false;
	const { mode, allowlist } = memoryV3SourceExpansionConfig(env);
	if (mode === "on") return true;
	if (mode === "allowlist") return allowlist.has(userId);
	return false;
}

/**
 * E9B searches scrubbed source episodes only when the semantic result is thin.
 * It is nested below E9A as well as E7: fallback cannot accidentally turn on a
 * broader read architecture for an account that has not accepted exact source
 * rendering first.
 */
export function memoryV3EpisodeFallbackConfig(env) {
	const raw = env?.ITSUKI_MEMORY_V3_EPISODE_FALLBACK;
	const mode = typeof raw === "string" && MEMORY_V3_MODES.has(raw.trim().toLowerCase())
		? raw.trim().toLowerCase()
		: "off";
	const allowlist = mode === "allowlist"
		? parseAllowlist(env?.ITSUKI_MEMORY_V3_EPISODE_FALLBACK_USERS)
		: new Set();
	return { mode, allowlist, allowlistCount: allowlist.size };
}

export function memoryV3EpisodeFallbackEnabled(env, userId) {
	if (!memoryV3SourceExpansionEnabled(env, userId)) return false;
	const { mode, allowlist } = memoryV3EpisodeFallbackConfig(env);
	if (mode === "on") return true;
	if (mode === "allowlist") return allowlist.has(userId);
	return false;
}

/**
 * E10 changes only how E7-selected evidence is rendered. It is nested directly
 * under E7 so historical states without E9A projections can run the causal
 * context-only confirmation, while accepted V3 states can still combine it
 * with independently gated source expansion.
 */
export function memoryV3AdaptiveContextConfig(env) {
	const raw = env?.ITSUKI_MEMORY_V3_ADAPTIVE_CONTEXT;
	const mode = typeof raw === "string" && MEMORY_V3_MODES.has(raw.trim().toLowerCase())
		? raw.trim().toLowerCase()
		: "off";
	const allowlist = mode === "allowlist"
		? parseAllowlist(env?.ITSUKI_MEMORY_V3_ADAPTIVE_CONTEXT_USERS)
		: new Set();
	return { mode, allowlist, allowlistCount: allowlist.size };
}

export function memoryV3AdaptiveContextEnabled(env, userId) {
	if (!memoryV3HybridRetrievalEnabled(env, userId)) return false;
	const { mode, allowlist } = memoryV3AdaptiveContextConfig(env);
	if (mode === "on") return true;
	if (mode === "allowlist") return allowlist.has(userId);
	return false;
}

/**
 * Flag state for operators, carrying no private data: the mode and how many
 * accounts are selected, never which ones.
 */
export function memoryV3Status(env) {
	const { mode, allowlistCount } = memoryV3Config(env);
	const extraction = memoryV3ExtractionB1Config(env);
	const atomicCapture = memoryV3AtomicCaptureConfig(env);
	const atomicProjection = memoryV3AtomicProjectionConfig(env);
	const atomicCoalescing = memoryV3AtomicCoalescingConfig(env);
	const hybridRetrieval = memoryV3HybridRetrievalConfig(env);
	const sourceExpansion = memoryV3SourceExpansionConfig(env);
	const episodeFallback = memoryV3EpisodeFallbackConfig(env);
	const adaptiveContext = memoryV3AdaptiveContextConfig(env);
	return {
		schema: MEMORY_V3_FLAG_SCHEMA,
		mode,
		allowlistCount,
		extractionB1: { mode: extraction.mode, allowlistCount: extraction.allowlistCount },
		atomicCapture: { mode: atomicCapture.mode, allowlistCount: atomicCapture.allowlistCount },
		atomicProjection: { mode: atomicProjection.mode, allowlistCount: atomicProjection.allowlistCount },
		atomicCoalescing: { mode: atomicCoalescing.mode, allowlistCount: atomicCoalescing.allowlistCount },
		hybridRetrieval: { mode: hybridRetrieval.mode, allowlistCount: hybridRetrieval.allowlistCount },
		sourceExpansion: { mode: sourceExpansion.mode, allowlistCount: sourceExpansion.allowlistCount },
		episodeFallback: { mode: episodeFallback.mode, allowlistCount: episodeFallback.allowlistCount },
		adaptiveContext: { mode: adaptiveContext.mode, allowlistCount: adaptiveContext.allowlistCount },
	};
}
