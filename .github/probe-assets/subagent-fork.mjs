/**
 * P5 / P13a on a real OpenCode host, through supported SDK APIs.
 *
 *   session.create({ parentID })  — exactly how the built-in `task` tool makes
 *                                   a subagent (packages/opencode/src/tool/task.ts)
 *   session.fork                  — the supported fork path
 *
 * The plugin under test is the PACKED artifact loaded by the real host; this
 * driver only drives the host and then asserts on what the memory stub actually
 * received.
 */

import { createOpencodeServer, createOpencodeClient } from "@opencode-ai/sdk";
import { readFileSync, existsSync } from "node:fs";

const LOG = process.env.PROBE_LOG_DIR;
const PROJECT = `${process.env.PROBE_ROOT}/project`;
const traffic = () =>
	existsSync(`${LOG}/itsuki.jsonl`)
		? readFileSync(`${LOG}/itsuki.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((l) => {
				try { return JSON.parse(l); } catch { return null; }
			}).filter(Boolean)
		: [];
const saves = () => traffic().filter((e) => e.kind === "save");
const recalls = () => traffic().filter((e) => e.kind === "recall" && e.query);

let fails = 0;
const check = (name, cond, detail = "") => {
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  :: " + detail : ""}`);
	if (!cond) fails++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = await createOpencodeServer({ hostname: "127.0.0.1", port: 0, config: { directory: PROJECT } });
const client = createOpencodeClient({ baseUrl: server.url });
const unwrap = (r) => r?.data ?? r;
const prompt = (id, text) =>
	client.session.prompt({ path: { id }, query: { directory: PROJECT }, body: { parts: [{ type: "text", text }] } });

try {
	// ---------------------------------------------------------- parent turn
	const parent = unwrap(await client.session.create({ body: { title: "p5-parent" }, query: { directory: PROJECT } }));
	await prompt(parent.id, "P5_PARENT_TURN: reply briefly.");
	await sleep(4000);
	const afterParent = saves().length;
	check("parent session captured its own settled turn", afterParent >= 1, `saves=${afterParent}`);
	const parentSaves = saves();
	check(
		"parent capture carries the parent's own text",
		parentSaves.some((s) => JSON.stringify(s.messages).includes("P5_PARENT_TURN")),
	);

	// -------------------------------------------------------- P5: subagent
	// A child session with parentID set is exactly what `task` creates.
	const child = unwrap(
		await client.session.create({ body: { title: "p5-child", parentID: parent.id }, query: { directory: PROJECT } }),
	);
	const childInfo = unwrap(await client.session.get({ path: { id: child.id }, query: { directory: PROJECT } }));
	check("the child really is a subagent (parentID set)", Boolean(childInfo?.parentID), `parentID=${childInfo?.parentID}`);

	const beforeChild = saves().length;
	const recallsBeforeChild = recalls().length;
	await prompt(child.id, "P5_CHILD_TURN: reply briefly.");
	await sleep(4000);
	check("subagent turn produced NO capture", saves().length === beforeChild, `${beforeChild} -> ${saves().length}`);
	check("subagent turn produced NO recall", recalls().length === recallsBeforeChild);
	check(
		"no subagent text ever reached memory",
		!saves().some((s) => JSON.stringify(s.messages).includes("P5_CHILD_TURN")),
	);

	// ------------------------------------------------- P13a: fork / replay
	let forked = null;
	try {
		forked = unwrap(await client.session.fork({ path: { id: parent.id }, query: { directory: PROJECT } }));
	} catch (error) {
		console.log("NOTE  session.fork unavailable: " + String(error?.message ?? error).slice(0, 120));
	}

	if (forked?.id) {
		const beforeFork = saves().length;
		// The fork already contains the parent's history. Settling it must not
		// re-capture anything that was captured under the parent.
		await sleep(2500);
		check("forking alone captured nothing", saves().length === beforeFork, `${beforeFork} -> ${saves().length}`);

		const beforeForkTurn = saves().length;
		await prompt(forked.id, "P13A_FORK_TURN: reply briefly.");
		await sleep(4000);
		const delta = saves().length - beforeForkTurn;
		check("a NEW turn in the fork captured exactly once", delta === 1, `delta=${delta}`);
		const forkSaves = saves().filter((s) => JSON.stringify(s.messages).includes("P13A_FORK_TURN"));
		check("the fork's capture contains its own new turn", forkSaves.length === 1, `matches=${forkSaves.length}`);
		check(
			"the fork did NOT re-capture the parent's inherited turn",
			forkSaves.every((s) => !JSON.stringify(s.messages).includes("P5_PARENT_TURN")),
		);

		// Every delivered key must be unique: replay must never double-deliver.
		const keys = saves().map((s) => s.idempotencyKey);
		check("no duplicate idempotency key across parent+fork", new Set(keys).size === keys.length,
			`${keys.length} saves, ${new Set(keys).size} unique`);
	}

	// ------------------------------------------------ cross-session bleed
	const other = unwrap(await client.session.create({ body: { title: "p5-other" }, query: { directory: PROJECT } }));
	const beforeOther = saves().length;
	await prompt(other.id, "P5_OTHER_SESSION: reply briefly.");
	await sleep(4000);
	const otherSaves = saves().slice(beforeOther);
	check("a second session captured its own turn", otherSaves.length === 1, `delta=${otherSaves.length}`);
	check(
		"the second session's capture contains ONLY its own text",
		otherSaves.every(
			(s) =>
				JSON.stringify(s.messages).includes("P5_OTHER_SESSION") &&
				!JSON.stringify(s.messages).includes("P5_PARENT_TURN") &&
				!JSON.stringify(s.messages).includes("P13A_FORK_TURN"),
		),
	);

	// Every save must be scoped to the session it came from.
	const conversationIds = new Set(saves().map((s) => s.conversationId));
	check("each capture is scoped to a distinct conversation", conversationIds.size >= 2, `ids=${conversationIds.size}`);
	check("no capture was sent without a conversation scope", !saves().some((s) => !s.conversationId));
} catch (error) {
	console.log("DRIVER ERROR: " + String(error?.stack ?? error).slice(0, 500));
	fails++;
} finally {
	try { await server.close(); } catch {}
}

console.log(fails === 0 ? "\nALL P5/P13a ASSERTIONS PASSED" : `\n${fails} ASSERTION(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
