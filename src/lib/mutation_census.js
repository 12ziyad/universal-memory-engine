/**
 * Static census of semantic writers.
 *
 * The first release of safe memory updates shipped writers that incremented
 * `revision` without CASing the revision they had read. A background job that
 * read state at revision N could therefore land after a user's explicit edit
 * and overwrite it as revision N+2. Green tests did not catch it because no
 * test interleaved the two.
 *
 * This module is the executable rule that stops it recurring: every UPDATE
 * that writes a user-visible editable column on a versioned table must either
 *   (a) carry a revision CAS in its WHERE clause, or
 *   (b) appear in ALLOWLIST below with a reason that says why it cannot be
 *       stale — and those reasons are reviewed, not assumed.
 *
 * The census is source-level on purpose: it fails in CI the moment someone
 * adds an unfenced writer, without needing a test that guesses the interleaving.
 */

/** Tables that carry a `revision` column and user-editable content. */
const VERSIONED_TABLES = Object.freeze(["nodes", "memory_pages", "slices", "events"]);

/**
 * Columns a customer can edit through the safe-update doors. A writer that
 * changes one of these is changing user-visible truth.
 */
const EDITABLE_COLUMNS = Object.freeze([
	"label", "category", "summary",
	"title", "short_summary", "full_markdown",
	"text", "kind",
	"importance", "happened_at",
]);

/** A WHERE clause counts as fenced when it pins the revision it observed. */
const REVISION_FENCE = /COALESCE\(\s*revision\s*,\s*1\s*\)\s*=\s*\?|(?:^|[^_\w])revision\s*=\s*\?/i;

/**
 * Deliberate exemptions. Each entry names the file, a unique fragment of the
 * statement, and why staleness is impossible — not merely unlikely.
 */
const ALLOWLIST = Object.freeze([
	{
		file: "src/pipeline/write.js",
		match: "SET revision = COALESCE(revision, 1) + 1, summary = COALESCE((",
		reason:
			"In-statement recompute. The summary is derived by the UPDATE itself from "
			+ "the facts committed in the same transaction, not from a value this "
			+ "writer read earlier, so there is no stale snapshot to overwrite.",
	},
	{
		file: "src/pipeline/write.js",
		match: "SET aliases_json = json_insert(",
		reason:
			"Append-only alias accumulation guarded by manual_node_identities; it "
			+ "adds a verified alias and never rewrites an editable field.",
	},
	{
		file: "src/pipeline/write.js",
		match: "UPDATE nodes SET aliases_json = ?, updated_at = ?, revision = COALESCE(revision, 1) + 1",
		reason:
			"aliases_json is system-owned identity metadata, not one of the "
			+ "customer-editable fields; identity claims already fence it.",
	},
	{
		file: "src/pipeline/write.js",
		match: "UPDATE slices SET is_current = 0, revision = COALESCE(revision, 1) + 1",
		reason:
			"Supersession flips lifecycle state (is_current), not editable content, "
			+ "and is gated by the manual fact identity that names the replacement.",
	},
	{
		file: "src/pipeline/pass2.js",
		match: "UPDATE slices SET is_current = 0, revision = COALESCE(revision, 1) + 1",
		reason: "Rollup supersession changes lifecycle state, never editable content.",
	},
]);

/** Files the census reads. Keep in sync with the semantic write paths. */
export const CENSUS_FILES = Object.freeze([
	"src/pipeline/write.js",
	"src/pipeline/pass2.js",
	"src/pipeline/pages.js",
	"src/pipeline/mcp_engine.js",
	"src/pipeline/cleanup.js",
	"src/pipeline/clusters.js",
	"src/pipeline/candidates.js",
	"src/lib/retention.js",
	"src/lib/memory_versions.js",
]);

/**
 * Extract UPDATE statements from source text. Statements are delimited by the
 * next backtick/quote terminator, which is enough to see the SET and WHERE of
 * a prepared statement written inline (the pattern this repository uses).
 */
export function extractUpdateStatements(source) {
	const statements = [];
	const re = /UPDATE\s+(\w+)\s+SET\b/gi;
	let match;
	while ((match = re.exec(source))) {
		const table = match[1];
		// Take a generous window; SQL in this repo is a single template literal.
		const window = source.slice(match.index, match.index + 2400);
		// Cut at the closing backtick/quote of the template literal.
		const endBacktick = window.indexOf("`", 1);
		const endQuote = window.indexOf('",', 1);
		let end = window.length;
		if (endBacktick > 0) end = Math.min(end, endBacktick);
		if (endQuote > 0) end = Math.min(end, endQuote);
		statements.push({ table, sql: window.slice(0, end), index: match.index });
	}
	return statements;
}

function setClauseOf(sql) {
	const whereAt = sql.search(/\bWHERE\b/i);
	return whereAt === -1 ? sql : sql.slice(0, whereAt);
}

function whereClauseOf(sql) {
	const whereAt = sql.search(/\bWHERE\b/i);
	return whereAt === -1 ? "" : sql.slice(whereAt);
}

/** Which editable columns a SET clause assigns. */
export function editableColumnsAssigned(setClause) {
	return EDITABLE_COLUMNS.filter((column) =>
		new RegExp(`(?:^|[\\s,(])${column}\\s*=`, "i").test(setClause));
}

function isAllowlisted(file, sql) {
	return ALLOWLIST.find((entry) =>
		file.endsWith(entry.file.split("/").pop())
		&& file.includes(entry.file.split("/").slice(-2, -1)[0] ?? "")
		&& sql.replace(/\s+/g, " ").includes(entry.match.replace(/\s+/g, " ")));
}

/**
 * Audit every census file. Returns { checked, fenced, allowlisted, unfenced }.
 * `unfenced` must be empty: each entry is a writer that can overwrite a newer
 * explicit user edit.
 */
export async function auditSemanticWriters({ files = CENSUS_FILES, readFile = null } = {}) {
	const read = readFile ?? (await defaultReader());
	const findings = { checked: 0, fenced: [], allowlisted: [], unfenced: [] };
	for (const file of files) {
		let source;
		try {
			source = await read(file);
		} catch {
			continue; // a file that no longer exists is not a finding
		}
		for (const statement of extractUpdateStatements(source)) {
			if (!VERSIONED_TABLES.includes(statement.table)) continue;
			const assigned = editableColumnsAssigned(setClauseOf(statement.sql));
			if (!assigned.length) continue;
			findings.checked += 1;
			const where = whereClauseOf(statement.sql);
			const excerpt = statement.sql.replace(/\s+/g, " ").slice(0, 150);
			if (REVISION_FENCE.test(where)) {
				findings.fenced.push({ file, table: statement.table, columns: assigned, excerpt });
				continue;
			}
			const allowed = isAllowlisted(file, statement.sql);
			if (allowed) {
				findings.allowlisted.push({ file, table: statement.table, columns: assigned, reason: allowed.reason });
				continue;
			}
			findings.unfenced.push({ file, table: statement.table, columns: assigned, excerpt });
		}
	}
	return findings;
}

/**
 * Default reader. Uses the bundled raw imports when running inside the Workers
 * pool (no filesystem), and node:fs everywhere else.
 */
async function defaultReader() {
	const bundled = await bundledSources();
	if (bundled) return async (file) => {
		const key = Object.keys(bundled).find((name) => name.endsWith(file.replace(/^src\//, "")));
		if (!key) throw new Error(`no bundled source for ${file}`);
		return bundled[key];
	};
	const { readFile } = await import("node:fs/promises");
	const { fileURLToPath } = await import("node:url");
	const root = fileURLToPath(new URL("../../", import.meta.url));
	return (file) => readFile(`${root}${file}`, "utf8");
}

async function bundledSources() {
	try {
		// Vite/workerd bundles these as raw text; unavailable under plain Node.
		const modules = import.meta.glob?.("../{pipeline,lib}/*.js", { query: "?raw", import: "default", eager: true });
		return modules && Object.keys(modules).length ? modules : null;
	} catch {
		return null;
	}
}
