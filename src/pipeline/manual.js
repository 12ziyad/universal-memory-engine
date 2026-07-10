/**
 * Path A — the user-COMMANDED save (Priority 4). When the user explicitly says
 * "save this", we skip the trigger's holding (flush now) and run the lenient gate
 * (manual:true → keep anything durable, drop only obvious junk). Canonical match
 * still applies, so re-saving something already stored updates it (no duplicates).
 *
 * One implementation, shared by the MCP tools (save_memory / save_conversation)
 * and the authenticated /v1/save route that powers the UI test buttons.
 */

import { getConfig } from "../config.js";
import { ingestMessages, stableMsgId } from "./ingest.js";
import { digestConversation } from "./digest.js";
import { buildReceipt, emptyReceipt, formatReceipt } from "./receipt.js";
import { writeApproved } from "./write.js";
import { storeReceipt, getUserNodes } from "../lib/db.js";
import { newId } from "../lib/ids.js";
import { normalizeLabel, tokens } from "../lib/text.js";

export { saveConversation } from "./manual_collect.js";

/** Shape the ingest result into a tool-ready { fired, summary, receipt, processing }. */
function finalize(res, { prefix = "", processingNote }) {
	if (res.optedOut) {
		return {
			fired: false,
			processing: false,
			summary: prefix + (res.summary ?? formatReceipt(res.receipt)),
			receipt: res.receipt ?? null,
			receipt_id: res.receiptId ?? res.receipt?.id ?? null,
			sourcePacket: res.sourcePacket ?? null,
			source_packet_id: res.receipt?.source_packet_id ?? res.sourcePacket?.id ?? null,
		};
	}
	if (!res.fired) {
		return {
			fired: false,
			processing: false,
			summary: prefix + "Saved: 0. Reason: nothing durable here (chatter, a question, or a duplicate).",
			receipt: null,
			receipt_id: null,
			sourcePacket: res.sourcePacket ?? null,
			source_packet_id: res.sourcePacket?.id ?? null,
		};
	}
	if (res.result && res.result.summary) {
		return {
			fired: true,
			processing: false,
			summary: prefix + res.result.summary,
			receipt: res.result.receipt,
			receipt_id: res.result.receipt?.id ?? null,
			sourcePacket: res.sourcePacket ?? null,
			source_packet_id: res.result.receipt?.source_packet_id ?? res.sourcePacket?.id ?? null,
		};
	}
	if (res.receipt) {
		return {
			fired: Boolean(res.fired),
			processing: false,
			summary: prefix + (res.summary ?? formatReceipt(res.receipt)),
			receipt: res.receipt,
			receipt_id: res.receiptId ?? res.receipt?.id ?? null,
			sourcePacket: res.sourcePacket ?? null,
			source_packet_id: res.receipt?.source_packet_id ?? res.sourcePacket?.id ?? null,
		};
	}
	// Extraction is still running past the wait budget — accepted-receipt.
	return {
		fired: true,
		processing: true,
		summary: prefix + (processingNote ?? "Captured ✓ — processing now; your memory updates in a moment."),
		receipt: null,
		receipt_id: null,
		sourcePacket: res.sourcePacket ?? null,
		source_packet_id: res.sourcePacket?.id ?? null,
	};
}

function titleCase(s) {
	return String(s ?? "")
		.split(/\s+/)
		.filter(Boolean)
		.map((w) => w.slice(0, 1).toUpperCase() + w.slice(1).toLowerCase())
		.join(" ");
}

function cleanSummaryText(digest) {
	return String(digest ?? "")
		.split(/\n+/)
		.map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim())
		.filter(Boolean)
		.join("; ");
}

function summaryLabelFor(digest, opts = {}) {
	if (opts.topic) return `${titleCase(opts.topic)} Research`;
	const lower = String(digest ?? "").toLowerCase();
	if (/\b(gta|grand theft auto|ps5|playstation|emi|loan|console)\b/.test(lower)) {
		return "GTA 6 / PS5 Research";
	}
	if (/\b(uml|universal memory|memory engine|mcp|cloudflare|vectorize|d1)\b/.test(lower)) {
		return "UML Project Discussion";
	}
	const words = tokens(digest)
		.filter((w) => w.length > 2)
		.slice(0, 4);
	return words.length ? `${titleCase(words.join(" "))} Summary` : "Conversation Summary";
}

function summaryCategory(label, digest) {
	const lower = `${label} ${digest}`.toLowerCase();
	if (/\b(uml|project|app|worker|cloudflare|mcp|d1|vectorize)\b/.test(lower)) return "project";
	if (/\b(health|diagnosed|doctor|asthma|injury)\b/.test(lower)) return "health";
	if (/\b(family|grandmother|married|relationship)\b/.test(lower)) return "life_event";
	return "interest";
}

function emptyPlan() {
	return {
		newNodes: [],
		nodeStateUpdates: [],
		nodeTouches: new Set(),
		sliceSupersede: [],
		newSlices: [],
		newEvents: [],
		newEdges: [],
		newCandidates: [],
		candidateBumps: [],
		affectedNodeIds: new Set(),
		autoCreated: [],
		rejected: [],
		hasWrites: true,
	};
}

async function saveSummaryMemory(env, config, userId, digest, { prefix, received, keptLines, topic }) {
	const text = cleanSummaryText(digest);
	if (!text) return null;

	const now = Date.now();
	const label = summaryLabelFor(text, { topic });
	const category = summaryCategory(label, text);
	const existing = await getUserNodes(env, userId);
	const match = existing.find((n) => normalizeLabel(n.label) === normalizeLabel(label));
	const nodeId = match?.id ?? newId("node");
	const sliceText = `User discussed/researched ${label}: ${text}`.slice(0, 1200);

	const plan = emptyPlan();
	if (match) {
		plan.nodeTouches.add(nodeId);
	} else {
		plan.newNodes.push({
			id: nodeId,
			user_id: userId,
			label,
			category,
			role: null,
			state: "active",
			summary: sliceText,
			created_at: now,
			updated_at: now,
		});
	}
	plan.sliceSupersede.push({ node_id: nodeId, kind: "other" });
	plan.newSlices.push({
		id: newId("slice"),
		user_id: userId,
		node_id: nodeId,
		text: sliceText,
		kind: "other",
		is_current: 1,
		created_at: now,
	});
	plan.affectedNodeIds.add(nodeId);

	await writeApproved(env, config, userId, plan);
	const receipt = buildReceipt("wrote", plan, {
		source: "save_conversation",
		received,
		digested: keptLines,
	});
	const receiptSummary = `${prefix}Saved conversation summary. ${formatReceipt(receipt)}`;
	await storeReceipt(env, userId, "save_conversation", receipt, receiptSummary);
	return { fired: true, processing: false, summary: receiptSummary, receipt };
}

/**
 * save_memory: one direct durable statement. Immediate (flush) + lenient gate.
 * `recentContext` is reference-only (assistant role) and never memorized.
 */
export async function saveMemory(env, ctx, userId, content, opts = {}) {
	const config = getConfig(env);
	const messages = [];
	if (opts.recentContext) {
		messages.push({
			id: await stableMsgId(userId, `ctx:${opts.recentContext}`),
			role: "assistant", // context only — never extracted as memory
			content: opts.recentContext,
		});
	}
	messages.push({ id: opts.id ?? (await stableMsgId(userId, content)), role: "user", content });

	const res = await ingestMessages(env, ctx, userId, messages, {
		flush: true,
		waitBudgetMs: opts.waitBudgetMs ?? config.saveWaitBudgetMs,
		sourceType: "message",
		sourceMode: "manual_direct",
		conversationId: opts.conversationId,
		threadId: opts.threadId,
		sourceId: opts.sourceId,
		idempotencyKey: opts.idempotencyKey,
		memoryScope: opts.memoryScope,
		overrides: { manual: true, source: "save_memory", ...(opts.overrides ?? {}) },
	});
	return finalize(res, {});
}

/**
 * save_conversation: digest a messy batch into clean fact-lines, THEN extract.
 * Scopes: { scope: "full" | "lastN" | "topic" | "summary", n, topic }.
 */
async function saveConversationGraphLegacy(env, ctx, userId, messages, opts = {}) {
	const config = getConfig(env);
	const received = (messages ?? []).length;
	const prefix = `Received ${received} message(s). `;

	const { digest, keptLines } = await digestConversation(env, config, messages ?? [], opts);

	if (!digest || !digest.trim()) {
		// Nothing durable survived the digest — store a clear "0" receipt anyway.
		const receipt = emptyReceipt("meaningful_no_write", "no durable facts in this chat (chatter/questions only)", {
			source: "save_conversation",
			received,
		});
		const summary = prefix + formatReceipt(receipt);
		await storeReceipt(env, userId, "save_conversation", receipt, summary);
		return { fired: false, processing: false, summary, receipt };
	}

	if (opts.scope === "summary") {
		const summaryResult = await saveSummaryMemory(env, config, userId, digest, {
			prefix,
			received,
			keptLines,
			topic: opts.topic,
		});
		if (summaryResult) return summaryResult;
	}

	const id = await stableMsgId(opts.conversationId ?? "digest", digest);
	const res = await ingestMessages(env, ctx, userId, [{ id, role: "user", content: digest }], {
		flush: true,
		waitBudgetMs: opts.waitBudgetMs ?? config.saveWaitBudgetMs,
		overrides: {
			manual: true,
			source: "save_conversation",
			meta: { received, digested: keptLines },
			...(opts.overrides ?? {}),
		},
	});
	return finalize(res, { prefix, processingNote: `Captured ✓ — digested ${keptLines} fact-line(s), processing now.` });
}
