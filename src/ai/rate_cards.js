/**
 * Read-time cost derivation, per provider, pinned to a version.
 *
 * The billed-unit rule generalizes the ai_meter neuron rule: unit columns hold
 * only what a provider reported; DOLLARS are always derived at read time from
 * this card, never stored as truth. Reservations record the card version they
 * were priced under, and settlement re-prices actuals ON THE SAME VERSION — a
 * card update can never corrupt an in-flight month's totals.
 *
 * Prices are micro-USD, deliberately CONSERVATIVE (ceil-rounded, worst case).
 * The Google figures are pre-launch estimates and MUST be verified against the
 * live Vertex pricing page before any non-shadow spend is enabled — erring
 * high here only makes budgets refuse earlier, which is the safe direction.
 */

export const RATE_CARD_VERSION = "2026-08-22.1";

const GOOGLE_MODELS = Object.freeze({
	"gemini-2.5-flash": { unitClass: "gen_tokens", inputPerMillionMicros: 300_000, outputPerMillionMicros: 2_500_000 },
	"gemini-2.5-flash-lite": { unitClass: "gen_tokens", inputPerMillionMicros: 100_000, outputPerMillionMicros: 400_000 },
	"gemini-2.5-pro": { unitClass: "gen_tokens", inputPerMillionMicros: 1_250_000, outputPerMillionMicros: 10_000_000 },
	"gemini-embedding-001": { unitClass: "embed_tokens", inputPerMillionMicros: 150_000, outputPerMillionMicros: 0 },
});

// Ranking API is priced per request in practice; 2,000 micro-USD/request is a
// deliberate over-estimate pending verification.
const GOOGLE_RANK_REQUEST_MICROS = 2_000;

// Workers AI: $0.011 per 1k neurons (validated against a binding-reported call
// in evals/locomo/ai_cost.js, which imports this constant).
export const WORKERS_AI_USD_MICROS_PER_1K_NEURONS = 11_000;

/** Fallback for unknown Google gen models: price as the most expensive card. */
const GOOGLE_GEN_FALLBACK = GOOGLE_MODELS["gemini-2.5-pro"];

export function googleModelCard(model) {
	return GOOGLE_MODELS[model] ?? null;
}

/**
 * Conservative micro-USD estimate for a prospective Google call.
 * gen: inputTokens/outputTokens are worst-case estimates (bytes/4, max_tokens).
 * embed: inputTokens only. rank: `records` count.
 */
export function estimateGoogleCostMicros({ model, unitClass, inputTokens = 0, outputTokens = 0, records = 0 }) {
	if (unitClass === "rank_units") return Math.ceil(Math.max(1, records / 100)) * GOOGLE_RANK_REQUEST_MICROS;
	const card = GOOGLE_MODELS[model] ?? (unitClass === "embed_tokens" ? GOOGLE_MODELS["gemini-embedding-001"] : GOOGLE_GEN_FALLBACK);
	return Math.ceil(
		(Math.max(0, inputTokens) * card.inputPerMillionMicros
			+ Math.max(0, outputTokens) * card.outputPerMillionMicros) / 1e6,
	);
}

export function workersAiCostMicros({ neurons = 0 }) {
	return Math.ceil((Math.max(0, neurons) / 1000) * WORKERS_AI_USD_MICROS_PER_1K_NEURONS);
}
