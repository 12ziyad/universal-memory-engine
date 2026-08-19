/**
 * The lifecycle artifact census — the executable form of the project
 * lifecycle artifact matrix.
 *
 * Every D1 table must be classified here. The schema-census regression test
 * (test/schema_census.spec.js) parses migrations/*.sql and fails when a table
 * exists that this manifest does not name, so a future table carrying
 * project_id / user_id / memory content / vectors cannot silently escape the
 * purge, delete, and residual-verification passes.
 *
 * kind:
 *   memory_space — rows keyed by user_id, where user_id is a memory-space id
 *                  (a project root `mem_…`/account id or an SDK subtenant).
 *   project      — control-plane rows keyed by project_id.
 *   account      — account/organization rows outside project lifecycle scope.
 *   global       — aggregate/operational rows with no tenant content.
 *   mechanism    — infrastructure tables (fences, ledgers) used BY lifecycle.
 *
 * purge / projectDelete:
 *   delete    — rows removed for every in-scope memory space / the project.
 *   minimize  — rows retained only as content-free fences (source_packets).
 *   retain    — rows deliberately kept (with the reason in `why`).
 *   shadow    — FTS shadow content removed by the base table's delete/triggers.
 *   scrub     — project grant/linkage cleared without deleting the row.
 *
 * Archive retains everything by definition; in-flight jobs are cancelled by
 * the archive run, never deleted.
 */

// Content-bearing (or content-adjacent) tables swept per memory space by a
// purge, in this order, AFTER bulkDeleteBySource has run its converge-erase
// (which owns nodes/pages cascades, vectors, episodes, and packet
// minimization). The order only matters for readability; every statement is
// an independent tenant-scoped DELETE.
export const PURGE_SPACE_TABLES = [
	"memory_pages",
	"nodes",
	"slices",
	"events",
	"edges",
	"candidates",
	"memory_profiles",
	"memory_suppressions",
	"manual_node_identities",
	"manual_fact_identities",
	"manual_page_identities",
	"manual_page_versions",
	"manual_page_write_epochs",
	"checkpoints",
	"node_topic_communities",
	"topic_communities",
	"manual_search_profiles",
	"semantic_atom_projections",
	"semantic_atom_candidates",
	"semantic_atom_capture_runs",
	"source_episodes",
	"staged_memories",
	"memory_source_links",
	"playground_messages",
	"playground_threads",
	"memory_exports",
	"webhook_deliveries",
	"webhooks",
	"receipts",
	"extraction_runs",
	"memory_jobs",
	"ai_calls",
	"error_reports",
	// Safe memory updates (0047): revision history is customer content and the
	// idempotency ledger stores bounded result payloads — both purge with the
	// space. Projection state is operational but object-keyed, so it goes too.
	"memory_revisions",
	"memory_update_idempotency",
	"memory_projection_state",
	// The vector artifact ledger (0049): content-free, but object-keyed, and the
	// authority deletion uses to find provider residue.
	"memory_vector_artifacts",
];

export const CENSUS = {
	// ——— memory-space content: purged and deleted ————————————————————————
	...Object.fromEntries(PURGE_SPACE_TABLES.map((table) => [table, {
		kind: "memory_space",
		purge: "delete",
		projectDelete: "delete",
		archive: "retain",
	}])),
	// The immutable idempotency/replay fence. Purge minimizes rows accepted at
	// or before the barrier to the content-free erased sentinel; deleting them
	// would let an erased terminal write be replayed as an acceptance.
	source_packets: {
		kind: "memory_space",
		purge: "minimize",
		projectDelete: "minimize",
		archive: "retain",
		why: "content-free replay fence (SRV-02); erased sentinel must survive",
	},
	deletion_barriers: {
		kind: "memory_space",
		purge: "retain",
		projectDelete: "retain",
		archive: "retain",
		why: "the monotonic resurrection fence every writer batch checks",
	},
	memory_rules: {
		kind: "memory_space",
		purge: "retain",
		projectDelete: "delete",
		archive: "retain",
		why: "purge preserves project configuration; rules are policy, not memory",
	},
	// FTS shadows: content removed via the base row's hard delete + triggers.
	source_episodes_fts: { kind: "memory_space", purge: "shadow", projectDelete: "shadow", archive: "retain", base: "source_episodes" },
	staged_memories_fts: { kind: "memory_space", purge: "shadow", projectDelete: "shadow", archive: "retain", base: "staged_memories" },
	manual_search_fts: { kind: "memory_space", purge: "shadow", projectDelete: "shadow", archive: "retain", base: "manual_search_profiles" },

	// ——— project control plane: preserved by purge, removed by delete ————
	project_memory_spaces: {
		kind: "project",
		purge: "retain",
		projectDelete: "delete",
		archive: "retain",
		why: "the authoritative subtenant inventory; deleted only after the residual scan proves every space empty",
	},
	project_categories: { kind: "project", purge: "retain", projectDelete: "delete", archive: "retain" },
	retention_policies: { kind: "project", purge: "retain", projectDelete: "delete", archive: "retain" },
	retention_runs: { kind: "project", purge: "retain", projectDelete: "delete", archive: "retain" },
	retention_fences: { kind: "project", purge: "retain", projectDelete: "retain", archive: "retain", why: "monotonic; removing a fence can only ever resurrect" },
	project_members: { kind: "project", purge: "retain", projectDelete: "delete", archive: "retain" },
	connection_tokens: {
		kind: "project",
		purge: "retain",
		projectDelete: "delete",
		archive: "retain",
		why: "purge preserves usable project credentials; delete revokes and removes project-bound keys",
	},
	organization_invitations: {
		kind: "project",
		purge: "retain",
		projectDelete: "scrub",
		archive: "retain",
		why: "org-level invitations survive; only the project grant is cleared",
	},
	managed_projects: {
		kind: "project",
		purge: "retain",
		projectDelete: "retain",
		archive: "retain",
		why: "the shell row (status='archived', lifecycle_state='deleted', description nulled) permanently reserves id + memory_owner identity against reuse",
	},
	project_lifecycle_runs: { kind: "project", purge: "retain", projectDelete: "retain", archive: "retain", why: "content-free lifecycle evidence" },
	project_lifecycle_confirmations: { kind: "project", purge: "retain", projectDelete: "retain", archive: "retain", why: "token hashes only; rows expire" },
	project_tombstones: { kind: "project", purge: "retain", projectDelete: "retain", archive: "retain", why: "the permanent content-free deletion record" },
	audit_events: { kind: "project", purge: "retain", projectDelete: "retain", archive: "retain", why: "content-free security evidence required by policy" },
	audit_event_completions: { kind: "project", purge: "retain", projectDelete: "retain", archive: "retain", why: "content-free security evidence required by policy" },

	// ——— account / organization scope: outside project lifecycle ————————
	users: { kind: "account" },
	sessions: { kind: "account" },
	organizations: { kind: "account" },
	organization_members: { kind: "account" },
	account_erasure_tombstones: { kind: "account" },
	login_events: { kind: "account" },
	invitation_email_outbox: { kind: "account", why: "org-scoped; project delete clears the invitation's project grant only" },

	// ——— global aggregates / mechanisms ————————————————————————————————
	site_visits: { kind: "global" },
	visit_dims: { kind: "global" },
	visit_uniques: { kind: "global" },
	ai_daily_totals: { kind: "global", why: "account-day aggregate counters; content-free billing evidence" },
	fence_guard: { kind: "mechanism" },
};

/**
 * Residual scan for one memory space: proves there is nothing left that a
 * purge was required to remove. Returns { table: count } including a
 * `source_packets_content` probe for packet rows that still carry content.
 * A clean space returns all zeros.
 */
export async function residualSpaceCounts(env, memoryUserId, { erasedContentHash }) {
	const tables = [...PURGE_SPACE_TABLES];
	const statements = tables.map((table) => env.DB.prepare(
		`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`,
	).bind(memoryUserId));
	statements.push(env.DB.prepare(
		`SELECT COUNT(*) AS n FROM source_packets
		  WHERE user_id = ? AND (
		    content_hash != ? OR content_preview IS NOT NULL
		    OR message_count != 0 OR raw_meta_json != '{}'
		  )`,
	).bind(memoryUserId, erasedContentHash));
	const results = await env.DB.batch(statements);
	const counts = {};
	tables.forEach((table, index) => {
		counts[table] = Number(results[index]?.results?.[0]?.n ?? 0);
	});
	counts.source_packets_content = Number(results[tables.length]?.results?.[0]?.n ?? 0);
	return counts;
}

export function residualTotal(counts) {
	return Object.values(counts ?? {}).reduce((sum, value) => sum + Number(value ?? 0), 0);
}
