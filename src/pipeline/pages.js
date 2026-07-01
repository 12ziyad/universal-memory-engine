import { newId } from "../lib/ids.js";
import {
	addSuppression,
	canonicalKey,
	createExtractionRun,
	getActiveSuppressions,
	getUserPages,
	storeReceipt,
	updateExtractionRun,
} from "../lib/db.js";
import { normalizeLabel, tokens } from "../lib/text.js";
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

function buildEvidence(lines, messages, receiptId) {
	const userLines = (messages ?? [])
		.filter((m) => (m.role ?? "user") === "user")
		.map((m) => ({ text: String(m.content ?? "").trim(), ts: m.ts ?? null, id: m.id ?? null }))
		.filter((m) => m.text);
	const evidence = [];
	for (const line of lines.slice(0, 12)) {
		const match = userLines.find((m) => normalizeLabel(m.text).includes(normalizeLabel(line).slice(0, 80)));
		evidence.push({
			source_type: match ? "user_message" : "digest",
			source_message_id: match?.id ?? null,
			source_role: match ? "user" : "digest",
			snippet: match?.text ?? line,
			timestamp: match?.ts ?? null,
			receipt_id: receiptId ?? null,
			confidence: match ? 0.92 : 0.75,
		});
	}
	return evidence;
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

function buildPageDraft({ digest, messages, intent, conversationId, extractionRunId }) {
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
	const evidence = buildEvidence(lines, messages);
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
		extraction_run_id: extractionRunId,
		confidence: evidence.some((e) => e.source_type === "user_message") ? 0.9 : 0.78,
		health_state: "active",
		importance_class: decisions.length ? "important" : "ordinary",
		cluster: intent.topic ? normalizeLabel(intent.topic) : canonicalTitle(title),
		role_type: "container",
		related,
		evidence,
		keyPoints,
		decisions,
		nextSteps,
	};
}

function findPageMatch(pages, draft, intent, conversationId) {
	if (intent.explicitNew) return null;
	const sameConversation = (p) => conversationId && p.source_conversation_id === conversationId;
	const sameTopic = (p) => draft.topic_filter && p.topic_filter === draft.topic_filter;
	const sameTitle = (p) => p.canonical_title === draft.canonical_title;
	return pages.find((p) => (
		p.source_mode === "manual_collect" &&
		(sameTopic(p) || sameTitle(p) || (intent.updateRequested && sameConversation(p)))
	)) ?? null;
}

function suppressedBy(rows, kind, key) {
	return rows.find((s) => s.kind === kind && s.canonical_key === key);
}

function pageReceipt({ action, page, runId, received, digested, relatedCount, skipped = [], suppressed = false }) {
	const created = action === "create" ? [{ id: page.id, title: page.title }] : [];
	const updated = action === "update" || action === "reinforce" ? [{ kind: "memory_page", id: page.id, title: page.title }] : [];
	const receipt = {
		outcome: suppressed ? "suppressed" : "wrote",
		source: "save_conversation",
		source_mode: "manual_collect",
		extraction_run_id: runId,
		received,
		digested,
		saved: {
			pages: suppressed ? 0 : 1,
			nodes: 0,
			newNodeLabels: [],
			autoCreated: [],
			updatedNodes: 0,
			slices: 0,
			events: 0,
			edges: 0,
			candidates: 0,
		},
		savedTotal: suppressed ? 0 : 1,
		actions: {
			createdPages: created,
			updatedPages: updated,
			reinforcedPages: action === "reinforce" ? updated : [],
			skippedObjects: skipped,
			suppressedObjects: suppressed ? [{ kind: "memory_page", title: page.title }] : [],
		},
		skipped: skipped.length,
		skippedReasons: Object.fromEntries(skipped.map((item) => [item.reason, (item.count ?? 1)])),
		relatedConceptsKeptInPage: relatedCount,
		created_at: Date.now(),
	};
	return receipt;
}

function pageSummary(action, page, receipt) {
	const verb = action === "create" ? "Saved as one memory page" : "Updated one memory page";
	const related = receipt.relatedConceptsKeptInPage ?? 0;
	const skipped = related
		? `\n\nSkipped graph node creation for ${related} related concept(s) because this was manual_collect mode.`
		: "";
	return `${verb}:\n${page.title}${skipped}\nReceipt: ${receipt.extraction_run_id}`;
}

export async function saveMemoryPage(env, userId, { digest, messages, intent, received, keptLines, conversationId }) {
	const runId = await createExtractionRun(env, userId, {
		toolName: "save_conversation",
		sourceMode: "manual_collect",
		topicFilter: intent.topic ? normalizeLabel(intent.topic) : null,
		status: "running",
	});

	const draft = buildPageDraft({ digest, messages, intent, conversationId, extractionRunId: runId });
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
		page = { ...draft, id: match.id, title: draft.title || match.title };
		await env.DB.prepare(
			`UPDATE memory_pages SET
				title = ?, canonical_title = ?, topic_filter = ?, short_summary = ?, full_markdown = ?,
				sections_json = ?, key_points_json = ?, decisions_json = ?, next_steps_json = ?,
				related_concepts_json = ?, evidence_json = ?, source_conversation_id = COALESCE(?, source_conversation_id),
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
				 source_conversation_id, extraction_run_id, created_at, updated_at, last_seen_at,
				 heat_score, confidence, health_state, importance_class, cluster, role_type)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
