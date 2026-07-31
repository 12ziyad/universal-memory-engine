/**
 * Aggregate scored JSONL into the results table: overall + per-category F1 and
 * judge accuracy, empty-recall rate, mean context tokens/query, p95 recall
 * latency, ingest stats.
 *
 * Usage: node evals/locomo/report.js [convIndex ...]  (default: every scored file)
 */

const path = require("node:path");
const fs = require("node:fs");
const { readJsonl, CATEGORY_NAMES } = require("./lib.js");

function p95(values) {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
}

function mean(values) {
	return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function main() {
	const resultsDir = path.join(__dirname, "results");
	const requested = process.argv.slice(2).map(Number);
	const files = fs.existsSync(resultsDir)
		? fs.readdirSync(resultsDir).filter((f) => f.startsWith("scored-conv"))
		: [];
	const indices = requested.length
		? requested
		: files.map((f) => Number(f.match(/scored-conv(\d+)/)?.[1])).filter(Number.isInteger);

	const rows = indices.flatMap((i) =>
		readJsonl(path.join(resultsDir, `scored-conv${i}.jsonl`)));
	if (rows.length === 0) {
		console.log("No scored results yet.");
		return;
	}

	const byCategory = new Map();
	for (const row of rows) {
		const key = row.category;
		if (!byCategory.has(key)) byCategory.set(key, []);
		byCategory.get(key).push(row);
	}

	const line = (label, subset) => {
		const f1 = mean(subset.map((r) => r.f1)) * 100;
		const judged = subset.filter((r) => r.judge !== null && r.judge !== undefined);
		const judgeAcc = judged.length ? mean(judged.map((r) => r.judge)) * 100 : NaN;
		const empty = subset.filter((r) => r.context_empty).length;
		return `${label.padEnd(14)} n=${String(subset.length).padStart(4)}  F1=${f1.toFixed(1).padStart(5)}  judge=${Number.isNaN(judgeAcc) ? "  n/a" : judgeAcc.toFixed(1).padStart(5)}  empty-recall=${empty} (${((empty / subset.length) * 100).toFixed(1)}%)`;
	};

	console.log(`\nLoCoMo results — conversations [${indices.join(", ")}]\n`);
	console.log(line("OVERALL", rows));
	for (const [category, subset] of [...byCategory.entries()].sort((a, b) => a[0] - b[0])) {
		console.log(line(CATEGORY_NAMES[category] ?? `cat ${category}`, subset));
	}
	console.log(`\nmean context tokens/query: ${Math.round(mean(rows.map((r) => r.context_tokens_est)))}`);
	console.log(`p95 recall latency: ${p95(rows.map((r) => r.recall_ms))} ms`);
	console.log(`mean answer latency: ${Math.round(mean(rows.map((r) => r.answer_ms)))} ms`);

	for (const i of indices) {
		const ingest = readJsonl(path.join(resultsDir, `ingest-conv${i}.jsonl`));
		const summary = ingest.find((r) => r.kind === "ingest_summary");
		if (summary) {
			console.log(`conv ${i} ingest: ${summary.turns} turns, ${summary.ingest_failures} failures, ${summary.wall_seconds}s wall`);
		}
	}
}

main();
