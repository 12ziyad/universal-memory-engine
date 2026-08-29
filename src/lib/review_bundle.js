/**
 * The sanitized AI Review Bundle (Phase 3).
 *
 * A reviewer — a prospective customer's security team, a compliance auditor,
 * counsel — needs to see how the system is configured and how much of it has
 * been exercised, WITHOUT being handed anybody's memory, anybody's email, or
 * a single credential. This composes that answer out of aggregates only.
 *
 * The design rule is inversion: nothing is included because it looked safe.
 * Every field here is either a count, an enum drawn from a CHECK-constrained
 * column, a boolean, a model name, or a numeric dial from wrangler.jsonc.
 * Free text, identifiers and addresses are structurally absent — the queries
 * below never SELECT `message`, `admin_notes`, `details_json`,
 * `metadata_json`, `actor_user_id`, `target_user_id`, `user_id`, or `email`.
 *
 * And because "we were careful" is not evidence, `assertBundleIsSanitized`
 * re-reads the finished bundle and throws if a secret value, an email
 * address, or an account identifier appears anywhere in it. The route runs
 * that assertion before responding, so a future contributor who adds a
 * leaking field gets a 500 and a failing test rather than a quiet disclosure.
 */

import { getConfig } from "../config.js";
import { memoryV3Status } from "./memory_v3.js";
import { POLICY_LANES, routingOverview } from "../ai/admin.js";
import { legalModesFor, ROUTING_MODES } from "../ai/policy.js";
import { KNOWN_PROVIDER_IDS } from "../ai/registry.js";
import { TRUST_KINDS, PRIVACY_CATEGORIES, TRUST_RESOLUTIONS } from "./trust_cases.js";
import { SECURITY_EVENT_FIELDS, SEVERITIES } from "./security_events.js";
import { AUDITABLE_FIELDS } from "./audit.js";

export const BUNDLE_SCHEMA = "itsuki.ai-review-bundle/v1";

/**
 * The subprocessor list as the legal pages state it. Held here as a constant
 * (not queried) because it is a disclosure, and a disclosure that drifts from
 * the published page is worse than no disclosure at all — the truthfulness
 * spec pins these two together.
 */
export const SUBPROCESSORS = Object.freeze([
	{ name: "Cloudflare", role: "All infrastructure and, today, all AI inference" },
	{ name: "Google", role: "Sign-in only (OAuth), when the user chooses it" },
	{ name: "GitHub", role: "Sign-in only (OAuth), when the user chooses it" },
]);

/** Env vars that are secrets. Their VALUES must never appear in the bundle. */
const SECRET_ENV_KEYS = Object.freeze([
	"API_KEY", "INVITATION_EMAIL_KEY", "AUTH_EMAIL_SECRET",
	"GOOGLE_CLIENT_SECRET", "GITHUB_CLIENT_SECRET", "GCP_SERVICE_ACCOUNT",
	"OWNER_NOTIFY_EMAIL",
]);

function countsFrom(rows, keys) {
	return (rows ?? []).map((row) => {
		const out = {};
		for (const key of keys) out[key] = row[key] ?? null;
		out.n = Number(row.n ?? 0);
		return out;
	});
}

/**
 * Build the bundle. Every query here is a GROUP BY over enum columns — the
 * shape of the data, never the data.
 */
export async function buildReviewBundle(env, { now = Date.now() } = {}) {
	const [trustRows, eventRows, auditRows, trustMeta, tableRows] = await env.DB.batch([
		env.DB.prepare("SELECT kind, status, severity, COUNT(*) AS n FROM trust_cases GROUP BY kind, status, severity"),
		env.DB.prepare("SELECT kind, severity, COUNT(*) AS n, SUM(count) AS occurrences FROM security_events GROUP BY kind, severity"),
		env.DB.prepare("SELECT action, outcome, COUNT(*) AS n FROM audit_events GROUP BY action, outcome"),
		env.DB.prepare(
			`SELECT
			   (SELECT COUNT(*) FROM trust_cases WHERE status != 'resolved') AS open,
			   (SELECT COUNT(*) FROM trust_cases WHERE status != 'resolved' AND response_due_at IS NOT NULL AND response_due_at < ?1) AS overdue,
			   (SELECT COUNT(*) FROM trust_cases WHERE status = 'resolved') AS resolved,
			   (SELECT COUNT(*) FROM trust_cases WHERE status = 'resolved' AND (response_due_at IS NULL OR resolved_at <= response_due_at)) AS resolved_within_promise`,
		).bind(now),
		env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"),
	]);

	let routing = null;
	try {
		const overview = await routingOverview(env);
		// audit_tail carries actor ids and operator free-text: dropped whole.
		routing = {
			master_gate: overview?.master_gate ?? null,
			credentials: overview?.credentials ?? null,
			global_disabled: overview?.global_disabled ?? null,
			lanes: (overview?.lanes ?? []).map((lane) => ({
				lane: lane.lane,
				pinned_by_saves: lane.pinned_by_saves ?? null,
				legal_modes: lane.legal_modes ?? null,
			})),
		};
	} catch (error) {
		routing = { unavailable: String(error?.message ?? "routing overview unavailable").slice(0, 120) };
	}

	const config = getConfig(env);
	const trustMetaRow = trustMeta?.results?.[0] ?? {};

	return {
		schema: BUNDLE_SCHEMA,
		generated_at: new Date(now).toISOString(),
		disclosure: {
			contains: "Configuration, enum-level aggregates, and counts.",
			excludes: "Memory content, message text, email addresses, account identifiers, IP data, credentials, and audit metadata blobs.",
		},
		version: {
			app: "0.1.0",
			latest_migration: "0062_trust_safety.sql",
			tables: (tableRows?.results ?? []).length,
		},
		configuration: {
			// getConfig reads only non-secret vars (model names, dials, flags).
			...config,
			maintenance_mode: String(env.MAINTENANCE_MODE ?? "off"),
			cors_enabled: env.ENABLE_CORS === "true",
			memory_v3: memoryV3Status(env),
		},
		ai_routing: {
			...routing,
			modes: ROUTING_MODES,
			known_providers: KNOWN_PROVIDER_IDS,
			legality_matrix: POLICY_LANES.map((lane) => ({ lane, legal_modes: legalModesFor(lane) })),
		},
		governance: {
			// The allowlists are the contract: publishing them lets a reviewer
			// check what CAN be recorded without seeing what WAS recorded.
			auditable_fields: [...AUDITABLE_FIELDS].sort(),
			security_event_fields: [...SECURITY_EVENT_FIELDS].sort(),
			severities: SEVERITIES,
			trust_kinds: TRUST_KINDS,
			privacy_request_categories: PRIVACY_CATEGORIES,
			trust_resolutions: TRUST_RESOLUTIONS,
		},
		trust: {
			meta: {
				open: Number(trustMetaRow.open ?? 0),
				overdue: Number(trustMetaRow.overdue ?? 0),
				resolved: Number(trustMetaRow.resolved ?? 0),
				resolved_within_promise: Number(trustMetaRow.resolved_within_promise ?? 0),
			},
			by_kind_status_severity: countsFrom(trustRows?.results, ["kind", "status", "severity"]),
		},
		security_events: {
			by_kind_severity: (eventRows?.results ?? []).map((row) => ({
				kind: row.kind, severity: row.severity,
				rows: Number(row.n ?? 0), occurrences: Number(row.occurrences ?? 0),
			})),
		},
		audit: {
			by_action_outcome: countsFrom(auditRows?.results, ["action", "outcome"]),
		},
		subprocessors: SUBPROCESSORS,
	};
}

/**
 * The proof, not the promise. Re-reads the serialized bundle and refuses to
 * let it out if it carries a secret value, an email address, or an account
 * identifier. Throws — a leak must be a failure, never a response.
 */
export function assertBundleIsSanitized(bundle, env) {
	const serialized = JSON.stringify(bundle);

	for (const key of SECRET_ENV_KEYS) {
		const value = env?.[key];
		if (typeof value === "string" && value.length >= 8 && serialized.includes(value)) {
			throw new Error(`review bundle leaked the value of ${key}`);
		}
	}
	// Any email address at all. The bundle has no legitimate reason to carry one.
	const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.exec(serialized);
	if (email) throw new Error(`review bundle leaked an email address: ${email[0].slice(0, 6)}…`);
	// Account and memory-space identifiers.
	const identifier = /\b(?:user_[0-9a-f-]{8,}|mem_[0-9a-f]{8,}|usr_[0-9a-zA-Z_-]{8,})\b/.exec(serialized);
	if (identifier) throw new Error(`review bundle leaked an identifier: ${identifier[0].slice(0, 8)}…`);
	// Field names that would mean content had been included.
	for (const forbidden of ["metadata_json", "details_json", "admin_notes", "message", "email", "ip_hash"]) {
		if (Object.prototype.hasOwnProperty.call(flattenKeys(bundle), forbidden)) {
			throw new Error(`review bundle carries a forbidden field: ${forbidden}`);
		}
	}
	return true;
}

function flattenKeys(value, out = {}) {
	if (Array.isArray(value)) {
		for (const item of value) flattenKeys(item, out);
	} else if (value && typeof value === "object") {
		for (const [key, child] of Object.entries(value)) {
			out[key] = true;
			flattenKeys(child, out);
		}
	}
	return out;
}
