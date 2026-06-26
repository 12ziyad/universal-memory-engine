/**
 * Central configuration for the extraction engine.
 *
 * Everything tunable lives here: the trigger "dials", the LLM model/provider
 * (configurable via AI Gateway), the embedding model, and feature flags that let
 * tests (and local dev without --remote) run without Workers AI / Vectorize.
 */

// Trigger dials — the only numbers you should need to touch to retune holding.
export const DIALS = {
	idleMs: 30000, // fire a held chunk after this much silence
	chunkMsgs: 5, // fire after this many meaningful messages held
	chunkChars: 1200, // fire after this many characters held
};

/**
 * Allowed node categories — the canonical set the gates store. This is a
 * category-of-MEANING vocabulary, not a narrow whitelist: anything durable about
 * the user has a home here, and a model proposal that doesn't match is mapped via
 * CATEGORY_ALIASES (below) or kept as "other" — it is NOT dropped. The gates judge
 * "is this worth saving?" by meaning + junk rules, never by membership in a short
 * list. (See gates.js canonicalizeCategory + the anti-orphan rule.)
 */
export const CATEGORIES = [
	"person", // a specific person the user knows
	"family", // family members / relatives (grandmother, dad, sister)
	"relationship", // partners, friends, colleagues, relationship status
	"project", // things the user is building / working on
	"system", // a larger system the user runs/owns
	"tool", // a tool/tech/service the user uses
	"skill", // a skill/practice/sport the user trains
	"habit", // a recurring habit/routine
	"health", // conditions, diagnoses, fitness, mental health
	"goal", // an objective the user is pursuing
	"preference", // a like/dislike/style preference
	"identity", // a trait/value/belief/role that defines the user
	"life_event", // marriage, birth, death, move, breakup, new job
	"place", // a place that matters (home city, where they moved)
	"organization", // a company/employer/team/school
	"possession", // a meaningful thing the user owns
	"interest", // a topic/hobby/interest
	"other", // durable but uncategorized — kept, never dropped
];

/**
 * Maps the many category names a model invents onto the canonical set above, so a
 * proposal like {category:"relative"} for "Grandmother" lands as family instead of
 * being downgraded to a weak candidate. Keys are matched case-insensitively after
 * lowercasing + collapsing separators to "_". Unknown values fall through to
 * "other" (still kept). This is the heart of "judge by meaning, not a list".
 */
export const CATEGORY_ALIASES = {
	// people / family / relationships
	relative: "family", grandmother: "family", grandma: "family", grandfather: "family",
	grandpa: "family", mother: "family", father: "family", mom: "family", dad: "family",
	mum: "family", sister: "family", brother: "family", son: "family", daughter: "family",
	parent: "family", child: "family", kid: "family", aunt: "family", uncle: "family",
	cousin: "family", nephew: "family", niece: "family", spouse: "relationship",
	wife: "relationship", husband: "relationship", partner: "relationship",
	girlfriend: "relationship", boyfriend: "relationship", friend: "relationship",
	colleague: "relationship", coworker: "relationship", people: "person", human: "person",
	contact: "person",
	// health
	illness: "health", condition: "health", disease: "health", diagnosis: "health",
	medical: "health", medication: "health", medicine: "health", symptom: "health",
	injury: "health", fitness: "health", mental_health: "health", disorder: "health",
	// life events
	milestone: "life_event", event: "life_event", marriage: "life_event",
	wedding: "life_event", divorce: "life_event", birth: "life_event", death: "life_event",
	breakup: "life_event", relocation: "life_event", graduation: "life_event",
	// work / orgs / projects
	company: "organization", employer: "organization", workplace: "organization",
	team: "organization", org: "organization", business: "organization",
	school: "organization", university: "organization", college: "organization",
	job: "organization", startup: "project", app: "project", application: "project",
	product: "project", website: "project", initiative: "project",
	// tools / tech / systems
	technology: "tool", tech: "tool", software: "tool", service: "tool",
	platform: "tool", framework: "tool", database: "tool", api: "tool",
	library: "tool", language: "tool", infrastructure: "system",
	// skills / interests
	sport: "skill", practice: "skill", craft: "skill", discipline: "skill",
	hobby: "interest", activity: "interest", topic: "interest", subject: "interest",
	// places
	city: "place", country: "place", location: "place", home: "place", address: "place",
	// goals / preferences / identity / possessions
	objective: "goal", target: "goal", aspiration: "goal", ambition: "goal",
	like: "preference", dislike: "preference", favorite: "preference", style: "preference",
	trait: "identity", value: "identity", belief: "identity", role: "identity",
	personality: "identity", belonging: "possession", item: "possession",
	asset: "possession", vehicle: "possession", pet: "possession",
};

export const ACTIONS = [
	"started",
	"stopped",
	"paused",
	"resumed",
	"launched",
	"completed",
	"fixed",
	"removed",
	"changed_plan",
	"decided",
	"diagnosed",
	"passed_away",
	"married",
	"born",
	"moved",
	"broke_up",
	"injured",
	"recovered",
	"achieved",
	"joined",
	"left",
	"other",
];

export const IMPORTANCE = ["ordinary", "important", "life_significant"];

export const EDGE_TYPES = [
	"uses",
	"part_of",
	"depends_on",
	"supports",
	"improves",
	"drives",
	"stores_in",
	"connects_to",
	"related_to",
];

export const SLICE_KINDS = [
	"feature_detail",
	"technical_detail",
	"progress",
	"blocker",
	"fix",
	"decision",
	"preference",
	"other",
];

export const CANDIDATE_STRENGTHS = ["weak", "medium", "strong"];

/**
 * Maps a lifecycle action to the node state it implies.
 * Used by the event gate to keep a node's `state` in sync with its history.
 */
export const ACTION_TO_STATE = {
	started: "active",
	resumed: "active",
	launched: "active",
	joined: "active",
	stopped: "inactive",
	removed: "inactive",
	left: "inactive",
	passed_away: "inactive",
	broke_up: "inactive",
	paused: "paused",
	completed: "completed",
	achieved: "completed",
};

function flag(value, fallback) {
	if (value === undefined || value === null) return fallback;
	return String(value) === "true";
}

/**
 * Reads runtime config from env, applying defaults. `env` is whatever the Worker
 * / Durable Object was constructed with, so vars set in wrangler.jsonc (or
 * overridden in vitest.config.js) flow through here.
 */
export function getConfig(env) {
	return {
		dials: DIALS,

		// Feature flags — default ON in production, turned OFF for tests so the
		// suite never reaches out to Workers AI / Vectorize.
		useVectors: flag(env.USE_VECTORS, true),
		enablePass2: flag(env.ENABLE_PASS2, true),

		// LLM (the proposer). Provider + model are configurable; route through an
		// AI Gateway by setting AI_GATEWAY_ID.
		llm: {
			provider: env.LLM_PROVIDER || "workers-ai",
			// THE extraction model — one-line switch (see Priority 2 bake-off). Override
			// in wrangler.jsonc vars or via env without touching code.
			model: env.LLM_MODEL || "@cf/meta/llama-3.1-8b-instruct-fp8",
			maxTokens: Number(env.LLM_MAX_TOKENS ?? 4096),
			// Cheap model for the secondary jobs: Pass-2 summaries and the
			// save_conversation digest. Stays small/fast on purpose.
			summaryModel:
				env.LLM_SUMMARY_MODEL || "@cf/meta/llama-3.1-8b-instruct-fp8",
			summaryMaxTokens: Number(env.LLM_SUMMARY_MAX_TOKENS ?? 256),
			digestModel:
				env.LLM_DIGEST_MODEL || env.LLM_SUMMARY_MODEL || "@cf/meta/llama-3.1-8b-instruct-fp8",
			digestMaxTokens: Number(env.LLM_DIGEST_MAX_TOKENS ?? 768),
			gatewayId: env.AI_GATEWAY_ID || null,
			temperature: Number(env.LLM_TEMPERATURE ?? 0),
		},

		// Embeddings (for the semantic half of the shortlist + node vectors).
		embedModel: env.EMBED_MODEL || "@cf/baai/bge-base-en-v1.5",

		// Gate tuning.
		confidenceMin: Number(env.CONFIDENCE_MIN ?? 0.5),
		// Lenient floor used by the user-commanded manual path (Path A): keep
		// anything durable, drop only obvious junk.
		manualConfidenceMin: Number(env.MANUAL_CONFIDENCE_MIN ?? 0.25),
		shortlistSize: Number(env.SHORTLIST_SIZE ?? 10),
		sliceRollupThreshold: Number(env.SLICE_ROLLUP_THRESHOLD ?? 10),

		// Faster-save (Priority 3): how long a manual save tool will wait for the
		// real receipt before returning "captured, processing". Extraction always
		// finishes in the background regardless; this only bounds the response so a
		// slow model can never time out the client.
		saveWaitBudgetMs: Number(env.SAVE_WAIT_BUDGET_MS ?? 9000),
	};
}
