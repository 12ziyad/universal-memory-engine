import { newId } from "../lib/ids.js";
import { normalizeDeliveryMetadata } from "../lib/ingest_contract.mjs";
import { normalizeProjectScope } from "../lib/project_scope.js";

const PREVIEW_LIMIT = 900;
const SNIPPET_LIMIT = 900;
const SCOPED_IDEMPOTENCY_PREFIX = "itsuki-scope:v1:";
const EXTRACTION_CONTEXT_SCHEMA = "itsuki.extract-context/v1";

function cleanText(value, fallback = "") {
	const text = String(value ?? fallback).replace(/\s+/g, " ").trim();
	return text;
}

function cleanKey(value, fallback = null) {
	const text = cleanText(value);
	return text || fallback;
}

function record(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function parseRecord(value) {
	if (typeof value !== "string" || !value.trim()) return {};
	try {
		return record(JSON.parse(value));
	} catch {
		return {};
	}
}

function firstKey(records, keys, fallback = null) {
	for (const candidate of records) {
		for (const key of keys) {
			if (!Object.prototype.hasOwnProperty.call(candidate, key)) continue;
			const value = cleanKey(candidate[key], null);
			if (value !== null) return value;
		}
	}
	return fallback;
}

function firstBoolean(records, keys) {
	for (const candidate of records) {
		for (const key of keys) {
			if (!Object.prototype.hasOwnProperty.call(candidate, key)) continue;
			const value = candidate[key];
			if (value === true || value === 1 || value === "true") return true;
			if (value === false || value === 0 || value === "false") return false;
		}
	}
	return null;
}

function sourceContextRecords(input = {}) {
	const direct = record(input);
	const nestedSourcePacket = record(direct.sourcePacket ?? direct.packet);
	const directIsSourcePacket = !Object.keys(nestedSourcePacket).length && Boolean(
		direct.raw_meta_json
			?? direct.rawMetaJson
			?? direct.idempotency_key
			?? direct.idempotencyKey
			?? direct.source_type
			?? direct.sourceType,
	);
	const sourcePacket = directIsSourcePacket ? direct : nestedSourcePacket;
	const scope = record(direct.scope);
	const meta = record(direct.meta);
	const directScopeJson = parseRecord(direct.scope_json ?? direct.scopeJson);
	const metaScopeJson = parseRecord(meta.scope_json ?? meta.scopeJson);
	const packetScopeJson = parseRecord(sourcePacket.scope_json ?? sourcePacket.scopeJson);
	const rawMeta = parseRecord(sourcePacket.raw_meta_json ?? sourcePacket.rawMetaJson);
	return {
		direct,
		sourcePacket,
		directIsSourcePacket,
		// Explicit call-site fields take precedence. Packet fields remain a
		// canonical fallback for delayed work reconstructed from D1.
		records: [direct, scope, directScopeJson, meta, metaScopeJson, sourcePacket, packetScopeJson, rawMeta],
	};
}

function explicitSessionId(context, memoryUserId) {
	// A normalized source packet always has session_id, even when the caller did
	// not supply one. Never infer explicitness from that fallback field alone.
	const explicitRecords = context.directIsSourcePacket ? [] : context.records.slice(0, 2);
	const explicitSession = firstKey(explicitRecords, ["session_id", "sessionId", "session"]);
	const explicitMarker = firstBoolean(explicitRecords, ["session_id_explicit", "sessionIdExplicit"]);
	if (explicitSession && explicitMarker !== false) return explicitSession;

	const persistedRecords = context.records.slice(2);
	const persistedSession = firstKey(persistedRecords, ["session_id", "sessionId", "session"]);
	const persistedMarker = firstBoolean(persistedRecords, ["session_id_explicit", "sessionIdExplicit"]);
	if (
		persistedSession
		&& persistedMarker !== false
		&& (persistedMarker === true || persistedSession !== memoryUserId)
	) return persistedSession;
	return null;
}

/**
 * Canonical extraction-context descriptor. Project is attribution, while the
 * conversation/thread/session source is the actual context boundary. The
 * caller must provide an acceptance id when no stronger durable identity is
 * available; silently falling back to the account would mix conversations.
 */
export function sourceContextDescriptor(memoryUserId, input = {}) {
	const context = sourceContextRecords(input);
	const memoryId = cleanKey(
		memoryUserId ?? firstKey(context.records, ["memory_user_id", "memoryUserId", "user_id", "userId"]),
		null,
	);
	if (!memoryId) throw new TypeError("memoryUserId is required for extraction context identity");

	const projectId = normalizeProjectScope({
		projectId: firstKey(context.records, ["project_id", "projectId"]),
	}).projectId;
	const workspaceId = firstKey(context.records, ["workspace_id", "workspaceId"], "default");
	const appId = firstKey(context.records, ["app_id", "appId"], "uml");
	const agentId = firstKey(context.records, ["agent_id", "agentId"]);
	const sourceScope = firstKey(context.records, ["source_scope", "sourceScope"]);

	const conversationId = firstKey(context.records, ["conversation_id", "conversationId"]);
	const threadId = firstKey(context.records, ["thread_id", "threadId"]);
	const sessionId = explicitSessionId(context, memoryId);
	const sourcePacketId = firstKey(context.records, ["source_packet_id", "sourcePacketId"])
		?? cleanKey(context.sourcePacket.id, null);
	const jobId = firstKey(context.records, ["job_id", "jobId"]);
	const handoffId = firstKey(context.records, ["handoff_id", "handoffId"]);
	const acceptanceId = firstKey([context.direct], ["acceptance_id", "acceptanceId"]);
	const primary = [
		["conversation", conversationId],
		["thread", threadId],
		["session", sessionId],
		["source_packet", sourcePacketId],
		["job", jobId],
		["handoff", handoffId],
		["acceptance", acceptanceId],
	].find(([, id]) => id);
	if (!primary) {
		throw new TypeError("acceptanceId is required when extraction context has no durable source identity");
	}

	return [
		EXTRACTION_CONTEXT_SCHEMA,
		memoryId,
		projectId,
		workspaceId,
		appId,
		agentId,
		sourceScope,
		primary[0],
		primary[1],
	];
}

export async function sourceContextIdentity(memoryUserId, input = {}) {
	const descriptor = sourceContextDescriptor(memoryUserId, input);
	const digest = await hashText(JSON.stringify(descriptor));
	return {
		contextKey: `context:v1:${digest}`,
		descriptor,
	};
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
	const project = normalizeProjectScope(scope);
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
		project_id: project.projectId,
		project_name: project.projectName,
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
	const rawScope = record(input.scope);
	const explicitSession = cleanKey(
		input.sessionId
			?? input.session_id
			?? rawScope.session_id
			?? rawScope.sessionId
			?? rawScope.session,
			null,
	);
	// Top-level session aliases are accepted by several internal callers. Fold
	// them into the canonical scope so content hashes and idempotency ownership
	// cannot collapse otherwise-distinct explicit sessions.
	const scope = resolveScope(userId, explicitSession
		? { ...rawScope, session_id: explicitSession }
		: rawScope);
	const sourceType = cleanKey(input.sourceType ?? input.type, input.content ? "message" : "message_batch");
	const sourceMode = cleanKey(input.sourceMode ?? input.mode, "ingest");
	const conversationId = cleanKey(input.conversationId ?? input.conversation_id, null);
	const threadId = cleanKey(input.threadId ?? input.thread_id ?? scope.thread_id, null);
	const sessionId = explicitSession ?? scope.session_id ?? conversationId ?? threadId ?? userId;
	const sourceRole = cleanKey(input.sourceRole ?? input.role, null);
	const topic = cleanKey(input.topic ?? scope.topic, null);
	const delivery = normalizeDeliveryMetadata(input.delivery);
	const messages = await normalizeMessages(
		input.messages ?? (input.content ? [{ id: input.messageId, role: input.role ?? "user", content: input.content, ts: input.ts }] : []),
		{ conversationId: conversationId ?? sessionId, sessionId },
	);
	// Keep the pre-project global hash byte-for-byte stable across this deploy.
	// Project identity participates, but project_name is display-only and must
	// never turn a rename into a second write of identical content.
	const { project_id: hashProjectId, project_name: _hashProjectName, ...legacyHashScope } = scope;
	const hashScope = hashProjectId
		? { ...legacyHashScope, project_id: hashProjectId }
		: legacyHashScope;
	const hashPayload = {
		sourceType,
		sourceMode,
		conversationId,
		threadId,
		topic,
		scope: hashScope,
		...(delivery ? { delivery } : {}),
		messages: messages.map((m) => ({
			id: m.id,
			role: m.role,
			content_hash: m.content_hash,
		})),
	};
	const contentHash = await hashText(JSON.stringify(hashPayload));
	const explicitSourceId = cleanKey(input.sourceId ?? input.source_id ?? input.id, null);
	const baseIdempotencyKey = cleanKey(
		input.idempotencyKey ?? input.idempotency_key,
		explicitSourceId
			? `${sourceType}:${sourceMode}:${scope.workspace_id}:${scope.app_id}:${explicitSourceId}`
			: `${sourceType}:${sourceMode}:${scope.workspace_id}:${scope.app_id}:${conversationId ?? threadId ?? sessionId}:${contentHash}`,
	);
	// The D1 uniqueness boundary is (account, idempotency_key). Project writes
	// therefore namespace even caller-supplied keys, while the legacy/global
	// format remains byte-for-byte compatible for existing clients and replays.
	const idempotencyKey = scope.project_id
		? `${SCOPED_IDEMPOTENCY_PREFIX}p:${(await hashText(scope.project_id)).slice(0, 24)}:${baseIdempotencyKey}`
		: baseIdempotencyKey.startsWith(SCOPED_IDEMPOTENCY_PREFIX)
			? `${SCOPED_IDEMPOTENCY_PREFIX}g:${baseIdempotencyKey}`
			: baseIdempotencyKey;
	const preview = clamp(messages.map((m) => m.content).join("\n"));
	const rawMeta = {
		delivery,
		session_id_explicit: Boolean(explicitSession),
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
			session_id_explicit: Boolean(explicitSession),
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
			delivery,
			messages,
		},
	};
}

export async function storeSourcePacket(env, packet, { immutableIdempotency = true } = {}) {
	if (!env?.DB || !packet) return null;
	const now = Date.now();
	const id = packet.id ?? newId("src");
	try {
		const conflictUpdate = immutableIdempotency
			? `DO UPDATE SET
				seen_count = COALESCE(source_packets.seen_count, 0) + 1,
				updated_at = excluded.updated_at
			 WHERE source_packets.content_hash = excluded.content_hash`
			: `DO UPDATE SET
				memory_user_id = excluded.memory_user_id,
				owner_user_id = excluded.owner_user_id,
				external_user_id = excluded.external_user_id,
				scope_user_id = excluded.scope_user_id,
				workspace_id = excluded.workspace_id,
				app_id = excluded.app_id,
				agent_id = excluded.agent_id,
				session_id = excluded.session_id,
				source_scope = excluded.source_scope,
				project_id = excluded.project_id,
				project_name = excluded.project_name,
				source_mode = excluded.source_mode,
				topic = excluded.topic,
				content_hash = excluded.content_hash,
				content_preview = excluded.content_preview,
				message_count = excluded.message_count,
				raw_meta_json = excluded.raw_meta_json,
				seen_count = COALESCE(source_packets.seen_count, 0) + 1,
				received_at = excluded.received_at,
				updated_at = excluded.updated_at`;
		const row = await env.DB.prepare(
			`INSERT INTO source_packets
				(id, user_id, memory_user_id, owner_user_id, external_user_id, scope_user_id,
				 workspace_id, app_id, agent_id, session_id, source_scope, project_id, project_name,
				 source_type, source_mode, source_id, source_role, conversation_id, thread_id, topic,
				 idempotency_key, content_hash, content_preview, message_count, raw_meta_json,
				 seen_count, received_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(user_id, idempotency_key) ${conflictUpdate}
			 RETURNING *`,
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
				packet.project_id,
				packet.project_name,
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
		if (!row && immutableIdempotency) {
			const existing = await env.DB.prepare(
				"SELECT * FROM source_packets WHERE user_id = ? AND idempotency_key = ? LIMIT 1",
			).bind(packet.user_id, packet.idempotency_key).first();
			if (existing && existing.content_hash !== packet.content_hash) {
				return {
					...existing,
					messages: [],
					delivery: sourceDelivery(existing),
					idempotency_conflict: true,
					existing_content_hash: existing.content_hash,
				};
			}
			if (existing) {
				return {
					...packet,
					...existing,
					idempotent_replay: true,
					messages: packet.messages ?? [],
					delivery: sourceDelivery(existing),
				};
			}
			throw new Error("an immutable source packet claim returned no durable row");
		}
		return {
			...packet,
			...(row ?? {}),
			id: row?.id ?? id,
			seen_count: row?.seen_count ?? 1,
			idempotent_replay: Boolean(row && (row.id !== id || Number(row.seen_count ?? 1) > 1)),
			messages: packet.messages ?? [],
			delivery: sourceDelivery(row ?? packet),
		};
	} catch (err) {
		if (immutableIdempotency) throw err;
		console.warn("source packet store failed:", err?.message ?? err);
		return { ...packet, id: null, error: String(err?.message ?? err) };
	}
}

export function sourceDelivery(sourcePacket) {
	const direct = normalizeDeliveryMetadata(sourcePacket?.delivery);
	if (direct) return direct;
	try {
		return normalizeDeliveryMetadata(JSON.parse(sourcePacket?.raw_meta_json ?? "{}")?.delivery);
	} catch {
		return null;
	}
}

export function sourceMeta(sourcePacket) {
	if (!sourcePacket) return {};
	const delivery = sourceDelivery(sourcePacket);
	const rawMeta = parseRecord(sourcePacket.raw_meta_json ?? sourcePacket.rawMetaJson);
	const storedSessionMarker = firstBoolean(
		[sourcePacket, rawMeta],
		["session_id_explicit", "sessionIdExplicit"],
	);
	const storedMemoryUserId = cleanKey(
		sourcePacket.memory_user_id ?? sourcePacket.memoryUserId ?? sourcePacket.user_id ?? sourcePacket.userId,
		null,
	);
	const storedSessionId = cleanKey(sourcePacket.session_id ?? sourcePacket.sessionId, null);
	const sessionIdExplicit = storedSessionMarker === true || (
		storedSessionMarker === null
		&& storedSessionId !== null
		&& storedSessionId !== storedMemoryUserId
	);
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
			session_id_explicit: sessionIdExplicit,
			conversation_id: sourcePacket.conversation_id,
			thread_id: sourcePacket.thread_id,
			topic: sourcePacket.topic,
			source_scope: sourcePacket.source_scope,
			project_id: sourcePacket.project_id,
			project_name: sourcePacket.project_name,
			source_type: sourcePacket.source_type,
			source_mode: sourcePacket.source_mode,
			delivery,
		}),
		project_id: sourcePacket.project_id ?? null,
		project_name: sourcePacket.project_name ?? null,
		delivery,
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
