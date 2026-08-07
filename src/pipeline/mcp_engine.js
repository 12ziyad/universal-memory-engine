/**
 * The MCP save lane on Engine v2 — receipt-first.
 *
 * One engine, many doors: MCP saves run the SAME runExtraction pipeline the
 * SDK and Playground use (pass 1 facts → concurrent pass 2 edges + pass 3
 * reflexion → gates → atomic write). What is different about this door is
 * HOW it answers, not WHAT it runs:
 *
 *   Sync phase (this file, stageMcpConversation) — deterministic, no model
 *   calls: scrub, author-tag, opt-out, thin-input gate, provisional page with
 *   a deterministic title (top entity + date, never assembled fragments),
 *   a memory_jobs row in state `staged`, durable enqueue on the user's
 *   Durable Object. Returns in well under a second.
 *
 *   Background phase (enrichMcpConversation, called by the DO under its
 *   per-user lock) — the full engine, then final title reconciliation from a
 *   single-purpose summarization pass, page finalize, job → `enriched`.
 *
 * The honesty contract (Graphiti #1164 is the disease being designed
 * against): the staged receipt says STAGED, never saved; a background
 * failure marks the job `failed`, marks the page `failed`, stores a receipt
 * the user can see, and auto-reports to admin. A receipt must never claim
 * success for work that silently didn't happen.
 *
 * Trust attribution: MCP content arrives host-mediated. Only user-authored
 * turns are extracted into the graph (assistant turns ride along solely as
 * reference context), profile "mcp" keeps the stricter auto-lane confidence
 * floor, and in whole-chat capture mode assistant lines land on the page
 * verbatim under a "derived" heading — never as graph facts.
 */

import { getConfig } from "../config.js";
import { newId } from "../lib/ids.js";
import { canonicalMemoryScope, normalizeProjectScope } from "../lib/project_scope.js";
import {
	activeJobDepth,
	claimMemoryJob,
	MEMORY_JOB_ACTIVE_LIMIT,
	storeReceipt,
	updateMemoryJob,
} from "../lib/db.js";
import { reportServerError } from "../lib/report.js";
import { resolveAdmissionRules } from "./admission.js";
import { rulesAllowText } from "./rules.js";
import { runExtraction } from "./extract.js";
import { emptyReceipt, formatReceipt } from "./receipt.js";
import { messagesContainMemoryOptOut, storeOptOutReceipt } from "./opt_out.js";
import { scrubMessages } from "./scrub.js";
import { normalizeSourcePacket, sourceMeta, storeSourcePacket } from "./source.js";
import { classifyMessage } from "./trigger.js";
import { canonicalTitle, isBadTitle, titleCaseWords } from "./title.js";
import { emitWebhookEvent, webhookDataFromReceipt } from "./webhooks.js";
import { settleStagedText } from "./staged_text.js";
import { runAi } from "../lib/ai_meter.js";
import { responseText, extractJson } from "./llm.js";

const SOURCE = "save_conversation";
const SOURCE_MODE = "mcp_save";
const JOB_TYPE = "mcp_enrich";
const TERMINAL_JOB_STATES = new Set(["enriched", "failed", "completed"]);

async function mcpExtractionRunId(userId, jobId, attempt) {
	const bytes = new TextEncoder().encode(`${userId}\u0000${jobId}\u0000${attempt}`);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	return `run_mcp_${hex.slice(0, 48)}`;
}

function mcpTestFault(input) {
	return input?.testOverrides?._testMcpFault ?? input?._testMcpFault ?? null;
}

function maybeInjectMcpFault(env, input, phase) {
	if (
		String(env.DO_WAKE_ALARMS ?? "true") === "false"
		&& mcpTestFault(input) === phase
	) {
		const error = new Error(`injected MCP interruption (${phase})`);
		error.code = "MCP_TEST_FAULT";
		throw error;
	}
}

function projectPayload(input) {
	const scope = normalizeProjectScope(input);
	return { project_id: scope.projectId, project_name: scope.projectName };
}

// A message that is ONLY a save instruction is control input, not memory.
const SAVE_INSTRUCTION_RE =
	/^\s*(?:ok(?:ay)?[,.!\s]*)?(?:please\s+)?(?:can you\s+|could you\s+)?(?:save|store|remember|add)\b[^.!?]{0,80}(?:\b(?:this|that|the|our|it|everything|memory|conversation|chat|itsuki|uml)\b[^.!?]{0,40})?[.!?\s]*$/i;

// "Save EVERYTHING" → capture mode: assistant lines are additionally kept on
// the page as derived notes (never as graph facts).
const CAPTURE_RE =
	/\bsave\b[^.!?]{0,60}\b(?:everything|whole\s+(?:chat|conversation)|entire\s+(?:chat|conversation)|full\s+(?:chat|conversation)|all\s+of\s+(?:this|it))\b/i;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Words that look like proper nouns but are not entities.
const TITLE_NOISE = new Set([
	"i", "im", "ive", "id", "ill", "monday", "tuesday", "wednesday", "thursday", "friday",
	"saturday", "sunday", "january", "february", "march", "april", "may", "june", "july",
	"august", "september", "october", "november", "december", "ok", "okay", "yes", "no",
	"the", "a", "an", "my", "our", "your", "dr", "mr", "mrs", "ms", "prof",
]);

export function dateLabel(ts = Date.now()) {
	const d = new Date(Number.isFinite(Number(ts)) && Number(ts) > 0 ? Number(ts) : Date.now());
	return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/**
 * The top-ranked entity from user-typed lines, deterministically: capitalized
 * runs (proper-noun-ish), scored by mention count then earliest mention.
 * Single mid-sentence capitals count; sentence-initial words only count when
 * part of a multi-word run ("Halcyon Robotics" yes, "Great" no).
 */
export function topEntityFromLines(lines = []) {
	const counts = new Map();
	let order = 0;
	for (const line of lines) {
		const text = String(line ?? "");
		const runRe = /(?:\b[A-Z][\w'&.-]*(?:\s+(?:of|the|de|van|von|for)\s+[A-Z][\w'&.-]*|\s+[A-Z][\w'&.-]*)*)/g;
		let match;
		while ((match = runRe.exec(text))) {
			const run = match[0].trim();
			const words = run.split(/\s+/);
			const atSentenceStart = match.index === 0 || /[.!?]\s*$/.test(text.slice(0, match.index));
			if (words.length === 1) {
				const bare = words[0].replace(/[^\w'-]/g, "");
				if (atSentenceStart || bare.length < 3 || TITLE_NOISE.has(bare.toLowerCase())) continue;
			}
			const cleaned = words
				.map((w) => w.replace(/[,.;:!?]+$/, ""))
				.filter((w) => w && !TITLE_NOISE.has(w.toLowerCase()) || words.length > 1)
				.join(" ")
				.trim();
			if (!cleaned || cleaned.length < 3) continue;
			const key = cleaned.toLowerCase();
			const existing = counts.get(key);
			if (existing) existing.count += 1;
			else counts.set(key, { label: cleaned, count: 1, order: order++ });
		}
	}
	const ranked = [...counts.values()].sort((a, b) => b.count - a.count || a.order - b.order);
	return ranked[0]?.label ?? null;
}

/**
 * Provisional title: `<top entity> — <date>`. Deterministic by construction —
 * there is no path that assembles a title out of loose fact-fragment words.
 */
export function provisionalTitle(userLines, ts = Date.now()) {
	const entity = topEntityFromLines(userLines);
	const base = entity ? String(entity).slice(0, 60) : "Conversation";
	return `${base} — ${dateLabel(ts)}`;
}

function userMessagesOf(messages) {
	return (messages ?? []).filter((m) => (m?.role ?? "user") === "user");
}

// Filler that often precedes a save command ("haha cool. ok save this") —
// stripped before the instruction test so decoration cannot smuggle a bare
// control message past the door as durable content.
const LEADING_FILLER_RE =
	/^[\s,.!?]*(?:(?:ok(?:ay)?|haha+|lol|lmao|hehe|cool|nice|sure|yep|yeah|yes|great|awesome|alright|anyway|hmm+)[\s,.!?]+)*/i;

/** Durable user lines: not noise/utility, and not a bare save instruction. */
export function durableUserMessages(messages) {
	return userMessagesOf(messages).filter((m) => {
		const content = String(m?.content ?? "").trim();
		if (!content) return false;
		const stripped = content.replace(LEADING_FILLER_RE, "");
		if (SAVE_INSTRUCTION_RE.test(stripped) || !stripped) return false;
		const cls = classifyMessage(content);
		return cls === "signal" || cls === "meaningful";
	});
}

export function captureRequested(messages) {
	return userMessagesOf(messages).some((m) => CAPTURE_RE.test(String(m?.content ?? "")));
}

function clampLine(value, limit = 300) {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function stagedMarkdown(title, userLines, derivedLines) {
	const out = [
		`# ${title}`,
		"",
		"_Staged — facts and relationships are still being extracted in the background._",
		"",
		"## What you said",
		...userLines.map((line) => `- ${clampLine(line)}`),
	];
	if (derivedLines.length) {
		out.push("", "## Conversation notes (assistant, derived)", ...derivedLines.map((line) => `- ${clampLine(line)}`));
	}
	return out.join("\n");
}

/** Human note lines from an approved plan: what the engine actually kept. */
export function factLinesFromPlan(plan = {}) {
	const lines = [];
	for (const slice of plan.newSlices ?? []) if (slice?.text) lines.push(clampLine(slice.text));
	for (const event of plan.newEvents ?? []) if (event?.text) lines.push(clampLine(event.text));
	return [...new Set(lines)];
}

export function edgeLinesFromPlan(plan = {}) {
	const labelById = new Map((plan.newNodes ?? []).map((n) => [n.id, n.label]));
	const lines = [];
	for (const edge of plan.newEdges ?? []) {
		if (edge?.fact) {
			lines.push(clampLine(edge.fact));
			continue;
		}
		const from = labelById.get(edge?.from_node) ?? null;
		const to = labelById.get(edge?.to_node) ?? null;
		if (from && to && edge?.type) lines.push(`${from} —${edge.type}→ ${to}`);
	}
	return [...new Set(lines)];
}

function enrichedMarkdown(title, { factLines, edgeLines, derivedLines, savedAt }) {
	const out = [`# ${title}`, "", `_Saved ${dateLabel(savedAt)} · extracted by the memory engine._`];
	if (factLines.length) out.push("", "## Facts", ...factLines.map((line) => `- ${line}`));
	if (edgeLines.length) out.push("", "## Relationships", ...edgeLines.map((line) => `- ${line}`));
	if (derivedLines.length) {
		out.push("", "## Conversation notes (assistant, derived)", ...derivedLines.map((line) => `- ${clampLine(line)}`));
	}
	return out.join("\n");
}

/**
 * The single-purpose title pass: one small model call over what was actually
 * saved. Anything invalid falls back to the deterministic entity+date form —
 * fragment concatenation has no code path here.
 */
export async function reconcileTitle(env, config, { entityLabels = [], factLines = [], fallbackTs = Date.now(), titleResponse }) {
	const fallbackEntity = entityLabels[0] ?? topEntityFromLines(factLines);
	const fallback = `${(fallbackEntity ?? "Conversation").slice(0, 60)} — ${dateLabel(fallbackTs)}`;
	let parsed = null;
	if (titleResponse !== undefined && titleResponse !== null) {
		parsed = typeof titleResponse === "string" ? extractJson(titleResponse) ?? { title: titleResponse } : titleResponse;
	} else {
		if (!env.AI || !factLines.length) return fallback;
		try {
			const res = await runAi(
				env,
				config.llm.summaryModel,
				{
					messages: [
						{
							role: "system",
							content: "You title a personal memory page. Given saved facts, reply with EXACTLY one JSON object {\"title\": \"...\"}: 3 to 7 plain words naming the main subject and what changed. No filler words like Notes, Memory, Summary, Session, Update. No trailing punctuation.",
						},
						{
							role: "user",
							content: `FACTS:\n${factLines.slice(0, 14).join("\n")}\n\nENTITIES: ${entityLabels.slice(0, 8).join(", ") || "(none)"}`,
						},
					],
					temperature: 0,
					max_tokens: config.llm.summaryMaxTokens,
				},
				config.llm.gatewayId ? { gateway: { id: config.llm.gatewayId } } : undefined,
				{ task: "mcp_title" },
			);
			parsed = extractJson(responseText(res));
		} catch (error) {
			console.warn("mcp title pass failed:", error?.message ?? error);
			return fallback;
		}
	}
	const raw = String(parsed?.title ?? "").replace(/\s+/g, " ").trim();
	const words = raw.split(/\s+/).filter(Boolean);
	if (!raw || words.length < 3 || words.length > 8) return fallback;
	// Validate the cased form — a good lowercase title is a casing problem,
	// not a content problem.
	const candidate = titleCaseWords(raw);
	if (isBadTitle(candidate)) return fallback;
	if (/\b(notes?|memory|memories|summary|session|update)\b$/i.test(candidate)) return fallback;
	// The title must be grounded: at least one saved entity token appears in it,
	// or there were no entities at all to ground against.
	const haystack = candidate.toLowerCase();
	const grounded = entityLabels.length === 0
		|| entityLabels.some((label) => String(label ?? "").toLowerCase().split(/\s+/).some((token) => token.length > 2 && haystack.includes(token)));
	if (!grounded) return fallback;
	return candidate;
}

function commandResult({ mode = "conversation_collect", ok = true, error = null, httpStatus = null, fired, processing, summary, receipt, receiptId, sourcePacket, extra = {} }) {
	const saved = receipt?.saved ?? {};
	const memoryScope = projectPayload(sourcePacket ?? receipt);
	return {
		ok: Boolean(ok),
		command_mode: mode,
		mode,
		source: SOURCE,
		fired: Boolean(fired),
		processing: Boolean(processing),
		summary,
		source_packet_id: receipt?.source_packet_id ?? sourcePacket?.id ?? null,
		receipt_id: receiptId ?? receipt?.id ?? null,
		receipt,
		memory_scope: memoryScope,
		...(error ? { error, code: error } : {}),
		...(httpStatus ? { http_status: httpStatus } : {}),
		counts: {
			received: receipt?.received ?? null,
			skipped: receipt?.skipped ?? 0,
			savedTotal: receipt?.savedTotal ?? 0,
			pages: saved.pages ?? 0,
			nodes: saved.nodes ?? 0,
			slices: saved.slices ?? 0,
			events: saved.events ?? 0,
			edges: saved.edges ?? 0,
			candidates: saved.candidates ?? 0,
		},
		...extra,
	};
}

async function storeStagedReceipt(env, userId, sourcePacket, {
	received,
	stagedFacts,
	pageId,
	title,
	jobId,
	receiptId: existingReceiptId = null,
}) {
	const receiptId = existingReceiptId ?? `receipt_mcp_stage_${jobId}`;
	const receipt = emptyReceipt("staged", "captured — extracting facts and relationships in the background", {
		source: SOURCE,
		source_mode: SOURCE_MODE,
		...sourceMeta(sourcePacket),
		received,
	});
	receipt.processing = true;
	receipt.final = false;
	receipt.status = "staged";
	receipt.staged_facts = stagedFacts;
	receipt.page_id = pageId;
	receipt.page_title = title;
	receipt.job_id = jobId;
	receipt.id = receiptId;
	const summary = `Staged ✓ "${title}" — ${stagedFacts} message(s) captured. Facts and relationships are being extracted now (~1 min); this save is final only when its page shows enriched.`;
	const saved = receipt.saved ?? {};
	await env.DB.prepare(
		`INSERT INTO receipts
			(id, user_id, source, outcome, summary, saved_total, saved_nodes, saved_slices,
			 saved_events, saved_edges, saved_candidates, updated_nodes, skipped, received,
			 digested, detail, created_at, saved_pages, source_packet_id, idempotency_key,
			 scope_json, source_mode)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO NOTHING`,
	).bind(
		receiptId,
		userId,
		SOURCE,
		receipt.outcome ?? "staged",
		summary,
		receipt.savedTotal ?? 0,
		saved.nodes ?? 0,
		saved.slices ?? 0,
		saved.events ?? 0,
		saved.edges ?? 0,
		saved.candidates ?? 0,
		saved.updatedNodes ?? 0,
		receipt.skipped ?? 0,
		receipt.received ?? received,
		receipt.digested ?? null,
		JSON.stringify(receipt),
		receipt.created_at ?? Date.now(),
		saved.pages ?? 0,
		receipt.source_packet_id ?? null,
		receipt.idempotency_key ?? null,
		receipt.scope_json ?? null,
		receipt.source_mode ?? SOURCE_MODE,
	).run();
	const stored = await env.DB.prepare(
		"SELECT detail, summary FROM receipts WHERE id = ? AND user_id = ? LIMIT 1",
	).bind(receiptId, userId).first();
	if (!stored) throw new Error("MCP staged receipt could not be durably created");
	let persisted = receipt;
	try { persisted = JSON.parse(stored.detail ?? "null") ?? receipt; } catch {}
	return { receipt: persisted, summary: stored.summary ?? summary, receiptId };
}

async function insertProvisionalPage(env, userId, { pageId, title, userLines, derivedLines, sourcePacket, receiptId, now }) {
	const meta = sourceMeta(sourcePacket);
	await env.DB.prepare(
		`INSERT INTO memory_pages
			(id, user_id, node_kind, source_mode, title, canonical_title, short_summary, full_markdown,
			 source_conversation_id, source_packet_id, input_hash, idempotency_key, scope_json, receipt_id,
			 created_at, updated_at, last_seen_at, heat_score, confidence, enrich_status, project_id, project_name)
		 VALUES (?, ?, 'memory_page', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0.6, 'staged', ?, ?)
		 ON CONFLICT(id) DO NOTHING`,
	).bind(
		pageId,
		userId,
		SOURCE_MODE,
		title,
		canonicalTitle(title),
		clampLine(userLines[0] ?? title, 200),
		stagedMarkdown(title, userLines, derivedLines),
		sourcePacket?.conversation_id ?? null,
		sourcePacket?.id ?? null,
		sourcePacket?.content_hash ?? null,
		sourcePacket?.idempotency_key ?? null,
		meta.scope_json ?? null,
		receiptId ?? null,
		now,
		now,
		now,
		meta.project_id ?? null,
		meta.project_name ?? null,
	).run();
	const stored = await env.DB.prepare(
		"SELECT id, user_id, source_packet_id, input_hash FROM memory_pages WHERE id = ? LIMIT 1",
	).bind(pageId).first();
	if (
		!stored
		|| stored.user_id !== userId
		|| stored.source_packet_id !== sourcePacket?.id
		|| stored.input_hash !== sourcePacket?.content_hash
	) {
		throw new Error("MCP provisional page ownership is inconsistent");
	}
	return stored;
}

async function stageMcpMemoryTextOnce(env, userId, {
	jobId,
	sourcePacketId,
	messages,
	projectId = null,
	projectName = null,
}) {
	const rows = (messages ?? [])
		.filter((message) => (message?.role ?? "user") === "user")
		.map((message) => ({ id: message?.id ?? null, text: String(message?.content ?? "").trim() }))
		.filter((message) => message.text)
		.slice(0, 40);
	if (!rows.length) return { staged: 0 };
	const now = Date.now();
	try {
		await env.DB.batch(rows.map((message, index) => env.DB.prepare(
			`INSERT INTO staged_memories
				(id, user_id, job_id, source_packet_id, lane, message_id, text, created_at,
				 settled_at, project_id, project_name)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
			 ON CONFLICT(id) DO NOTHING`,
		).bind(
			`staged_mcp_${jobId}_${index}`,
			userId,
			jobId,
			sourcePacketId,
			SOURCE_MODE,
			message.id,
			message.text.slice(0, 2000),
			now,
			projectId,
			projectName,
		)));
		return { staged: rows.length };
	} catch (error) {
		console.warn("MCP staged text failed:", error?.message ?? error);
		return { staged: 0, error: String(error?.message ?? error) };
	}
}

/**
 * Duplicate pre-check: the same content (same idempotency key) already went
 * through this door. Answer with the existing page + job status instead of
 * re-staging — safe re-sends were a promise of the old door and remain one.
 */
async function findExistingJob(env, userId, idempotencyKey) {
	if (!idempotencyKey) return null;
	const job = await env.DB.prepare(
		`SELECT id, status, type, payload_json, receipt_id, source_packet_id
		 FROM memory_jobs WHERE user_id = ? AND idempotency_key = ? LIMIT 1`,
	).bind(userId, idempotencyKey).first();
	if (!job) return null;
	let payload = {};
	try { payload = JSON.parse(job.payload_json ?? "{}") ?? {}; } catch {}
	if (job.type !== JOB_TYPE) return { job, page: null, payload };
	const pageId = payload.pageId ?? null;
	const page = pageId
		? await env.DB.prepare("SELECT id, title, enrich_status FROM memory_pages WHERE id = ? AND user_id = ? AND deleted_at IS NULL").bind(pageId, userId).first()
		: null;
	return { job, page, payload };
}

function idempotencyConflictResult(normalized, existingSourceId = null) {
	const summary = "That idempotency key is already bound to different content or a different save lane. Send the original request or use a new key.";
	return commandResult({
		ok: false,
		error: "idempotency_conflict",
		httpStatus: 409,
		fired: false,
		processing: false,
		summary,
		sourcePacket: normalized.packet,
		extra: {
			idempotencyConflict: true,
			idempotency_key: normalized.packet.idempotency_key,
			source_packet_id: existingSourceId,
			retryable: false,
		},
	});
}

async function duplicateMcpResult(env, userId, normalized, sourcePacket, existing) {
	const status = existing.page?.enrich_status ?? existing.job.status ?? "staged";
	const stillProcessing = ["queued", "staged", "processing"].includes(status);
	const title = existing.page?.title ?? null;
	let storedReceipt = null;
	if (existing.job.receipt_id) {
		const row = await env.DB.prepare(
			"SELECT detail FROM receipts WHERE id = ? AND user_id = ? LIMIT 1",
		).bind(existing.job.receipt_id, userId).first();
		try { storedReceipt = JSON.parse(row?.detail ?? "null"); } catch {}
	}
	const receipt = storedReceipt
		? { ...storedReceipt }
		: emptyReceipt("duplicate", "this exact conversation was already accepted", {
			source: SOURCE,
			source_mode: SOURCE_MODE,
			...sourceMeta(sourcePacket),
			received: normalized.messages.length,
		});
	receipt.page_id = existing.page?.id ?? receipt.page_id ?? null;
	receipt.page_title = title ?? receipt.page_title ?? null;
	receipt.status = status;
	receipt.processing = stillProcessing;
	receipt.final = !stillProcessing;
	receipt.duplicate = true;
	const summary = title
		? (stillProcessing
			? `Already staged - "${title}" is still being enriched in the background.`
			: `Already saved - "${title}" (${status}).`)
		: `Already accepted - this exact conversation was staged earlier (${status}); its page is not currently present.`;
	return commandResult({
		fired: false,
		processing: stillProcessing,
		summary,
		receipt,
		receiptId: existing.job.receipt_id ?? receipt.id ?? null,
		sourcePacket,
		extra: {
			page_id: existing.page?.id ?? null,
			title,
			staged_facts: null,
			job_status: status,
			job_id: existing.job.id,
			duplicate: true,
		},
	});
}

function ignoredMcpReceiptId(sourcePacket) {
	return sourcePacket?.id ? `receipt_mcp_ignored_${sourcePacket.id}` : null;
}

async function replayIgnoredMcpResult(env, userId, normalized, sourcePacket) {
	const id = ignoredMcpReceiptId(sourcePacket);
	if (!id) return null;
	const row = await env.DB.prepare(
		"SELECT detail, summary FROM receipts WHERE id = ? AND user_id = ? LIMIT 1",
	).bind(id, userId).first();
	if (!row) return null;
	let receipt = null;
	try { receipt = JSON.parse(row.detail ?? "null"); } catch {}
	if (!receipt) return null;
	receipt = { ...receipt, id, duplicate: true, final: true, processing: false };
	return commandResult({
		fired: false,
		processing: false,
		summary: row.summary ?? "Saved: 0. Reason: nothing durable here.",
		receipt,
		receiptId: id,
		sourcePacket,
		extra: { duplicate: true, job_status: "completed" },
	});
}

/**
 * Sync phase. Deterministic, no model calls, returns in well under a second
 * with an honest staged receipt: { page_id, title, staged_facts, processing }.
 */
export async function stageMcpConversation(env, ctx, userId, input = {}) {
	const config = getConfig(env);
	const requestedScope = canonicalMemoryScope(input.memoryScope);
	const requestedProject = projectPayload(requestedScope);
	const scrubbed = scrubMessages(Array.isArray(input.messages) ? input.messages : []);
	const optOut = messagesContainMemoryOptOut(scrubbed.messages);
	if (optOut.optedOut) {
		const received = userMessagesOf(scrubbed.messages).length;
		const { receipt, receiptId, summary } = await storeOptOutReceipt(env, userId, SOURCE, {
			source_mode: SOURCE_MODE,
			...requestedProject,
			received,
			skipped: received || 1,
			opt_out_phrase: optOut.phrase,
		});
		return commandResult({ fired: false, processing: false, summary, receipt, receiptId });
	}

	const normalized = await normalizeSourcePacket(userId, {
		type: "message_batch",
		sourceMode: SOURCE_MODE,
		messages: scrubbed.messages,
		conversationId: input.conversationId,
		threadId: input.threadId,
		sourceId: input.sourceId,
		idempotencyKey: input.idempotencyKey,
		scope: requestedScope,
	});
	const received = normalized.messages.length;
	// Check the account-wide job namespace before source ownership is created.
	// A colliding ingest/internal key is a clean 409 with zero mutation.
	let existing = await findExistingJob(env, userId, normalized.packet.idempotency_key);
	if (existing && existing.job.type !== JOB_TYPE) {
		return idempotencyConflictResult(normalized, existing.job.source_packet_id ?? null);
	}

	// Size cap — a clear refusal beats a silent truncation.
	const totalChars = normalized.messages.reduce((n, m) => n + m.content.length, 0);
	if (received > config.mcp.maxStagedMessages || totalChars > config.mcp.maxStagedChars) {
		const receipt = emptyReceipt("too_large", "conversation exceeds the per-save limit", {
			source: SOURCE, source_mode: SOURCE_MODE, ...requestedProject, received,
		});
		receipt.skipped = received;
		const summary = `Saved: 0. This conversation is too large for one save (limit ${config.mcp.maxStagedMessages} messages / ${Math.round(config.mcp.maxStagedChars / 1000)}k characters) — send the part that matters.`;
		const receiptId = await storeReceipt(env, userId, SOURCE, receipt, summary);
		return commandResult({
			ok: false,
			error: "too_large",
			httpStatus: 413,
			fired: false,
			processing: false,
			summary,
			receipt,
			receiptId,
		});
	}

	// The source packet is the account-wide, content-bound ownership record.
	// source_type and source_mode participate in its hash, so a key cannot move
	// between HTTP ingest and MCP (or between two different MCP payloads).
	const sourcePacket = await storeSourcePacket(env, normalized.packet, { immutableIdempotency: true });
	if (sourcePacket?.idempotency_conflict) {
		return idempotencyConflictResult(normalized, sourcePacket.id ?? null);
	}
	const ignoredReplay = await replayIgnoredMcpResult(env, userId, normalized, sourcePacket);
	if (ignoredReplay) return ignoredReplay;

	// Terminal work is a pure replay. Active work continues through the repair
	// path below: its D1 claim may exist while its receipt/page/DO enqueue does
	// not, depending on where the first isolate stopped.
	if (existing?.job.source_packet_id && existing.job.source_packet_id !== sourcePacket?.id) {
		return idempotencyConflictResult(normalized, existing.job.source_packet_id);
	}
	if (existing && TERMINAL_JOB_STATES.has(existing.job.status)) {
		return duplicateMcpResult(env, userId, normalized, sourcePacket, existing);
	}
	const recovering = Boolean(existing);

	// 1.7 backpressure — every lane refuses clearly at the same depth cap.
	const queueDepth = await activeJobDepth(env, userId);
	if (!recovering && queueDepth >= MEMORY_JOB_ACTIVE_LIMIT) {
		const receipt = emptyReceipt("queue_full", "too much unprocessed work — retry shortly", {
			source: SOURCE, source_mode: SOURCE_MODE, ...requestedProject, received,
		});
		const summary = "Your memory queue is full — give it a moment to catch up, then retry this save.";
		const receiptId = await storeReceipt(env, userId, SOURCE, receipt, summary);
		return commandResult({
			ok: false, error: "queue_full", httpStatus: 429,
			fired: false, processing: false, summary, receipt, receiptId,
			extra: { backpressure: true, queue_depth: queueDepth, retry_after_s: 30 },
		});
	}

	const project = projectPayload(sourcePacket);
	const durable = durableUserMessages(normalized.messages);

	// Thin input: nothing durable → no page, no job, an honest zero. This is
	// the July fix, now deterministic and instant instead of 20s of model time.
	if (durable.length === 0) {
		const receipt = emptyReceipt("ignored", "nothing durable here (chatter, questions, or instructions only)", {
			source: SOURCE, source_mode: SOURCE_MODE,
			...sourceMeta(sourcePacket),
			received,
		});
		receipt.skipped = received;
		receipt.id = ignoredMcpReceiptId(sourcePacket);
		const summary = "Saved: 0. Reason: nothing durable here (chatter, questions, or instructions only).";
		const receiptId = await storeReceipt(env, userId, SOURCE, receipt, summary, { strict: true });
		return commandResult({ fired: false, processing: false, summary, receipt, receiptId, sourcePacket });
	}

	const now = Date.now();
	// The user's memory rules apply to PAGE CONTENT here (an excluded topic
	// must never appear on a notes page); graph enforcement stays in the
	// engine's gates, where each refusal is named on the receipt.
	// The MCP door only ever serves the key owner's root identity (handleMcp),
	// so a self-load here IS the account's rules — the admission boundary makes
	// that explicit.
	const rules = await resolveAdmissionRules(env, userId);
	const capture = captureRequested(normalized.messages) && rules.captureDefault !== "graph_only";
	const userLines = durable.map((m) => m.content).filter((line) => rulesAllowText(rules, line));
	const derivedLines = capture
		? normalized.messages
			.filter((m) => m.role === "assistant")
			.map((m) => m.content)
			.filter((line) => rulesAllowText(rules, line))
			.slice(0, 40)
		: [];
	const lastTs = normalized.messages.reduce((max, m) => (Number(m.ts) > max ? Number(m.ts) : max), 0) || now;
	const proposedTitle = provisionalTitle(userLines, lastTs);
	const proposedPageId = newId("page");
	const proposedJobId = newId("job");
	const proposedReceiptId = `receipt_mcp_stage_${proposedJobId}`;
	let jobClaim = existing
		? { claimed: false, id: existing.job.id, job: existing.job }
		: await claimMemoryJob(env, userId, {
			id: proposedJobId,
			type: JOB_TYPE,
			status: "staged",
			idempotencyKey: sourcePacket?.idempotency_key ?? normalized.packet.idempotency_key,
			sourcePacketId: sourcePacket?.id ?? null,
			payload: {
				pageId: proposedPageId,
				title: proposedTitle,
				stagedReceiptId: proposedReceiptId,
				sourceContentHash: sourcePacket?.content_hash ?? null,
				...project,
			},
		});
	if (jobClaim.capacityExceeded) {
		const summary = "Your memory queue is full - give it a moment to catch up, then retry this save.";
		return commandResult({
			ok: false,
			error: "queue_full",
			httpStatus: 429,
			fired: false,
			processing: false,
			summary,
			sourcePacket,
			extra: {
				backpressure: true,
				queue_depth: jobClaim.activeLimit,
				retry_after_s: 30,
			},
		});
	}
	if (!jobClaim.claimed) {
		if (!jobClaim.job) throw new Error("MCP memory job claim was lost without an existing job");
		if (
			jobClaim.job.type !== JOB_TYPE
			|| (jobClaim.job.source_packet_id && jobClaim.job.source_packet_id !== sourcePacket?.id)
		) {
			return idempotencyConflictResult(normalized, jobClaim.job.source_packet_id ?? sourcePacket?.id ?? null);
		}
		existing = await findExistingJob(env, userId, normalized.packet.idempotency_key);
		if (!existing) throw new Error("MCP memory job claim returned an unreadable owner");
		if (TERMINAL_JOB_STATES.has(existing.job.status)) {
			return duplicateMcpResult(env, userId, normalized, sourcePacket, existing);
		}
	}
	const jobId = jobClaim.id;
	if (!jobId) throw new Error("MCP memory job row could not be created");
	const ownerPayload = jobClaim.claimed
		? {
			pageId: proposedPageId,
			title: proposedTitle,
			stagedReceiptId: proposedReceiptId,
			sourceContentHash: sourcePacket?.content_hash ?? null,
			...project,
		}
		: existing?.payload ?? {};
	if (ownerPayload.sourceContentHash && ownerPayload.sourceContentHash !== sourcePacket?.content_hash) {
		return idempotencyConflictResult(normalized, sourcePacket?.id ?? null);
	}
	const pageId = ownerPayload.pageId;
	const title = ownerPayload.title;
	if (!pageId || !title) throw new Error("MCP memory job is missing its repair metadata");
	maybeInjectMcpFault(env, input, "after_job_claim");

	const { receipt, summary, receiptId } = await storeStagedReceipt(env, userId, sourcePacket, {
		received,
		stagedFacts: durable.length,
		pageId,
		title,
		jobId,
		receiptId: existing?.job.receipt_id ?? ownerPayload.stagedReceiptId ?? `receipt_mcp_stage_${jobId}`,
	});
	await insertProvisionalPage(env, userId, { pageId, title, userLines, derivedLines, sourcePacket, receiptId, now });
	if (receiptId) await updateMemoryJob(env, userId, jobId, { receiptId });

	// 8.2 read-your-writes: every durable line is findable the moment this
	// receipt returns — not just the first one via the page's short_summary
	// (the gap the 0.3 trace measured on this exact lane).
	await stageMcpMemoryTextOnce(env, userId, {
		jobId,
		sourcePacketId: sourcePacket?.id ?? null,
		messages: durable.map((m) => ({ id: m.id, role: "user", content: m.content })),
		projectId: project.project_id,
		projectName: project.project_name,
	});

	// Durable enqueue on the user's DO — the alarm drives enrichment even if
	// this isolate dies the moment we return. The job entry carries everything
	// the background phase needs; assistant turns ride only as context.
	const { _testMcpFault: _discardMcpFault, ...jobTestOverrides } = input.testOverrides ?? {};
	const job = {
		jobId,
		pageId,
		title,
		receiptId,
		captureMode: capture,
		derivedLines,
		userMessages: durable.map((m) => ({ id: m.id, role: "user", content: m.content, ts: m.ts })),
		contextMessages: normalized.messages
			.filter((m) => m.role === "assistant")
			.slice(-8)
			.map((m) => ({ id: m.id, role: "assistant", content: clampLine(m.content, 1500), ts: m.ts })),
		sourceMeta: { ...sourceMeta(sourcePacket), topic_filter: normalized.packet.topic ?? null },
		lastTs,
		testOverrides: Object.keys(jobTestOverrides).length ? jobTestOverrides : null,
	};
	const stub = env.USER_MEMORY.get(env.USER_MEMORY.idFromName(userId));
	const handoff = await stub.enqueueMcpJobOnce(userId, job, {
		handoffId: jobId,
		contentHash: sourcePacket?.content_hash,
		_testMcpFault: mcpTestFault(input),
	});
	if (handoff?._testMcpFault) maybeInjectMcpFault(env, input, handoff._testMcpFault);
	if (!jobClaim.claimed) {
		const repaired = await findExistingJob(env, userId, normalized.packet.idempotency_key);
		if (!repaired) throw new Error("MCP repair completed without a readable job");
		return duplicateMcpResult(env, userId, normalized, sourcePacket, repaired);
	}

	return commandResult({
		fired: true,
		processing: true,
		summary,
		receipt,
		receiptId,
		sourcePacket,
		extra: { page_id: pageId, title, staged_facts: durable.length, job_id: jobId, job_status: "staged", ...project },
	});
}

export async function markMcpEnrichmentFailed(env, userId, job, reason, defer = null) {
	const project = projectPayload(job.sourceMeta);
	const receipt = emptyReceipt("enrich_failed", "background processing hit a problem — it has been reported", {
		source: SOURCE, source_mode: SOURCE_MODE, ...(job.sourceMeta ?? {}),
	});
	receipt.id = `receipt_mcp_failed_${job.jobId}`;
	receipt.page_id = job.pageId;
	receipt.status = "failed";
	const summary = "This save could not finish processing. The staged page is kept, nothing was lost, and the problem has been reported automatically.";
	await updateMemoryJob(env, userId, job.jobId, {
		status: "failed",
		receiptId: receipt.id,
		error: String(reason ?? "unknown").slice(0, 400),
		payload: {
			pageId: job.pageId,
			title: job.title ?? null,
			reason: String(reason ?? "unknown").slice(0, 400),
			...project,
		},
		completedAt: Date.now(),
	});
	const terminal = await env.DB.prepare(
		"SELECT status FROM memory_jobs WHERE id = ? AND user_id = ? LIMIT 1",
	).bind(job.jobId, userId).first();
	if (terminal?.status !== "failed") {
		throw new Error("MCP failure verdict is not durable");
	}
	// The D1 terminal verdict is written before repairable side effects so an
	// isolate loss can never send this paid job back through inference. The
	// stable receipt id makes the subsequent repair idempotent.
	await storeReceipt(env, userId, SOURCE, receipt, summary, { strict: true });
	try {
		await env.DB.prepare(
			"UPDATE memory_pages SET enrich_status = 'failed', updated_at = ? WHERE id = ? AND user_id = ? AND project_id IS ? AND deleted_at IS NULL",
		).bind(Date.now(), job.pageId, userId, project.project_id).run();
	} catch (error) {
		console.warn("mcp enrich failure side effects failed:", error?.message ?? error);
	}
	await reportServerError(env, "mcp_enrich", new Error(String(reason ?? "unknown")), userId, {
		reportId: `err_mcp_enrich_${job.jobId}`,
	})
		.catch((error) => console.warn("mcp enrich report failed:", error?.message ?? error));
	// A failed enrichment is terminal too: the staged page is what the user
	// has, and the job row says why. Staged text stops answering either way.
	await settleStagedText(env, userId, [job.jobId])
		.catch((error) => console.warn("mcp staged-text settlement failed:", error?.message ?? error));
}

export async function announceMcpTerminal(env, userId, job, defer = null) {
	if (!defer || !job?.jobId) return;
	const row = await env.DB.prepare(
		"SELECT status, source_packet_id, receipt_id, payload_json, error FROM memory_jobs WHERE id = ? AND user_id = ? LIMIT 1",
	).bind(job.jobId, userId).first();
	if (!row || !["enriched", "failed", "completed"].includes(row.status)) {
		throw new Error("MCP terminal announcement has no durable job verdict");
	}
	let payload = {};
	try { payload = JSON.parse(row.payload_json ?? "{}") ?? {}; } catch {}
	const project = projectPayload(payload);
	let receipt = null;
	if (row.receipt_id) {
		const stored = await env.DB.prepare(
			"SELECT detail FROM receipts WHERE id = ? AND user_id = ? LIMIT 1",
		).bind(row.receipt_id, userId).first();
		try { receipt = JSON.parse(stored?.detail ?? "null"); } catch {}
	}
	if (row.status !== "failed" && receipt) {
		const saved = receipt.saved ?? {};
		const added = Number(saved.nodes ?? 0) + Number(saved.slices ?? 0)
			+ Number(saved.events ?? 0) + Number(saved.edges ?? 0) > 0;
		if (added) {
			await emitWebhookEvent(env, defer, userId, "memory.added", webhookDataFromReceipt(receipt), {
				eventId: `receipt:${receipt.id}:memory.added:${userId}`,
				strict: true,
			});
		}
	}
	const status = row.status === "failed" ? "failed" : "enriched";
	await emitWebhookEvent(env, defer, userId, `memory.${status}`, {
		job_id: job.jobId,
		source_packet_id: row.source_packet_id ?? job.sourceMeta?.source_packet_id ?? null,
		receipt_id: row.receipt_id ?? null,
		status,
		...project,
		counts: {
			nodes: payload.nodes ?? receipt?.saved?.nodes ?? 0,
			edges: payload.edges ?? receipt?.saved?.edges ?? 0,
			slices: payload.slices ?? receipt?.saved?.slices ?? 0,
			events: payload.events ?? receipt?.saved?.events ?? 0,
		},
		...(row.error ? { error: String(row.error).slice(0, 200) } : {}),
	}, {
		eventId: `job:${job.jobId}:${status}`,
		strict: true,
	});
}

/**
 * Background phase — runs on the user's Durable Object, under its per-user
 * lock. Returns { done } or { retry: true } for transient engine failures
 * (the DO retries with backoff, bounded by attempts).
 */
export async function enrichMcpConversation(env, userId, job, defer = null) {
	const config = getConfig(env);
	const project = projectPayload(job.sourceMeta);
	try {
		const rules = await resolveAdmissionRules(env, userId);
		const overrides = {
			manual: true,
			source: SOURCE,
			profile: "mcp",
			rules,
			meta: {
				...(job.sourceMeta ?? {}),
				source_mode: SOURCE_MODE,
				page_id: job.pageId,
				job_id: job.jobId,
				trust: "mcp_host",
			},
			...(job.testOverrides ?? {}),
		};
		const attempt = Number(job.attempts ?? 0);
		const result = await runExtraction(
			env,
			userId,
			job.userMessages ?? [],
			job.contextMessages ?? [],
			overrides,
			{ runId: await mcpExtractionRunId(userId, job.jobId, attempt) },
		);

		if (result.outcome === "in_progress") {
			return { retry: true, inProgress: true, reason: "extraction already in progress" };
		}
		if (result.outcome === "interrupted_unknown") {
			const reason = "extraction was interrupted after inference began; the model was not called again";
			try {
				await markMcpEnrichmentFailed(env, userId, job, reason, defer);
				return { done: true, failed: true };
			} catch (error) {
				return { retry: true, terminalPending: true, reason, error: String(error?.message ?? error) };
			}
		}

		if (result.outcome === "llm_failed" || result.outcome === "db_write_failed") {
			const attempts = Number(job.attempts ?? 0);
			if (attempts < 2) return { retry: true, reason: result.outcome };
			const reason = `${result.outcome} after ${attempts + 1} attempts`;
			try {
				await markMcpEnrichmentFailed(env, userId, job, reason, defer);
				return { done: true, failed: true };
			} catch (error) {
				return { retry: true, terminalPending: true, reason, error: String(error?.message ?? error) };
			}
		}

		const plan = result.plan ?? {};
		const receipt = result.receipt ?? null;
		const summary = receipt ? formatReceipt(receipt) : null;
		if (receipt) {
			const storedId = await storeReceipt(env, userId, SOURCE, receipt, summary);
			if (storedId) receipt.id = storedId;
		}

		const factLines = factLinesFromPlan(plan);
		const edgeLines = edgeLinesFromPlan(plan);
		const wroteSomething = result.outcome === "wrote";

		if (!wroteSomething && factLines.length === 0) {
			// The engine looked and found nothing durable. The staged page must
			// not linger as junk — remove it and say so on the job.
			await env.DB.prepare(
				"UPDATE memory_pages SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND project_id IS ?",
			).bind(Date.now(), Date.now(), job.pageId, userId, project.project_id).run();
			await updateMemoryJob(env, userId, job.jobId, {
				status: "enriched",
				receiptId: receipt?.id ?? null,
				payload: {
					pageId: job.pageId,
					page_deleted: true,
					reason: "no durable content survived extraction",
					...project,
				},
				completedAt: Date.now(),
			});
			await settleStagedText(env, userId, [job.jobId]);
			return { done: true };
		}

		const entityLabels = [
			...new Set([...(plan.newNodes ?? []).map((n) => n.label)].filter(Boolean)),
		];
		const title = await reconcileTitle(env, config, {
			entityLabels,
			factLines: [...factLines, ...edgeLines],
			fallbackTs: job.lastTs ?? Date.now(),
			titleResponse: job.testOverrides?.titleResponse,
		});
		// Rules re-checked at finalize: they may have changed since staging, and
		// an excluded topic must never survive onto the final page.
		const derivedLines = job.captureMode
			? (job.derivedLines ?? []).filter((line) => rulesAllowText(rules, line))
			: [];
		const markdown = enrichedMarkdown(title, {
			factLines,
			edgeLines,
			derivedLines,
			savedAt: job.lastTs ?? Date.now(),
		});
		await env.DB.prepare(
			`UPDATE memory_pages SET
				title = ?, canonical_title = ?, short_summary = ?, full_markdown = ?,
				enrich_status = 'enriched', extraction_run_id = ?, receipt_id = COALESCE(?, receipt_id),
				updated_at = ?, last_seen_at = ?
			 WHERE id = ? AND user_id = ? AND project_id IS ? AND deleted_at IS NULL`,
		).bind(
			title,
			canonicalTitle(title),
			clampLine(factLines[0] ?? title, 200),
			markdown,
			receipt?.extraction_run_id ?? null,
			receipt?.id ?? null,
			Date.now(),
			Date.now(),
			job.pageId,
			userId,
			project.project_id,
		).run();
		await updateMemoryJob(env, userId, job.jobId, {
			status: "enriched",
			receiptId: receipt?.id ?? null,
			payload: {
				pageId: job.pageId,
				title,
				nodes: receipt?.saved?.nodes ?? 0,
				edges: receipt?.saved?.edges ?? 0,
				slices: receipt?.saved?.slices ?? 0,
				events: receipt?.saved?.events ?? 0,
				...project,
			},
			completedAt: Date.now(),
		});

		// 8.2 upgrade: the graph now holds this content, so its staged rows
		// stop answering recall.
		await settleStagedText(env, userId, [job.jobId]);

		return { done: true };
	} catch (error) {
		const reason = String(error?.message ?? error);
		try {
			await markMcpEnrichmentFailed(env, userId, job, reason, defer);
			return { done: true, failed: true };
		} catch (bookkeepingError) {
			return {
				retry: true,
				terminalPending: true,
				reason,
				error: String(bookkeepingError?.message ?? bookkeepingError),
			};
		}
	}
}
