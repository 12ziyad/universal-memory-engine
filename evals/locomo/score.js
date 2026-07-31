/**
 * Scoring phase: token F1 (SQuAD-style) computed locally, plus an LLM judge
 * (same Workers AI model via /eval/llm) that sees question + gold + prediction
 * and returns CORRECT or WRONG. Judge and answerer are separate calls; the
 * answerer never saw the gold.
 *
 * Usage: node evals/locomo/score.js <convIndex>
 */

const path = require("node:path");
const fs = require("node:fs");
const { postEval, tokenF1, readJsonl, CATEGORY_NAMES } = require("./lib.js");

const JUDGE_SYSTEM = [
	"You grade question-answering. Given a question, the gold answer, and a",
	"model's answer, reply with exactly one word: CORRECT if the model's answer",
	"conveys the same fact as the gold answer (wording may differ; partial dates",
	"count if the stated part matches), otherwise WRONG. Reply 'I don't know' is",
	"always WRONG. /no_think",
].join(" ");

async function main() {
	const convIndex = Number(process.argv[2]);
	if (!Number.isInteger(convIndex)) throw new Error("usage: node score.js <convIndex 0-9>");

	const answersFile = path.join(__dirname, "results", `answers-conv${convIndex}.jsonl`);
	const outFile = path.join(__dirname, "results", `scored-conv${convIndex}.jsonl`);
	const rows = readJsonl(answersFile).filter((row) => !row.error);
	const alreadyScored = new Map(readJsonl(outFile).map((row) => [row.question_id, row]));

	console.log(`[score] conv ${convIndex}: ${rows.length} answers, ${alreadyScored.size} already scored`);

	const out = fs.createWriteStream(outFile, { flags: "a" });
	let processed = 0;

	for (const row of rows) {
		if (alreadyScored.has(row.question_id)) continue;

		const f1 = tokenF1(row.answer, row.gold);
		let judge = null;
		try {
			const res = await postEval("/eval/llm", {
				messages: [
					{ role: "system", content: JUDGE_SYSTEM },
					{
						role: "user",
						content: `Question: ${row.question}\nGold answer: ${row.gold}\nModel answer: ${row.answer || "(empty)"}\nVerdict:`,
					},
				],
				max_tokens: 200,
				temperature: 0,
			});
			const verdict = String(res?.text ?? "").trim().toUpperCase();
			judge = verdict.startsWith("CORRECT") ? 1 : 0;
		} catch {
			judge = null; // scored later on retry
		}

		out.write(`${JSON.stringify({ ...row, recall_raw: undefined, f1, judge })}\n`);
		processed++;
		if (processed % 25 === 0) console.log(`[score] ${processed} scored`);
	}
	out.end();
	console.log(`[score] DONE — ${processed} newly scored`);
}

main().catch((error) => {
	console.error("[score] FATAL:", error);
	process.exit(1);
});
