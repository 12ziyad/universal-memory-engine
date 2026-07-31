/**
 * Answer phase: for every scorable question of one conversation, call UML
 * recall with the question, then hand ONLY the recalled context + question to
 * the answerer model. The gold answer never appears in the recall query or the
 * answerer prompt.
 *
 * Category 5 (adversarial) is excluded, matching Mem0's and Zep's published
 * LoCoMo evaluations.
 *
 * The answerer exists only for this benchmark (UML recall returns memory, it
 * does not generate answers). It runs on Cloudflare Workers AI via the
 * EVAL_MODE-gated /eval/llm pass-through.
 *
 * Usage: node evals/locomo/ask.js <convIndex>
 */

const path = require("node:path");
const { post, postEval, loadDataset, appendJsonl, readJsonl } = require("./lib.js");

const ANSWERER_SYSTEM = [
	"You answer questions about a person using ONLY the memory context provided.",
	"The context comes from a personal memory system. Be concise: answer with the",
	"shortest phrase that fully answers the question (a name, a date, a short",
	"phrase). Do not explain. If the context does not contain the answer, reply",
	"exactly: I don't know. /no_think",
].join(" ");

async function main() {
	const convIndex = Number(process.argv[2]);
	if (!Number.isInteger(convIndex)) throw new Error("usage: node ask.js <convIndex 0-9>");

	const dataset = loadDataset();
	const conv = dataset[convIndex];
	const userId = `locomo-conv-${convIndex}`;
	const outFile = path.join(__dirname, "results", `answers-conv${convIndex}.jsonl`);

	const done = new Set(readJsonl(outFile).map((row) => row.question_id));
	const questions = conv.qa
		.map((qa, index) => ({ ...qa, question_id: `c${convIndex}-q${index}` }))
		.filter((qa) => qa.category !== 5);

	console.log(`[ask] conv ${convIndex}: ${questions.length} scorable questions (${done.size} already done)`);

	let emptyRecalls = 0;
	let processed = 0;
	const startedAt = Date.now();

	for (const qa of questions) {
		if (done.has(qa.question_id)) continue;

		const recallStart = Date.now();
		let recall;
		try {
			recall = await post("/v1/recall", { userId, query: qa.question });
		} catch (error) {
			appendJsonl(outFile, {
				question_id: qa.question_id,
				conv: convIndex,
				category: qa.category,
				question: qa.question,
				gold: String(qa.answer ?? ""),
				error: `recall_failed: ${String(error?.message ?? error).slice(0, 200)}`,
			});
			continue;
		}
		const recallMs = Date.now() - recallStart;
		const context = String(recall?.context ?? "").trim();
		if (!context) emptyRecalls++;

		const answerStart = Date.now();
		let answer = "";
		let answerError = null;
		try {
			const llm = await postEval("/eval/llm", {
				messages: [
					{ role: "system", content: ANSWERER_SYSTEM },
					{
						role: "user",
						content: context
							? `Memory context:\n${context}\n\nQuestion: ${qa.question}`
							: `Memory context: (no memory found)\n\nQuestion: ${qa.question}`,
					},
				],
				max_tokens: 400,
				temperature: 0,
			});
			answer = String(llm?.text ?? "").trim();
		} catch (error) {
			answerError = String(error?.message ?? error).slice(0, 200);
		}
		const answerMs = Date.now() - answerStart;

		appendJsonl(outFile, {
			question_id: qa.question_id,
			conv: convIndex,
			category: qa.category,
			question: qa.question,
			gold: String(qa.answer ?? ""),
			recall_raw: recall,
			context,
			context_empty: context.length === 0,
			context_tokens_est: Math.ceil(context.length / 4),
			answer,
			answer_error: answerError,
			recall_ms: recallMs,
			answer_ms: answerMs,
		});

		processed++;
		if (processed % 20 === 0) {
			const rate = processed / ((Date.now() - startedAt) / 1000);
			console.log(`[ask] ${processed} answered (${rate.toFixed(2)}/s, ${emptyRecalls} empty recalls)`);
		}
	}

	console.log(`[ask] DONE — ${processed} new answers, ${emptyRecalls} empty recalls this run`);
}

main().catch((error) => {
	console.error("[ask] FATAL:", error);
	process.exit(1);
});
