export const SOURCE_EVENT_SCHEMA = "itsuki.source-event/v1";
export const SOURCE_EVENT_TRACE_SCHEMA = "itsuki.source-event-trace/v1";
export const CLAUDE_CODING_EVENT_PREFIX = "[Claude coding event/v1]";

export const SOURCE_EVENT_TOOL_NAMES = Object.freeze([
	"AskUserQuestion",
	"Bash",
	"Edit",
	"NotebookEdit",
	"PowerShell",
	"RunCommand",
	"Shell",
	"Write",
]);

export const SOURCE_EVENT_KINDS = Object.freeze([
	"user_prompt",
	"assistant_prose",
	"tool_call",
	"tool_result",
	"command_result",
	"file_change",
	"test_result",
	"git_commit",
	"deployment_result",
	"error",
	"plan",
	"decision",
	"architecture_decision",
	"bug_fix",
	"user_preference",
	"unresolved_issue",
]);

export const SOURCE_EVENT_OUTCOMES = Object.freeze([
	"success",
	"failure",
	"partial",
	"skipped",
	"unknown",
]);

const KIND_SET = new Set(SOURCE_EVENT_KINDS);
const OUTCOME_SET = new Set(SOURCE_EVENT_OUTCOMES);
const TOOL_NAME_SET = new Set(SOURCE_EVENT_TOOL_NAMES);
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const PERSISTED_EVENT_ID_RE = /^source_event_v1_[a-f0-9]{48}$/;
const RESERVED_CLAUDE_PREFIX_RE = /^(\s*)\[Claude coding event\/v1\]/;
const SOURCE_EVENT_ID_DOMAIN = "itsuki.source-event-id/v1";
const MAX_EVENT_ID_LENGTH = 160;
const MAX_TOOL_NAME_LENGTH = 64;
const MAX_SEQUENCE = 1_000_000;
const MIN_EXIT_CODE = -255;
const MAX_EXIT_CODE = 255;
const MAX_TRACE_EVENTS = 10_000;
const MAX_TRACE_DROPPED_EVENTS = 1_000_000;
const ALIAS_CONFLICT = Symbol("source-event-alias-conflict");

function record(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function own(value, key) {
	return Object.prototype.hasOwnProperty.call(value, key);
}

function aliased(value, snake, camel) {
	const snakeValue = own(value, snake) ? value[snake] : undefined;
	const camelValue = own(value, camel) ? value[camel] : undefined;
	if (snakeValue != null && camelValue != null && snakeValue !== camelValue) return ALIAS_CONFLICT;
	return snakeValue ?? camelValue;
}

function optionalToken(value, limit) {
	if (value == null) return undefined;
	if (typeof value !== "string" || value.length < 1 || value.length > limit) return null;
	if (value.trim() !== value || !TOKEN_RE.test(value)) return null;
	return value;
}

function optionalToolName(value) {
	const token = optionalToken(value, MAX_TOOL_NAME_LENGTH);
	if (token === undefined || token === null) return token;
	return TOOL_NAME_SET.has(token) ? token : null;
}

function optionalInteger(value, min, max) {
	if (value == null) return undefined;
	if (!Number.isSafeInteger(value) || value < min || value > max) return null;
	return value;
}

/**
 * Normalize one content-minimal source event.
 *
 * Unknown properties are deliberately discarded. A malformed allowlisted
 * property rejects the event as a unit so an audit record can never imply
 * provenance that the caller did not validly supply. Text payloads such as
 * commands, diffs, logs, paths, prompts, output, and reasoning have no field
 * in this schema and therefore cannot cross this metadata boundary.
 */
export function normalizeSourceEvent(value) {
	const input = record(value);
	if (!input || input.schema !== SOURCE_EVENT_SCHEMA || !KIND_SET.has(input.kind)) return null;

	const eventId = optionalToken(aliased(input, "event_id", "eventId"), MAX_EVENT_ID_LENGTH);
	const parentEventId = optionalToken(
		aliased(input, "parent_event_id", "parentEventId"),
		MAX_EVENT_ID_LENGTH,
	);
	const toolName = optionalToolName(aliased(input, "tool_name", "toolName"));
	const outcomeInput = input.outcome;
	const outcome = outcomeInput == null
		? undefined
		: typeof outcomeInput === "string" && OUTCOME_SET.has(outcomeInput)
			? outcomeInput
			: null;
	const exitCode = optionalInteger(aliased(input, "exit_code", "exitCode"), MIN_EXIT_CODE, MAX_EXIT_CODE);
	const sequence = optionalInteger(input.sequence, 0, MAX_SEQUENCE);
	const truncated = input.truncated == null
		? undefined
		: typeof input.truncated === "boolean"
			? input.truncated
			: null;

	if ([eventId, parentEventId, toolName, outcome, exitCode, sequence, truncated].includes(null)) {
		return null;
	}

	return {
		schema: SOURCE_EVENT_SCHEMA,
		kind: input.kind,
		...(eventId === undefined ? {} : { event_id: eventId }),
		...(parentEventId === undefined ? {} : { parent_event_id: parentEventId }),
		...(toolName === undefined ? {} : { tool_name: toolName }),
		...(outcome === undefined ? {} : { outcome }),
		...(exitCode === undefined ? {} : { exit_code: exitCode }),
		...(sequence === undefined ? {} : { sequence }),
		...(truncated === undefined ? {} : { truncated }),
	};
}

export function isCanonicalSourceEventId(value) {
	return typeof value === "string" && PERSISTED_EVENT_ID_RE.test(value);
}

async function canonicalEventId(value) {
	if (value === undefined) return undefined;
	const bytes = new TextEncoder().encode(`${SOURCE_EVENT_ID_DOMAIN}\0${value}`);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	const hex = [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	return `source_event_v1_${hex.slice(0, 48)}`;
}

/** Derive an opaque persisted identifier from a server-controlled slot seed. */
export async function sourceEventIdFromServerSeed(value) {
	return canonicalEventId(value);
}

/**
 * Replace a caller-controlled identifier with a server-namespaced opaque ID.
 * The seed must contain no caller event ID; parent linkage is supplied only
 * after the surrounding batch has resolved it to a safe server identity.
 */
export async function canonicalizeSourceEvent(value, { eventIdSeed, parentEventId = null } = {}) {
	const event = normalizeSourceEvent(value);
	// A caller-supplied kind/outcome without a linkable identifier is only a
	// shape assertion. Keep it out of the structured metadata lane entirely.
	if (!event?.event_id || eventIdSeed == null) return null;
	const { event_id: _callerEventId, parent_event_id: callerParentEventId, ...safe } = event;
	return {
		...safe,
		event_id: await canonicalEventId(eventIdSeed),
		...(callerParentEventId !== undefined && PERSISTED_EVENT_ID_RE.test(parentEventId ?? "")
			? { parent_event_id: parentEventId }
			: {}),
	};
}

/** Validate the exact identifier form allowed beyond the ingest boundary. */
export function normalizePersistedSourceEvent(value) {
	const event = normalizeSourceEvent(value);
	if (!event?.event_id || !PERSISTED_EVENT_ID_RE.test(event.event_id)) return null;
	if (event.parent_event_id !== undefined && !PERSISTED_EVENT_ID_RE.test(event.parent_event_id)) return null;
	return event;
}

/** Resolve raw snake/camel aliases without persisting caller identifiers. */
export function sourceEventFromMessage(value) {
	const message = record(value);
	if (!message) return { provided: false, event: null };
	const hasSnake = own(message, "source_event") && message.source_event != null;
	const hasCamel = own(message, "sourceEvent") && message.sourceEvent != null;
	if (!hasSnake && !hasCamel) return { provided: false, event: null };

	const snake = hasSnake ? normalizeSourceEvent(message.source_event) : null;
	const camel = hasCamel ? normalizeSourceEvent(message.sourceEvent) : null;
	if ((hasSnake && !snake) || (hasCamel && !camel)) return { provided: true, event: null };
	if (snake && camel && JSON.stringify(snake) !== JSON.stringify(camel)) {
		return { provided: true, event: null };
	}
	const event = snake ?? camel;
	return { provided: true, event: event?.event_id ? event : null };
}

/** Resolve aliases and replace caller IDs with a server-derived opaque slot ID. */
export async function canonicalSourceEventFromMessage(value, options = {}) {
	const resolved = sourceEventFromMessage(value);
	if (!resolved.event) return resolved;
	return {
		provided: true,
		event: await canonicalizeSourceEvent(resolved.event, options),
	};
}

/** Resolve only server-canonical metadata after the public ingest boundary. */
export function persistedSourceEventFromMessage(value) {
	const message = record(value);
	if (!message) return { provided: false, event: null };
	const hasSnake = own(message, "source_event") && message.source_event != null;
	const hasCamel = own(message, "sourceEvent") && message.sourceEvent != null;
	if (!hasSnake && !hasCamel) return { provided: false, event: null };
	const snake = hasSnake ? normalizePersistedSourceEvent(message.source_event) : null;
	const camel = hasCamel ? normalizePersistedSourceEvent(message.sourceEvent) : null;
	if ((hasSnake && !snake) || (hasCamel && !camel)) return { provided: true, event: null };
	if (snake && camel && JSON.stringify(snake) !== JSON.stringify(camel)) {
		return { provided: true, event: null };
	}
	return { provided: true, event: snake ?? camel };
}

/**
 * A reserved coding-event header is inert without canonical metadata. Keep the
 * caller's text, but make its unverified status explicit before persistence or
 * model input so a forged prefix cannot acquire structured semantics.
 */
export function neutralizeReservedSourcePrefix(value, hasCanonicalSourceEvent = false) {
	const text = String(value ?? "");
	if (hasCanonicalSourceEvent) return text;
	return text.replace(RESERVED_CLAUDE_PREFIX_RE, "$1[Unverified coding-event text]");
}

function traceInteger(value, max) {
	return Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null;
}

function normalizeCounts(value, allowed, max) {
	const input = record(value);
	if (!input) return null;
	const output = {};
	for (const [key, rawCount] of Object.entries(input)) {
		if (!allowed.has(key)) return null;
		const count = traceInteger(rawCount, max);
		if (count == null) return null;
		if (count > 0) output[key] = count;
	}
	return output;
}

function sumCounts(value) {
	return Object.values(value).reduce((sum, count) => sum + count, 0);
}

/** Rebuild a content-free aggregate trace from normalized message metadata. */
export function sourceEventTraceFromMessages(messages, { droppedEvents = 0 } = {}) {
	const kinds = {};
	const outcomes = {};
	let events = 0;
	let linkedEvents = 0;
	let truncatedEvents = 0;

	for (const message of Array.isArray(messages) ? messages : []) {
		const candidate = record(message)?.source_event ?? record(message)?.sourceEvent ?? null;
		const event = normalizePersistedSourceEvent(candidate);
		if (!event) continue;
		events += 1;
		kinds[event.kind] = (kinds[event.kind] ?? 0) + 1;
		if (event.outcome) outcomes[event.outcome] = (outcomes[event.outcome] ?? 0) + 1;
		if (event.parent_event_id) linkedEvents += 1;
		if (event.truncated === true) truncatedEvents += 1;
	}

	if (events === 0 && droppedEvents === 0) return null;
	return normalizeSourceEventTrace({
		schema: SOURCE_EVENT_TRACE_SCHEMA,
		events,
		dropped_events: droppedEvents,
		linked_events: linkedEvents,
		truncated_events: truncatedEvents,
		kinds,
		outcomes,
	});
}

/** Validate receipt-safe source-event tracing and strip all unknown fields. */
export function normalizeSourceEventTrace(value) {
	const input = record(value);
	if (!input || input.schema !== SOURCE_EVENT_TRACE_SCHEMA) return null;

	const events = traceInteger(input.events, MAX_TRACE_EVENTS);
	const droppedEvents = traceInteger(input.dropped_events, MAX_TRACE_DROPPED_EVENTS);
	const linkedEvents = traceInteger(input.linked_events, MAX_TRACE_EVENTS);
	const truncatedEvents = traceInteger(input.truncated_events, MAX_TRACE_EVENTS);
	const kinds = normalizeCounts(input.kinds, KIND_SET, MAX_TRACE_EVENTS);
	const outcomes = normalizeCounts(input.outcomes, OUTCOME_SET, MAX_TRACE_EVENTS);
	if (
		events == null
		|| droppedEvents == null
		|| linkedEvents == null
		|| truncatedEvents == null
		|| !kinds
		|| !outcomes
		|| sumCounts(kinds) !== events
		|| sumCounts(outcomes) > events
		|| linkedEvents > events
		|| truncatedEvents > events
		|| events + droppedEvents < 1
	) return null;

	return {
		schema: SOURCE_EVENT_TRACE_SCHEMA,
		events,
		dropped_events: droppedEvents,
		linked_events: linkedEvents,
		truncated_events: truncatedEvents,
		kinds,
		outcomes,
	};
}
