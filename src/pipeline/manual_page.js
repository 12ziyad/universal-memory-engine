import { getActiveSuppressions, getUserPages } from "../lib/db.js";
import { sourceMeta } from "./source.js";
import {
	buildPageDraft,
	findPageMatch,
	isDuplicateCollect,
	mergePageDraft,
	suppressedBy,
} from "./pages.js";

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
			receiptId: input.receiptId,
			sourcePacket: groundedSourcePacket,
		}),
		source_thread_id: input.sourcePacket?.thread_id ?? null,
		scope_json: source.scope_json ?? null,
	};
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
	const match = findPageMatch(pages, draft, input.intent, input.conversationId);
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
		const action = input.intent?.updateRequested ? "updated" : "reinforced";
		const page = mergePageDraft(match, draft, { preferDraftTitle: Boolean(input.intent?.updateRequested) });
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
			}],
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
	};
	return {
		action: "created",
		page,
		write: true,
		newPages: [page],
		pageUpdates: [],
		skipped: [],
	};
}
