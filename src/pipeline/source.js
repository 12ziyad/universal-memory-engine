import { newId } from "../lib/ids.js";

const PREVIEW_LIMIT = 900;
const SNIPPET_LIMIT = 900;

function cleanText(value, fallback = "") {
	const text = String(value ?? fallback).replace(/\s+/g, " ").trim();
	return text;
}

function cleanKey(value, fallback = null) {
	const text = cleanText(value);
	return text || fallback;
}

function safeRole(role) {
	const value = String(role ?? "user").toLowerCase();
	if (["user", "assistant", "system", "tool"].includes(value)) return value;
	return "user";
}

function numberOrNow(value) {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : Date.now();
}

function clamp(value, limit = PREVIEW_LIMIT) {
	const text = cleanText(value);
	if (text.length <= limit) return text;
	return `${text.slice(0, limit - 3).trim()}...`;
}

export async function hashText(value) {
	const data = new TextEncoder().encode(String(value ?? ""));
	const digest = await crypto.subtle.digest("SHA-256", data);
	return [...new Uint8Array(digest)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export function resolveScope(userId, input = {}) {
	const scope = input && typeof input === "object" ? input : {};
	const ownerUserId = cleanKey(scope.owner_user_id ?? scope.ownerUserId ?? scope.ownerId, userId);
	const externalUserId = cleanKey(scope.external_user_id ?? scope.externalUserId ?? scope.endUserId ?? scope.userId, userId);
	const sessionId = cleanKey(scope.session_id ?? scope.sessionId ?? scope.session ?? scope.threadId, null);
	const threadId = cleanKey(scope.thread_id ?? scope.threadId, null);
	return {
		user_id: userId,
		memory_user_id: cleanKey(scope.memory_user_id ?? scope.memoryUserId, userId),
		owner_user_id: ownerUserId,
		external_user_id: externalUserId,
		scope_user_id: userId,
		workspace_id: cleanKey(scope.workspace_id ?? scope.workspaceId, "default"),
		app_id: cleanKey(scope.app_id ?? scope.appId ?? scope.app, "uml"),
		agent_id: cleanKey(scope.agent_id ?? scope.agentId ?? scope.agent, null),
		session_id: sessionId,
		thread_id: threadId,
		topic: cleanKey(scope.topic ?? scope.topic_filter ?? scope.topicFilter, null),
		source_scope: cleanKey(scope.source_scope ?? scope.sourceScope ?? scope.name, null),
	};
}

export async function stableSourceMessageId(namespace, role, content) {
	const hash = await hashText(`${namespace ?? "source"}:${role ?? "user"}:${content ?? ""}`);
	return `msg_${hash.slice(0, 24)}`;
}

export async function normalizeMessages(messages = [], opts = {}) {
	const conversationId = opts.conversationId ?? opts.sessionId ?? opts.namespace ?? "source";
	const out = [];
	for (const raw of messages ?? []) {
		const role = safeRole(typeof raw === "string" ? "user" : raw?.role);
		const content = typeof raw === "string" ? raw : raw?.content;
		const text = String(content ?? "").trim();
		if (!text) continue;
		const contentHash = await hashText(text);
		const id = raw?.id ?? await stableSourceMessageId(conversationId, role, text);
		out.push({
			id,
			role,
			content: text,
			ts: numberOrNow(raw?.ts),
			content_hash: contentHash,
		});
	}
	return out;
}

export async function normalizeSourcePacket(userId, input = {}) {
	const scope = resolveScope(userId, input.scope);
	const sourceType = cleanKey(input.sourceType ?? input.type, input.content ? "message" : "message_batch");
	const sourceMode = cleanKey(input.sourceMode ?? input.mode, "ingest");
	const conversationId = cleanKey(input.conversationId ?? input.conversation_id, null);
	const threadId = cleanKey(input.threadId ?? input.thread_id ?? scope.thread_id, null);
	const sessionId = scope.session_id ?? conversationId ?? threadId ?? userId;
	const sourceRole = cleanKey(input.sourceRole ?? input.role, null);
	const topic = cleanKey(input.topic ?? scope.topic, null);
	const messages = await normalizeMessages(
		input.messages ?? (input.content ? [{ id: input.messageId, role: input.role ?? "user", content: input.content, ts: input.ts }] : []),
		{ conversationId: conversationId ?? sessionId, sessionId },
	);
	const hashPayload = {
		sourceType,
		sourceMode,
		conversationId,
		threadId,
		topic,
		scope,
		messages: messages.map((m) => ({
			id: m.id,
			role: m.role,
			content_hash: m.content_hash,
		})),
	};
	const contentHash = await hashText(JSON.stringify(hashPayload));
	const explicitSourceId = cleanKey(input.sourceId ?? input.source_id ?? input.id, null);
	const idempotencyKey = cleanKey(
		input.idempotencyKey ?? input.idempotency_key,
		explicitSourceId
			? `${sourceType}:${sourceMode}:${scope.workspace_id}:${scope.app_id}:${explicitSourceId}`
			: `${sourceType}:${sourceMode}:${scope.workspace_id}:${scope.app_id}:${conversationId ?? threadId ?? sessionId}:${contentHash}`,
	);
	const preview = clamp(messages.map((m) => m.content).join("\n"));
	const rawMeta = {
		messages: messages.map((m) => ({
			id: m.id,
			role: m.role,
			ts: m.ts,
			content_hash: m.content_hash,
			snippet: clamp(m.content, 240),
		})),
	};

	return {
		scope,
		messages,
		packet: {
			user_id: userId,
			...scope,
			memory_user_id: scope.memory_user_id,
			owner_user_id: scope.owner_user_id,
			external_user_id: scope.external_user_id,
			session_id: sessionId,
			source_type: sourceType,
			source_mode: sourceMode,
			source_id: explicitSourceId,
			source_role: sourceRole,
			conversation_id: conversationId,
			thread_id: threadId,
			topic,
			idempotency_key: idempotencyKey,
			content_hash: contentHash,
			content_preview: preview,
			message_count: messages.length,
			raw_meta_json: JSON.stringify(rawMeta),
			received_at: numberOrNow(input.receivedAt),
			messages,
		},
	};
}

export async function storeSourcePacket(env, packet) {
	if (!env?.DB || !packet) return null;
	const now = Date.now();
	const id = packet.id ?? newId("src");
	try {
		const row = await env.DB.prepare(
			`INSERT INTO source_packets
				(id, user_id, memory_user_id, owner_user_id, external_user_id, scope_user_id,
				 workspace_id, app_id, agent_id, session_id, source_scope,
				 source_type, source_mode, source_id, source_role, conversation_id, thread_id, topic,
				 idempotency_key, content_hash, content_preview, message_count, raw_meta_json,
				 seen_count, received_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(user_id, idempotency_key) DO UPDATE SET
				memory_user_id = excluded.memory_user_id,
				owner_user_id = excluded.owner_user_id,
				external_user_id = excluded.external_user_id,
				scope_user_id = excluded.scope_user_id,
				workspace_id = excluded.workspace_id,
				app_id = excluded.app_id,
				agent_id = excluded.agent_id,
				session_id = excluded.session_id,
				source_scope = excluded.source_scope,
				source_mode = excluded.source_mode,
				topic = excluded.topic,
				content_hash = excluded.content_hash,
				content_preview = excluded.content_preview,
				message_count = excluded.message_count,
				raw_meta_json = excluded.raw_meta_json,
				seen_count = COALESCE(source_packets.seen_count, 0) + 1,
				received_at = excluded.received_at,
				updated_at = excluded.updated_at
			 RETURNING id, seen_count`,
		)
			.bind(
				id,
				packet.user_id,
				packet.memory_user_id,
				packet.owner_user_id,
				packet.external_user_id,
				packet.scope_user_id,
				packet.workspace_id,
				packet.app_id,
				packet.agent_id,
				packet.session_id,
				packet.source_scope,
				packet.source_type,
				packet.source_mode,
				packet.source_id,
				packet.source_role,
				packet.conversation_id,
				packet.thread_id,
				packet.topic,
				packet.idempotency_key,
				packet.content_hash,
				packet.content_preview,
				packet.message_count,
				packet.raw_meta_json,
				1,
				packet.received_at ?? now,
				now,
				now,
			)
			.first();
		return { ...packet, id: row?.id ?? id, seen_count: row?.seen_count ?? 1 };
	} catch (err) {
		console.warn("source packet store failed:", err?.message ?? err);
		return { ...packet, id: null, error: String(err?.message ?? err) };
	}
}

export function sourceMeta(sourcePacket) {
	if (!sourcePacket) return {};
	return {
		source_packet_id: sourcePacket.id ?? null,
		source_content_hash: sourcePacket.content_hash ?? null,
		idempotency_key: sourcePacket.idempotency_key ?? null,
		scope_json: JSON.stringify({
			user_id: sourcePacket.scope_user_id,
			memory_user_id: sourcePacket.memory_user_id,
			owner_user_id: sourcePacket.owner_user_id,
			external_user_id: sourcePacket.external_user_id,
			workspace_id: sourcePacket.workspace_id,
			app_id: sourcePacket.app_id,
			agent_id: sourcePacket.agent_id,
			session_id: sourcePacket.session_id,
			thread_id: sourcePacket.thread_id,
			topic: sourcePacket.topic,
			source_scope: sourcePacket.source_scope,
			source_type: sourcePacket.source_type,
			source_mode: sourcePacket.source_mode,
		}),
	};
}

export function sourceEvidenceFromPacket(sourcePacket, opts = {}) {
	if (!sourcePacket?.messages?.length) return [];
	return sourcePacket.messages
		.filter((m) => ["user", "assistant"].includes(m.role))
		.map((m) => ({
			source_type: `${m.role}_message`,
			source_packet_id: sourcePacket.id ?? null,
			source_message_id: m.id ?? null,
			source_role: m.role,
			snippet: clamp(m.content, SNIPPET_LIMIT),
			timestamp: m.ts ?? null,
			content_hash: m.content_hash ?? null,
			receipt_id: opts.receiptId ?? null,
			confidence: m.role === "user" ? 0.92 : 0.72,
		}));
}
