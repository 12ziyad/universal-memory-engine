import { newId } from "../lib/ids.js";
import {
	addSuppression,
	canonicalKey,
	createExtractionRun,
	createMemoryJob,
	getActiveSuppressions,
	getUserPages,
	storeReceipt,
	updateExtractionRun,
	updateMemoryJob,
} from "../lib/db.js";
import { getConfig } from "../config.js";
import { normalizeLabel, tokens } from "../lib/text.js";
import { clusterForMemory } from "./clusters.js";
import { runPass2 } from "./pass2.js";
import { dedupeEvidence, overlapRatio, safeJsonArray, topicSimilarity } from "./signals.js";
import { sourceEvidenceFromPacket, sourceMeta } from "./source.js";
import { canonicalTitle, generateTitle } from "./title.js";

const RELATED_HINTS = [
	"ai",
	"api",
	"cloudflare",
	"cypher",
	"d1",
	"durable objects",
	"fine-tuning",
	"graphrl",
	"llm",
	"lora",
	"mcp",
	"neo4j",
	"rag",
	"vectorize",
	"workers",
];

function parseList(value) {
	if (!value) return [];
	if (Array.isArray(value)) return value.map(String).filter(Boolean);
	return String(value)
		.split(/\s*(?:,|;|\band\b|\&)\s*/i)
		.map((s) => s.trim())
		.filter(Boolean);
}

export function parseCollectIntent(messages = [], opts = {}) {
	const userText = (messages ?? [])
		.filter((m) => (m.role ?? "user") === "user")
		.map((m) => String(m.content ?? ""))
		.join("\n");
	const lower = userText.toLowerCase();
	const topic = opts.topic ?? lower.match(/\b(?:about|regarding|on)\s+([^,.;\n]+?)(?:\s+from\b|\s+in\b|\s+skip\b|$)/i)?.[1]
		?? lower.match(/\bsave\s+(?:all|everything)\s+([^,.;\n]+?)\s+details\b/i)?.[1]
		?? null;
	const skip = lower.match(/\b(?:skip|except|exclude)\s+([^,.;\n]+)/i)?.[1] ?? null;
	const explicitNew = /\b(new summary|new page|separate page)\b/i.test(userText);
	const updateRequested = /\b(save more|update|add this|add more|more about)\b/i.test(userText);
	const isCollectCommand =
		opts.scope === "summary" ||
		opts.scope === "topic" ||
		/\b(save everything|save all|save this chat|collect what|summary)\b/i.test(userText);

	return {
		sourceMode: "manual_collect",
		topic: topic ? String(topic).trim() : opts.topic ?? null,
		skip: parseList(skip),
		explicitNew,
		updateRequested,
		isCollectCommand,
	};
}

function lineTokens(line) {
	return new Set(tokens(line));
}

function topicMatches(line, topic) {
	if (!topic) return true;
	const lineNorm = normalizeLabel(line);
	const topicNorm = normalizeLabel(topic);
	if (lineNorm.includes(topicNorm)) return true;
	const lt = lineTokens(line);
	const topicTokens = tokens(topic);
	return topicTokens.some((t) => lt.has(t));
}

function skipMatches(line, skipTopics) {
	const lineNorm = normalizeLabel(line);
	for (const skip of skipTopics ?? []) {
		const s = normalizeLabel(skip);
		if (s && lineNorm.includes(s)) return true;
	}
	return false;
}

export function filterDigestByTopic(digest, intent = {}) {
	const lines = String(digest ?? "")
		.split(/\n+/)
		.map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim())
		.filter(Boolean);
	const filtered = lines.filter((line) => topicMatches(line, intent.topic) && !skipMatches(line, intent.skip));
	return filtered.join("\n");
}

function uniq(items) {
	return [...new Set((items ?? []).map((x) => String(x).trim()).filter(Boolean))];
}

function safeJsonObject(value) {
	try {
		const parsed = JSON.parse(value || "{}");
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function classifyLines(lines) {
	const decisions = [];
	const nextSteps = [];
	const technical = [];
	for (const line of lines) {
		if (/\b(decided|chose|choice|will use|settled|approved)\b/i.test(line)) decisions.push(line);
		if (/\b(next|todo|plan|later|should|will|need to|follow up)\b/i.test(line)) nextSteps.push(line);
		if (/\b(api|d1|vectorize|worker|cloudflare|database|schema|model|mcp|graph|edge|node|embedding|neo4j|cypher|lora)\b/i.test(line)) {
			technical.push(line);
		}
	}
	return { decisions: uniq(decisions), nextSteps: uniq(nextSteps), technical: uniq(technical) };
}

function relatedConcepts(lines, title, topic) {
	const text = `${title}\n${topic ?? ""}\n${lines.join("\n")}`.toLowerCase();
	const hits = RELATED_HINTS.filter((hint) => text.includes(hint));
	const caps = lines
		.join(" ")
		.match(/\b[A-Z][A-Za-z0-9/+.-]{2,}(?:\s+[A-Z][A-Za-z0-9/+.-]{2,}){0,2}\b/g);
	return uniq([...hits, ...(caps ?? [])])
		.filter((x) => canonicalKey(x) !== canonicalKey(title) && (!topic || canonicalKey(x) !== canonicalKey(topic)))
		.slice(0, 16);
}

function evidenceOverlap(line, text) {
	const lineNorm = normalizeLabel(line);
	const textNorm = normalizeLabel(text);
	if (!lineNorm || !textNorm) return false;
	if (textNorm.includes(lineNorm.slice(0, Math.min(100, lineNorm.length)))) return true;
	const lineTokens = tokens(line);
	const textTokens = tokens(text);
	if (!lineTokens.length || !textTokens.length) return false;
	const shared = lineTokens.filter((token) => textTokens.includes(token)).length;
	return shared >= Math.min(4, Math.ceil(lineTokens.length * 0.5));
}

function clampSnippet(text) {
	const clean = String(text ?? "").replace(/\s+/g, " ").trim();
	if (clean.length <= 900) return clean;
	return `${clean.slice(0, 897).trim()}...`;
}

function buildEvidence(lines, messages, receiptId, sourcePacket) {
	const packetEvidence = sourceEvidenceFromPacket(sourcePacket, { receiptId });
	const messageLines = packetEvidence.length
		? packetEvidence.map((item) => ({
			role: item.source_role,
			text: item.snippet,
			ts: item.timestamp,
			id: item.source_message_id,
			content_hash: item.content_hash,
			source_packet_id: item.source_packet_id,
			confidence: item.confidence,
		}))
		: (messages ?? [])
			.filter((m) => ["user", "assistant"].includes(m.role ?? "user"))
			.map((m) => ({ role: m.role ?? "user", text: String(m.content ?? "").trim(), ts: m.ts ?? null, id: m.id ?? null }))
			.filter((m) => m.text);
	const evidence = [];

	for (const msg of messageLines) {
		if (!lines.some((line) => evidenceOverlap(line, msg.text))) continue;
		evidence.push({
			source_type: `${msg.role}_message`,
			source_packet_id: msg.source_packet_id ?? sourcePacket?.id ?? null,
			source_message_id: msg.id ?? null,
			source_role: msg.role,
			snippet: clampSnippet(msg.text),
			timestamp: msg.ts ?? null,
			content_hash: msg.content_hash ?? null,
			receipt_id: receiptId ?? null,
			confidence: msg.confidence ?? (msg.role === "user" ? 0.92 : 0.72),
		});
	}

	const digestSnippet = lines.slice(0, 8).join(" ");
	if (digestSnippet) {
		evidence.push({
			source_type: "digest",
			source_packet_id: sourcePacket?.id ?? null,
			source_message_id: null,
			source_role: "digest",
			snippet: clampSnippet(digestSnippet),
			timestamp: null,
			content_hash: sourcePacket?.content_hash ?? null,
			receipt_id: receiptId ?? null,
			confidence: 0.75,
		});
	}
	return dedupeEvidence(evidence, 12);
}

function markdownFor({ title, overview, keyPoints, decisions, technical, nextSteps, related, evidence }) {
	const parts = [`# ${title}`, "", "## Overview", overview || "Collected memory page."];
	const add = (heading, lines) => {
		if (!lines?.length) return;
		parts.push("", `## ${heading}`, ...lines.map((line) => `- ${line}`));
	};
	add("Key Points", keyPoints);
	add("Decisions", decisions);
	add("Technical Details", technical);
	add("Next Steps", nextSteps);
	add("Related Concepts", related);
	if (evidence?.length) {
		parts.push("", "## Evidence");
		parts.push(...evidence.slice(0, 8).map((e) => `- ${e.snippet}`));
	}
	return parts.join("\n");
}

export function buildPageDraft({ digest, messages, intent, conversationId, extractionRunId, receiptId = null, sourcePacket }) {
	const lines = String(digest ?? "")
		.split(/\n+/)
		.map((line) => line.trim())
		.filter(Boolean);
	const text = lines.join("\n");
	const title = generateTitle(text, { topic: intent.topic });
	const { decisions, nextSteps, technical } = classifyLines(lines);
	const keyPoints = uniq(lines).slice(0, 30);
	const overview = keyPoints.slice(0, 3).join(" ");
	const related = relatedConcepts(lines, title, intent.topic);
	const evidence = buildEvidence(lines, messages, receiptId ?? extractionRunId, sourcePacket);
	const sections = {
		overview,
		keyPoints,
		decisions,
		technicalDetails: technical,
		nextSteps,
		relatedConcepts: related,
		evidence,
	};
	const fullMarkdown = markdownFor({ title, overview, keyPoints, decisions, technical, nextSteps, related, evidence });
	const cluster = clusterForMemory({
		title,
		category: intent.topic ?? "interest",
		summary: overview,
		text,
	});
	return {
		id: newId("page"),
		node_id: null,
		node_kind: "memory_page",
		source_mode: "manual_collect",
		title,
		canonical_title: canonicalTitle(title),
		topic_filter: intent.topic ? normalizeLabel(intent.topic) : null,
		short_summary: overview.slice(0, 700),
		full_markdown: fullMarkdown,
		sections_json: JSON.stringify(sections),
		key_points_json: JSON.stringify(keyPoints),
		decisions_json: JSON.stringify(decisions),
		next_steps_json: JSON.stringify(nextSteps),
		related_concepts_json: JSON.stringify(related),
		evidence_json: JSON.stringify(evidence),
		source_thread_id: null,
		source_conversation_id: conversationId ?? null,
		source_packet_id: sourcePacket?.id ?? null,
		input_hash: sourcePacket?.content_hash ?? null,
		idempotency_key: sourcePacket?.idempotency_key ?? null,
		extraction_run_id: extractionRunId,
		receipt_id: receiptId,
		confidence: evidence.some((e) => e.source_type === "user_message") ? 0.9 : 0.78,
		health_state: "active",
		importance_class: decisions.length ? "important" : "ordinary",
		cluster,
		role_type: "container",
		related,
		evidence,
		keyPoints,
		decisions,
		nextSteps,
	};
}

function pageMatchPayload(page) {
	return {
		title: page.title,
		topic: page.topic_filter,
		summary: page.short_summary,
		text: [
			page.full_markdown,
			page.key_points_json,
			page.related_concepts_json,
		].filter(Boolean).join("\n"),
	};
}

function titleSimilarity(a, b) {
	const left = normalizeLabel(a);
	const right = normalizeLabel(b);
	if (!left || !right) return 0;
	if (left === right) return 1;
	if (left.includes(right) || right.includes(left)) return 0.82;
	return overlapRatio(tokens(left), tokens(right));
}

function clusterCompatible(page, draft) {
	if (!page.cluster || !draft.cluster) return true;
	if (page.cluster === draft.cluster) return true;
	return page.cluster === "general_memory" || draft.cluster === "general_memory";
}

function genericCanonicalTitle(value) {
	const title = normalizeLabel(value);
	return !title || title === "memory research" || title === "memory research session";
}

function scorePageMatch(page, draft, intent, conversationId) {
	const similarity = topicSimilarity(pageMatchPayload(page), {
		title: draft.title,
		topic: draft.topic_filter,
		summary: draft.short_summary,
		text: [draft.full_markdown, draft.key_points_json, draft.related_concepts_json].join("\n"),
	});
	const sameTopic = Boolean(draft.topic_filter && page.topic_filter && page.topic_filter === draft.topic_filter);
	const topicConflict = Boolean(draft.topic_filter && page.topic_filter && draft.topic_filter !== page.topic_filter);
	const sameTitle = page.canonical_title === draft.canonical_title;
	const sameConversation = Boolean(conversationId && page.source_conversation_id === conversationId);
	const titleScore = Math.max(titleSimilarity(page.title, draft.title), titleSimilarity(page.canonical_title, draft.canonical_title));
	const compatible = clusterCompatible(page, draft);
	const pageSig = similarity.left;
	const draftSig = similarity.right;
	const domainConflict = pageSig.domainId && draftSig.domainId && pageSig.domainId !== draftSig.domainId;
	const safeSameTitle = sameTitle && !genericCanonicalTitle(page.canonical_title) && titleScore >= 0.95;
	let score =
		similarity.score * 0.48 +
		titleScore * 0.24 +
		(sameTopic ? 0.2 : 0) +
		(sameTitle ? 0.18 : 0) +
		(sameConversation && intent.updateRequested ? 0.08 : 0) +
		(compatible ? 0.08 : -0.22);
	if (domainConflict) score -= 0.18;
	const strong =
		compatible &&
		!domainConflict &&
		!topicConflict &&
		(score >= 0.62 ||
			(sameTopic && score >= 0.52) ||
			(similarity.sameDomain && similarity.score >= 0.4 && titleScore >= 0.35) ||
			(safeSameTitle && similarity.score >= 0.12) ||
			(sameTitle && similarity.score >= 0.22) ||
			(sameConversation && intent.updateRequested && score >= 0.58));
	return {
		page,
		score,
		strong,
		reasons: { sameTopic, sameTitle, sameConversation, compatible, domainConflict, topicConflict, titleScore, topicScore: similarity.score },
	};
}

export function findPageMatch(pages, draft, intent, conversationId) {
	if (intent.explicitNew) return null;
	const scored = (pages ?? [])
		.filter((p) => p.source_mode === "manual_collect")
		.map((page) => scorePageMatch(page, draft, intent, conversationId))
		.sort((a, b) => b.score - a.score || String(b.page.updated_at ?? 0).localeCompare(String(a.page.updated_at ?? 0)));
	return scored.find((item) => item.strong)?.page ?? null;
}

export function suppressedBy(rows, kind, key) {
	return rows.find((s) => s.kind === kind && s.canonical_key === key);
}

function pageArray(page, column, sectionKey) {
	const direct = safeJsonArray(page?.[column]);
	if (direct.length) return direct;
	const sections = safeJsonObject(page?.sections_json);
	return safeJsonArray(sections[sectionKey]);
}

export function mergePageDraft(existing, draft, { preferDraftTitle = false } = {}) {
	const keyPoints = uniq([...pageArray(existing, "key_points_json", "keyPoints"), ...(draft.keyPoints ?? [])]).slice(0, 30);
	const decisions = uniq([...pageArray(existing, "decisions_json", "decisions"), ...(draft.decisions ?? [])]).slice(0, 20);
	const nextSteps = uniq([...pageArray(existing, "next_steps_json", "nextSteps"), ...(draft.nextSteps ?? [])]).slice(0, 20);
	const existingSections = safeJsonObject(existing?.sections_json);
	const technical = uniq([
		...safeJsonArray(existingSections.technicalDetails),
		...classifyLines(draft.keyPoints ?? []).technical,
	]).slice(0, 20);
	const related = uniq([...safeJsonArray(existing?.related_concepts_json), ...(draft.related ?? [])]).slice(0, 16);
	const evidence = dedupeEvidence([...safeJsonArray(existing?.evidence_json), ...(draft.evidence ?? [])], 12);
	const title = preferDraftTitle ? (draft.title || existing.title) : (existing.title || draft.title);
	const overview = keyPoints.slice(0, 3).join(" ") || draft.short_summary || existing.short_summary || "Collected memory page.";
	const sections = {
		overview,
		keyPoints,
		decisions,
		technicalDetails: technical,
		nextSteps,
		relatedConcepts: related,
		evidence,
	};
	const fullMarkdown = markdownFor({ title, overview, keyPoints, decisions, technical, nextSteps, related, evidence });
	return {
		...draft,
		id: existing.id,
		title,
		canonical_title: canonicalTitle(title),
		short_summary: overview.slice(0, 700),
		full_markdown: fullMarkdown,
		sections_json: JSON.stringify(sections),
		key_points_json: JSON.stringify(keyPoints),
		decisions_json: JSON.stringify(decisions),
		next_steps_json: JSON.stringify(nextSteps),
		related_concepts_json: JSON.stringify(related),
		evidence_json: JSON.stringify(evidence),
		related,
		evidence,
		keyPoints,
		decisions,
		nextSteps,
	};
}

export function isDuplicateCollect(match, draft, sourcePacket) {
	if (!match || !draft.input_hash) return false;
	if (match.input_hash !== draft.input_hash) return false;
	return Boolean(
		match.source_packet_id === draft.source_packet_id ||
		match.idempotency_key === draft.idempotency_key ||
		Number(sourcePacket?.seen_count ?? 0) > 1,
	);
}

function pageReceipt({ action, page, runId, received, digested, relatedCount, skipped = [], suppressed = false }) {
	const created = action === "create" ? [{ id: page.id, title: page.title }] : [];
	const updated = action === "update" || action === "reinforce" ? [{ kind: "memory_page", id: page.id, title: page.title }] : [];
	const duplicate = action === "duplicate";
	const receipt = {
		outcome: suppressed ? "suppressed" : duplicate ? "skipped_duplicate" : "wrote",
		source: "save_conversation",
		source_mode: "manual_collect",
		extraction_run_id: runId,
		page_action: duplicate ? "skipped_duplicate" : action === "create" ? "created" : action === "update" ? "updated" : action === "reinforce" ? "reinforced" : action,
		source_packet_id: page.source_packet_id ?? null,
		idempotency_key: page.idempotency_key ?? null,
		scope_json: page.scope_json ?? null,
		received,
		digested,
		saved: {
			pages: suppressed || duplicate ? 0 : 1,
			nodes: 0,
			newNodeLabels: [],
			autoCreated: [],
			updatedNodes: 0,
			slices: 0,
			events: 0,
			edges: 0,
			candidates: 0,
		},
		savedTotal: suppressed || duplicate ? 0 : 1,
		actions: {
			createdPages: created,
			updatedPages: updated,
			reinforcedPages: action === "reinforce" ? updated : [],
			skippedObjects: duplicate
				? [{ kind: "memory_page", id: page.id, title: page.title, reason: "duplicate_memory_page", count: 1 }, ...skipped]
				: skipped,
			suppressedObjects: suppressed ? [{ kind: "memory_page", title: page.title }] : [],
		},
		skipped: duplicate ? skipped.length + 1 : skipped.length,
		skippedReasons: duplicate
			? { duplicate_memory_page: 1, ...Object.fromEntries(skipped.map((item) => [item.reason, (item.count ?? 1)])) }
			: Object.fromEntries(skipped.map((item) => [item.reason, (item.count ?? 1)])),
		relatedConceptsKeptInPage: relatedCount,
		created_at: Date.now(),
	};
	if (duplicate) receipt.reason = "duplicate memory page already exists";
	return receipt;
}

function pageSummary(action, page, receipt) {
	if (action === "duplicate") {
		return `Skipped duplicate memory page:\n${page.title}\nReceipt: ${receipt.extraction_run_id}`;
	}
	const verb =
		action === "create"
			? "Created one memory page"
			: action === "reinforce"
				? "Reinforced one memory page"
				: "Updated one memory page";
	const related = receipt.relatedConceptsKeptInPage ?? 0;
	const skipped = related
		? `\n\nSkipped graph node creation for ${related} related concept(s) because this was manual_collect mode.`
		: "";
	return `${verb}:\n${page.title}${skipped}\nReceipt: ${receipt.extraction_run_id}`;
}

export async function saveMemoryPage(env, userId, { digest, messages, intent, received, keptLines, conversationId, sourcePacket = null }) {
	const source = sourceMeta(sourcePacket);
	const runId = await createExtractionRun(env, userId, {
		toolName: "save_conversation",
		sourceMode: "manual_collect",
		topicFilter: intent.topic ? normalizeLabel(intent.topic) : null,
		sourcePacketId: source.source_packet_id,
		idempotencyKey: source.idempotency_key,
		scopeJson: source.scope_json,
		status: "running",
	});

	const draft = {
		...buildPageDraft({ digest, messages, intent, conversationId, extractionRunId: runId, sourcePacket }),
		scope_json: source.scope_json ?? null,
	};
	const suppressions = await getActiveSuppressions(env, userId);
	const suppression = suppressedBy(suppressions, "memory_page", draft.canonical_title)
		?? (draft.topic_filter ? suppressedBy(suppressions, "memory_page", draft.topic_filter) : null);
	if (suppression) {
		const receipt = pageReceipt({
			action: "suppressed",
			page: draft,
			runId,
			received,
			digested: keptLines,
			relatedCount: 0,
			skipped: [{ kind: "memory_page", label: draft.title, reason: "suppressed_blocked", count: 1 }],
			suppressed: true,
		});
		await updateExtractionRun(env, userId, runId, {
			status: "suppressed",
			skippedObjects: receipt.actions.skippedObjects,
		});
		const summary = `Skipped suppressed memory page:\n${draft.title}\nReceipt: ${runId}`;
		await storeReceipt(env, userId, "save_conversation", receipt, summary);
		return { fired: false, processing: false, summary, receipt };
	}

	const pages = await getUserPages(env, userId);
	const match = findPageMatch(pages, draft, intent, conversationId);
	const now = Date.now();
	let action = "create";
	let page = draft;

	if (match) {
		action = intent.updateRequested ? "update" : "reinforce";
		if (isDuplicateCollect(match, draft, sourcePacket)) {
			action = "duplicate";
			page = {
				...draft,
				id: match.id,
				title: match.title || draft.title,
				canonical_title: match.canonical_title || draft.canonical_title,
			};
			const receipt = pageReceipt({
				action,
				page,
				runId,
				received,
				digested: keptLines,
				relatedCount: 0,
			});
			await updateExtractionRun(env, userId, runId, {
				status: "skipped_duplicate",
				skippedObjects: receipt.actions.skippedObjects,
			});
			const summary = pageSummary(action, page, receipt);
			const receiptId = await storeReceipt(env, userId, "save_conversation", receipt, summary);
			if (receiptId) {
				await env.DB.prepare("UPDATE memory_pages SET receipt_id = ? WHERE id = ? AND user_id = ?")
					.bind(receiptId, page.id, userId)
					.run();
			}
			return { fired: false, processing: false, summary, receipt };
		}
		page = mergePageDraft(match, draft, { preferDraftTitle: intent.updateRequested });
		await env.DB.prepare(
			`UPDATE memory_pages SET
				title = ?, canonical_title = ?, topic_filter = ?, short_summary = ?, full_markdown = ?,
				sections_json = ?, key_points_json = ?, decisions_json = ?, next_steps_json = ?,
				related_concepts_json = ?, evidence_json = ?, source_conversation_id = COALESCE(?, source_conversation_id),
				source_packet_id = ?, input_hash = ?, idempotency_key = ?,
				extraction_run_id = ?, updated_at = ?, last_seen_at = ?, heat_score = COALESCE(heat_score, 0) + 1,
				confidence = MAX(COALESCE(confidence, 0), ?), importance_class = ?, cluster = ?
			 WHERE id = ? AND user_id = ?`,
		)
			.bind(
				page.title,
				page.canonical_title,
				page.topic_filter,
				page.short_summary,
				page.full_markdown,
				page.sections_json,
				page.key_points_json,
				page.decisions_json,
				page.next_steps_json,
				page.related_concepts_json,
				page.evidence_json,
				conversationId ?? null,
				page.source_packet_id,
				page.input_hash,
				page.idempotency_key,
				runId,
				now,
				now,
				page.confidence,
				page.importance_class,
				page.cluster,
				match.id,
				userId,
			)
			.run();
	} else {
		await env.DB.prepare(
			`INSERT INTO memory_pages
				(id, user_id, node_id, node_kind, source_mode, title, canonical_title, topic_filter,
				 short_summary, full_markdown, sections_json, key_points_json, decisions_json,
				 next_steps_json, related_concepts_json, evidence_json, source_thread_id,
				 source_conversation_id, source_packet_id, input_hash, idempotency_key, extraction_run_id,
				 created_at, updated_at, last_seen_at, heat_score, confidence, health_state, importance_class,
				 cluster, role_type)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(
				page.id,
				userId,
				page.node_id,
				page.node_kind,
				page.source_mode,
				page.title,
				page.canonical_title,
				page.topic_filter,
				page.short_summary,
				page.full_markdown,
				page.sections_json,
				page.key_points_json,
				page.decisions_json,
				page.next_steps_json,
				page.related_concepts_json,
				page.evidence_json,
				page.source_thread_id,
				page.source_conversation_id,
				page.source_packet_id,
				page.input_hash,
				page.idempotency_key,
				runId,
				now,
				now,
				now,
				1,
				page.confidence,
				page.health_state,
				page.importance_class,
				page.cluster,
				page.role_type,
			)
			.run();
	}

	const relatedCount = page.related?.length ?? 0;
	const skipped = relatedCount
		? [{ kind: "related_concepts", label: page.title, reason: "manual_collect_kept_inside_page", count: relatedCount }]
		: [];
	const receipt = pageReceipt({ action, page, runId, received, digested: keptLines, relatedCount, skipped });
	await updateExtractionRun(env, userId, runId, {
		status: "wrote",
		createdPages: action === "create" ? [{ id: page.id, title: page.title }] : [],
		updatedObjects: action !== "create" ? [{ kind: "memory_page", id: page.id, title: page.title }] : [],
		reinforcedObjects: action === "reinforce" ? [{ kind: "memory_page", id: page.id, title: page.title }] : [],
		skippedObjects: skipped,
	});
	const jobId = await createMemoryJob(env, userId, {
		type: "pass2_rollup",
		status: "running",
		idempotencyKey: `pass2:${runId}`,
		sourcePacketId: page.source_packet_id ?? null,
		extractionRunId: runId,
		payload: { affectedNodeIds: [], pageId: page.id },
	});
	if (jobId) await updateExtractionRun(env, userId, runId, { jobId });
	try {
		const pass2 = await runPass2(env, getConfig(env), userId, [], { jobId });
		await updateMemoryJob(env, userId, jobId, {
			status: pass2?.ran ? "completed" : "skipped",
			payload: { affectedNodeIds: [], pageId: page.id, pass2 },
			completedAt: Date.now(),
		});
	} catch (err) {
		await updateMemoryJob(env, userId, jobId, {
			status: "failed",
			error: String(err?.message ?? err),
			completedAt: Date.now(),
		});
	}
	const summary = pageSummary(action, page, receipt);
	const receiptId = await storeReceipt(env, userId, "save_conversation", receipt, summary);
	if (receiptId) {
		await env.DB.prepare("UPDATE memory_pages SET receipt_id = ? WHERE id = ? AND user_id = ?")
			.bind(receiptId, page.id, userId)
			.run();
	}
	return { fired: true, processing: false, summary, receipt };
}

export async function suppressPageKey(env, userId, page, reason = "deleted") {
	await addSuppression(env, userId, {
		kind: "memory_page",
		label: page.title,
		canonical_key: page.canonical_title,
		reason,
		source_object_id: page.id,
	});
	if (page.topic_filter) {
		await addSuppression(env, userId, {
			kind: "memory_page",
			label: page.topic_filter,
			canonical_key: page.topic_filter,
			reason,
			source_object_id: page.id,
		});
	}
}
