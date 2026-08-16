// Assertions over what the real host actually did.
import { readFileSync, existsSync, readdirSync } from "node:fs";

const LOG = process.env.PROBE_LOG_DIR;
const read = (f) => existsSync(`${LOG}/${f}`) ? readFileSync(`${LOG}/${f}`, "utf8").trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];

const itsuki = read("itsuki.jsonl");
const llm = read("llm.jsonl");
const recalls = itsuki.filter((e) => e.kind === "recall");
const saves = itsuki.filter((e) => e.kind === "save");
const completions = llm.filter((e) => e.kind === "completion");

let fails = 0;
const check = (name, cond, detail = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  :: " + detail : ""}`); if (!cond) fails++; };

const phase = process.argv[2] ?? "main";
console.log(`\n===== ASSERTIONS (${phase}) =====`);
console.log(`recalls=${recalls.length} saves=${saves.length} completions=${completions.length}`);

if (phase === "main") {
  check("exactly one recall for one human turn", recalls.length === 1, `got ${recalls.length}`);
  check("the model SAW the recalled needle", completions.some((c) => c.sawMarker === true));
  check("at least one completion happened", completions.length > 0);
  check("exactly one settled capture was delivered", saves.length === 1, `got ${saves.length}`);
  // SEC-04: only ONE provider call may carry the block, and it must be the
  // inference — never the title/summary call.
  const withBlock = completions.filter((c) => c.sawMarker === true);
  check("exactly one provider call received the memory block", withBlock.length === 1, `got ${withBlock.length}`);
  if (saves.length === 1) {
    const s = saves[0];
    const text = JSON.stringify(s.messages);
    check("capture carries the user turn", text.includes("PROBE_TURN_ALPHA"));
    check("capture carries the assistant answer", s.messages.some((m) => m.role === "assistant" && m.content.length > 0));
    check("capture does NOT contain the injected recall block", !text.includes("itsuki-recalled-context"));
    check("capture does NOT contain the recall needle", !text.includes("PROBE_RECALL_NEEDLE_OMEGA"));
    check("capture is conversation mode with an idempotency key", s.mode === "conversation" && !!s.idempotencyKey);
  }
}

if (phase === "titles") {
  // The title/summary calls are the small-model ones. None may see our block.
  const titleCalls = completions.filter((c) => c.nMsgs !== undefined && c.nMsgs <= 2);
  check("title-shaped calls occurred", titleCalls.length > 0, `count=${titleCalls.length}`);
  check("NO title-shaped call saw the recall block", titleCalls.every((c) => c.sawMarker !== true));
}

if (phase === "p14") {
  check("spool drained exactly once after restart", saves.length === 1, `got ${saves.length}`);
  if (saves.length >= 1) check("drained capture carries the pre-crash turn", JSON.stringify(saves[0].messages).includes("PROBE_TURN_CRASH"));
}

if (phase === "dup") {
  const keys = new Set(saves.map((s) => s.idempotencyKey));
  check("no duplicate idempotency keys delivered", keys.size === saves.length, `${saves.length} saves, ${keys.size} unique`);
}

if (phase === "failopen") {
  check("turn completed even though memory was unreachable", completions.length > 0);
  check("nothing was injected when recall failed", !completions.some((c) => c.sawMarker === true));
}

console.log(fails === 0 ? `\nALL ASSERTIONS PASSED (${phase})` : `\n${fails} ASSERTION(S) FAILED (${phase})`);
process.exit(fails === 0 ? 0 : 1);
