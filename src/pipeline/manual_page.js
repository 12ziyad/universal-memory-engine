import { getActiveSuppressions, getUserPages } from "../lib/db.js";
import { canonicalIdentity, manualIdentitySimilarity } from "./manual_identity.js";
import { sourceMeta } from "./source.js";
import {
	buildPageDraft,
	findPageMatch,
	isDuplicateCollect,
	mergePageDraft,
	suppressedBy,
} from "./pages.js";

function canonicalPageResolution(pages, identities = []) {
	const scored = [];
	for (const page of pages ?? []) {
		if (page.source_mode !== "manual_collect") continue;
		let score = 0;
		let matchedBy = null;
		for (const identity of identities ?? []) {
			if (identity?.existing_node_id && page.node_id === identity.existing_node_id) {
				score = 1;
				matchedBy = "node_id";
				break;
			}
			for (const name of [identity?.label, ...(identity?.aliases ?? [])].filter(Boolean)) {
				const candidate = Math.max(
					manualIdentitySimilarity(name, page.title),
					manualIdentitySimilarity(name, page.canonical_title),
					canonicalIdentity(name) === canonicalIdentity(page.canonical_title) ? 1 : 0,
				);
				if (candidate > score) {
					score = candidate;
					matchedBy = name;
				}
			}
		}
		if (score >= 0.94) scored.push({ page, score, matchedBy });
	}
	scored.sort((left, right) => right.score - left.score || String(left.page.id).localeCompare(String(right.page.id)));
	if (!scored.length) return { decision: "none", page: null, matches: [] };
	if (scored[1] && scored[1].score >= scored[0].score - 0.03) {
		return {
			decision: "ambiguous",
			page: null,
			matches: scored.slice(0, 4).map((item) => ({ id: item.page.id, title: item.page.title, score: item.score, matched_by: item.matchedBy })),
		};
	}
	return { decision: "existing", page: scored[0].page, matches: [] };
}

/** Plan one manual conversation page without writing or creating a receipt. */
export async function buildManualPagePlan(env, userId, input = {}) {
	const source = sourceMeta(input.sourcePacket);
	const userMessages = (input.messages ?? []).filter((message) => (message?.role ?? "user") === "user");
	const groundedSourcePacket = input.sourcePacket
		? { ...input.sourcePacket, messages: userMessages }
		: null;
	const draft = {
		...buildPageDraft({
			digest: input.digest,
			messages: userMessages,
			intent: input.intent,
			conversationId: input.conversationId,
			extractionRunId: input.runId,
			// The receipt is persisted after the atomic page+graph write. Do not put a
			// preallocated, potentially unstored receipt id into the page or evidence.
			receiptId: null,
			fallbackReceiptToRun: false,
			preferredTitle: input.preferredTitle,
			corrections: input.corrections,
			sourcePacket: groundedSourcePacket,
		}),
		source_thread_id: input.sourcePacket?.thread_id ?? null,
		scope_json: source.scope_json ?? null,
	};
	// Manual page identity is deliberately narrower than fuzzy page matching.
	// A stable topic owns one page when supplied; otherwise the deterministic
	// canonical title owns it. The write layer claims this key atomically.
	const baseIdentityKey = draft.topic_filter || draft.canonical_title;
	draft.identity_key = input.intent?.explicitNew
		? `${baseIdentityKey}:${source.source_packet_id ?? draft.input_hash ?? draft.id}`
		: baseIdentityKey;
	const suppressions = await getActiveSuppressions(env, userId);
	const suppression = suppressedBy(suppressions, "memory_page", draft.canonical_title)
		?? (draft.topic_filter ? suppressedBy(suppressions, "memory_page", draft.topic_filter) : null);
	if (suppression) {
		return {
			action: "suppressed",
			page: draft,
			write: false,
			reason: "suppressed_blocked",
			skipped: [{ kind: "memory_page", label: draft.title, reason: "suppressed_blocked" }],
		};
	}

	const pages = await getUserPages(env, userId);
	// Exact retries must remain duplicates even when a later graph extraction
	// supplies a better preferred title than the page's original draft had.
	const exactRetry = pages.find((page) => isDuplicateCollect(page, draft, input.sourcePacket)) ?? null;
	const canonicalResolution = canonicalPageResolution(pages, input.identityHints);
	if (canonicalResolution.decision === "ambiguous") {
		return {
			action: "ambiguous",
			page: draft,
			write: false,
			reason: "multiple_existing_pages_match",
			page_conflicts: canonicalResolution.matches,
			newPages: [],
			pageUpdates: [],
			pageClaims: [],
			skipped: [{ kind: "memory_page", label: draft.title, reason: "multiple_existing_pages_match" }],
		};
	}
	const match = exactRetry ?? canonicalResolution.page ?? findPageMatch(pages, draft, input.intent, input.conversationId);
	if (match && isDuplicateCollect(match, draft, input.sourcePacket)) {
		return {
			action: "duplicate",
			page: {
				...draft,
				id: match.id,
				title: match.title || draft.title,
				canonical_title: match.canonical_title || draft.canonical_title,
			},
			match,
			write: false,
			reason: "duplicate_memory_page",
			skipped: [{ kind: "memory_page", id: match.id, label: match.title, reason: "duplicate_memory_page" }],
		};
	}

	const now = Date.now();
	if (match) {
		const action = input.corrections?.length || input.intent?.updateRequested ? "updated" : "reinforced";
		const page = mergePageDraft(match, draft, {
			// Canonical existing page titles are stable; a correction or differently
			// worded save must not rename the page.
			preferDraftTitle: false,
			corrections: input.corrections,
		});
		const expectedRevision = Number(match.manual_revision ?? 0);
		return {
			action,
			page,
			match,
			write: true,
			pageUpdates: [{
				page,
				conversationId: input.conversationId,
				runId: input.runId,
				now,
				expected_revision: expectedRevision,
				expected_updated_at: match.updated_at ?? null,
			}],
			pageClaims: [],
			newPages: [],
			skipped: [],
		};
	}

	const page = {
		...draft,
		created_at: now,
		updated_at: now,
		last_seen_at: now,
		heat_score: 1,
		manual_revision: 0,
	};
	return {
		action: "created",
		page,
		write: true,
		newPages: [page],
		pageUpdates: [],
		pageClaims: [{
			identity_key: page.identity_key,
			page_id: page.id,
			created_at: now,
		}],
		skipped: [],
	};
}
