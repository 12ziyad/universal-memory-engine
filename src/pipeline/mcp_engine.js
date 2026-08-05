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
import { activeJobDepth, createMemoryJob, storeReceipt, updateMemoryJob } from "../lib/db.js";
import { reportServerError } from "../lib/report.js";
import { getMemoryRules, rulesAllowText } from "./rules.js";
import { runExtraction } from "./extract.js";
import { emptyReceipt, formatReceipt } from "./receipt.js";
import { messagesContainMemoryOptOut, storeOptOutReceipt } from "./opt_out.js";
import { scrubMessages } from "./scrub.js";
import { normalizeSourcePacket, sourceMeta, storeSourcePacket } from "./source.js";
import { classifyMessage } from "./trigger.js";
import { canonicalTitle, isBadTitle, titleCaseWords } from "./title.js";
import { emitWebhookEvent, webhookDataFromReceipt } from "./webhooks.js";
import { settleStagedText, stageMemoryText } from "./staged_text.js";
import { runAi } from "../lib/ai_meter.js";
import { responseText, extractJson } from "./llm.js";

const SOURCE = "save_conversation";
const SOURCE_MODE = "mcp_save";
const JOB_TYPE = "mcp_enrich";

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

async function storeStagedReceipt(env, userId, sourcePacket, { received, stagedFacts, pageId, title, jobId }) {
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
	const summary = `Staged ✓ "${title}" — ${stagedFacts} message(s) captured. Facts and relationships are being extracted now (~1 min); this save is final only when its page shows enriched.`;
	const id = await storeReceipt(env, userId, SOURCE, receipt, summary);
	if (id) receipt.id = id;
	return { receipt, summary, receiptId: id ?? null };
}

async function insertProvisionalPage(env, userId, { pageId, title, userLines, derivedLines, sourcePacket, receiptId, now }) {
	const meta = sourceMeta(sourcePacket);
	await env.DB.prepare(
		`INSERT INTO memory_pages
			(id, user_id, node_kind, source_mode, title, canonical_title, short_summary, full_markdown,
			 source_conversation_id, source_packet_id, input_hash, idempotency_key, scope_json, receipt_id,
			 created_at, updated_at, last_seen_at, heat_score, confidence, enrich_status, project_id, project_name)
		 VALUES (?, ?, 'memory_page', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0.6, 'staged', ?, ?)`,
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
}

/**
 * Duplicate pre-check: the same content (same idempotency key) already went
 * through this door. Answer with the existing page + job status instead of
 * re-staging — safe re-sends were a promise of the old door and remain one.
 */
async function findExistingJob(env, userId, idempotencyKey) {
	if (!idempotencyKey) return null;
	const job = await env.DB.prepare(
		"SELECT id, status, payload_json FROM memory_jobs WHERE user_id = ? AND idempotency_key = ? AND type = ? LIMIT 1",
	).bind(userId, idempotencyKey, JOB_TYPE).first();
	if (!job) return null;
	let pageId = null;
	try { pageId = JSON.parse(job.payload_json ?? "{}")?.pageId ?? null; } catch {}
	const page = pageId
		? await env.DB.prepare("SELECT id, title, enrich_status FROM memory_pages WHERE id = ? AND user_id = ? AND deleted_at IS NULL").bind(pageId, userId).first()
		: null;
	return { job, page };
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

	// Duplicate re-send → answer with what already exists, do nothing twice.
	const existing = await findExistingJob(env, userId, normalized.packet.idempotency_key);
	if (existing) {
		const status = existing.page?.enrich_status ?? existing.job.status ?? "staged";
		const stillProcessing = status === "staged";
		const title = existing.page?.title ?? null;
		const receipt = emptyReceipt("duplicate", "this exact conversation was already saved", {
			source: SOURCE, source_mode: SOURCE_MODE, ...requestedProject, received,
		});
		receipt.page_id = existing.page?.id ?? null;
		receipt.page_title = title;
		receipt.status = status;
		receipt.processing = stillProcessing;
		receipt.final = !stillProcessing;
		// No title means the page this job wrote is gone (deleted since). The
		// acceptance still happened, so say that and not "already saved" — the
		// saved thing may no longer exist.
		const summary = title
			? (stillProcessing
				? `Already staged — "${title}" is still being enriched in the background.`
				: `Already saved — "${title}" (${status}).`)
			: `Already accepted — this exact conversation was staged earlier (${status}); its page is no longer present.`;
		const receiptId = await storeReceipt(env, userId, SOURCE, receipt, summary);
		return commandResult({
			fired: false,
			processing: stillProcessing,
			summary,
			receipt,
			receiptId,
			sourcePacket: normalized.packet,
			extra: { page_id: existing.page?.id ?? null, title, staged_facts: null, job_status: status, duplicate: true },
		});
	}

	// 1.7 backpressure — every lane refuses clearly at the same depth cap.
	const queueDepth = await activeJobDepth(env, userId);
	if (queueDepth >= 200) {
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

	const sourcePacket = await storeSourcePacket(env, normalized.packet);
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
		const summary = "Saved: 0. Reason: nothing durable here (chatter, questions, or instructions only).";
		const receiptId = await storeReceipt(env, userId, SOURCE, receipt, summary);
		return commandResult({ fired: false, processing: false, summary, receipt, receiptId, sourcePacket });
	}

	const now = Date.now();
	// The user's memory rules apply to PAGE CONTENT here (an excluded topic
	// must never appear on a notes page); graph enforcement stays in the
	// engine's gates, where each refusal is named on the receipt.
	const rules = await getMemoryRules(env, userId);
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
	const title = provisionalTitle(userLines, lastTs);
	const pageId = newId("page");

	const { receipt, summary, receiptId } = await storeStagedReceipt(env, userId, sourcePacket, {
		received,
		stagedFacts: durable.length,
		pageId,
		title,
		jobId: null,
	});
	await insertProvisionalPage(env, userId, { pageId, title, userLines, derivedLines, sourcePacket, receiptId, now });
	const jobId = await createMemoryJob(env, userId, {
		type: JOB_TYPE,
		status: "staged",
		idempotencyKey: sourcePacket?.idempotency_key ?? normalized.packet.idempotency_key,
		sourcePacketId: sourcePacket?.id ?? null,
		receiptId,
		payload: { pageId, title, ...project },
	});

	// 8.2 read-your-writes: every durable line is findable the moment this
	// receipt returns — not just the first one via the page's short_summary
	// (the gap the 0.3 trace measured on this exact lane).
	await stageMemoryText(env, userId, {
		jobId,
		sourcePacketId: sourcePacket?.id ?? null,
		lane: SOURCE_MODE,
		messages: durable.map((m) => ({ id: m.id, role: "user", content: m.content })),
		projectId: project.project_id,
		projectName: project.project_name,
	});

	// Durable enqueue on the user's DO — the alarm drives enrichment even if
	// this isolate dies the moment we return. The job entry carries everything
	// the background phase needs; assistant turns ride only as context.
	const job = {
		jobId,
		pageId,
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
		testOverrides: input.testOverrides ?? null,
	};
	const stub = env.USER_MEMORY.get(env.USER_MEMORY.idFromName(userId));
	await stub.enqueueMcpJob(userId, job);

	return commandResult({
		fired: true,
		processing: true,
		summary,
		receipt,
		receiptId,
		sourcePacket,
		extra: { page_id: pageId, title, staged_facts: durable.length, job_status: "staged", ...project },
	});
}

async function markEnrichmentFailed(env, userId, job, reason, defer = null) {
	const project = projectPayload(job.sourceMeta);
	try {
		await updateMemoryJob(env, userId, job.jobId, {
			status: "failed",
			error: String(reason ?? "unknown").slice(0, 400),
			payload: {
				pageId: job.pageId,
				title: job.title ?? null,
				reason: String(reason ?? "unknown").slice(0, 400),
				...project,
			},
			completedAt: Date.now(),
		});
		await env.DB.prepare(
			"UPDATE memory_pages SET enrich_status = 'failed', updated_at = ? WHERE id = ? AND user_id = ? AND project_id IS ? AND deleted_at IS NULL",
		).bind(Date.now(), job.pageId, userId, project.project_id).run();
		const receipt = emptyReceipt("enrich_failed", "background processing hit a problem — it has been reported", {
			source: SOURCE, source_mode: SOURCE_MODE, ...(job.sourceMeta ?? {}),
		});
		receipt.page_id = job.pageId;
		receipt.status = "failed";
		const summary = "This save could not finish processing. The staged page is kept, nothing was lost, and the problem has been reported automatically.";
		await storeReceipt(env, userId, SOURCE, receipt, summary);
	} catch (error) {
		console.warn("mcp enrich failure bookkeeping failed:", error?.message ?? error);
	}
	await reportServerError(env, "mcp_enrich", new Error(String(reason ?? "unknown")), userId);
	// A failed enrichment is terminal too: the staged page is what the user
	// has, and the job row says why. Staged text stops answering either way.
	await settleStagedText(env, userId, [job.jobId]);
	// Part 2.3: the job's terminal transition, announced exactly once.
	if (defer) {
		try {
			await emitWebhookEvent(env, defer, userId, "memory.failed", {
				job_id: job.jobId,
				source_packet_id: job.sourceMeta?.source_packet_id ?? null,
				status: "failed",
				error: String(reason ?? "unknown").slice(0, 200),
				...project,
			});
		} catch (error) {
			console.warn("memory.failed webhook failed:", error?.message ?? error);
		}
	}
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
		const rules = await getMemoryRules(env, userId);
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
		const result = await runExtraction(env, userId, job.userMessages ?? [], job.contextMessages ?? [], overrides);

		if (result.outcome === "llm_failed" || result.outcome === "db_write_failed") {
			const attempts = Number(job.attempts ?? 0);
			if (attempts < 2) return { retry: true, reason: result.outcome };
			await markEnrichmentFailed(env, userId, job, `${result.outcome} after ${attempts + 1} attempts`, defer);
			return { done: true, failed: true };
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

		// Announce like every other engine door: strictly after the fact,
		// strictly async, never able to fail the save.
		if (wroteSomething && receipt && defer) {
			try {
				const saved = receipt.saved ?? {};
				const added = (saved.nodes ?? 0) + (saved.slices ?? 0) + (saved.events ?? 0) + (saved.edges ?? 0) > 0;
				if (added) await emitWebhookEvent(env, defer, userId, "memory.added", webhookDataFromReceipt(receipt));
			} catch (error) {
				console.warn("mcp enrich webhook failed:", error?.message ?? error);
			}
		}
		// Part 2.3: the job's terminal transition, announced exactly once.
		if (defer) {
			try {
				await emitWebhookEvent(env, defer, userId, "memory.enriched", {
					job_id: job.jobId,
					source_packet_id: job.sourceMeta?.source_packet_id ?? null,
					status: "enriched",
					...project,
					counts: {
						nodes: receipt?.saved?.nodes ?? 0,
						edges: receipt?.saved?.edges ?? 0,
						slices: receipt?.saved?.slices ?? 0,
						events: receipt?.saved?.events ?? 0,
					},
				});
			} catch (error) {
				console.warn("memory.enriched webhook failed:", error?.message ?? error);
			}
		}
		return { done: true };
	} catch (error) {
		await markEnrichmentFailed(env, userId, job, error?.message ?? error, defer);
		return { done: true, failed: true };
	}
}
