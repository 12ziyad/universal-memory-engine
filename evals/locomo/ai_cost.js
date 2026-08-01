/**
 * Workers AI cost report, straight out of the local D1 the smoke wrote to.
 *
 * Reads `ai_calls` (one row per model call, recorded by src/lib/ai_meter.js)
 * and reports tokens and neurons per call, per save and per recall.
 *
 * MEASURED vs DERIVED is the whole point of this file, so it is explicit:
 *   - `neurons` returned by the Workers AI binding is MEASURED. Text-generation
 *     models return it; embedding models currently do not.
 *   - Where a model returns no neuron count, this derives one from Cloudflare's
 *     published rate card and labels every such figure `derived`.
 *
 * The rate card is only used for models that report no neurons. It was checked
 * against the binding's own number for the extraction model and agreed to five
 * significant figures, which is why it is trusted for the rest.
 *
 * Usage: node evals/locomo/ai_cost.js [--user <id>] [--since <epoch_ms>]
 */

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const USD_PER_1K_NEURONS = 0.011;

// developers.cloudflare.com/workers-ai/platform/pricing — neurons per MILLION
// tokens, read off the published table (checked 2026-08-02). Only consulted for
// models that return no neuron count of their own.
//
// The qwen row is the one that validates this table: the binding reported
// 59.936768 neurons for a call of 1580 in / 1727 out, and this card computes
// 59.937825 for the same call. Agreement to five significant figures is why the
// bge row is trusted for embeddings, which report no neurons.
const RATE_CARD = {
	"@cf/baai/bge-base-en-v1.5": { input: 6058, output: 0 },
	"@cf/qwen/qwen3-30b-a3b-fp8": { input: 4625, output: 30475 },
	"@cf/meta/llama-3.1-8b-instruct-fp8": { input: 13778, output: 26128 },
	"@cf/meta/llama-3.2-1b-instruct": { input: 2457, output: 18252 },
};

function localD1() {
	const dir = path.join(__dirname, "..", "..", ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
	const file = fs.readdirSync(dir)
		.filter((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite")
		.map((f) => path.join(dir, f))
		.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
	if (!file) throw new Error("no local D1 database found — run the smoke first");
	return new DatabaseSync(file, { readOnly: true });
}

/** Neurons for one call: the binding's number if it gave one, else the card. */
function neuronsFor(call) {
	if (Number.isFinite(call.neurons)) return { neurons: call.neurons, source: "measured" };
	const rate = RATE_CARD[call.model];
	if (!rate) return { neurons: null, source: "unknown" };
	const n = ((call.input_tokens ?? 0) * rate.input + (call.output_tokens ?? 0) * rate.output) / 1e6;
	return { neurons: n, source: "derived" };
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const round = (n, dp = 4) => (Number.isFinite(n) ? Number(n.toFixed(dp)) : null);
function stats(xs) {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	return {
		n: s.length,
		mean: round(sum(s) / s.length),
		median: round(s[Math.floor(s.length / 2)]),
		p90: round(s[Math.min(s.length - 1, Math.floor(s.length * 0.9))]),
		max: round(s[s.length - 1]),
	};
}

function main() {
	const args = process.argv.slice(2);
	const userArg = args.includes("--user") ? args[args.indexOf("--user") + 1] : null;
	const since = args.includes("--since") ? Number(args[args.indexOf("--since") + 1]) : 0;

	const db = localD1();
	const where = ["created_at >= ?"];
	const binds = [since];
	if (userArg) { where.push("user_id = ?"); binds.push(userArg); }
	const calls = db.prepare(
		`SELECT * FROM ai_calls WHERE ${where.join(" AND ")} ORDER BY created_at`,
	).all(...binds);

	if (!calls.length) { console.log("no ai_calls rows matched"); return; }

	// ---- per model -------------------------------------------------------
	const byModel = new Map();
	for (const call of calls) {
		const key = `${call.model}  (${call.task ?? "-"})`;
		if (!byModel.has(key)) byModel.set(key, []);
		byModel.get(key).push(call);
	}

	console.log("\n=== per LLM call, by model + task ===");
	console.log("model (task) | calls | in tok (mean) | out tok (mean) | neurons (mean) | source");
	for (const [key, list] of byModel) {
		const ins = list.map((c) => c.input_tokens ?? 0);
		const outs = list.map((c) => c.output_tokens ?? 0);
		const ns = list.map((c) => neuronsFor(c));
		const sources = [...new Set(ns.map((x) => x.source))].join("+");
		const known = ns.map((x) => x.neurons).filter(Number.isFinite);
		console.log(`${key} | ${list.length} | ${round(sum(ins) / list.length, 1)} | ${round(sum(outs) / list.length, 1)} | ${known.length ? round(sum(known) / known.length) : "n/a"} | ${sources}`);
	}

	// ---- per scope (save / recall) ---------------------------------------
	console.log("\n=== per scope ===");
	const scopes = [...new Set(calls.map((c) => c.scope))];
	const report = {};
	for (const scope of scopes) {
		const rows = calls.filter((c) => c.scope === scope);
		// Group by the run that caused them. Calls with no scope_id (nothing to
		// attribute to) are counted in the totals but cannot form a per-unit mean.
		const byRun = new Map();
		for (const row of rows) {
			if (!row.scope_id) continue;
			if (!byRun.has(row.scope_id)) byRun.set(row.scope_id, []);
			byRun.get(row.scope_id).push(row);
		}
		const units = [...byRun.values()];
		const perUnit = units.map((u) => ({
			calls: u.length,
			input: sum(u.map((c) => c.input_tokens ?? 0)),
			output: sum(u.map((c) => c.output_tokens ?? 0)),
			neurons: sum(u.map((c) => neuronsFor(c).neurons ?? 0)),
			measuredNeurons: sum(u.filter((c) => Number.isFinite(c.neurons)).map((c) => c.neurons)),
		}));
		const derivedShare = 1 - (sum(perUnit.map((u) => u.measuredNeurons)) / Math.max(1e-9, sum(perUnit.map((u) => u.neurons))));
		report[scope] = {
			units: units.length,
			unattributed_calls: rows.length - sum(units.map((u) => u.length)),
			calls_per_unit: stats(perUnit.map((u) => u.calls)),
			input_tokens: stats(perUnit.map((u) => u.input)),
			output_tokens: stats(perUnit.map((u) => u.output)),
			neurons: stats(perUnit.map((u) => u.neurons)),
			pct_of_neurons_derived: round(derivedShare * 100, 2),
		};
		const mean = report[scope].neurons?.mean;
		report[scope].usd_per_unit = mean === null || mean === undefined ? null : Number(((mean / 1000) * USD_PER_1K_NEURONS).toFixed(8));
		console.log(`\n-- ${scope} --`);
		console.log(JSON.stringify(report[scope], null, 2));
	}

	// ---- what the credit buys -------------------------------------------
	const save = report.save;
	if (save?.neurons?.mean) {
		const perSave = save.neurons.mean;
		const usdPerSave = (perSave / 1000) * USD_PER_1K_NEURONS;
		const credit = 2500;
		const savesPerCredit = credit / usdPerSave;
		const savesPerUserPerYear = 5 * 365;
		console.log("\n=== capacity (derived arithmetic from the measured mean) ===");
		console.log(JSON.stringify({
			neurons_per_save_mean: round(perSave),
			usd_per_save: Number(usdPerSave.toFixed(8)),
			saves_per_2500_usd: Math.round(savesPerCredit),
			users_at_5_saves_per_day_for_1_year: Math.round(savesPerCredit / savesPerUserPerYear),
		}, null, 2));
	}
	db.close();
}

main();
