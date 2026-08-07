/**
 * OPS-02 — the operator surface.
 *
 * The questions this exists to answer, for someone running Itsuki in
 * production rather than reading its source:
 *
 *   Is my memory system healthy? · Is backlog building? · Are there stuck
 *   jobs? · Which tenant or project is affected? · Was that write cancelled by
 *   my own delete, or did it actually fail? · Are retries happening? · Did an
 *   erasure converge?
 *
 * Before this, every one of those needed direct D1 access: `/v1/requests`,
 * `/v1/jobs` and `/v1/status` are each scoped to ONE memory user, so an
 * integrator running sub-tenants could only ask about a tenant they already
 * suspected, and could not see the account at all.
 *
 * Three rules constrain what this may return:
 *
 *   1. NEVER content. Counts, states, timestamps, latency. No labels, no slice
 *      text, no summaries, no `project_name` (a plugin derives that from the
 *      user's working directory — the id is a hash, the name is not).
 *   2. NEVER another account. Every tenant is discovered through the caller's
 *      OWN `owner_user_id` provenance and re-checked before it is reported.
 *   3. NEVER a new terminal job status. Cancellations are surfaced as a
 *      separate count, because A10 proved a new terminal word would hang the
 *      poller in every shipped 0.2.1 SDK.
 *
 * `external_user_id` IS returned: the caller minted it, the caller sent it, it
 * is stored in their own write provenance, and returning it to that same
 * account is what makes a tenant row actionable. It is echoed to nobody else.
 */

const RANGE_DAYS = { "1d": 1, "7d": 7, "30d": 30, "90d": 90 };
const TERMINAL = ["enriched", "failed", "completed"];
const CANCELLED_PREFIX = "cancelled_by_delete";
// A job still non-terminal after this long is not "busy", it is a question.
const STUCK_AFTER_MS = 15 * 60 * 1000;
const MAX_TENANTS = 200;
// OPS-03: D1 caps bound parameters per statement, so a `user_id IN (...)` list
// built from an account's tenants is a query that works until the account
// grows. Every fan-out below is chunked; 80 leaves headroom for the extra
// binds each statement adds. Found in production at 360 tenants — a test
// account with two could never have shown it.
const ID_CHUNK = 80;

function chunk(list, size = ID_CHUNK) {
	const out = [];
	for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
	return out;
}

function percentile(sorted, p) {
	if (!sorted.length) return null;
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return Math.round(sorted[index]);
}

function placeholders(list) {
	return list.map(() => "?").join(",");
}

function emptyJobCounts() {
	return { queued: 0, staged: 0, processing: 0, enriched: 0, failed: 0, completed: 0 };
}

/**
 * Account-wide operator view for ONE owner account.
 *
 * @param ownerUserId the authenticated account (never a sub-tenant hash)
 */
export async function operatorOverview(env, ownerUserId, { range = "7d", limit, chunkSize = ID_CHUNK } = {}) {
	const rangeDays = RANGE_DAYS[range] ?? 7;
	const now = Date.now();
	const fromMs = now - rangeDays * 24 * 60 * 60 * 1000;
	const cap = Math.min(Math.max(Number(limit) || MAX_TENANTS, 1), MAX_TENANTS);

	// Tenant discovery. Write provenance already records which account a scoped
	// write belonged to, so no new storage and no new identifier are needed:
	// the link exists, it was simply never readable through an API.
	const { results: discovered } = await env.DB.prepare(
		`SELECT user_id,
		        json_extract(scope_json, '$.external_user_id') AS external_user_id,
		        MAX(created_at) AS last_activity_at
		   FROM receipts
		  WHERE created_at >= ?
		    AND (user_id = ? OR json_extract(scope_json, '$.owner_user_id') = ?)
		  GROUP BY user_id, external_user_id
		  ORDER BY last_activity_at DESC
		  LIMIT ?`,
	).bind(fromMs, ownerUserId, ownerUserId, cap).all();

	// OPS-04: the account's OWN memory must never be crowded out by busier
	// sub-tenants. Recency ordering plus a cap did exactly that in production —
	// 200 recently-erased sub-tenants filled the list and the root row, holding
	// hundreds of live nodes, fell off the end. An operator asking "how much
	// memory do I have?" was answered zero.
	const rows = [...(discovered ?? [])];
	if (!rows.some((row) => String(row.user_id) === ownerUserId)) {
		rows.push({ user_id: ownerUserId, external_user_id: null, last_activity_at: 0 });
	}

	const tenants = new Map();
	for (const row of rows) {
		const id = String(row.user_id);
		// Belt and braces: the root row is the account itself; every other row
		// must be a scoped hash. Anything else is not ours and is dropped rather
		// than reported.
		const isRoot = id === ownerUserId;
		if (!isRoot && !id.startsWith("mem_")) continue;
		const existing = tenants.get(id);
		if (existing) {
			existing.external_user_id ??= row.external_user_id ?? null;
			existing.last_activity_at = Math.max(existing.last_activity_at ?? 0, Number(row.last_activity_at ?? 0));
			continue;
		}
		tenants.set(id, {
			memory_user_id: id,
			external_user_id: row.external_user_id ?? (isRoot ? null : null),
			is_root: isRoot,
			project_ids: [],
			live_nodes: 0,
			jobs: emptyJobCounts(),
			backlog: { depth: 0, oldest_age_ms: null },
			stuck: 0,
			cancelled_by_delete: 0,
			failures: { total: 0, cancelled_by_delete: 0, other: 0 },
			retries: { jobs_with_retries: 0, max_attempts: 0 },
			barrier_at: null,
			last_activity_at: Number(row.last_activity_at ?? 0) || null,
			latency_ms: { p50: null, p95: null, samples: 0 },
		});
	}

	const ids = [...tenants.keys()];
	const account = {
		owner_user_id: ownerUserId,
		range: { days: rangeDays, from: fromMs, to: now },
		tenants: ids.length,
		truncated: (discovered ?? []).length >= cap,
		live_nodes: 0,
		jobs: emptyJobCounts(),
		backlog: { depth: 0, oldest_age_ms: null },
		stuck: { non_terminal: 0, older_than_ms: STUCK_AFTER_MS },
		cancelled_by_delete: 0,
		failures: { total: 0, cancelled_by_delete: 0, other: 0 },
		retries: { jobs_with_retries: 0, max_attempts: 0 },
		erasures: { tenants_with_barrier: 0, latest_barrier_at: null },
		latency_ms: { p50: null, p95: null, samples: 0 },
	};
	if (!ids.length) return { ok: true, account, tenants: [] };

	// One batch per chunk of tenant ids, then the rows are merged. Splitting by
	// chunk rather than by query keeps every statement under the D1 bound-
	// parameter limit no matter how many tenants an account has (OPS-03).
	const jobRows = { results: [] };
	const nodeRows = { results: [] };
	const barrierRows = { results: [] };
	const latencyRows = { results: [] };
	const projectRows = { results: [] };
	for (const group of chunk(ids, Math.max(1, Number(chunkSize) || ID_CHUNK))) {
		const slot = placeholders(group);
		const [jobs, nodes, barriers, latency, projects] = await env.DB.batch([
			env.DB.prepare(
				`SELECT user_id, status, attempts, created_at, error
				   FROM memory_jobs
				  WHERE user_id IN (${slot}) AND type IN ('extract', 'mcp_enrich')`,
			).bind(...group),
			env.DB.prepare(
				`SELECT user_id, COUNT(*) AS n FROM nodes
				  WHERE deleted_at IS NULL AND user_id IN (${slot}) GROUP BY user_id`,
			).bind(...group),
			env.DB.prepare(
				`SELECT user_id, barrier_at FROM deletion_barriers WHERE user_id IN (${slot})`,
			).bind(...group),
			env.DB.prepare(
				`SELECT user_id, latency_ms FROM receipts
				  WHERE user_id IN (${slot}) AND created_at >= ? AND latency_ms IS NOT NULL`,
			).bind(...group, fromMs),
			env.DB.prepare(
				`SELECT DISTINCT user_id, json_extract(scope_json, '$.project_id') AS project_id
				   FROM receipts
				  WHERE user_id IN (${slot}) AND created_at >= ?
				    AND json_extract(scope_json, '$.project_id') IS NOT NULL`,
			).bind(...group, fromMs),
		]);
		jobRows.results.push(...(jobs.results ?? []));
		nodeRows.results.push(...(nodes.results ?? []));
		barrierRows.results.push(...(barriers.results ?? []));
		latencyRows.results.push(...(latency.results ?? []));
		projectRows.results.push(...(projects.results ?? []));
	}

	const latencies = new Map(ids.map((id) => [id, []]));
	const accountLatencies = [];

	for (const row of jobRows.results ?? []) {
		const t = tenants.get(String(row.user_id));
		if (!t) continue;
		const status = String(row.status ?? "");
		if (status in t.jobs) t.jobs[status] += 1;
		const attempts = Number(row.attempts ?? 0);
		if (attempts > 0) t.retries.jobs_with_retries += 1;
		t.retries.max_attempts = Math.max(t.retries.max_attempts, attempts);

		if (!TERMINAL.includes(status)) {
			t.backlog.depth += 1;
			const age = now - Number(row.created_at ?? now);
			t.backlog.oldest_age_ms = Math.max(t.backlog.oldest_age_ms ?? 0, age);
			if (age > STUCK_AFTER_MS) t.stuck += 1;
		}
		if (status === "failed") {
			const cancelled = String(row.error ?? "").startsWith(CANCELLED_PREFIX);
			t.failures.total += 1;
			if (cancelled) { t.failures.cancelled_by_delete += 1; t.cancelled_by_delete += 1; }
			else t.failures.other += 1;
		}
	}
	for (const row of nodeRows.results ?? []) {
		const t = tenants.get(String(row.user_id));
		if (t) t.live_nodes = Number(row.n ?? 0);
	}
	for (const row of barrierRows.results ?? []) {
		const t = tenants.get(String(row.user_id));
		if (t) t.barrier_at = Number(row.barrier_at ?? 0) || null;
	}
	for (const row of latencyRows.results ?? []) {
		const bucket = latencies.get(String(row.user_id));
		const value = Number(row.latency_ms);
		if (bucket && Number.isFinite(value)) { bucket.push(value); accountLatencies.push(value); }
	}
	for (const row of projectRows.results ?? []) {
		const t = tenants.get(String(row.user_id));
		// project_id only — `project_name` is a working-directory basename.
		if (t && row.project_id && !t.project_ids.includes(row.project_id)) t.project_ids.push(String(row.project_id));
	}

	for (const t of tenants.values()) {
		const sorted = (latencies.get(t.memory_user_id) ?? []).sort((a, b) => a - b);
		t.latency_ms = { p50: percentile(sorted, 50), p95: percentile(sorted, 95), samples: sorted.length };

		account.live_nodes += t.live_nodes;
		for (const key of Object.keys(account.jobs)) account.jobs[key] += t.jobs[key];
		account.backlog.depth += t.backlog.depth;
		if (t.backlog.oldest_age_ms != null) {
			account.backlog.oldest_age_ms = Math.max(account.backlog.oldest_age_ms ?? 0, t.backlog.oldest_age_ms);
		}
		account.stuck.non_terminal += t.stuck;
		account.cancelled_by_delete += t.cancelled_by_delete;
		account.failures.total += t.failures.total;
		account.failures.cancelled_by_delete += t.failures.cancelled_by_delete;
		account.failures.other += t.failures.other;
		account.retries.jobs_with_retries += t.retries.jobs_with_retries;
		account.retries.max_attempts = Math.max(account.retries.max_attempts, t.retries.max_attempts);
		if (t.barrier_at) {
			account.erasures.tenants_with_barrier += 1;
			account.erasures.latest_barrier_at = Math.max(account.erasures.latest_barrier_at ?? 0, t.barrier_at);
		}
	}
	const accountSorted = accountLatencies.sort((a, b) => a - b);
	account.latency_ms = {
		p50: percentile(accountSorted, 50),
		p95: percentile(accountSorted, 95),
		samples: accountSorted.length,
	};

	return {
		ok: true,
		account,
		tenants: [...tenants.values()].sort((a, b) => (b.last_activity_at ?? 0) - (a.last_activity_at ?? 0)),
	};
}
