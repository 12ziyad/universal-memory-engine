/**
 * Ingest one LoCoMo conversation into UML through the production ingestion
 * path: every turn goes through POST /v1/turn (recall + auto-collect), and the
 * end of every session forces a digest with POST /v1/ingest {flush:true}.
 *
 * Isolation: each conversation gets its own synthetic user (locomo-conv-<N>).
 * Under legacy x-api-key auth the explicit userId IS the memory scope — its own
 * D1 rows, Durable Object, and Vectorize namespace — so conversations can never
 * see each other's memory. This is the same tenancy primitive production uses.
 *
 * Usage: node evals/locomo/ingest.js <convIndex>
 */

const path = require("node:path");
const { post, sleep, loadDataset, sessionsOf, renderTurn, appendJsonl, PACE_MS } = require("./lib.js");

async function main() {
	const convIndex = Number(process.argv[2]);
	if (!Number.isInteger(convIndex)) throw new Error("usage: node ingest.js <convIndex 0-9>");

	const dataset = loadDataset();
	const conv = dataset[convIndex];
	if (!conv) throw new Error(`no conversation at index ${convIndex}`);

	const userId = process.env.SMOKE_USER || `locomo-conv-${convIndex}`;
	const sessions = sessionsOf(conv.conversation);
	const totalTurns = sessions.reduce((sum, s) => sum + s.turns.length, 0);
	const logFile = path.join(__dirname, "results", `ingest-conv${convIndex}.jsonl`);

	console.log(`[ingest] conv ${convIndex} (${conv.sample_id}) -> user ${userId}`);
	console.log(`[ingest] ${sessions.length} sessions, ${totalTurns} turns`);

	const startedAt = Date.now();
	let sent = 0;
	let failures = 0;

	for (const session of sessions) {
		const conversationId = `${userId}-${session.key}`;
		for (const turn of session.turns) {
			const content = renderTurn(turn, session.dateTime);
			try {
				await post("/v1/turn", {
					userId,
					conversationId,
					messages: [{ role: "user", content }],
					...(process.env.CAPTURE_DENSITY ? { captureDensity: process.env.CAPTURE_DENSITY } : {}),
				});
			} catch (error) {
				failures++;
				appendJsonl(logFile, {
					kind: "ingest_failure",
					session: session.key,
					dia_id: turn.dia_id,
					error: String(error?.message ?? error).slice(0, 300),
				});
			}
			sent++;
			// Pace ingest: stays under SAVE_LIMITER (60/min/user) and spreads
			// background extraction so Workers AI never sees a burst.
			await sleep(PACE_MS);
			if (sent % 25 === 0) {
				const rate = sent / ((Date.now() - startedAt) / 1000);
				console.log(`[ingest] ${sent}/${totalTurns} turns (${rate.toFixed(1)}/s, ${failures} failures)`);
			}
		}
		// End of session: force the held turns through extraction.
		try {
			await post("/v1/ingest", { userId, flush: true, messages: [] });
		} catch (error) {
			failures++;
			appendJsonl(logFile, {
				kind: "flush_failure",
				session: session.key,
				error: String(error?.message ?? error).slice(0, 300),
			});
		}
		console.log(`[ingest] flushed ${session.key} (${session.turns.length} turns)`);
	}

	// Extraction runs in the background via waitUntil; give it time to settle
	// before anything queries this user. Poll the graph until stable.
	console.log("[ingest] waiting for extraction to settle…");
	let previousNodes = -1;
	for (let i = 0; i < 30; i++) {
		await sleep(10000);
		try {
			const res = await fetch(
				`${require("./lib.js").BASE}/v1/graph?userId=${encodeURIComponent(userId)}`,
				{ headers: { "x-api-key": require("node:fs").readFileSync(path.join(__dirname, "..", "..", ".dev.vars"), "utf8").match(/API_KEY="([^"]+)"/)[1] } },
			);
			const graph = await res.json();
			const nodes = (graph.nodes ?? []).length;
			console.log(`[ingest] settle check ${i + 1}: ${nodes} nodes`);
			if (nodes === previousNodes && nodes > 0) break;
			previousNodes = nodes;
		} catch {
			// worker busy; keep waiting
		}
	}

	const wallSeconds = Math.round((Date.now() - startedAt) / 1000);
	const summary = {
		kind: "ingest_summary",
		conv: convIndex,
		user_id: userId,
		sessions: sessions.length,
		turns: totalTurns,
		ingest_failures: failures,
		wall_seconds: wallSeconds,
		finished_at: new Date().toISOString(),
	};
	appendJsonl(logFile, summary);
	console.log(`[ingest] DONE in ${wallSeconds}s — ${failures} failures`, summary);
}

main().catch((error) => {
	console.error("[ingest] FATAL:", error);
	process.exit(1);
});
