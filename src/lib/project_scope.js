const PROJECT_ID_MAX = 160;
const PROJECT_NAME_MAX = 120;

export class ProjectScopeError extends Error {
	constructor(code, message) {
		super(message);
		this.name = "ProjectScopeError";
		this.code = code;
		this.status = 400;
	}
}

function cleanDisplayValue(value, limit) {
	if (typeof value !== "string" && typeof value !== "number") return null;
	const text = String(value).replace(/\s+/g, " ").trim();
	if (!text) return null;
	return text.slice(0, limit);
}

function cleanProjectId(value) {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") {
		const received = Array.isArray(value) ? "array" : typeof value;
		throw new ProjectScopeError("invalid_project_id", `memoryScope.projectId must be a string (received ${received})`);
	}
	const text = value;
	if (!text || text.trim() !== text) {
		throw new ProjectScopeError("invalid_project_id", "memoryScope.projectId cannot be empty or have surrounding whitespace");
	}
	if (/[\u0000-\u001f\u007f]/.test(text)) {
		throw new ProjectScopeError("invalid_project_id", "memoryScope.projectId cannot contain control characters");
	}
	if (text.length > PROJECT_ID_MAX) {
		throw new ProjectScopeError(
			"project_id_too_long",
			`memoryScope.projectId cannot exceed ${PROJECT_ID_MAX} characters`,
		);
	}
	return text;
}

function parsedScopeJson(value) {
	if (typeof value !== "string" || !value.trim()) return {};
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

/**
 * Canonical project attribution used by every write path.
 *
 * A missing project id is the account-global scope. `projectName` is display
 * metadata only and can never turn an otherwise-global write into a project
 * write. `scope_json` is accepted so delayed jobs can recover the same scope
 * from their persisted source metadata.
 */
export function normalizeProjectScope(input = {}) {
	const direct = input && typeof input === "object" && !Array.isArray(input) ? input : {};
	const persisted = parsedScopeJson(direct.scope_json ?? direct.scopeJson);
	const projectId = cleanProjectId(
		direct.project_id ?? direct.projectId ?? persisted.project_id ?? persisted.projectId,
	);
	const projectName = projectId
		? cleanDisplayValue(
			direct.project_name ?? direct.projectName ?? persisted.project_name ?? persisted.projectName,
			PROJECT_NAME_MAX,
		)
		: null;
	return {
		projectId,
		projectName,
		project_id: projectId,
		project_name: projectName,
	};
}

/** Preserve non-project provenance while canonicalizing the project fields. */
export function canonicalMemoryScope(input = {}) {
	const raw = input && typeof input === "object" && !Array.isArray(input) ? input : {};
	const project = normalizeProjectScope(raw);
	return {
		...raw,
		projectId: project.projectId,
		projectName: project.projectName,
		project_id: project.projectId,
		project_name: project.projectName,
	};
}

/** True when a helper caller deliberately requested project filtering. */
export function hasProjectScopeOption(options) {
	return Boolean(options && typeof options === "object" && (
		Object.prototype.hasOwnProperty.call(options, "projectId")
		|| Object.prototype.hasOwnProperty.call(options, "project_id")
	));
}
