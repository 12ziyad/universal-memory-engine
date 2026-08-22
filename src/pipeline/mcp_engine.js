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
import { managedMutationGuardStatement } from "../lib/managed_projects.js";
import { canonicalMemoryScope, normalizeProjectScope } from "../lib/project_scope.js";
import {
	activeJobDepth,
	claimMemoryJob,
	getActiveSuppressions,
	MEMORY_JOB_ACTIVE_LIMIT,
	storeReceipt,
	updateMemoryJob,
} from "../lib/db.js";
import {
	appendAdvanceSection,
	advanceHeading,
	CONVERSATION_ADVANCE_LIMIT,
	conversationKeyFrom,
	conversationMessageCount,
	conversationPagesMode,
	countConversationPageSources,
	isUniqueConstraintError,
	linkConversationPageSource,
	newConversationPageId,
	pageFollowJobKey,
	resolveConversationPage,
	stageConversationAdvance,
} from "./conversation_pages.js";
import { suppressedBy } from "./pages.js";
import { reportServerError } from "../lib/report.js";
import { resolveAdmissionRules } from "./admission.js";
import { narrowManagedMemoryRules, rulesAllowText } from "./rules.js";
import { planFromExtractionRun, runExtraction } from "./extract.js";
import { emptyReceipt, formatReceipt } from "./receipt.js";
import { messagesContainMemoryOptOut, storeOptOutReceipt } from "./opt_out.js";
import { scrubMessages } from "./scrub.js";
import { normalizeSourcePacket, sourceMeta, storeSourcePacket } from "./source.js";
import { classifyMessage } from "./trigger.js";
import { canonicalTitle, isBadTitle, titleCaseWords } from "./title.js";
import { emitWebhookEvent, webhookDataFromReceipt } from "./webhooks.js";
import { settleStagedText } from "./staged_text.js";
import { runAi, withFlushedAiMeter } from "../lib/ai_meter.js";
import { applyFencedUpdate, userAuthoredSummaryFence } from "../lib/memory_versions.js";
import { responseText, extractJson } from "./llm.js";

const SOURCE = "save_conversation";
const SOURCE_MODE = "mcp_save";
// REST /v1/save mode:"conversation" pages carry the door's own source mode so
// packet identity can never migrate between doors.
const REST_SOURCE_MODE = "conversation_collect";
const JOB_TYPE = "mcp_enrich";
const TERMINAL_JOB_STATES = new Set(["enriched", "failed", "completed"]);
// A failed extract is a verdict about one processing attempt, not the content
// (shared contract with the ingest lane's SRV-02 repair). Bounded identically.
const MAX_FAILED_REPLAY_REPAIRS = 5;

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
export async function reconcileTitle(env, config, { entityLabels = [], factLines = [], fallbackTs = Date.now(), titleResponse, userId = null }) {
	const fallbackEntity = entityLabels[0] ?? topEntityFromLines(factLines);
	const fallback = `${(fallbackEntity ?? "Conversation").slice(0, 60)} — ${dateLabel(fallbackTs)}`;
	let parsed = null;
	if (titleResponse !== undefined && titleResponse !== null) {
		parsed = typeof titleResponse === "string" ? extractJson(titleResponse) ?? { title: titleResponse } : titleResponse;
	} else {
		if (!env.AI || !factLines.length) return fallback;
		try {
			const res = await withFlushedAiMeter(env, "title", { userId }, () => runAi(
				env,
				config.llm.summaryModel,
				{
					messages: [
						{
							role: "system",
							content: "You title a personal conversation page. Given saved facts, reply with EXACTLY one JSON object {\"title\": \"...\"}: 3 to 7 plain words naming the main subject and what changed. No filler words like Notes, Memory, Summary, Session, Update. No trailing punctuation.",
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
				{ task: "mcp_title", capability: "generate_structured" },
			));
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
	pageAdvance = false,
	pageSkipReason = null,
	receiptId: existingReceiptId = null,
	sourceMode = SOURCE_MODE,
}) {
	const source = sourceMeta(sourcePacket);
	const receiptId = existingReceiptId ?? `receipt_mcp_stage_${jobId}`;
	const receipt = emptyReceipt("staged", "captured — extracting facts and relationships in the background", {
		source: SOURCE,
		source_mode: sourceMode,
		...sourceMeta(sourcePacket),
		received,
	});
	receipt.processing = true;
	receipt.final = false;
	receipt.status = "staged";
	receipt.staged_facts = stagedFacts;
	receipt.page_id = pageId;
	receipt.page_title = pageId ? title : null;
	receipt.page_advance = Boolean(pageId && pageAdvance);
	if (pageSkipReason) receipt.page_skipped = pageSkipReason;
	receipt.job_id = jobId;
	receipt.id = receiptId;
	const summary = !pageId
		? `Staged ✓ — ${stagedFacts} message(s) captured. Facts and relationships are being extracted now (~1 min); no Conversation Page is kept for this save (${pageSkipReason ?? "pages off"}).`
		: pageAdvance
			? `Staged ✓ "${title}" — ${stagedFacts} message(s) captured, advancing this conversation's page. This save is final only when the page shows enriched.`
			: `Staged ✓ "${title}" — ${stagedFacts} message(s) captured. Facts and relationships are being extracted now (~1 min); this save is final only when its page shows enriched.`;
	const saved = receipt.saved ?? {};
	const statement = env.DB.prepare(
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
	);
	if (source.managed_project_id) {
		await env.DB.batch([
			managedMutationGuardStatement(env, {
				accountUserId: source.account_user_id,
				projectId: source.managed_project_id,
			}),
			statement,
		]);
	} else {
		await statement.run();
	}
	const stored = await env.DB.prepare(
		"SELECT detail, summary FROM receipts WHERE id = ? AND user_id = ? LIMIT 1",
	).bind(receiptId, userId).first();
	if (!stored) throw new Error("MCP staged receipt could not be durably created");
	let persisted = receipt;
	try { persisted = JSON.parse(stored.detail ?? "null") ?? receipt; } catch {}
	return { receipt: persisted, summary: stored.summary ?? summary, receiptId };
}

async function insertProvisionalPage(env, userId, {
	pageId, title, userLines, derivedLines, sourcePacket, receiptId, now,
	conversationKey = null, sourceMode = SOURCE_MODE,
}) {
	const meta = sourceMeta(sourcePacket);
	const statement = env.DB.prepare(
		`INSERT INTO memory_pages
			(id, user_id, node_kind, source_mode, title, canonical_title, short_summary, full_markdown,
			 source_conversation_id, conversation_key, source_packet_id, input_hash, idempotency_key, scope_json, receipt_id,
			 created_at, updated_at, last_seen_at, heat_score, confidence, enrich_status, project_id, project_name)
		 VALUES (?, ?, 'memory_page', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0.6, 'staged', ?, ?)
		 ON CONFLICT(id) DO NOTHING`,
	).bind(
		pageId,
		userId,
		sourceMode,
		title,
		canonicalTitle(title),
		clampLine(userLines[0] ?? title, 200),
		stagedMarkdown(title, userLines, derivedLines),
		sourcePacket?.conversation_id ?? null,
		conversationKey,
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
	);
	if (meta.managed_project_id) {
		await env.DB.batch([
			managedMutationGuardStatement(env, {
				accountUserId: meta.account_user_id,
				projectId: meta.managed_project_id,
			}),
			statement,
		]);
	} else {
		await statement.run();
	}
	const stored = await env.DB.prepare(
		"SELECT id, user_id, source_packet_id, input_hash, conversation_key FROM memory_pages WHERE id = ? LIMIT 1",
	).bind(pageId).first();
	// A repair replay may find the page already advanced by a LATER batch of
	// the same conversation — same page identity, newer packet pointers. That
	// is convergence working, not an ownership inconsistency.
	const sameConversation = Boolean(conversationKey && stored?.conversation_key === conversationKey);
	if (
		!stored
		|| stored.user_id !== userId
		|| (!sameConversation && stored.source_packet_id !== sourcePacket?.id)
		|| (!sameConversation && stored.input_hash !== sourcePacket?.content_hash)
	) {
		throw new Error("MCP provisional page ownership is inconsistent");
	}
	return stored;
}

async function stageMcpMemoryTextOnce(env, userId, {
	accountUserId = null,
	managedProjectId = null,
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
		const statements = rows.map((message, index) => env.DB.prepare(
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
		));
		if (managedProjectId) statements.unshift(managedMutationGuardStatement(env, {
			accountUserId,
			projectId: managedProjectId,
		}));
		await env.DB.batch(statements);
		return { staged: rows.length };
	} catch (error) {
		if (/fence_guard|violation IS NULL/i.test(String(error?.message ?? error))) throw error;
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
		`SELECT id, status, type, attempts, payload_json, receipt_id, source_packet_id
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
 * Deterministic Conversation Page identity for one explicit batch, resolved
 * before the job claim so repairs and replays pin the same page.
 *
 * Returns { page, conversationKey, skipReason }:
 *   - page set        → this batch ADVANCES an existing live page
 *   - page null + key → this batch CREATES the page owning the key
 *   - skipReason set  → no page is written for this batch (rule off,
 *     suppressed conversation, archived page, or advance limit); graph
 *     extraction still runs and the receipt says why.
 *
 * Everything here is gated on CONVERSATION_PAGES="on" — in "track" the lane
 * behaves exactly as before (one page per accepted batch, no identity).
 */
async function resolveConversationPageIdentity(env, userId, { rules, conversationId, threadId, projectId = null }) {
	if (conversationPagesMode(env) !== "on") return { page: null, conversationKey: null, skipReason: null };
	if (rules?.captureDefault === "graph_only") {
		return { page: null, conversationKey: null, skipReason: "pages_off_by_rule" };
	}
	const conversationKey = conversationKeyFrom({ conversationId, threadId });
	if (!conversationKey) return { page: null, conversationKey: null, skipReason: null };
	const suppressions = await getActiveSuppressions(env, userId, { projectId });
	if (suppressedBy(suppressions, "conversation_page", conversationKey)) {
		return { page: null, conversationKey, skipReason: "conversation_page_suppressed" };
	}
	const page = await resolveConversationPage(env, userId, { projectId, conversationKey });
	if (page && (page.archived_at || page.suppressed_at)) {
		return {
			page: null,
			conversationKey,
			skipReason: page.archived_at ? "conversation_page_archived" : "conversation_page_suppressed",
		};
	}
	if (page) {
		const links = await countConversationPageSources(env, userId, page.id);
		if (links >= CONVERSATION_ADVANCE_LIMIT) {
			return { page: null, conversationKey, skipReason: "conversation_page_advance_limit" };
		}
	}
	return { page, conversationKey, skipReason: null };
}

/**
 * Mark an existing Conversation Page as processing a new advance, retrying a
 * lost revision CAS against a fresh read. Never reports success it did not
 * have: a page that vanished, got archived, or keeps moving returns
 * applied:false with the reason, and the caller downgrades to a pageless
 * save instead of forking or lying.
 */
async function advanceStagingWithRetry(env, userId, { pageId, sourcePacket, projectId = null }) {
	for (let attempt = 0; attempt < 4; attempt++) {
		const fresh = await env.DB.prepare(
			`SELECT id, revision, archived_at, suppressed_at FROM memory_pages
			 WHERE id = ? AND user_id = ? AND project_id IS ? AND deleted_at IS NULL LIMIT 1`,
		).bind(pageId, userId, projectId).first();
		if (!fresh) return { applied: false, reason: "conversation_page_deleted" };
		if (fresh.archived_at || fresh.suppressed_at) {
			return { applied: false, reason: fresh.archived_at ? "conversation_page_archived" : "conversation_page_suppressed" };
		}
		const staged = await stageConversationAdvance(env, userId, { page: fresh, sourcePacket, projectId });
		if (staged.applied) return { applied: true };
	}
	return { applied: false, reason: "conversation_page_contended" };
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
	const rules = await resolveAdmissionRules(env, userId, input.rules);
	const admittedMessages = scrubbed.messages.filter((message) => rulesAllowText(rules, message?.content));
	const receivedBeforeRules = userMessagesOf(scrubbed.messages).length;
	const admittedUserMessages = userMessagesOf(admittedMessages).length;
	if (receivedBeforeRules > 0 && admittedUserMessages === 0) {
		const receipt = emptyReceipt("excluded_by_rule", "project memory policy excluded this content", {
			source: SOURCE, source_mode: SOURCE_MODE, ...requestedProject, received: receivedBeforeRules,
		});
		receipt.skipped = receivedBeforeRules;
		return commandResult({
			fired: false,
			processing: false,
			summary: "Saved: 0. Reason: excluded by the project's memory policy.",
			receipt,
			receiptId: null,
		});
	}

	const normalized = await normalizeSourcePacket(userId, {
		type: "message_batch",
		sourceMode: SOURCE_MODE,
		messages: admittedMessages,
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
		const receiptId = await storeReceipt(env, userId, SOURCE, receipt, summary, {
			accountUserId: requestedScope.accountUserId ?? requestedScope.account_user_id ?? null,
			managedProjectId: requestedScope.managedProjectId ?? requestedScope.managed_project_id ?? null,
		});
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

	// Terminal SUCCESS is a pure replay. Active work continues through the
	// repair path below: its D1 claim may exist while its receipt/page/DO
	// enqueue does not, depending on where the first isolate stopped.
	if (existing?.job.source_packet_id && existing.job.source_packet_id !== sourcePacket?.id) {
		return idempotencyConflictResult(normalized, existing.job.source_packet_id);
	}
	let repairedReplay = false;
	if (existing?.job.status === "failed") {
		// SRV-05, the lane mirror of SRV-02: MCP keys default to content
		// derivation, so a caller re-sending the same conversation cannot mint
		// a fresh key — the replay IS the user explicitly asking again. Repair
		// the SAME job row (bounded) or refuse honestly; never answer
		// "Already saved" over dead work.
		const repairGeneration = Number(existing.payload?.repair_generation ?? 0);
		if (repairGeneration >= MAX_FAILED_REPLAY_REPAIRS || Number(existing.job.attempts ?? 0) >= MAX_FAILED_REPLAY_REPAIRS) {
			const summary = "Extraction for this exact conversation failed permanently after its bounded repair attempts. Review the job error, rephrase or split the conversation, or contact support.";
			const receipt = emptyReceipt("extraction_failed_terminal", summary, {
				source: SOURCE, source_mode: SOURCE_MODE, ...sourceMeta(sourcePacket), received,
			});
			receipt.duplicate = false;
			receipt.final = true;
			receipt.status = "failed";
			return commandResult({
				ok: false,
				error: "extraction_failed_terminal",
				httpStatus: 422,
				fired: false,
				processing: false,
				summary,
				receipt,
				receiptId: existing.job.receipt_id ?? null,
				sourcePacket,
				extra: { job_id: existing.job.id, job_status: "failed", retryable: false },
			});
		}
		// Compare-and-set so concurrent replays perform one reset; losers see a
		// non-terminal job and take the normal recovery path below. The bumped
		// repair generation gives the re-run FRESH extraction run identity —
		// the run ledger's idempotency would otherwise replay the recorded
		// failed outcomes without ever calling the model again.
		const repairedPayload = { ...(existing.payload ?? {}), repair_generation: repairGeneration + 1 };
		await env.DB.prepare(
			"UPDATE memory_jobs SET status = 'staged', error = NULL, completed_at = NULL, run_after = ?, updated_at = ?, payload_json = ? WHERE id = ? AND user_id = ? AND status = 'failed'",
		).bind(Date.now(), Date.now(), JSON.stringify(repairedPayload), existing.job.id, userId).run();
		existing.job.status = "staged";
		existing.payload = repairedPayload;
		repairedReplay = true;
	} else if (existing && TERMINAL_JOB_STATES.has(existing.job.status)) {
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
		const receiptId = await storeReceipt(env, userId, SOURCE, receipt, summary, {
			accountUserId: requestedScope.accountUserId ?? requestedScope.account_user_id ?? null,
			managedProjectId: requestedScope.managedProjectId ?? requestedScope.managed_project_id ?? null,
		});
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
	// must never appear on a Conversation Page); graph enforcement stays in
	// the engine's gates, where each refusal is named on the receipt.
	// The MCP door only ever serves the key owner's root identity (handleMcp),
	// so a self-load here IS the account's rules — the admission boundary makes
	// that explicit.
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

	// Conversation Pages: deterministic identity on the explicit doors.
	// "graph_only" is the user saying "never build pages" — it now means
	// exactly that: graph extraction runs, no Conversation Page is written.
	const identity = await resolveConversationPageIdentity(env, userId, {
		rules,
		conversationId: input.conversationId,
		threadId: input.threadId,
		projectId: project.project_id,
	});
	const pageless = Boolean(identity.skipReason);
	const advance = Boolean(identity.page);

	const proposedTitle = advance ? identity.page.title : provisionalTitle(userLines, lastTs);
	const proposedPageId = pageless ? null : (advance ? identity.page.id : newConversationPageId());
	const proposedJobId = newId("job");
	const proposedReceiptId = `receipt_mcp_stage_${proposedJobId}`;
	let jobClaim = existing
		? { claimed: false, id: existing.job.id, job: existing.job }
		: await claimMemoryJob(env, userId, {
			accountUserId: sourceMeta(sourcePacket).account_user_id,
			managedProjectId: sourceMeta(sourcePacket).managed_project_id,
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
				conversationKey: identity.conversationKey,
				pageAdvance: advance,
				pageless,
				pageSkipReason: identity.skipReason,
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
			conversationKey: identity.conversationKey,
			pageAdvance: advance,
			pageless,
			pageSkipReason: identity.skipReason,
			...project,
		}
		: existing?.payload ?? {};
	if (ownerPayload.sourceContentHash && ownerPayload.sourceContentHash !== sourcePacket?.content_hash) {
		return idempotencyConflictResult(normalized, sourcePacket?.id ?? null);
	}
	let pageId = ownerPayload.pageless ? null : ownerPayload.pageId;
	let pageAdvance = Boolean(ownerPayload.pageAdvance);
	const title = ownerPayload.title;
	if (!ownerPayload.pageless && (!pageId || !title)) {
		throw new Error("MCP memory job is missing its repair metadata");
	}
	maybeInjectMcpFault(env, input, "after_job_claim");

	const { receipt, summary, receiptId } = await storeStagedReceipt(env, userId, sourcePacket, {
		received,
		stagedFacts: durable.length,
		pageId,
		title,
		jobId,
		pageAdvance,
		pageSkipReason: ownerPayload.pageless ? (ownerPayload.pageSkipReason ?? "pages_off_by_rule") : null,
		receiptId: existing?.job.receipt_id ?? ownerPayload.stagedReceiptId ?? `receipt_mcp_stage_${jobId}`,
	});
	if (pageId && pageAdvance) {
		const staged = await advanceStagingWithRetry(env, userId, {
			pageId,
			sourcePacket,
			projectId: project.project_id,
		});
		if (!staged.applied) {
			// The page vanished or kept moving under this save. The memories
			// still land; the page half is skipped and the job says so.
			pageId = null;
			pageAdvance = false;
			await updateMemoryJob(env, userId, jobId, {
				payload: { ...ownerPayload, pageId: null, pageAdvance: false, pageless: true, pageSkipReason: staged.reason ?? "conversation_page_moved" },
			});
		}
	} else if (pageId) {
		try {
			await insertProvisionalPage(env, userId, {
				pageId,
				title,
				userLines,
				derivedLines,
				sourcePacket,
				receiptId,
				now,
				conversationKey: ownerPayload.conversationKey ?? null,
			});
		} catch (error) {
			if (!isUniqueConstraintError(error)) throw error;
			// Concurrent create for the same conversation: the unique identity
			// index chose a winner. Advance the winner instead of duplicating.
			const winner = ownerPayload.conversationKey
				? await resolveConversationPage(env, userId, {
					projectId: project.project_id,
					conversationKey: ownerPayload.conversationKey,
				})
				: null;
			if (winner && !winner.archived_at && !winner.suppressed_at) {
				pageId = winner.id;
				pageAdvance = true;
				await updateMemoryJob(env, userId, jobId, {
					payload: { ...ownerPayload, pageId, pageAdvance: true },
				});
				await advanceStagingWithRetry(env, userId, {
					pageId,
					sourcePacket,
					projectId: project.project_id,
				});
			} else {
				pageId = null;
				pageAdvance = false;
				await updateMemoryJob(env, userId, jobId, {
					payload: { ...ownerPayload, pageId: null, pageAdvance: false, pageless: true, pageSkipReason: "conversation_page_unavailable" },
				});
			}
		}
	}
	if (pageId && sourcePacket?.id) {
		await linkConversationPageSource(env, userId, { pageId, sourcePacketId: sourcePacket.id });
	}
	if (receiptId) await updateMemoryJob(env, userId, jobId, { receiptId });

	// 8.2 read-your-writes: every durable line is findable the moment this
	// receipt returns — not just the first one via the page's short_summary
	// (the gap the 0.3 trace measured on this exact lane).
	await stageMcpMemoryTextOnce(env, userId, {
		accountUserId: sourceMeta(sourcePacket).account_user_id,
		managedProjectId: sourceMeta(sourcePacket).managed_project_id,
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
		pageAdvance,
		conversationKey: ownerPayload.conversationKey ?? null,
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
		repairGeneration: Number(ownerPayload.repair_generation ?? 0),
		managedPolicy: input.managedPolicy === true,
		credentialRules: input.managedPolicy === true ? (input.credentialRules ?? null) : null,
		projectCategories: input.managedPolicy === true && Array.isArray(input.projectCategories)
			? input.projectCategories
			: [],
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
		const owner = await findExistingJob(env, userId, normalized.packet.idempotency_key);
		if (!owner) throw new Error("MCP repair completed without a readable job");
		if (repairedReplay) {
			// A repair is a fresh promise, not a duplicate: the earlier attempt
			// FAILED, and this replay re-staged the same job for enrichment.
			// "Already saved" wording here would be the SRV-05 defect again.
			const repairSummary = "Retrying this save - the earlier processing attempt failed, so it was re-staged and is being enriched in the background.";
			const repairReceipt = emptyReceipt("staged", "re-staged after a failed processing attempt", {
				source: SOURCE, source_mode: SOURCE_MODE, ...sourceMeta(sourcePacket), received,
			});
			repairReceipt.page_id = owner.payload?.pageId ?? null;
			repairReceipt.status = owner.job.status;
			repairReceipt.processing = true;
			return commandResult({
				fired: true,
				processing: true,
				summary: repairSummary,
				receipt: repairReceipt,
				receiptId: owner.job.receipt_id ?? null,
				sourcePacket,
				extra: { page_id: owner.payload?.pageId ?? null, job_id: owner.job.id, job_status: owner.job.status, repaired: true },
			});
		}
		return duplicateMcpResult(env, userId, normalized, sourcePacket, owner);
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

/**
 * Finalize one ADVANCE of an existing Conversation Page: append this batch's
 * facts as a bounded "## Update — date" section, fenced so it can never
 * rewrite a user's own wording (the advance then keeps their text and says
 * so) and CAS-retried against genuine contention. A page deleted while the
 * advance processed stays deleted — the memories stand on their own.
 */
async function finalizeConversationAdvance(env, userId, job, { project, factLines, edgeLines, derivedLines, receipt }) {
	for (let attempt = 0; attempt < 3; attempt++) {
		const fresh = await env.DB.prepare(
			`SELECT id, title, full_markdown, revision, deleted_at FROM memory_pages
			 WHERE id = ? AND user_id = ? AND project_id IS ? LIMIT 1`,
		).bind(job.pageId, userId, project.project_id).first();
		if (!fresh || fresh.deleted_at) return { done: true, pageDeleted: true };
		const expected = Number(fresh.revision) >= 1 ? Number(fresh.revision) : 1;
		const sectionLines = [advanceHeading(dateLabel(job.lastTs ?? Date.now()))];
		if (factLines.length) sectionLines.push("", ...factLines.map((line) => `- ${line}`));
		if (edgeLines.length) sectionLines.push("", "### Relationships", ...edgeLines.map((line) => `- ${line}`));
		if (derivedLines.length) {
			sectionLines.push("", "### Conversation notes (assistant, derived)", ...derivedLines.map((line) => `- ${clampLine(line)}`));
		}
		const { markdown } = appendAdvanceSection(fresh.full_markdown, sectionLines.join("\n"));
		const messageCount = await conversationMessageCount(env, userId, job.pageId);
		const fence = userAuthoredSummaryFence("memory_pages", { column: "full_markdown", kind: "page" });
		const write = await applyFencedUpdate(env.DB.prepare(
			`UPDATE memory_pages SET
				full_markdown = ?, enrich_status = 'enriched',
				extraction_run_id = ?, receipt_id = COALESCE(?, receipt_id),
				message_count = ?,
				updated_at = ?, last_seen_at = ?, revision = COALESCE(revision, 1) + 1
			 WHERE id = ? AND user_id = ? AND project_id IS ? AND deleted_at IS NULL
			   AND COALESCE(revision, 1) = ?
			   ${fence.sql}`,
		).bind(
			markdown,
			receipt?.extraction_run_id ?? null,
			receipt?.id ?? null,
			messageCount,
			Date.now(),
			Date.now(),
			job.pageId,
			userId,
			project.project_id,
			expected,
		), { label: "conversation page advance finalize" });
		if (write.applied) return { done: true };
		const after = await env.DB.prepare(
			"SELECT revision, deleted_at FROM memory_pages WHERE id = ? AND user_id = ? AND project_id IS ? LIMIT 1",
		).bind(job.pageId, userId, project.project_id).first().catch(() => null);
		if (!after || after.deleted_at) return { done: true, pageDeleted: true };
		if (Number(after.revision ?? 1) === expected) {
			// Unchanged revision + no write: the user-authored fence held. The
			// stored markdown is the user's wording — record the advance's state
			// without touching their text.
			const statusOnly = await applyFencedUpdate(env.DB.prepare(
				`UPDATE memory_pages SET enrich_status = 'enriched',
					extraction_run_id = ?, receipt_id = COALESCE(?, receipt_id),
					updated_at = ?, last_seen_at = ?, revision = COALESCE(revision, 1) + 1
				 WHERE id = ? AND user_id = ? AND project_id IS ? AND deleted_at IS NULL
				   AND COALESCE(revision, 1) = ?`,
			).bind(
				receipt?.extraction_run_id ?? null,
				receipt?.id ?? null,
				Date.now(),
				Date.now(),
				job.pageId,
				userId,
				project.project_id,
				expected,
			), { label: "conversation page advance state" });
			if (statusOnly.applied) return { done: true, keptUserText: true };
		}
		// Revision moved under us: genuine contention — loop re-reads.
	}
	return { retry: true, reason: "conversation page contended during advance finalize" };
}

/**
 * Finalize a freshly CREATED page from durable extraction manifests (the
 * REST follower path): replace the provisional body, fenced against user
 * authorship and revision movement.
 */
async function finalizeConversationCreate(env, config, userId, job, { project, factLines, edgeLines, entityLabels, runId, receiptId }) {
	const title = await reconcileTitle(env, config, {
		entityLabels,
		factLines: [...factLines, ...edgeLines],
		fallbackTs: job.lastTs ?? Date.now(),
		titleResponse: job.testOverrides?.titleResponse,
		userId,
	});
	const markdown = enrichedMarkdown(title, {
		factLines,
		edgeLines,
		derivedLines: [],
		savedAt: job.lastTs ?? Date.now(),
	});
	for (let attempt = 0; attempt < 3; attempt++) {
		const fresh = await env.DB.prepare(
			"SELECT revision, deleted_at FROM memory_pages WHERE id = ? AND user_id = ? AND project_id IS ? LIMIT 1",
		).bind(job.pageId, userId, project.project_id).first();
		if (!fresh || fresh.deleted_at) return { done: true, pageDeleted: true };
		const expected = Number(fresh.revision) >= 1 ? Number(fresh.revision) : 1;
		const messageCount = await conversationMessageCount(env, userId, job.pageId);
		const markdownFence = userAuthoredSummaryFence("memory_pages", { column: "full_markdown", kind: "page" });
		const titleFence = userAuthoredSummaryFence("memory_pages", { column: "title", kind: "page" });
		const write = await applyFencedUpdate(env.DB.prepare(
			`UPDATE memory_pages SET
				title = ?, canonical_title = ?, short_summary = ?, full_markdown = ?,
				enrich_status = 'enriched', extraction_run_id = ?, receipt_id = COALESCE(?, receipt_id),
				message_count = ?,
				updated_at = ?, last_seen_at = ?, revision = COALESCE(revision, 1) + 1
			 WHERE id = ? AND user_id = ? AND project_id IS ? AND deleted_at IS NULL
			   AND COALESCE(revision, 1) = ?
			   ${markdownFence.sql}
			   ${titleFence.sql}`,
		).bind(
			title,
			canonicalTitle(title),
			clampLine(factLines[0] ?? title, 200),
			markdown,
			runId ?? null,
			receiptId ?? null,
			messageCount,
			Date.now(),
			Date.now(),
			job.pageId,
			userId,
			project.project_id,
			expected,
		), { label: "conversation page create finalize" });
		if (write.applied) return { done: true, title };
		const after = await env.DB.prepare(
			"SELECT revision, deleted_at FROM memory_pages WHERE id = ? AND user_id = ? AND project_id IS ? LIMIT 1",
		).bind(job.pageId, userId, project.project_id).first().catch(() => null);
		if (!after || after.deleted_at) return { done: true, pageDeleted: true };
		if (Number(after.revision ?? 1) === expected) {
			const statusOnly = await applyFencedUpdate(env.DB.prepare(
				`UPDATE memory_pages SET enrich_status = 'enriched',
					extraction_run_id = ?, receipt_id = COALESCE(?, receipt_id),
					updated_at = ?, last_seen_at = ?, revision = COALESCE(revision, 1) + 1
				 WHERE id = ? AND user_id = ? AND project_id IS ? AND deleted_at IS NULL
				   AND COALESCE(revision, 1) = ?`,
			).bind(runId ?? null, receiptId ?? null, Date.now(), Date.now(), job.pageId, userId, project.project_id, expected), { label: "conversation page create state" });
			if (statusOnly.applied) return { done: true, keptUserText: true };
		}
	}
	return { retry: true, reason: "conversation page contended during create finalize" };
}

function pageFollowPayload(job, project, extra = {}) {
	return {
		lane: "page_follow",
		pageId: job.pageId ?? null,
		pageAdvance: Boolean(job.pageAdvance),
		conversationKey: job.conversationKey ?? null,
		sourcePacketId: job.sourcePacketId ?? null,
		...project,
		...extra,
	};
}

const ACTIVE_JOB_STATES = new Set(["awaiting_source", "queued", "staged", "processing"]);

/**
 * REST-lane page follower: waits for the ingest lane's durable extraction
 * verdict for this batch's packet, then finalizes the staged Conversation
 * Page from the run's manifests. Never re-runs extraction, never charges the
 * model again, and treats "extraction still running" as patient waiting, not
 * failure.
 */
async function followConversationPage(env, userId, job, defer = null) {
	const config = getConfig(env);
	const project = projectPayload(job.sourceMeta);
	const deadline = Number(job.deadlineAt ?? 0) || (Date.now() + 15 * 60_000);
	const extract = await env.DB.prepare(
		`SELECT id, status FROM memory_jobs
		 WHERE user_id = ? AND source_packet_id = ? AND type != ?
		 ORDER BY created_at LIMIT 1`,
	).bind(userId, job.sourcePacketId, JOB_TYPE).first();

	if (!extract || ACTIVE_JOB_STATES.has(extract.status)) {
		if (Date.now() > deadline) {
			try {
				await markMcpEnrichmentFailed(env, userId, job, "the batch's extraction did not settle in time; the Conversation Page update was abandoned", defer);
				return { done: true, failed: true };
			} catch (error) {
				return { retry: true, terminalPending: true, reason: "page follow deadline", error: String(error?.message ?? error) };
			}
		}
		// Waiting, not failing: a bounded sleep instead of a 250ms re-poll for
		// the whole extraction. The deadline above is what ends the wait.
		return {
			retry: true,
			inProgress: true,
			retryAfterMs: 3_000,
			reason: "waiting for the batch's extraction verdict",
		};
	}

	if (extract.status === "failed" || /cancel/i.test(String(extract.status))) {
		if (job.pageAdvance && job.pageId) {
			// The advance's batch failed; the page's prior enriched content
			// stands. Restore its state and record the failed advance on the job.
			await env.DB.prepare(
				`UPDATE memory_pages SET enrich_status = 'enriched', updated_at = ?
				 WHERE id = ? AND user_id = ? AND project_id IS ? AND deleted_at IS NULL AND enrich_status = 'staged'`,
			).bind(Date.now(), job.pageId, userId, project.project_id).run();
			await updateMemoryJob(env, userId, job.jobId, {
				status: "enriched",
				payload: pageFollowPayload(job, project, { page_advance_failed_extraction: extract.status }),
				completedAt: Date.now(),
			});
			return { done: true };
		}
		try {
			await markMcpEnrichmentFailed(env, userId, job, `the batch's extraction ended ${extract.status}; the staged Conversation Page was marked failed`, defer);
			return { done: true, failed: true };
		} catch (error) {
			return { retry: true, terminalPending: true, reason: "page follow failure bookkeeping", error: String(error?.message ?? error) };
		}
	}

	// Terminal success: rebuild the outcome from the durable run manifest —
	// exactly what the engine kept, no model reruns.
	const run = await env.DB.prepare(
		"SELECT * FROM extraction_runs WHERE user_id = ? AND source_packet_id = ? ORDER BY created_at DESC LIMIT 1",
	).bind(userId, job.sourcePacketId).first();
	const plan = run ? planFromExtractionRun(run) : {};
	const factLines = factLinesFromPlan(plan);
	const edgeLines = edgeLinesFromPlan(plan);
	const runReceipt = { extraction_run_id: run?.id ?? null, id: run?.receipt_id ?? null };

	if (!factLines.length && !edgeLines.length) {
		if (job.pageId && !job.pageAdvance) {
			await env.DB.prepare(
				"UPDATE memory_pages SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND project_id IS ?",
			).bind(Date.now(), Date.now(), job.pageId, userId, project.project_id).run();
		} else if (job.pageId && job.pageAdvance) {
			await env.DB.prepare(
				`UPDATE memory_pages SET enrich_status = 'enriched', updated_at = ?
				 WHERE id = ? AND user_id = ? AND project_id IS ? AND deleted_at IS NULL AND enrich_status = 'staged'`,
			).bind(Date.now(), job.pageId, userId, project.project_id).run();
		}
		await updateMemoryJob(env, userId, job.jobId, {
			status: "enriched",
			payload: pageFollowPayload(job, project, job.pageAdvance ? { page_advance_empty: true } : { page_deleted: true }),
			completedAt: Date.now(),
		});
		return { done: true };
	}

	const outcome = job.pageAdvance
		? await finalizeConversationAdvance(env, userId, job, {
			project,
			factLines,
			edgeLines,
			derivedLines: [],
			receipt: runReceipt,
		})
		: await finalizeConversationCreate(env, config, userId, job, {
			project,
			factLines,
			edgeLines,
			entityLabels: [...new Set((plan.newNodes ?? []).map((n) => n?.label).filter(Boolean))],
			runId: run?.id ?? null,
			receiptId: run?.receipt_id ?? null,
		});
	if (outcome.retry) return outcome;
	await updateMemoryJob(env, userId, job.jobId, {
		status: "enriched",
		payload: pageFollowPayload(job, project, {
			...(outcome.title ? { title: outcome.title } : {}),
			...(outcome.keptUserText ? { page_text_kept_user_authored: true } : {}),
			...(outcome.pageDeleted ? { page_deleted_during_processing: true } : {}),
		}),
		completedAt: Date.now(),
	});
	return { done: true };
}

/**
 * REST door hook (Campaign A): after /v1/save mode:"conversation" has been
 * ACCEPTED by the ingest engine, create or advance this conversation's page
 * and enqueue a follower that finalizes it from the extraction verdict. The
 * accepted save never fails because of the page half — a page problem is
 * reported on the response and the job row instead.
 */
export async function stageRestConversationPage(env, ctx, doorUserId, input = {}, saveResult = {}) {
	if (conversationPagesMode(env) !== "on") return null;
	const sourcePacket = saveResult?.sourcePacket;
	if (!sourcePacket?.id) return null;
	if (saveResult.idempotencyConflict || saveResult.cancelled || saveResult.backpressure) return null;
	// Pages live in the packet's memory space: for scoped writes the resolved
	// memory user (the packet's owner), not the authenticating account.
	const userId = sourcePacket.user_id ?? doorUserId;
	const projectScope = normalizeProjectScope(sourceMeta(sourcePacket));
	const projectId = projectScope.projectId;

	if (saveResult.duplicate) {
		// A terminal replay: the original acceptance owns the page work.
		const conversationKey = conversationKeyFrom({ conversationId: input.conversationId, threadId: input.threadId });
		if (!conversationKey) return null;
		const page = await resolveConversationPage(env, userId, { projectId, conversationKey });
		return page
			? { id: page.id, status: page.enrich_status ?? "enriched", advance: false, replayed: true }
			: null;
	}

	// Rules belong to the authenticating ACCOUNT (SRV-04): prefer the door's
	// resolved rules object; self-load only under the door identity.
	const rules = input.overrides?.rules ?? await resolveAdmissionRules(env, doorUserId);
	const identity = await resolveConversationPageIdentity(env, userId, {
		rules,
		conversationId: input.conversationId,
		threadId: input.threadId,
		projectId,
	});
	if (identity.skipReason) return { skipped: identity.skipReason };

	const scrubbed = scrubMessages(Array.isArray(input.messages) ? input.messages : []).messages;
	const durable = durableUserMessages(scrubbed).filter((m) => rulesAllowText(rules, m.content));
	if (!durable.length) return { skipped: "nothing_durable" };
	const userLines = durable.map((m) => m.content);
	const lastTs = scrubbed.reduce((max, m) => (Number(m.ts) > max ? Number(m.ts) : max), 0) || Date.now();

	let pageAdvance = Boolean(identity.page);
	let pageId = pageAdvance ? identity.page.id : newConversationPageId();
	const title = pageAdvance ? identity.page.title : provisionalTitle(userLines, lastTs);
	const now = Date.now();
	const basePayload = {
		lane: "page_follow",
		pageId,
		title,
		pageAdvance,
		conversationKey: identity.conversationKey,
		sourcePacketId: sourcePacket.id,
		sourceContentHash: sourcePacket.content_hash ?? null,
		deadlineAt: now + 15 * 60_000,
		project_id: projectScope.projectId,
		project_name: projectScope.projectName,
	};
	const claim = await claimMemoryJob(env, userId, {
		accountUserId: sourceMeta(sourcePacket).account_user_id,
		managedProjectId: sourceMeta(sourcePacket).managed_project_id,
		id: newId("job"),
		type: JOB_TYPE,
		status: "staged",
		idempotencyKey: pageFollowJobKey(sourcePacket.id),
		sourcePacketId: sourcePacket.id,
		payload: basePayload,
	});
	if (claim.capacityExceeded) return { skipped: "queue_full" };
	if (!claim.claimed) {
		const owner = await findExistingJob(env, userId, pageFollowJobKey(sourcePacket.id));
		return owner?.payload?.pageId
			? { id: owner.payload.pageId, status: owner.page?.enrich_status ?? "staged", advance: Boolean(owner.payload.pageAdvance), replayed: true }
			: null;
	}
	const jobId = claim.id;

	if (pageAdvance) {
		const staged = await advanceStagingWithRetry(env, userId, { pageId, sourcePacket, projectId });
		if (!staged.applied) {
			await updateMemoryJob(env, userId, jobId, {
				status: "enriched",
				payload: { ...basePayload, pageId: null, pageAdvance: false, pageless: true, pageSkipReason: staged.reason },
				completedAt: Date.now(),
			});
			return { skipped: staged.reason };
		}
	} else {
		try {
			await insertProvisionalPage(env, userId, {
				pageId,
				title,
				userLines,
				derivedLines: [],
				sourcePacket,
				receiptId: saveResult.receipt_id ?? saveResult.receipt?.id ?? null,
				now,
				conversationKey: identity.conversationKey,
				sourceMode: REST_SOURCE_MODE,
			});
		} catch (error) {
			if (!isUniqueConstraintError(error)) throw error;
			const winner = identity.conversationKey
				? await resolveConversationPage(env, userId, { projectId, conversationKey: identity.conversationKey })
				: null;
			if (winner && !winner.archived_at && !winner.suppressed_at) {
				pageId = winner.id;
				pageAdvance = true;
				await updateMemoryJob(env, userId, jobId, {
					payload: { ...basePayload, pageId, pageAdvance: true, title: winner.title },
				});
				await advanceStagingWithRetry(env, userId, { pageId, sourcePacket, projectId });
			} else {
				await updateMemoryJob(env, userId, jobId, {
					status: "enriched",
					payload: { ...basePayload, pageId: null, pageAdvance: false, pageless: true, pageSkipReason: "conversation_page_unavailable" },
					completedAt: Date.now(),
				});
				return { skipped: "conversation_page_unavailable" };
			}
		}
	}
	await linkConversationPageSource(env, userId, { pageId, sourcePacketId: sourcePacket.id });

	const testOverrides = {};
	if (input.overrides?.titleResponse !== undefined) testOverrides.titleResponse = input.overrides.titleResponse;
	const doJob = {
		jobId,
		lane: "page_follow",
		pageId,
		pageAdvance,
		conversationKey: identity.conversationKey,
		title,
		sourcePacketId: sourcePacket.id,
		deadlineAt: now + 15 * 60_000,
		lastTs,
		sourceMeta: { ...sourceMeta(sourcePacket) },
		testOverrides: Object.keys(testOverrides).length ? testOverrides : null,
	};
	const stub = env.USER_MEMORY.get(env.USER_MEMORY.idFromName(userId));
	await stub.enqueueMcpJobOnce(userId, doJob, {
		handoffId: jobId,
		contentHash: sourcePacket.content_hash,
	});
	return { id: pageId, status: "staged", advance: pageAdvance };
}

/**
 * Rebuild one Conversation Page's derived body from its SURVIVING linked
 * sources' durable run manifests (source-scoped deletion). Deletion outranks
 * the user-authored fence here: stored wording may quote the deleted source,
 * so the body is replaced, and the caller erases the page's revision history
 * for the same reason. Returns { rebuilt } or a reason the caller acts on
 * ("no_sources" / "no_surviving_content" → the page has no independent
 * support left and should be deleted outright).
 */
export async function rebuildConversationPageFromSources(env, userId, pageId) {
	const page = await env.DB.prepare(
		"SELECT id, title, project_id FROM memory_pages WHERE id = ? AND user_id = ? AND deleted_at IS NULL LIMIT 1",
	).bind(pageId, userId).first();
	if (!page) return { rebuilt: false, reason: "gone" };
	const { results: links } = await env.DB.prepare(
		"SELECT source_packet_id FROM conversation_page_sources WHERE user_id = ? AND page_id = ? ORDER BY seq",
	).bind(userId, pageId).all();
	if (!links?.length) return { rebuilt: false, reason: "no_sources" };
	const sections = [];
	let firstFact = null;
	for (const link of links) {
		const run = await env.DB.prepare(
			"SELECT * FROM extraction_runs WHERE user_id = ? AND source_packet_id = ? ORDER BY created_at DESC LIMIT 1",
		).bind(userId, link.source_packet_id).first();
		const plan = run ? planFromExtractionRun(run) : {};
		const factLines = factLinesFromPlan(plan);
		const edgeLines = edgeLinesFromPlan(plan);
		if (!factLines.length && !edgeLines.length) continue;
		if (firstFact === null) firstFact = factLines[0] ?? null;
		if (sections.length === 0) {
			sections.push(enrichedMarkdown(page.title, {
				factLines,
				edgeLines,
				derivedLines: [],
				savedAt: run?.created_at ?? Date.now(),
			}));
		} else {
			const lines = [advanceHeading(dateLabel(run?.created_at ?? Date.now()))];
			if (factLines.length) lines.push("", ...factLines.map((line) => `- ${line}`));
			if (edgeLines.length) lines.push("", "### Relationships", ...edgeLines.map((line) => `- ${line}`));
			sections.push(lines.join("\n"));
		}
	}
	if (!sections.length) return { rebuilt: false, reason: "no_surviving_content" };
	let markdown = sections[0];
	for (const section of sections.slice(1)) markdown = appendAdvanceSection(markdown, section).markdown;
	const messageCount = await conversationMessageCount(env, userId, pageId);
	await env.DB.prepare(
		`UPDATE memory_pages SET full_markdown = ?, short_summary = ?, message_count = ?,
			updated_at = ?, last_seen_at = ?, revision = COALESCE(revision, 1) + 1
		 WHERE id = ? AND user_id = ? AND project_id IS ? AND deleted_at IS NULL`,
	).bind(
		markdown,
		clampLine(firstFact ?? page.title, 200),
		messageCount,
		Date.now(),
		Date.now(),
		pageId,
		userId,
		page.project_id ?? null,
	).run();
	return { rebuilt: true };
}

export async function markMcpEnrichmentFailed(env, userId, job, reason, defer = null) {
	const project = projectPayload(job.sourceMeta);
	const receipt = emptyReceipt("enrich_failed", "background processing hit a problem — it has been reported", {
		source: SOURCE, source_mode: SOURCE_MODE, ...(job.sourceMeta ?? {}),
	});
	receipt.id = `receipt_mcp_failed_${job.jobId}`;
	receipt.page_id = job.pageId ?? null;
	receipt.status = "failed";
	const summary = !job.pageId
		? "This save could not finish processing. Nothing was lost, and the problem has been reported automatically."
		: job.pageAdvance
			? "This save could not finish processing. The Conversation Page keeps its last enriched content, nothing was lost, and the problem has been reported automatically."
			: "This save could not finish processing. The staged page is kept, nothing was lost, and the problem has been reported automatically.";
	await updateMemoryJob(env, userId, job.jobId, {
		status: "failed",
		receiptId: receipt.id,
		error: String(reason ?? "unknown").slice(0, 400),
		payload: {
			// A follower's terminal payload keeps its lane marker: the job stays
			// identifiable as page bookkeeping, and announceMcpTerminal keeps its
			// promise never to re-announce a batch the ingest lane already owns.
			...(job.lane ? { lane: job.lane } : {}),
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
		if (job.pageId && job.pageAdvance) {
			// A failed ADVANCE leaves the page's prior enriched content standing;
			// the job row and receipt carry the failure.
			await env.DB.prepare(
				`UPDATE memory_pages SET enrich_status = 'enriched', updated_at = ?
				 WHERE id = ? AND user_id = ? AND project_id IS ? AND deleted_at IS NULL AND enrich_status = 'staged'`,
			).bind(Date.now(), job.pageId, userId, project.project_id).run();
		} else if (job.pageId) {
			await env.DB.prepare(
				"UPDATE memory_pages SET enrich_status = 'failed', updated_at = ? WHERE id = ? AND user_id = ? AND project_id IS ? AND deleted_at IS NULL",
			).bind(Date.now(), job.pageId, userId, project.project_id).run();
		}
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
	// Page followers are internal bookkeeping for a batch the ingest lane
	// already announced — emitting here would double-fire webhook events.
	if (payload.lane === "page_follow") return;
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
	// REST-lane page followers ride the same queue machinery but never run
	// extraction themselves — they wait on the ingest lane's durable verdict
	// and finalize the Conversation Page from it.
	if (job.lane === "page_follow") return followConversationPage(env, userId, job, defer);
	const config = getConfig(env);
	const project = projectPayload(job.sourceMeta);
	// The revision this enrichment starts from. Model work takes seconds, and an
	// explicit user edit can land in that window; the final page write is fenced
	// on this value so a stale enrichment loses instead of overwriting the
	// correction. NULL (a pre-versioning row) keeps the historical behaviour.
	// Advances skip this: their finalize reads fresh and CASes at write time.
	if (job.observedRevision === undefined && job.pageId && !job.pageAdvance) {
		const observed = await env.DB.prepare(
			"SELECT COALESCE(revision, 1) AS revision FROM memory_pages WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
		).bind(job.pageId, userId).first().catch(() => null);
		if (!observed) {
			// No readable revision means no safe fence. Failing here keeps the job
			// retryable; writing unfenced would risk overwriting a user's edit.
			const unreadable = new Error("page revision unreadable; enrichment cannot fence safely");
			unreadable.code = "ENRICH_REVISION_UNREADABLE";
			throw unreadable;
		}
		job.observedRevision = Number(observed.revision);
	}
	try {
		const accountRules = await resolveAdmissionRules(env, userId);
		const rules = job.managedPolicy
			? narrowManagedMemoryRules(accountRules, job.credentialRules)
			: accountRules;
		if (job.managedPolicy) rules.projectCategories = Array.isArray(job.projectCategories) ? job.projectCategories : [];
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
		// A repaired job (SRV-05) runs under a fresh generation so its run ids
		// never collide with the failed generation's ledger records.
		const generation = Number(job.repairGeneration ?? 0);
		const runKey = generation > 0 ? `${job.jobId}#g${generation}` : job.jobId;
		const result = await runExtraction(
			env,
			userId,
			job.userMessages ?? [],
			job.contextMessages ?? [],
			overrides,
			{ runId: await mcpExtractionRunId(userId, runKey, attempt) },
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
			// The engine looked and found nothing durable.
			if (job.pageId && !job.pageAdvance) {
				// A freshly staged page must not linger as junk — remove it and
				// say so on the job.
				await env.DB.prepare(
					"UPDATE memory_pages SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND project_id IS ?",
				).bind(Date.now(), Date.now(), job.pageId, userId, project.project_id).run();
			} else if (job.pageId && job.pageAdvance) {
				// An advance that added nothing keeps the page's prior enriched
				// content; only the processing state is restored.
				await env.DB.prepare(
					`UPDATE memory_pages SET enrich_status = 'enriched', updated_at = ?
					 WHERE id = ? AND user_id = ? AND project_id IS ? AND deleted_at IS NULL AND enrich_status = 'staged'`,
				).bind(Date.now(), job.pageId, userId, project.project_id).run();
			}
			await updateMemoryJob(env, userId, job.jobId, {
				status: "enriched",
				receiptId: receipt?.id ?? null,
				payload: {
					pageId: job.pageId ?? null,
					...(job.pageId && !job.pageAdvance ? { page_deleted: true } : {}),
					...(job.pageId && job.pageAdvance ? { page_advance_empty: true } : {}),
					...(job.pageId ? {} : { pageless: true }),
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
		const savedCounts = {
			nodes: receipt?.saved?.nodes ?? 0,
			edges: receipt?.saved?.edges ?? 0,
			slices: receipt?.saved?.slices ?? 0,
			events: receipt?.saved?.events ?? 0,
		};

		// Pageless save (rules off / suppressed / archived / advance limit):
		// the graph write above is the whole outcome.
		if (!job.pageId) {
			await updateMemoryJob(env, userId, job.jobId, {
				status: "enriched",
				receiptId: receipt?.id ?? null,
				payload: { pageId: null, pageless: true, ...savedCounts, ...project },
				completedAt: Date.now(),
			});
			await settleStagedText(env, userId, [job.jobId]);
			return { done: true };
		}

		const title = await reconcileTitle(env, config, {
			entityLabels,
			factLines: [...factLines, ...edgeLines],
			fallbackTs: job.lastTs ?? Date.now(),
			titleResponse: job.testOverrides?.titleResponse,
			userId,
		});
		// Rules re-checked at finalize: they may have changed since staging, and
		// an excluded topic must never survive onto the final page.
		const derivedLines = job.captureMode
			? (job.derivedLines ?? []).filter((line) => rulesAllowText(rules, line))
			: [];

		if (job.pageAdvance) {
			const advanced = await finalizeConversationAdvance(env, userId, job, {
				project,
				factLines,
				edgeLines,
				derivedLines,
				receipt,
			});
			if (advanced.retry) return advanced;
			await updateMemoryJob(env, userId, job.jobId, {
				status: "enriched",
				receiptId: receipt?.id ?? null,
				payload: {
					pageId: job.pageId,
					pageAdvance: true,
					...(advanced.keptUserText ? { page_text_kept_user_authored: true } : {}),
					...(advanced.pageDeleted ? { page_deleted_during_processing: true } : {}),
					...savedCounts,
					...project,
				},
				completedAt: Date.now(),
			});
			await settleStagedText(env, userId, [job.jobId]);
			return { done: true };
		}

		const markdown = enrichedMarkdown(title, {
			factLines,
			edgeLines,
			derivedLines,
			savedAt: job.lastTs ?? Date.now(),
		});
		const messageCount = await conversationMessageCount(env, userId, job.pageId);
		const enrichStatement = env.DB.prepare(
			// Enrichment ran against the page revision the job observed. If an
			// explicit edit landed since, this write must lose: zero changed rows
			// leaves the page at the user's version and the job is re-driven.
			`UPDATE memory_pages SET
				title = ?, canonical_title = ?, short_summary = ?, full_markdown = ?,
				enrich_status = 'enriched', extraction_run_id = ?, receipt_id = COALESCE(?, receipt_id),
				message_count = ?,
				updated_at = ?, last_seen_at = ?, revision = COALESCE(revision, 1) + 1
			 WHERE id = ? AND user_id = ? AND project_id IS ? AND deleted_at IS NULL
			   AND COALESCE(revision, 1) = ?`,
		).bind(
			title,
			canonicalTitle(title),
			clampLine(factLines[0] ?? title, 200),
			markdown,
			receipt?.extraction_run_id ?? null,
			receipt?.id ?? null,
			messageCount,
			Date.now(),
			Date.now(),
			job.pageId,
			userId,
			project.project_id,
			// Never NULL: a revision that could not be read fails the job closed
			// above rather than becoming an unfenced write.
			job.observedRevision,
		);
		const enrichWrite = await applyFencedUpdate(enrichStatement, { label: "mcp page enrichment" });
		if (!enrichWrite.applied) {
			// Distinguish WHY the page moved. A newer advance of the same
			// conversation staged on top of this create — convergence working —
			// is retryable: re-drive against the fresh revision, and the
			// advance's own finalize appends after ours. Anything else (an
			// explicit user edit, a delete, a project fence) keeps the historic
			// fail-closed behaviour.
			const fresh = await env.DB.prepare(
				`SELECT revision, enrich_status, input_hash, deleted_at FROM memory_pages
				 WHERE id = ? AND user_id = ? AND project_id IS ? LIMIT 1`,
			).bind(job.pageId, userId, project.project_id).first().catch(() => null);
			const advancedOnTop = Boolean(
				fresh
				&& !fresh.deleted_at
				&& fresh.enrich_status === "staged"
				&& fresh.input_hash !== (job.sourceMeta?.source_content_hash ?? null)
				&& Number(fresh.revision ?? 1) !== Number(job.observedRevision),
			);
			if (advancedOnTop) {
				return { retry: true, reason: "conversation page advanced during enrichment" };
			}
			const stale = new Error("page revision changed during enrichment");
			stale.code = "ENRICH_STALE_REVISION";
			throw stale;
		}
		await updateMemoryJob(env, userId, job.jobId, {
			status: "enriched",
			receiptId: receipt?.id ?? null,
			payload: {
				pageId: job.pageId,
				title,
				...savedCounts,
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
