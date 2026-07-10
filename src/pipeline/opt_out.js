import { storeReceipt } from "../lib/db.js";
import { emptyReceipt, formatReceipt } from "./receipt.js";

const OPT_OUT_PATTERNS = [
	/(?:^|[.!?;:,\n]\s*)(?:please\s+)?(?:do\s+not|don['’]?t)\s+(?:remember|save|store)(?:\s+(?:this|that|it))?\b/gi,
	/\bforget\s+this\s+after\s+replying\b/gi,
	/\bno\s+memory\s+for\s+this\b/gi,
	/\bthis\s+is\s+private\b[\s\S]{0,120}?\b(?:do\s+not|don['’]?t)\s+remember\b/gi,
];

const CLEAR_ALLOW_PATTERNS = [
	/\b(?:actually|please|ok(?:ay)?|now)\s+(?:remember|save|store)\s+(?:this|that|it)\b/gi,
	/\byou\s+can\s+(?:remember|save|store)\s+(?:this|that|it)?\b/gi,
	/\bremember\s+this\s+after\s+all\b/gi,
	/\bdo\s+remember\s+(?:this|that|it)\b/gi,
];

function clean(value) {
	return String(value ?? "").replace(/\s+/g, " ").trim();
}

function matches(patterns, text, type) {
	const found = [];
	for (const pattern of patterns) {
		pattern.lastIndex = 0;
		let match;
		while ((match = pattern.exec(text)) !== null) {
			found.push({ type, index: match.index, phrase: clean(match[0]) });
			if (match[0].length === 0) pattern.lastIndex++;
		}
	}
	return found;
}

export function memoryOptOutDecision(text) {
	const value = String(text ?? "");
	if (!value.trim()) return { optedOut: false };
	const directives = [
		...matches(OPT_OUT_PATTERNS, value, "opt_out"),
		...matches(CLEAR_ALLOW_PATTERNS, value, "allow"),
	].sort((a, b) => a.index - b.index);
	const lastOptOut = directives.filter((d) => d.type === "opt_out").at(-1);
	if (!lastOptOut) return { optedOut: false };
	const laterAllow = directives.find((d) => d.type === "allow" && d.index > lastOptOut.index);
	if (laterAllow) return { optedOut: false, phrase: lastOptOut.phrase, overriddenBy: laterAllow.phrase };
	return { optedOut: true, phrase: lastOptOut.phrase };
}

export function userTextFromMessages(messages = []) {
	return (messages ?? [])
		.filter((m) => typeof m === "string" || (m?.role ?? "user") === "user")
		.map((m) => String(typeof m === "string" ? m : m?.content ?? ""))
		.filter((text) => text.trim())
		.join("\n");
}

export function messagesContainMemoryOptOut(messages = []) {
	return memoryOptOutDecision(userTextFromMessages(messages));
}

export async function storeOptOutReceipt(env, userId, source = "ingest", meta = {}) {
	const receipt = emptyReceipt("no_write", "user_opt_out", {
		source,
		...meta,
	});
	receipt.durable = false;
	receipt.opt_out = true;
	if (meta.manual) {
		receipt.manual = true;
		receipt.saved.resolvedCandidates = 0;
		receipt.identity_decisions = [];
		receipt.identity_conflicts = [];
		receipt.actions = {
			createdPages: [],
			updatedPages: [],
			reinforcedPages: [],
			createdNodes: [],
			mergedNodes: [],
			createdSlices: [],
			createdEvents: [],
			createdEdges: [],
			reinforcedNodes: [],
			supersededSlices: [],
			reinforcedSlices: [],
			reinforcedEvents: [],
			reinforcedEdges: [],
			resolvedCandidates: [],
			skippedObjects: [{ kind: "source", reason: "user_opt_out" }],
			identityConflicts: [],
		};
	}
	if (meta.final !== undefined) receipt.final = Boolean(meta.final);
	if (meta.processing !== undefined) receipt.processing = Boolean(meta.processing);
	receipt.opt_out_phrase = meta.opt_out_phrase ?? null;
	receipt.skippedReasons = { user_opt_out: meta.skipped ?? 1 };
	const summary = formatReceipt(receipt);
	const receiptId = await storeReceipt(env, userId, source, receipt, summary);
	if (receiptId) receipt.id = receiptId;
	return { receipt, receiptId, summary };
}
