import { hashText } from "./source.js";

const MAX_PROFILE_PART = 8000;

/** Keep page vectors out of the legacy node namespace used by AutoMode. */
export async function manualPageVectorNamespace(userId) {
	const digest = await hashText(`uml-manual-page-v1:${String(userId ?? "")}`);
	return `uml_pages_${digest.slice(0, 40)}`;
}

function clean(value, limit = MAX_PROFILE_PART) {
	return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function unique(values = []) {
	return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function identitySearchVariants(label, category) {
	const tokens = clean(label, 240)
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "")
		.toLocaleLowerCase("en-US")
		.match(/[\p{L}\p{N}]+/gu) ?? [];
	if (tokens.length < 2) return [];
	const acronym = tokens.map((token) => token[0]).join("");
	const variants = [acronym];
	if (String(category ?? "").toLocaleLowerCase("en-US") === "organization" &&
		!acronym.endsWith("fc") && tokens.some((token) => ["united", "city", "rovers", "wanderers", "athletic"].includes(token))) {
		variants.push(`${acronym}fc`);
	}
	return variants;
}

function parseArray(value) {
	if (Array.isArray(value)) return value;
	try {
		const parsed = JSON.parse(value || "[]");
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function joinParts(values, limit = MAX_PROFILE_PART) {
	return unique(values.map((value) => clean(value, 1200))).join("\n").slice(0, limit);
}

function sourceTime(values = []) {
	return Math.max(0, ...values.map((value) => Number(value ?? 0)).filter(Number.isFinite));
}

export async function buildManualNodeSearchProfile(node, context = {}) {
	const identityClaims = context.identityClaims ?? [];
	const claimKeys = identityClaims.map((claim) => typeof claim === "string" ? claim : claim?.canonical_key);
	const aliases = unique([
		...parseArray(node?.aliases_json ?? node?.aliases),
		...claimKeys,
	]);
	const facts = (context.slices ?? []).filter((slice) => Number(slice.is_current ?? 1) === 1);
	const events = context.events ?? [];
	const relationships = context.relationships ?? [];
	const communities = context.communities ?? [];
	const pages = context.pages ?? [];
	const identityText = joinParts([
		node?.label,
		node?.canonical_label,
		...aliases,
		...identitySearchVariants(node?.label, node?.category),
	], 2400);
	const semanticText = joinParts([
		node?.label,
		node?.summary,
		...facts.slice(0, 24).map((slice) => slice.text),
		...events.slice(0, 12).map((event) => event.text),
		...relationships.slice(0, 20).map((edge) =>
			`${edge.direction === "incoming" ? edge.other_label : node?.label} ${edge.type} ${edge.direction === "incoming" ? node?.label : edge.other_label}`),
	], MAX_PROFILE_PART);
	const contextText = joinParts([
		node?.category,
		node?.role,
		node?.state,
		node?.cluster,
		...communities.map((community) => `${community.label ?? community.canonical_key} ${community.summary ?? ""}`),
		...pages.map((page) => `${page.title} ${page.topic_filter ?? ""}`),
	], 4000);
	const sourceUpdatedAt = sourceTime([
		node?.updated_at,
		node?.last_seen_at,
		...facts.map((slice) => slice.last_seen_at ?? slice.created_at),
		...events.map((event) => event.last_seen_at ?? event.created_at),
		...relationships.map((edge) => edge.last_seen_at ?? edge.created_at),
		...pages.map((page) => page.updated_at),
		...identityClaims.map((claim) => typeof claim === "object" ? claim.updated_at : 0),
		...communities.map((community) => community.updated_at),
	]);
	const profileHash = await hashText(JSON.stringify({ identityText, semanticText, contextText }));
	return {
		user_id: node.user_id,
		object_kind: "node",
		object_id: node.id,
		identity_text: identityText,
		semantic_text: semanticText,
		context_text: contextText,
		profile_hash: profileHash,
		source_updated_at: sourceUpdatedAt,
		label: clean(node.label, 120),
		category: clean(node.category, 40) || "other",
	};
}

export async function buildManualPageSearchProfile(page, context = {}) {
	const claims = context.identityClaims ?? [];
	const claimKeys = claims.map((claim) => typeof claim === "string" ? claim : claim?.canonical_key);
	const identityText = joinParts([
		page?.title,
		page?.canonical_title,
		page?.topic_filter,
		...claimKeys,
	], 2600);
	const semanticText = joinParts([
		page?.title,
		page?.short_summary,
		page?.sections_json,
		page?.key_points_json,
		page?.decisions_json,
		page?.next_steps_json,
		page?.related_concepts_json,
		page?.full_markdown,
	], MAX_PROFILE_PART);
	const contextText = joinParts([
		page?.node_id,
		page?.source_thread_id,
		page?.source_conversation_id,
		page?.cluster,
		page?.role_type,
	], 2400);
	const sourceUpdatedAt = sourceTime([
		page?.updated_at,
		page?.last_seen_at,
		page?.created_at,
		...claims.map((claim) => typeof claim === "object" ? claim.updated_at : 0),
	]);
	const profileHash = await hashText(JSON.stringify({ identityText, semanticText, contextText }));
	return {
		user_id: page.user_id,
		object_kind: "page",
		object_id: page.id,
		identity_text: identityText,
		semantic_text: semanticText,
		context_text: contextText,
		profile_hash: profileHash,
		source_updated_at: sourceUpdatedAt,
		label: clean(page.title, 160),
		category: "memory_page",
	};
}

function placeholders(values) {
	return values.map(() => "?").join(", ");
}

async function loadNodeProfiles(env, userId, ids) {
	if (!ids.length) return [];
	const marks = placeholders(ids);
	const bindings = [userId, ...ids];
	const [nodesResult, slicesResult, eventsResult, edgesResult, claimsResult, communitiesResult, pagesResult] = await env.DB.batch([
		env.DB.prepare(
			`SELECT * FROM nodes WHERE user_id = ? AND id IN (${marks})
			 AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL`,
		).bind(...bindings),
		env.DB.prepare(
			`SELECT * FROM (
			 SELECT slices.*, ROW_NUMBER() OVER (PARTITION BY node_id ORDER BY
			  is_current DESC, COALESCE(last_seen_at, created_at) DESC, id) AS row_rank
			 FROM slices WHERE user_id = ? AND node_id IN (${marks}) AND deleted_at IS NULL
			) WHERE row_rank <= 24`,
		).bind(...bindings),
		env.DB.prepare(
			`SELECT * FROM (
			 SELECT events.*, ROW_NUMBER() OVER (PARTITION BY node_id ORDER BY
			  COALESCE(last_seen_at, happened_at, created_at) DESC, id) AS row_rank
			 FROM events WHERE user_id = ? AND node_id IN (${marks}) AND deleted_at IS NULL
			) WHERE row_rank <= 12`,
		).bind(...bindings),
		env.DB.prepare(
			`WITH endpoint_edges AS (
			 SELECT e.*, source.label AS from_label, target.label AS to_label,
			  e.from_node AS owner_node_id, 'outgoing' AS direction, target.label AS other_label
			 FROM edges e JOIN nodes source ON source.id = e.from_node JOIN nodes target ON target.id = e.to_node
			 WHERE e.user_id = ? AND e.deleted_at IS NULL AND e.from_node IN (${marks})
			  AND source.deleted_at IS NULL AND source.archived_at IS NULL AND source.suppressed_at IS NULL
			  AND target.deleted_at IS NULL AND target.archived_at IS NULL AND target.suppressed_at IS NULL
			 UNION ALL
			 SELECT e.*, source.label, target.label,
			  e.to_node AS owner_node_id, 'incoming' AS direction, source.label AS other_label
			 FROM edges e JOIN nodes source ON source.id = e.from_node JOIN nodes target ON target.id = e.to_node
			 WHERE e.user_id = ? AND e.deleted_at IS NULL AND e.to_node IN (${marks})
			  AND source.deleted_at IS NULL AND source.archived_at IS NULL AND source.suppressed_at IS NULL
			  AND target.deleted_at IS NULL AND target.archived_at IS NULL AND target.suppressed_at IS NULL
			), ranked AS (
			 SELECT *, ROW_NUMBER() OVER (PARTITION BY owner_node_id ORDER BY COALESCE(last_seen_at, created_at) DESC, id) AS row_rank
			 FROM endpoint_edges
			)
			SELECT * FROM ranked WHERE row_rank <= 20`,
		).bind(userId, ...ids, userId, ...ids),
		env.DB.prepare(
			`SELECT node_id, canonical_key, updated_at FROM manual_node_identities
			 WHERE user_id = ? AND node_id IN (${marks})`,
		).bind(...bindings),
		env.DB.prepare(
			`SELECT node_id, canonical_key, label, summary, updated_at FROM (
			 SELECT ntc.node_id, tc.canonical_key, tc.label, tc.summary, tc.updated_at,
			  ROW_NUMBER() OVER (PARTITION BY ntc.node_id ORDER BY ntc.updated_at DESC, tc.id) AS row_rank
			 FROM node_topic_communities ntc JOIN topic_communities tc ON tc.id = ntc.community_id AND tc.user_id = ntc.user_id
			 WHERE ntc.user_id = ? AND ntc.node_id IN (${marks})
			) WHERE row_rank <= 10`,
		).bind(...bindings),
		env.DB.prepare(
			`SELECT id, node_id, title, topic_filter, updated_at FROM (
			 SELECT id, node_id, title, topic_filter, updated_at,
			  ROW_NUMBER() OVER (PARTITION BY node_id ORDER BY updated_at DESC, id) AS row_rank
			 FROM memory_pages WHERE user_id = ? AND node_id IN (${marks})
			 AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL
			) WHERE row_rank <= 10`,
		).bind(...bindings),
	]);
	const snapshotObservedAt = Date.now();
	const rowsFor = (result, key, id) => (result?.results ?? []).filter((row) => row[key] === id);
	const profiles = [];
	for (const node of nodesResult?.results ?? []) {
		profiles.push({ ...await buildManualNodeSearchProfile(node, {
			slices: rowsFor(slicesResult, "node_id", node.id),
			events: rowsFor(eventsResult, "node_id", node.id),
			relationships: rowsFor(edgesResult, "owner_node_id", node.id),
			identityClaims: rowsFor(claimsResult, "node_id", node.id),
			communities: rowsFor(communitiesResult, "node_id", node.id),
			pages: rowsFor(pagesResult, "node_id", node.id),
		}), snapshot_observed_at: snapshotObservedAt });
	}
	return profiles;
}

async function loadPageProfiles(env, userId, ids) {
	if (!ids.length) return [];
	const marks = placeholders(ids);
	const bindings = [userId, ...ids];
	const [pagesResult, claimsResult] = await env.DB.batch([
		env.DB.prepare(
			`SELECT * FROM memory_pages WHERE user_id = ? AND id IN (${marks})
			 AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL`,
		).bind(...bindings),
		env.DB.prepare(
			`SELECT page_id, canonical_key, updated_at FROM manual_page_identities
			 WHERE user_id = ? AND page_id IN (${marks})`,
		).bind(...bindings),
	]);
	const snapshotObservedAt = Date.now();
	const profiles = [];
	for (const page of pagesResult?.results ?? []) {
		profiles.push({ ...await buildManualPageSearchProfile(page, {
			identityClaims: (claimsResult?.results ?? []).filter((claim) => claim.page_id === page.id),
		}), snapshot_observed_at: snapshotObservedAt });
	}
	return profiles;
}

function failure(stage, object, error) {
	return {
		stage,
		object_kind: object?.object_kind ?? null,
		object_id: object?.object_id ?? null,
		code: `${stage}_failed`,
		message: String(error?.message ?? error),
	};
}

function activeObjectSql(objectKind) {
	const table = objectKind === "page" ? "memory_pages" : "nodes";
	return `SELECT 1 FROM ${table}
		WHERE user_id = ? AND id = ?
		 AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL`;
}

async function activeObjectExists(env, userId, objectKind, objectId) {
	const row = await env.DB.prepare(activeObjectSql(objectKind))
		.bind(userId, objectId)
		.first();
	return Boolean(row);
}

async function activeStoredProfile(env, userId, objectKind, objectId) {
	const sourceTable = objectKind === "page" ? "memory_pages" : "nodes";
	return env.DB.prepare(
		`SELECT profile.object_kind, profile.object_id, profile.identity_text,
		        profile.semantic_text, profile.context_text, profile.profile_hash
		 FROM manual_search_profiles profile
		 WHERE profile.user_id = ? AND profile.object_kind = ? AND profile.object_id = ?
		  AND EXISTS (
		   SELECT 1 FROM ${sourceTable} source
		   WHERE source.user_id = profile.user_id AND source.id = profile.object_id
		    AND source.deleted_at IS NULL AND source.archived_at IS NULL AND source.suppressed_at IS NULL
		  )`,
	).bind(userId, objectKind, objectId).first();
}

async function deleteProfileVector(env, profile) {
	if (!env.VECTORIZE) return;
	const id = profile.object_kind === "page" ? `page:${profile.object_id}` : profile.object_id;
	await env.VECTORIZE.deleteByIds([id]);
}

async function embedAndUpsertProfile(env, config, userId, profile) {
	if (!config.useVectors) return { status: "skipped", reason: "vectors_disabled" };
	if (!env.AI) return { status: "skipped", reason: "ai_binding_missing" };
	if (!env.VECTORIZE) return { status: "skipped", reason: "vectorize_binding_missing" };
	const vectorText = joinParts([
		profile.identity_text,
		profile.semantic_text,
		profile.context_text,
	], MAX_PROFILE_PART);
	const response = await env.AI.run(config.embedModel, { text: [vectorText] });
	const values = response?.data?.[0];
	if (!Array.isArray(values) || values.length === 0) throw new Error("embedding response did not contain a vector");
	const latest = await activeStoredProfile(env, userId, profile.object_kind, profile.object_id);
	if (!latest || latest.profile_hash !== profile.profile_hash) {
		return { status: "stale", reason: "profile_changed_during_embedding" };
	}
	await env.VECTORIZE.upsert([{
		id: profile.object_kind === "page" ? `page:${profile.object_id}` : profile.object_id,
		values,
		namespace: profile.object_kind === "page" ? await manualPageVectorNamespace(userId) : userId,
		metadata: {
			user_id: userId,
			object_kind: profile.object_kind,
			label: profile.label,
			category: profile.category,
			profile_hash: profile.profile_hash,
		},
	}]);
	// D1 and Vectorize cannot share a transaction. Compensate if an archive or
	// delete won after the pre-upsert check, which otherwise lets a delayed
	// refresher recreate a vector that cleanup already removed.
	if (!await activeObjectExists(env, userId, profile.object_kind, profile.object_id)) {
		await deleteProfileVector(env, profile);
		return { status: "stale", reason: "source_removed_during_vector_refresh" };
	}
	const latestAfter = await activeStoredProfile(env, userId, profile.object_kind, profile.object_id);
	if (!latestAfter || latestAfter.profile_hash !== profile.profile_hash) {
		return { status: "stale", reason: "profile_changed_during_vector_upsert" };
	}
	return { status: "refreshed" };
}

/**
 * Best-effort derived refresh for the MCP manual lane. Canonical D1 graph writes
 * must already be committed before this function is called.
 */
export async function refreshManualSearchProfiles(env, config, userId, { nodeIds = [], pageIds = [] } = {}) {
	const wantedNodes = unique(nodeIds).slice(0, 100);
	const wantedPages = unique(pageIds).slice(0, 100);
	const warnings = [];
	let profiles = [];
	try {
		profiles = [
			...await loadNodeProfiles(env, userId, wantedNodes),
			...await loadPageProfiles(env, userId, wantedPages),
		];
		if (profiles.length) {
			const now = Date.now();
			await env.DB.batch(profiles.map((profile) => {
				const sourceTable = profile.object_kind === "page" ? "memory_pages" : "nodes";
				return env.DB.prepare(
				`INSERT INTO manual_search_profiles
				 (user_id, object_kind, object_id, identity_text, semantic_text, context_text,
				  profile_hash, source_updated_at, created_at, updated_at)
				 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
				 WHERE EXISTS (
				  SELECT 1 FROM ${sourceTable}
				  WHERE user_id = ? AND id = ?
				   AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL
				 )
				 ON CONFLICT(user_id, object_kind, object_id) DO UPDATE SET
				  identity_text = excluded.identity_text,
				  semantic_text = excluded.semantic_text,
				  context_text = excluded.context_text,
				  profile_hash = excluded.profile_hash,
				  source_updated_at = MAX(manual_search_profiles.source_updated_at, excluded.source_updated_at),
				  updated_at = excluded.updated_at
				 WHERE excluded.source_updated_at > manual_search_profiles.source_updated_at
				    OR (excluded.source_updated_at = manual_search_profiles.source_updated_at
				        AND excluded.updated_at > manual_search_profiles.updated_at)
				    OR (excluded.source_updated_at = manual_search_profiles.source_updated_at
				        AND excluded.updated_at = manual_search_profiles.updated_at
				        AND excluded.profile_hash > manual_search_profiles.profile_hash)
				    OR manual_search_profiles.profile_hash LIKE 'legacy:%'`,
				).bind(
				userId, profile.object_kind, profile.object_id, profile.identity_text,
				profile.semantic_text, profile.context_text, profile.profile_hash,
				profile.source_updated_at, now, profile.snapshot_observed_at ?? now,
				userId, profile.object_id,
				);
			}));
		}
	} catch (error) {
		warnings.push(failure("search_profile", null, error));
		return { refreshed: [], vector_refreshed: [], warnings };
	}

	const refreshed = [];
	const vectorRefreshed = [];
	for (const profile of profiles) {
		try {
			// Re-read the winning durable profile so a slower stale refresher cannot
			// overwrite Vectorize with an older local draft.
			const stored = await activeStoredProfile(env, userId, profile.object_kind, profile.object_id);
			if (!stored) continue;
			refreshed.push({ object_kind: profile.object_kind, object_id: profile.object_id });
			const status = await embedAndUpsertProfile(env, config, userId, { ...profile, ...stored });
			if (status.status === "refreshed") vectorRefreshed.push({ object_kind: profile.object_kind, object_id: profile.object_id });
		} catch (error) {
			warnings.push(failure("vector_profile", profile, error));
		}
	}
	return { refreshed, vector_refreshed: vectorRefreshed, warnings };
}

export async function deleteManualSearchObjects(env, config, userId, { nodeIds = [], pageIds = [] } = {}) {
	const nodes = unique(nodeIds);
	const pages = unique(pageIds);
	const statements = [];
	for (const nodeId of nodes) {
		statements.push(env.DB.prepare(
			"DELETE FROM node_topic_communities WHERE user_id = ? AND node_id = ?",
		).bind(userId, nodeId));
		statements.push(env.DB.prepare(
			"DELETE FROM manual_search_profiles WHERE user_id = ? AND object_kind = 'node' AND object_id = ?",
		).bind(userId, nodeId));
	}
	for (const pageId of pages) {
		statements.push(env.DB.prepare(
			"DELETE FROM manual_search_profiles WHERE user_id = ? AND object_kind = 'page' AND object_id = ?",
		).bind(userId, pageId));
	}
	if (statements.length) {
		statements.push(env.DB.prepare(
			`DELETE FROM topic_communities WHERE user_id = ? AND NOT EXISTS (
			 SELECT 1 FROM node_topic_communities WHERE user_id = ? AND community_id = topic_communities.id
			)`,
		).bind(userId, userId));
		await env.DB.batch(statements);
	}
	if (env.VECTORIZE) {
		const vectorIds = [...nodes, ...pages.map((id) => `page:${id}`)];
		if (vectorIds.length) {
			try {
				await env.VECTORIZE.deleteByIds(vectorIds);
			} catch (error) {
				console.warn("manual search vector cleanup failed:", error?.message ?? error);
			}
		}
	}
}
