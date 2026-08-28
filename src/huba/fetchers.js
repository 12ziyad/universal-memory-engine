/**
 * Huba's live-data fetchers — how it answers about YOUR account instead of
 * about the documentation in general.
 *
 * Each fetcher is a small, bounded, READ-ONLY view of one area of the app,
 * mirroring one tab of the dashboard. A question is routed to at most a few
 * of them, they run server-side, and their output becomes context for the
 * answer. That is the whole mechanism: route -> fetch -> ground -> answer.
 *
 * Invariants, none of which are negotiable:
 *
 *   IDENTITY  Every fetcher receives the identity resolved from the SESSION.
 *             Nothing here ever reads a user id, project id, or role out of
 *             the request body — a caller cannot point Huba at another
 *             account by asking it nicely.
 *   READ-ONLY No fetcher writes, deletes, or spends. The one that touches
 *             inference (memory_search) runs the account's own recall, which
 *             is metered under `recall` and deliberately unquota'd.
 *   NO SECRETS Key material, webhook signing secrets, session tokens and
 *             OAuth secrets are never selected, never shaped, never returned.
 *             API keys appear as label/created/last-used metadata only.
 *   BOUNDED   Every query has a LIMIT and every payload is truncated, so a
 *             large account cannot blow up the model context or the bill.
 */

import { memoryCounts } from "../lib/memory_inventory.js";
import { listJobs } from "../pipeline/jobs_api.js";
import { getUserReceipts } from "../lib/db.js";
import { listWebhooks } from "../pipeline/webhooks.js";
import { listOrganizations, listOrganizationMembers } from "../lib/organizations.js";
import { getMemoryRules } from "../pipeline/rules.js";
import { runRecallCommand } from "../pipeline/commands.js";
import {
	aiBudget,
	loadEntitlements,
	neuronsSpentTodayForAccount,
	countWritesThisMonth,
	hubaMessagesToday,
	startOfNextUtcDay,
	startOfNextUtcMonth,
} from "../lib/ai_budget.js";

const MAX_FETCHERS_PER_TURN = 3;

/** Never let one fetcher's payload dominate the context window. */
function cap(value, limit = 1200) {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return text.length > limit ? `${text.slice(0, limit)}…(truncated)` : text;
}

const iso = (ms) => (Number.isFinite(Number(ms)) ? new Date(Number(ms)).toISOString() : null);

export const FETCHERS = {
	/** Usage & plan tab: the allowance, the spend, the reset. */
	usage: {
		terms: ["usage", "quota", "limit", "limits", "neuron", "neurons", "allowance", "remaining", "left",
			"cap", "budget", "upgrade", "plan", "cost", "price", "billing", "many", "today"],
		async run(env, identity) {
			const budget = aiBudget(env);
			const entitlements = await loadEntitlements(env, identity.accountUserId ?? identity.userId);
			const [neuronsToday, writesThisMonth, hubaToday] = await Promise.all([
				neuronsSpentTodayForAccount(env, identity),
				countWritesThisMonth(env, identity),
				hubaMessagesToday(env, identity),
			]);
			const dailyLimit = entitlements?.dailyNeurons ?? budget.dailyNeuronsPerUser;
			const monthlyLimit = entitlements?.monthlyWrites ?? budget.monthlyWrites;
			return {
				saves_today: {
					neurons_used: Math.round(neuronsToday),
					neurons_limit: dailyLimit,
					approx_saves_left: Math.max(0, Math.floor((dailyLimit - neuronsToday) / 150)),
					resets_at: iso(startOfNextUtcDay()),
				},
				this_month: { ai_writes_used: writesThisMonth, ai_writes_limit: monthlyLimit, resets_at: iso(startOfNextUtcMonth()) },
				huba_messages_today: { used: hubaToday },
				early_access: entitlements?.earlyAccess ?? false,
				custom_limits_granted: Boolean(entitlements?.dailyNeurons || entitlements?.monthlyWrites || entitlements?.hubaDailyMessages),
				recall_is_metered: false,
				note: "A direct save is roughly 150 neurons; a long conversation save costs several times that.",
			};
		},
	},

	/** Dashboard tab: what this account has stored, at a glance. */
	inventory: {
		terms: ["dashboard", "overview", "stats", "how", "much", "total", "memory", "memories", "stored",
			"have", "count", "everything", "know"],
		async run(env, identity) {
			const counts = await memoryCounts(env, identity.userId).catch(() => null);
			const { results } = await env.DB.prepare(
				"SELECT label, category, updated_at FROM nodes WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 12",
			).bind(identity.userId).all();
			return {
				counts,
				most_recent_memories: (results ?? []).map((row) => ({ label: row.label, category: row.category, updated: iso(row.updated_at) })),
			};
		},
	},

	/** "What do you know about X" — the account's own recall, verbatim. */
	memory_search: {
		terms: ["remember", "recall", "search", "find", "know", "about", "stored", "told"],
		async run(env, identity, { question }) {
			const result = await runRecallCommand(env, identity.userId, question, { limit: 6 }).catch((error) => ({
				error: String(error?.message ?? error).slice(0, 120),
			}));
			// `context` is the assembled recall text and is what actually
			// answers "what do you know about X"; `items`/`nodes` are the
			// structured hits behind it. Reading the wrong field made Huba
			// report that it could not see any memory content at all.
			const context = typeof result?.context === "string" ? result.context : null;
			const items = Array.isArray(result?.items) ? result.items : [];
			const nodes = Array.isArray(result?.nodes) ? result.nodes : [];
			return {
				query: question.slice(0, 200),
				recalled_text: context ? cap(context, 1600) : null,
				matches: (items.length ? items : nodes).slice(0, 6).map((item) => cap(
					typeof item === "string" ? item : (item.text ?? item.label ?? item.summary ?? item.title ?? item),
					220,
				)),
				nothing_matched: !context && !items.length && !nodes.length,
			};
		},
	},

	/** History tab: what was saved recently and how each one landed. */
	history: {
		terms: ["history", "receipt", "receipts", "recent", "last", "saved", "activity", "log", "yesterday", "week"],
		async run(env, identity) {
			const receipts = await getUserReceipts(env, identity.userId, { limit: 10 }).catch(() => []);
			return (receipts ?? []).slice(0, 10).map((receipt) => ({
				at: iso(receipt.created_at),
				source: receipt.source,
				outcome: receipt.outcome,
				saved: receipt.saved_total,
				summary: cap(receipt.summary ?? "", 160),
			}));
		},
	},

	/** Requests tab: the write queue, and anything that broke. */
	jobs: {
		terms: ["job", "jobs", "queue", "pending", "processing", "stuck", "fail", "failed", "failing",
			"error", "errors", "broken", "wrong", "why", "issue", "problem", "request", "requests"],
		async run(env, identity) {
			const [recent, failed] = await Promise.all([
				listJobs(env, identity.userId, { limit: 10 }).catch(() => []),
				listJobs(env, identity.userId, { status: "failed", limit: 5, cancelled: false }).catch(() => []),
			]);
			const byStatus = {};
			for (const job of recent ?? []) byStatus[job.status] = (byStatus[job.status] ?? 0) + 1;
			return {
				recent_by_status: byStatus,
				failures: (failed ?? []).map((job) => ({
					at: iso(job.completed_at ?? job.updated_at ?? job.created_at),
					type: job.type,
					reference: job.id,
					error: cap(job.error ?? "", 200),
				})),
			};
		},
	},

	/** Graph tab: the shape of the memory graph. */
	graph: {
		terms: ["graph", "cluster", "clusters", "edge", "edges", "node", "nodes", "connection", "connections", "relation", "map", "visual"],
		async run(env, identity) {
			const [clusters, edges] = await Promise.all([
				env.DB.prepare(
					"SELECT COALESCE(cluster, 'general_memory') AS cluster, COUNT(*) AS n FROM nodes WHERE user_id = ? AND deleted_at IS NULL GROUP BY cluster ORDER BY n DESC LIMIT 12",
				).bind(identity.userId).all().catch(() => ({ results: [] })),
				env.DB.prepare(
					"SELECT type, COUNT(*) AS n FROM edges WHERE user_id = ? GROUP BY type ORDER BY n DESC LIMIT 12",
				).bind(identity.userId).all().catch(() => ({ results: [] })),
			]);
			return {
				clusters: (clusters.results ?? []).map((row) => ({ cluster: row.cluster, memories: row.n })),
				edges_by_type: (edges.results ?? []).map((row) => ({ type: row.type, count: row.n })),
			};
		},
	},

	/** API Keys tab — METADATA ONLY. No key value is ever selected here. */
	api_keys: {
		terms: ["key", "keys", "token", "tokens", "credential", "apikey", "auth", "revoke", "rotate"],
		async run(env, identity) {
			const { results } = await env.DB.prepare(
				`SELECT label, type, created_at, last_used_at, revoked_at FROM connection_tokens
				 WHERE user_id = ? ORDER BY created_at DESC LIMIT 12`,
			).bind(identity.accountUserId ?? identity.userId).all();
			return {
				note: "Key values are never retrievable after creation — not by Huba, not by anyone.",
				keys: (results ?? []).map((row) => ({
					label: row.label,
					type: row.type,
					created: iso(row.created_at),
					last_used: iso(row.last_used_at),
					revoked: Boolean(row.revoked_at),
				})),
			};
		},
	},

	/** Webhooks tab. publicWebhook() already strips the signing secret; the
	 * delete below is belt-and-braces so a future shape change cannot leak it. */
	webhooks: {
		terms: ["webhook", "webhooks", "callback", "event", "events", "subscribe", "notification", "delivery"],
		async run(env, identity) {
			const hooks = await listWebhooks(env, identity.userId).catch(() => []);
			return (hooks ?? []).slice(0, 10).map((hook) => {
				const safe = { ...hook };
				delete safe.secret;
				delete safe.signing_secret;
				return safe;
			});
		},
	},

	/** Memory exports tab. */
	exports: {
		terms: ["export", "exports", "download", "backup", "portability", "copy"],
		async run(env, identity) {
			const { results } = await env.DB.prepare(
				"SELECT id, status, format, created_at, completed_at FROM memory_exports WHERE user_id = ? ORDER BY created_at DESC LIMIT 6",
			).bind(identity.userId).all().catch(() => ({ results: [] }));
			return (results ?? []).map((row) => ({ id: row.id, status: row.status, format: row.format, created: iso(row.created_at) }));
		},
	},

	/** Settings: organizations, projects, and who is on them. Membership is
	 * read through the same helpers the Settings page uses, so Huba can only
	 * ever see the organizations this session actually belongs to. */
	members: {
		terms: ["member", "members", "team", "teammate", "invite", "invitation", "role", "roles",
			"permission", "permissions", "who", "access", "organization", "org", "project", "projects", "workspace"],
		async run(env, identity) {
			const organizations = await listOrganizations(env, identity.accountUserId ?? identity.userId).catch(() => []);
			const primary = organizations?.[0];
			const members = primary ? await listOrganizationMembers(env, primary.id).catch(() => []) : [];
			const { results: projects } = await env.DB.prepare(
				"SELECT name, status, created_at FROM managed_projects WHERE owner_user_id = ? ORDER BY created_at DESC LIMIT 10",
			).bind(identity.accountUserId ?? identity.userId).all().catch(() => ({ results: [] }));
			return {
				organizations: (organizations ?? []).map((org) => ({ name: org.name, role: org.role ?? org.org_role ?? null })),
				members: (members ?? []).slice(0, 20).map((member) => ({
					name: member.name ?? null, email: member.email ?? null, role: member.role ?? member.org_role ?? null,
					status: member.status ?? null,
				})),
				projects: (projects ?? []).map((project) => ({ name: project.name, status: project.status })),
			};
		},
	},

	/** The extraction rules that decide what gets remembered. */
	rules: {
		terms: ["rule", "rules", "policy", "extraction", "filter", "ignore", "capture", "control", "remember"],
		async run(env, identity) {
			const rules = await getMemoryRules(env, identity.userId).catch(() => null);
			return cap(rules ?? { rules: "none configured — defaults apply" }, 1800);
		},
	},

	/** Admin console — ONLY for an account whose session carries role=admin. */
	admin: {
		terms: ["admin", "operator", "everyone", "all", "users", "signups", "funnel", "spend", "console"],
		adminOnly: true,
		async run(env) {
			const [funnel, queue, errors] = await Promise.all([
				env.DB.prepare(
					`SELECT (SELECT COUNT(*) FROM users) AS users,
					        (SELECT COUNT(DISTINCT user_id) FROM receipts) AS activated,
					        (SELECT COUNT(*) FROM upgrade_requests WHERE status = 'open') AS open_requests`,
				).first().catch(() => null),
				env.DB.prepare(
					"SELECT kind, COUNT(*) AS n FROM upgrade_requests WHERE status = 'open' GROUP BY kind",
				).all().catch(() => ({ results: [] })),
				env.DB.prepare(
					`SELECT scope, COUNT(*) AS n FROM error_reports
					 WHERE created_at > ? AND scope NOT LIKE 'noise:%' GROUP BY scope ORDER BY n DESC LIMIT 8`,
				).bind(Date.now() - 7 * 24 * 60 * 60 * 1000).all().catch(() => ({ results: [] })),
			]);
			return {
				funnel,
				open_upgrade_requests: (queue.results ?? []),
				top_error_scopes_7d: (errors.results ?? []),
			};
		},
	},
};

/** The dashboard tab a person is looking at, mapped to what they likely mean. */
const VIEW_HINTS = {
	overview: ["inventory", "usage"],
	memory: ["inventory"],
	graph: ["graph"],
	receipts: ["history"],
	requests: ["jobs"],
	webhooks: ["webhooks"],
	exports: ["exports"],
	keys: ["api_keys"],
	usage: ["usage"],
	settings: ["members", "rules"],
	admin: ["admin"],
	install: [],
	playground: [],
};

/**
 * Decide which fetchers a question needs.
 *
 * Deterministic term routing, not a model call: it is free, instant, and
 * testable, and a wrong guess here costs an irrelevant paragraph rather than
 * a wrong answer. The view the person is looking at breaks ties, so "how does
 * this work?" asked on the Graph page fetches the graph.
 */
export function routeFetchers(question, { view = null, isAdmin = false } = {}) {
	const words = new Set(String(question ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
	const scored = [];
	for (const [id, fetcher] of Object.entries(FETCHERS)) {
		if (fetcher.adminOnly && !isAdmin) continue;
		let score = 0;
		for (const term of fetcher.terms) if (words.has(term)) score += 1;
		if (score > 0) scored.push({ id, score });
	}
	// The page in front of them is a strong signal, but never the only one.
	for (const id of VIEW_HINTS[view] ?? []) {
		if (FETCHERS[id]?.adminOnly && !isAdmin) continue;
		const existing = scored.find((entry) => entry.id === id);
		if (existing) existing.score += 1.5;
		else scored.push({ id, score: 1.5 });
	}
	// A first-person question about the account always deserves its numbers.
	if (/\b(my|mine|our|i|we|me)\b/.test(String(question ?? "").toLowerCase()) && !scored.some((entry) => entry.id === "usage")) {
		scored.push({ id: "usage", score: 0.5 });
	}
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, MAX_FETCHERS_PER_TURN).map((entry) => entry.id);
}

/** Run the chosen fetchers. One failing fetcher never fails the answer. */
export async function runFetchers(env, identity, ids, { question = "" } = {}) {
	const out = {};
	await Promise.all((ids ?? []).map(async (id) => {
		const fetcher = FETCHERS[id];
		if (!fetcher) return;
		try {
			out[id] = await fetcher.run(env, identity, { question });
		} catch (error) {
			console.warn(`huba fetcher ${id} failed:`, error?.message ?? error);
		}
	}));
	return out;
}
