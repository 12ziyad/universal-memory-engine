/**
 * Conversation Pages — deterministic conversation identity for the explicit
 * conversation doors (MCP save_conversation, REST /v1/save mode:"conversation").
 *
 * The contract (Campaign A):
 *   - a stable explicit conversation/thread id converges to ONE live page per
 *     (account, project, conversation); the partial unique index
 *     idx_memory_pages_conversation_identity (migration 0050) is the
 *     convergence authority — code treats a constraint loss as "someone else
 *     created it, re-read and advance";
 *   - a later explicit batch ADVANCES that page as a forward revision through
 *     the existing revision machinery (fenced CAS participation, history via
 *     the safe-update system's lazy snapshots, user-authored text never
 *     silently reverted);
 *   - legacy rows keep conversation_key NULL. Identity may be ADOPTED onto a
 *     legacy conversation-door page only when exactly one live page carries
 *     the same source_conversation_id in scope — an evidence-based claim,
 *     CAS-guarded, race-settled by the unique index. Nothing is invented.
 *
 * Rollout flag CONVERSATION_PAGES: "on" enables identity + REST pages;
 * anything else is "track" (schema + source links live, behavior unchanged).
 */

import { newId } from "../lib/ids.js";
import { applyFencedUpdate } from "../lib/memory_versions.js";

/** Modes with live conversation-door pages that identity may bind to. */
const CONVERSATION_SOURCE_MODES = ["mcp_save", "conversation_collect"];

/** Bounded-advance contract: a page accepts at most this many linked batches. */
export const CONVERSATION_ADVANCE_LIMIT = 200;

/**
 * Rendered-markdown budget per page. Well under D1's 100KB statement cap with
 * every other bound column included; the workspace read surface caps display
 * at 20k on its own. Oldest advance sections trim first — the newest material
 * is never silently lost, and a truthful marker records the trim.
 */
export const CONVERSATION_MARKDOWN_CAP = 24_000;

const ADVANCE_HEADING = "## Update — ";
const CONVERSATION_KEY_MAX = 200;

export function conversationPagesMode(env) {
	return String(env?.CONVERSATION_PAGES ?? "").toLowerCase() === "on" ? "on" : "track";
}

/**
 * The canonical conversation identity for one explicit batch: the caller's
 * conversationId, else threadId. Null when neither was supplied — then each
 * distinct explicit batch legitimately makes its own page and replays stay
 * safe through packet idempotency alone.
 */
export function conversationKeyFrom({ conversationId, threadId } = {}) {
	const raw = String(conversationId ?? "").trim() || String(threadId ?? "").trim();
	if (!raw) return null;
	return raw.slice(0, CONVERSATION_KEY_MAX);
}

const PAGE_COLUMNS =
	"id, user_id, title, canonical_title, source_mode, conversation_key, source_conversation_id, " +
	"source_packet_id, input_hash, idempotency_key, enrich_status, full_markdown, short_summary, " +
	"message_count, revision, created_at, updated_at, deleted_at, archived_at, suppressed_at, " +
	"project_id, project_name";

/**
 * The live page owning this conversation identity, or null.
 *
 * Adoption: when no page owns the key yet, and EXACTLY ONE live
 * conversation-door page in scope carries the same source_conversation_id
 * with no identity claimed, that page is adopted (covers both pre-0050 rows
 * and rows written between migration apply and code deploy). The COUNT
 * evidence predicate and the conversation_key IS NULL CAS run in one
 * statement, and the unique index settles any race — a lost claim simply
 * re-reads whoever won.
 */
export async function resolveConversationPage(env, userId, { projectId = null, conversationKey }) {
	if (!conversationKey) return null;
	const byKey = () => env.DB.prepare(
		`SELECT ${PAGE_COLUMNS} FROM memory_pages
		 WHERE user_id = ? AND project_id IS ? AND conversation_key = ? AND deleted_at IS NULL
		 LIMIT 1`,
	).bind(userId, projectId, conversationKey).first();

	const owned = await byKey();
	if (owned) return owned;

	const modeList = CONVERSATION_SOURCE_MODES.map(() => "?").join(", ");
	try {
		await env.DB.prepare(
			`UPDATE memory_pages SET conversation_key = ?, updated_at = ?
			 WHERE user_id = ? AND project_id IS ? AND deleted_at IS NULL
			   AND conversation_key IS NULL
			   AND source_conversation_id = ?
			   AND source_mode IN (${modeList})
			   AND (
				 SELECT COUNT(*) FROM memory_pages
				  WHERE user_id = ? AND project_id IS ? AND deleted_at IS NULL
					AND source_conversation_id = ? AND source_mode IN (${modeList})
			   ) = 1`,
		).bind(
			conversationKey, Date.now(),
			userId, projectId, conversationKey, ...CONVERSATION_SOURCE_MODES,
			userId, projectId, conversationKey, ...CONVERSATION_SOURCE_MODES,
		).run();
	} catch (error) {
		// A concurrent creator claimed the identity between our read and this
		// claim — the unique index refused the adoption. Whoever won owns it.
		if (!isUniqueConstraintError(error)) throw error;
	}
	return byKey();
}

export function isUniqueConstraintError(error) {
	return /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(String(error?.message ?? error));
}

/**
 * Record one accepted batch as this page's next linked source. Idempotent per
 * (page, packet); seq is advisory ordering, ties are settled by created_at.
 */
export async function linkConversationPageSource(env, userId, { pageId, sourcePacketId }) {
	if (!pageId || !sourcePacketId) return { linked: false };
	const now = Date.now();
	// OR IGNORE (not WHERE NOT EXISTS): two concurrent exact retries can both
	// pass a read-then-insert check; the primary key is the authority and a
	// replayed link is simply a no-op.
	const result = await env.DB.prepare(
		`INSERT OR IGNORE INTO conversation_page_sources (user_id, page_id, source_packet_id, seq, created_at)
		 SELECT ?, ?, ?,
			COALESCE((SELECT MAX(seq) FROM conversation_page_sources WHERE user_id = ? AND page_id = ?), 0) + 1,
			?`,
	).bind(userId, pageId, sourcePacketId, userId, pageId, now).run();
	return { linked: Number(result?.meta?.changes ?? 0) > 0 };
}

export async function countConversationPageSources(env, userId, pageId) {
	const row = await env.DB.prepare(
		"SELECT COUNT(*) AS n FROM conversation_page_sources WHERE user_id = ? AND page_id = ?",
	).bind(userId, pageId).first();
	return Number(row?.n ?? 0);
}

/**
 * Distinct stable message ids across every linked packet — the truthful
 * message_count. Returns null (unknown, never a guess) when any linked packet
 * no longer exposes message identity (minimized/erased packets).
 */
export async function conversationMessageCount(env, userId, pageId) {
	const { results } = await env.DB.prepare(
		`SELECT sp.raw_meta_json FROM conversation_page_sources cps
		 JOIN source_packets sp ON sp.id = cps.source_packet_id AND sp.user_id = cps.user_id
		 WHERE cps.user_id = ? AND cps.page_id = ?
		 ORDER BY cps.seq LIMIT ?`,
	).bind(userId, pageId, CONVERSATION_ADVANCE_LIMIT).all();
	const ids = new Set();
	for (const row of results ?? []) {
		let meta = null;
		try { meta = JSON.parse(row.raw_meta_json ?? "null"); } catch {}
		const messages = Array.isArray(meta?.messages) ? meta.messages : null;
		if (!messages) return null;
		for (const message of messages) {
			const id = message?.id ?? message?.message_id ?? null;
			if (!id) return null;
			ids.add(String(id));
		}
	}
	return ids.size;
}

/**
 * Mark an existing page as processing a new advance: state + packet pointers,
 * revision participation (fenced CAS on the revision the caller read). The
 * caller MUST inspect `applied` — a lost CAS means the page moved and the
 * caller re-reads before retrying. Content is not touched here; the advance's
 * text lands at finalize, where the extraction outcome is known.
 */
export async function stageConversationAdvance(env, userId, { page, sourcePacket, projectId = null }) {
	const now = Date.now();
	const expected = Number(page?.revision) >= 1 ? Number(page.revision) : 1;
	const statement = env.DB.prepare(
		`UPDATE memory_pages SET
			enrich_status = 'staged', updated_at = ?, last_seen_at = ?,
			source_packet_id = ?, input_hash = ?, idempotency_key = ?,
			heat_score = COALESCE(heat_score, 0) + 1,
			revision = COALESCE(revision, 1) + 1
		 WHERE id = ? AND user_id = ? AND project_id IS ?
		   AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL
		   AND COALESCE(revision, 1) = ?`,
	).bind(
		now, now,
		sourcePacket?.id ?? null,
		sourcePacket?.content_hash ?? null,
		sourcePacket?.idempotency_key ?? null,
		page.id, userId, projectId,
		expected,
	);
	return applyFencedUpdate(statement, { label: "conversation page advance staging" });
}

/**
 * Append one advance section to the rendered markdown, bounded. When the
 * budget is exceeded, the OLDEST advance sections are trimmed first and a
 * truthful marker records how many were removed — the newest material is
 * never silently lost, and the full history stays reachable through the
 * page's linked sources.
 */
export function appendAdvanceSection(existingMarkdown, sectionMarkdown, { cap = CONVERSATION_MARKDOWN_CAP } = {}) {
	const existing = String(existingMarkdown ?? "").trimEnd();
	const section = String(sectionMarkdown ?? "").trim();
	if (!section) return { markdown: existing, trimmed: 0 };
	const combined = existing ? `${existing}\n\n${section}` : section;
	if (combined.length <= cap) return { markdown: combined, trimmed: 0 };

	const marker = `\n${ADVANCE_HEADING}`;
	if (!combined.includes(marker)) {
		// No earlier advance sections to trim: keep the head, clamp hard.
		return { markdown: `${combined.slice(0, cap - 2)}…`, trimmed: 0, clamped: true };
	}
	const parts = combined.split(marker);
	const head = parts[0].replace(/\n_\(\d+ earlier update[\s\S]*?\)_\s*$/, "").trimEnd();
	const sections = parts.slice(1);
	let trimmed = 0;
	for (;;) {
		const note = trimmed
			? `\n\n_(${trimmed} earlier update${trimmed === 1 ? "" : "s"} trimmed for size — the full history remains in this page's linked sources.)_`
			: "";
		const candidate = [head + note, ...sections.map((s) => ADVANCE_HEADING + s)].join("\n\n");
		if (candidate.length <= cap) return { markdown: candidate, trimmed };
		if (sections.length <= 1) {
			return { markdown: `${candidate.slice(0, cap - 2)}…`, trimmed, clamped: true };
		}
		sections.shift();
		trimmed += 1;
	}
}

/** The markdown heading for one advance's section. */
export function advanceHeading(dateText) {
	return `${ADVANCE_HEADING}${dateText}`;
}

/** Deterministic id + payload for a REST-lane page-follower job. */
export function pageFollowJobKey(sourcePacketId) {
	return `pagefollow:v1:${sourcePacketId}`;
}

export function newConversationPageId() {
	return newId("page");
}
