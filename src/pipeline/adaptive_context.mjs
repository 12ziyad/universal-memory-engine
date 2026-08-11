/**
 * E10: deterministic, breadth-preserving context compilation.
 *
 * Retrieval has already selected and ordered scope-safe objects and E7 has
 * ordered the assertions inside each object. The compiler never searches,
 * scores, or introduces evidence. It chooses how many already-ranked
 * assertions to render for each object, groups exact E9A sources beside those
 * assertions, removes only exact normalized duplicates, and accounts for every
 * omission at the final assembly boundary.
 */

export const ADAPTIVE_CONTEXT_HARD_MAX = 24_000;
export const ADAPTIVE_ASSERTION_TEXT_MAX = 1_200;

const PROFILE_SPECS = Object.freeze({
	targeted: Object.freeze({ maxAssertionsPerNode: 1, maxContextChars: 12_000 }),
	"temporal-point": Object.freeze({ maxAssertionsPerNode: 1, maxContextChars: 14_000 }),
	"multi-source": Object.freeze({ maxAssertionsPerNode: 2, maxContextChars: 18_000 }),
	"temporal-span": Object.freeze({ maxAssertionsPerNode: 4, maxContextChars: 20_000 }),
	broad: Object.freeze({ maxAssertionsPerNode: 4, maxContextChars: ADAPTIVE_CONTEXT_HARD_MAX }),
});

const BROAD_RE = /\b(?:all|everything|summar(?:y|ize)|tell me about|what do you know|list|overview|profile|various|overall)\b/i;
const TEMPORAL_SPAN_RE = /\b(?:how long|duration|between|over time|history|timeline|changed?|changes|before|after|since|until|first|last|previous|former|used to|no longer|currently|current|latest|earliest|most recent)\b/i;
const MULTI_SOURCE_RE = /\b(?:both|compare|comparison|difference|relationship|related|respectively|each)\b/i;
const TEMPORAL_POINT_RE = /\b(?:when|date|dated|day|week|month|year|what time)\b|\b(?:19|20)\d{2}\b/i;
const QUESTION_WORD_RE = /\b(?:who|what|when|where|which|why|how)\b/gi;

function clean(value) {
	return String(value ?? "").replace(/\s+/g, " ").trim();
}

function finiteInteger(value, fallback) {
	const numeric = Number(value);
	return Number.isInteger(numeric) && numeric >= 0 ? numeric : fallback;
}

function clipCodeUnits(value, limit) {
	const text = clean(value);
	if (text.length <= limit) return { text, clipped: false };
	if (limit <= 1) return { text: limit === 1 ? "…" : "", clipped: true };
	let end = limit - 1;
	const code = text.charCodeAt(end - 1);
	if (code >= 0xD800 && code <= 0xDBFF) end -= 1;
	return { text: `${text.slice(0, Math.max(0, end))}…`, clipped: true };
}

function exactKey(value) {
	return clean(value).normalize("NFKC").toLocaleLowerCase("en-US");
}

function entryKey(entry, index) {
	return `${String(entry?.type ?? "entry")}:${String(entry?.id ?? entry?.item?.id ?? index)}`;
}

function nodeEvidence(entry) {
	const item = entry?.item ?? {};
	if (Array.isArray(item.evidence)) {
		return item.evidence
			.filter((row) => clean(row?.text))
			.map((row, index) => ({
				key: String(row?.key ?? `evidence:${index}`),
				kind: String(row?.kind ?? "fact"),
				text: clean(row.text),
				index,
			}));
	}
	const fallback = [
		...(item.relations ?? []).map((text) => ({ kind: "relation", text })),
		...(item.slices ?? []).map((row) => ({ kind: "slice", text: row?.text ?? row })),
		...(item.events ?? []).map((row) => ({ kind: "event", text: row?.text ?? row })),
	];
	return fallback.filter((row) => clean(row.text)).map((row, index) => ({
		key: `${row.kind}:${index}`,
		kind: row.kind,
		text: clean(row.text),
		index,
	}));
}

function sourceRecords(sourceExpansion) {
	const records = Array.isArray(sourceExpansion?.records)
		? sourceExpansion.records.filter((row) => clean(row?.line)).map((row, index) => ({
			episodeId: String(row?.episodeId ?? `source:${index}`),
			assertionKeys: [...new Set((row?.assertionKeys ?? []).map(String).filter(Boolean))],
			line: clean(row.line),
			sourceTime: Number.isFinite(Number(row?.sourceTime)) ? Number(row.sourceTime) : null,
			index,
		}))
		: [];
	if (records.length) return records;
	return (sourceExpansion?.lines ?? []).filter((line) => clean(line)).map((line, index) => ({
		episodeId: `unbound-source:${index}`,
		assertionKeys: [],
		line: clean(line),
		sourceTime: null,
		index,
	}));
}

function pageLine(entry) {
	const page = entry?.item ?? {};
	const points = (page.key_points ?? []).map(clean).filter(Boolean).slice(0, 3);
	const tail = [clean(page.short_summary), points.length ? `Key points: ${points.join("; ")}` : ""]
		.filter(Boolean).join(" ");
	return `Memory page: ${clean(page.title)}${tail ? ` - ${tail}` : ""}`;
}

function nodePrefix(entry) {
	const node = entry?.item ?? {};
	return `${clean(node.label) || "Memory"} (${clean(node.category) || "fact"}, state: ${clean(node.state) || "unknown"})`;
}

/** Classify query shape using only generic language signals. */
export function classifyAdaptiveContext(query) {
	const value = clean(query);
	if (BROAD_RE.test(value)) return "broad";
	if (TEMPORAL_SPAN_RE.test(value)) return "temporal-span";
	const questionWords = value.match(QUESTION_WORD_RE)?.length ?? 0;
	if (MULTI_SOURCE_RE.test(value) || questionWords > 1 || /\band\b/i.test(value) && questionWords > 0) {
		return "multi-source";
	}
	if (TEMPORAL_POINT_RE.test(value)) return "temporal-point";
	return "targeted";
}

/** Apply the frozen profile without ever widening the existing BF-2 plan. */
export function adaptiveContextPlan(query, plan = {}) {
	const profile = classifyAdaptiveContext(query);
	const spec = PROFILE_SPECS[profile];
	const existingLineItems = finiteInteger(plan?.maxLineItems, 4);
	const existingChars = finiteInteger(plan?.maxContextChars, ADAPTIVE_CONTEXT_HARD_MAX);
	return {
		profile,
		maxAssertionsPerNode: Math.min(existingLineItems, spec.maxAssertionsPerNode),
		maxContextChars: Math.min(existingChars, spec.maxContextChars, ADAPTIVE_CONTEXT_HARD_MAX),
	};
}

/**
 * Compile selected entries. Returned trace ids are opaque and are only exposed
 * through the existing opt-in internal trace; telemetry is content-free.
 */
export function compileAdaptiveContext(query, {
	entries = [],
	plan = {},
	staged = [],
	sourceExpansion = {},
	fallbackLines = [],
} = {}) {
	const profilePlan = adaptiveContextPlan(query, plan);
	const records = sourceRecords(sourceExpansion);
	const sourceByAssertion = new Map();
	for (const record of records) {
		for (const key of record.assertionKeys) {
			const list = sourceByAssertion.get(key) ?? [];
			list.push(record);
			sourceByAssertion.set(key, list);
		}
	}

	const units = [];
	const seenAssertionText = new Set();
	const plannedEpisodes = new Set();
	const trace = {
		profileSelectedAssertionIds: [],
		renderedAssertionIds: [],
		renderedEntryIds: [],
		renderedEpisodeIds: [],
	};
	const telemetry = {
		profile: profilePlan.profile,
		maxAssertionsPerNode: profilePlan.maxAssertionsPerNode,
		maxContextChars: profilePlan.maxContextChars,
		selectedEntries: entries.length,
		availableAssertions: 0,
		profileSelectedAssertions: 0,
		intentionalAssertionOmissions: 0,
		exactDuplicatesRemoved: 0,
		selectedSources: 0,
		renderedEntries: 0,
		renderedAssertions: 0,
		renderedSources: 0,
		hardCapDroppedEntries: 0,
		hardCapDroppedAssertions: 0,
		hardCapDroppedSources: 0,
		clippedAssertions: 0,
		contextLines: 0,
		contextChars: 0,
	};

	for (const [index, row] of staged.slice(0, 3).entries()) {
		const clipped = clipCodeUnits(row?.text, ADAPTIVE_ASSERTION_TEXT_MAX);
		if (clipped.text) units.push({ kind: "staged", line: `Just saved (still being organized): ${clipped.text}`, id: `staged:${row?.id ?? index}` });
	}

	// Records without an assertion mapping remain bounded E9A evidence and are
	// preserved before semantic entries. Current E9A always supplies mappings;
	// this path prevents a future schema mismatch from silently deleting source.
	for (const record of records.filter((row) => row.assertionKeys.length === 0)) {
		if (plannedEpisodes.has(record.episodeId)) continue;
		plannedEpisodes.add(record.episodeId);
		telemetry.selectedSources += 1;
		units.push({ kind: "source", line: record.line, episodeId: record.episodeId });
	}
	for (const [index, line] of fallbackLines.entries()) {
		const text = clean(line);
		if (text) units.push({ kind: "fallback", line: text, id: `fallback:${index}` });
	}

	entries.forEach((entry, index) => {
		const eKey = entryKey(entry, index);
		if (entry?.type === "page") {
			units.push({ kind: "entry", line: pageLine(entry), entryKey: eKey });
			return;
		}
		const evidence = nodeEvidence(entry);
		telemetry.availableAssertions += evidence.length;
		let selected = evidence.slice(0, profilePlan.maxAssertionsPerNode);
		telemetry.profileSelectedAssertions += selected.length;
		telemetry.intentionalAssertionOmissions += Math.max(0, evidence.length - selected.length);
		trace.profileSelectedAssertionIds.push(...selected.map((row) => row.key));

		// Duration/history queries retain E7's chosen set but render source-dated
		// assertions chronologically. Undated assertions remain stable at the end.
		if (profilePlan.profile === "temporal-span") {
			selected = selected.map((row, order) => {
				const times = (sourceByAssertion.get(row.key) ?? [])
					.map((source) => source.sourceTime).filter(Number.isFinite);
				return { ...row, order, sourceTime: times.length ? Math.min(...times) : null };
			}).sort((a, b) => {
				if (a.sourceTime === null && b.sourceTime === null) return a.order - b.order;
				if (a.sourceTime === null) return 1;
				if (b.sourceTime === null) return -1;
				return a.sourceTime - b.sourceTime || a.order - b.order;
			});
		}

		let plannedForEntry = 0;
		for (const assertion of selected) {
			const attached = sourceByAssertion.get(assertion.key) ?? [];
			const chronologySignature = profilePlan.profile === "temporal-span" || profilePlan.profile === "broad"
				? attached.map((row) => row.episodeId).sort().join("|")
				: "";
			const key = `${exactKey(assertion.text)}\u0000${chronologySignature}`;
			if (seenAssertionText.has(key)) {
				telemetry.exactDuplicatesRemoved += 1;
				continue;
			}
			seenAssertionText.add(key);
			for (const record of attached) {
				if (plannedEpisodes.has(record.episodeId)) continue;
				plannedEpisodes.add(record.episodeId);
				telemetry.selectedSources += 1;
				units.push({ kind: "source", line: record.line, entryKey: eKey, episodeId: record.episodeId });
			}
			const clipped = clipCodeUnits(assertion.text, ADAPTIVE_ASSERTION_TEXT_MAX);
			if (!clipped.text) continue;
			if (clipped.clipped) telemetry.clippedAssertions += 1;
			units.push({
				kind: "assertion",
				line: `${nodePrefix(entry)} - ${clipped.text}`,
				entryKey: eKey,
				assertionKey: assertion.key,
			});
			plannedForEntry += 1;
		}
		if (plannedForEntry === 0) {
			units.push({ kind: "entry", line: nodePrefix(entry), entryKey: eKey });
		}
	});

	const output = [];
	const renderedEntries = new Set();
	let chars = 0;
	for (const unit of units) {
		const line = clean(unit.line);
		if (!line) continue;
		const added = line.length + (output.length ? 1 : 0);
		if (chars + added > profilePlan.maxContextChars) {
			if (unit.kind === "assertion") telemetry.hardCapDroppedAssertions += 1;
			else if (unit.kind === "source") telemetry.hardCapDroppedSources += 1;
			continue;
		}
		output.push(line);
		chars += added;
		if (unit.entryKey) renderedEntries.add(unit.entryKey);
		if (unit.kind === "assertion") {
			telemetry.renderedAssertions += 1;
			trace.renderedAssertionIds.push(unit.assertionKey);
		}
		if (unit.kind === "source") {
			telemetry.renderedSources += 1;
			trace.renderedEpisodeIds.push(unit.episodeId);
		}
	}
	telemetry.renderedEntries = renderedEntries.size;
	telemetry.hardCapDroppedEntries = Math.max(0, telemetry.selectedEntries - renderedEntries.size);
	telemetry.contextLines = output.length;
	telemetry.contextChars = chars;
	trace.renderedEntryIds = [...renderedEntries];
	return { context: output.join("\n"), telemetry, trace, plan: profilePlan };
}

