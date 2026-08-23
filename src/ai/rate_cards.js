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
 * The Google figures below were verified against Google's public Vertex AI
 * and Vertex AI Search pricing pages on 2026-08-22. They MUST be revalidated
 * before live activation and whenever a model or billing SKU changes.
 */

export const RATE_CARD_VERSION = "2026-08-22.2";

const GOOGLE_MODELS = Object.freeze({
	"gemini-2.5-flash": { unitClass: "gen_tokens", inputPerMillionMicros: 300_000, outputPerMillionMicros: 2_500_000 },
	"gemini-2.5-flash-lite": { unitClass: "gen_tokens", inputPerMillionMicros: 100_000, outputPerMillionMicros: 400_000 },
	"gemini-2.5-pro": { unitClass: "gen_tokens", inputPerMillionMicros: 1_250_000, outputPerMillionMicros: 10_000_000 },
	"gemini-embedding-001": { unitClass: "embed_tokens", inputPerMillionMicros: 150_000, outputPerMillionMicros: 0 },
	"semantic-ranker-default-004": { unitClass: "rank_units", rankPer100Micros: 1_000 },
});

// Workers AI: $0.011 per 1k neurons (validated against a binding-reported call
// in evals/locomo/ai_cost.js, which imports this constant).
export const WORKERS_AI_USD_MICROS_PER_1K_NEURONS = 11_000;

const GOOGLE_FALLBACK_MODELS = Object.freeze({
	gen_tokens: "gemini-2.5-pro",
	embed_tokens: "gemini-embedding-001",
	rank_units: "semantic-ranker-default-004",
});

export function googleModelCard(model) {
	// A moving alias is not an immutable billing or replay identity even if a
	// future edit accidentally adds a similarly named card.
	if (typeof model !== "string" || model.endsWith("-latest")) return null;
	return GOOGLE_MODELS[model] ?? null;
}

function rateCardError(code, model, unitClass) {
	return Object.assign(new Error(`Google model ${String(model ?? "<missing>")} has no exact ${unitClass} rate identity`), {
		code,
		aiErrorClass: "provider_refused",
	});
}

/**
 * Produce the immutable monetary snapshot stored on a reservation. Settlement
 * uses these concrete integer rates, never whichever card happens to be
 * current when the provider returns.
 */
export function googleRateSnapshot(model, unitClass) {
	const concreteModel = typeof model === "string" && model ? model : GOOGLE_FALLBACK_MODELS[unitClass] ?? GOOGLE_FALLBACK_MODELS.gen_tokens;
	const card = googleModelCard(concreteModel);
	if (!card) throw rateCardError("model_rate_unpriced", concreteModel, unitClass);
	if (card.unitClass !== unitClass) {
		throw rateCardError("model_capability_mismatch", concreteModel, unitClass);
	}
	if (unitClass === "rank_units") {
		return Object.freeze({
			version: RATE_CARD_VERSION,
			model: concreteModel,
			unitClass,
			inputPerMillionMicros: 0,
			outputPerMillionMicros: 0,
			rankPer100Micros: card.rankPer100Micros,
		});
	}
	return Object.freeze({
		version: RATE_CARD_VERSION,
		model: concreteModel,
		unitClass,
		inputPerMillionMicros: card.inputPerMillionMicros,
		outputPerMillionMicros: card.outputPerMillionMicros,
		rankPer100Micros: 0,
	});
}

export function estimateCostFromRateSnapshot(snapshot, { inputTokens = 0, outputTokens = 0, records = 0 } = {}) {
	if (snapshot?.unitClass === "rank_units") {
		return Math.ceil(Math.max(1, records / 100)) * Math.max(0, Number(snapshot.rankPer100Micros) || 0);
	}
	return Math.ceil(
		(Math.max(0, inputTokens) * Math.max(0, Number(snapshot?.inputPerMillionMicros) || 0)
			+ Math.max(0, outputTokens) * Math.max(0, Number(snapshot?.outputPerMillionMicros) || 0)) / 1e6,
	);
}

/**
 * Conservative micro-USD estimate for a prospective Google call.
 * gen: inputTokens/outputTokens are worst-case estimates (bytes/4, max_tokens).
 * embed: inputTokens only. rank: `records` count.
 */
export function estimateGoogleCostMicros({ model, unitClass, inputTokens = 0, outputTokens = 0, records = 0 }) {
	return estimateCostFromRateSnapshot(googleRateSnapshot(model, unitClass), { inputTokens, outputTokens, records });
}

export function workersAiCostMicros({ neurons = 0 }) {
	return Math.ceil((Math.max(0, neurons) / 1000) * WORKERS_AI_USD_MICROS_PER_1K_NEURONS);
}
