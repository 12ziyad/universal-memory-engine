import { describe, expect, it } from "vitest";
import html from "../public/index.html?raw";

const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
const script = scripts.at(-1) ?? "";
const css = [...html.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/g)]
	.map((match) => match[1])
	.join("\n")
	.replace(/\r\n/g, "\n");

function fnSource(name) {
	// Dashboard renderers can be replaced additively while a release is in
	// flight. JavaScript resolves the last declaration, so the contract test
	// must inspect the function users actually execute rather than an earlier
	// compatibility declaration.
	let start = script.lastIndexOf(`function ${name}(`);
	if (start === -1) return "";
	if (script.slice(Math.max(0, start - 6), start) === "async ") start -= 6;
	let parens = 0;
	let sawParams = false;
	let bodyStart = -1;
	for (let i = start; i < script.length; i++) {
		if (script[i] === "(") { parens++; sawParams = true; }
		else if (script[i] === ")") parens--;
		else if (script[i] === "{" && sawParams && parens === 0) { bodyStart = i; break; }
	}
	if (bodyStart === -1) throw new Error(`no body for ${name}`);
	let depth = 0;
	for (let i = bodyStart; i < script.length; i++) {
		if (script[i] === "{") depth++;
		else if (script[i] === "}") {
			depth--;
			if (depth === 0) return script.slice(start, i + 1);
		}
	}
	throw new Error(`unbalanced ${name}`);
}

function firstFunction(names) {
	for (const name of names) {
		const source = fnSource(name);
		if (source) return { name, source };
	}
	throw new Error(`none of these functions exist: ${names.join(", ")}`);
}

function overviewSource() {
	const start = script.indexOf("const OVERVIEW_RANGES");
	const end = script.indexOf("function viewMemory(", start);
	if (start === -1 || end === -1) throw new Error("overview source boundary is missing");
	return script.slice(start, end);
}

function compact(value) {
	return value.replace(/\s+/g, " ").trim();
}

function blockAfter(source, marker) {
	const start = source.indexOf(marker);
	if (start === -1) return "";
	const bodyStart = source.indexOf("{", start);
	if (bodyStart === -1) return "";
	let depth = 0;
	for (let i = bodyStart; i < source.length; i++) {
		if (source[i] === "{") depth++;
		else if (source[i] === "}") {
			depth--;
			if (depth === 0) return source.slice(start, i + 1);
		}
	}
	throw new Error(`unbalanced CSS block after ${marker}`);
}

function blockMatching(source, pattern) {
	const marker = source.match(pattern)?.[0] ?? "";
	return marker ? blockAfter(source, marker) : "";
}

function overviewRuntime(names, globals = {}) {
	const keys = Object.keys(globals);
	return new Function(
		...keys,
		`${overviewSource()}\nreturn { ${names.join(", ")} };`,
	)(...keys.map((key) => globals[key]));
}

function selectedOverviewMetric(state) {
	for (const field of ["metric", "kpi", "activeKpi"]) {
		if (typeof state[field] === "string") return state[field];
	}
	throw new Error("overview state has no selected KPI metric");
}

function overviewMetricStateField() {
	const state = script.match(/const S\s*=\s*\{([\s\S]*?)\n\};/)?.[1] ?? "";
	return state.match(/\b(metric|kpi|activeKpi)\s*:\s*["']memory["']/)?.[1] ?? "";
}

function dashboardFixture() {
	const from = Date.UTC(2026, 7, 12);
	const latency = (p50, p95, p99, samples, eligible, bands) => ({
		p50, p95, p99, samples, eligible, coverage: samples / eligible,
		bands: [
			{ min_ms: 0, max_ms_exclusive: 50, count: bands[0] },
			{ min_ms: 50, max_ms_exclusive: 100, count: bands[1] },
			{ min_ms: 100, max_ms_exclusive: 200, count: bands[2] },
			{ min_ms: 200, max_ms_exclusive: 400, count: bands[3] },
			{ min_ms: 400, max_ms_exclusive: 800, count: bands[4] },
			{ min_ms: 800, max_ms_exclusive: null, count: bands[5] },
		],
	});
	const reliability = ({ successful, noWrite, policy = 0, cancelled = 0, failed = 0, other = 0 }) => {
		const eligible = successful + noWrite + policy + cancelled + failed + other;
		const classified = eligible - other;
		return {
			successful, meaningful_no_write: noWrite, policy_skipped: policy, cancelled,
			genuine_failure: failed, other, classified, eligible,
			coverage: eligible ? classified / eligible : null, retry_scheduled: null,
		};
	};
	const aiPeriod = (calls, input, output, neurons, day) => ({
		calls, successful_calls: Math.max(0, calls - 1), failed_calls: calls ? 1 : 0,
		input_tokens: input, output_tokens: output, total_tokens: input + output,
		token_reported_calls: calls, measured_neurons: neurons, measured_neuron_calls: calls,
		derived_neuron_top_up: 0, total_neurons_estimate: neurons,
		daily: day,
	});
	const currentDaily = [
		{
			from_ms: from, to_ms: from + 86_400_000, total: 19, saves: 7, recalls: 12,
			saved_objects: 9, skipped: 1, matched: 8, matched_operations: 8, matched_samples: 12,
			outcomes: [{ outcome: "wrote", count: 6 }, { outcome: "recalled", count: 10 }, { outcome: "meaningful_no_write", count: 2 }, { outcome: "llm_failed", count: 1 }],
			lanes: [{ source: "save_memory", source_mode: "manual_direct", count: 7 }, { source: "recall", source_mode: "bounded_recall", count: 12 }],
			reliability: reliability({ successful: 16, noWrite: 2, failed: 1 }),
			latency_ms: latency(60, 330, 650, 19, 19, [2, 5, 6, 3, 2, 1]),
		},
		{
			from_ms: from + 86_400_000, to_ms: from + 172_800_000, total: 27, saves: 10, recalls: 17,
			saved_objects: 14, skipped: 2, matched: 11, matched_operations: 11, matched_samples: 17,
			outcomes: [{ outcome: "wrote", count: 9 }, { outcome: "recalled", count: 15 }, { outcome: "suppressed", count: 1 }, { outcome: "cancelled_by_retention", count: 1 }, { outcome: "db_write_failed", count: 1 }],
			lanes: [{ source: "save_conversation", source_mode: "conversation", count: 10 }, { source: "recall", source_mode: "bounded_recall", count: 17 }],
			reliability: reliability({ successful: 24, noWrite: 0, policy: 1, cancelled: 1, failed: 1 }),
			latency_ms: latency(82, 416, 854, 27, 27, [3, 7, 8, 5, 3, 1]),
		},
	];
	const previousDaily = [
		{
			from_ms: from - 172_800_000, to_ms: from - 86_400_000, total: 17, saves: 6, recalls: 11,
			saved_objects: 8, skipped: 1, matched: 7, matched_operations: 7, matched_samples: 11,
			outcomes: [{ outcome: "wrote", count: 6 }, { outcome: "recalled", count: 9 }, { outcome: "meaningful_no_write", count: 1 }, { outcome: "llm_failed", count: 1 }],
			lanes: [], reliability: reliability({ successful: 15, noWrite: 1, failed: 1 }),
			latency_ms: latency(55, 300, 600, 17, 17, [2, 5, 5, 3, 1, 1]),
		},
		{
			from_ms: from - 86_400_000, to_ms: from, total: 22, saves: 8, recalls: 14,
			saved_objects: 10, skipped: 1, matched: 11, matched_operations: 11, matched_samples: 14,
			outcomes: [{ outcome: "wrote", count: 8 }, { outcome: "recalled", count: 13 }, { outcome: "cancelled_by_delete", count: 1 }],
			lanes: [], reliability: reliability({ successful: 21, noWrite: 0, cancelled: 1 }),
			latency_ms: latency(65, 370, 790, 22, 22, [2, 6, 7, 4, 2, 1]),
		},
	];
	const projectAiCurrentDaily = [
		{ from_ms: from, to_ms: from + 86_400_000, calls: 4, successful_calls: 4, failed_calls: 0, input_tokens: 420, output_tokens: 120, total_tokens: 540, token_reported_calls: 4, measured_neurons: 2_400, measured_neuron_calls: 4, derived_neuron_top_up: 0, total_neurons_estimate: 2_400 },
		{ from_ms: from + 86_400_000, to_ms: from + 172_800_000, calls: 6, successful_calls: 5, failed_calls: 1, input_tokens: 680, output_tokens: 220, total_tokens: 900, token_reported_calls: 6, measured_neurons: 3_800, measured_neuron_calls: 6, derived_neuron_top_up: 0, total_neurons_estimate: 3_800 },
	];
	const projectAiPreviousDaily = [
		{ from_ms: from - 172_800_000, to_ms: from - 86_400_000, calls: 3, successful_calls: 3, failed_calls: 0, input_tokens: 300, output_tokens: 90, total_tokens: 390, token_reported_calls: 3, measured_neurons: 1_700, measured_neuron_calls: 3, derived_neuron_top_up: 0, total_neurons_estimate: 1_700 },
		{ from_ms: from - 86_400_000, to_ms: from, calls: 4, successful_calls: 3, failed_calls: 1, input_tokens: 390, output_tokens: 130, total_tokens: 520, token_reported_calls: 4, measured_neurons: 2_100, measured_neuron_calls: 4, derived_neuron_top_up: 0, total_neurons_estimate: 2_100 },
	];
	return {
		scope: { kind: "managed_project", project_id: "proj_fixture", memory_spaces: 2 },
		range: { key: "7d", days: 2, current: { from_ms: from, to_ms: from + 172_800_000 }, previous: { from_ms: from - 172_800_000, to_ms: from } },
		inventory: { total_objects: 41, nodes: 11, pages: 7, slices: 17, events: 4, edges: 2 },
		periods: {
			current: {
				operations: {
					total: 46, saves: 17, recalls: 29, saved_objects: 23, skipped: 3,
					matched: 19, matched_operations: 19, matched_samples: 29,
					outcomes: [
						{ outcome: "successful", count: 34 },
						{ outcome: "meaningful_no_write", count: 5 },
						{ outcome: "genuine_failure", count: 2 },
					],
				},
				daily: currentDaily,
				latency_ms: { p50: 71, p95: 416, p99: 854, samples: 40, eligible: 46, coverage: 40 / 46 },
			},
			previous: {
				operations: {
					total: 39, saves: 14, recalls: 25, saved_objects: 18, skipped: 2,
					matched: 18, matched_operations: 18, matched_samples: 25,
					outcomes: [{ outcome: "successful", count: 32 }, { outcome: "genuine_failure", count: 1 }],
				},
				daily: previousDaily,
				latency_ms: { p50: 65, p95: 370, p99: 790, samples: 34, eligible: 39, coverage: 34 / 39 },
			},
		},
		ai: {
			available: true,
			current: { calls: 13, successful_calls: 12, failed_calls: 1, input_tokens: 1_300, output_tokens: 420, total_tokens: 1_720, total_neurons_estimate: 8_100 },
			previous: { calls: 9, successful_calls: 9, failed_calls: 0, input_tokens: 900, output_tokens: 300, total_tokens: 1_200, total_neurons_estimate: 5_600 },
			quota: { used: 812, limit: 1_000, remaining: 188, capped: false, resets_at: Date.UTC(2026, 8, 1) },
			project: {
				scope: "managed_project", project_id: "proj_fixture", attribution: "managed_project_id",
				legacy_unattributed_excluded: true,
				periods: {
					current: aiPeriod(10, 1_100, 340, 6_200, projectAiCurrentDaily),
					previous: aiPeriod(7, 690, 220, 3_800, projectAiPreviousDaily),
				},
			},
		},
		jobs: {
			periods: {
				current: { enriched: 9, completed: 6, genuine_failures: 2, cancelled_by_delete: 1, cancelled_by_retention: 1, accepted_jobs_with_retries: 3 },
				previous: { enriched: 8, completed: 5, genuine_failures: 1, cancelled_by_delete: 0, cancelled_by_retention: 1, accepted_jobs_with_retries: 2 },
			},
		},
	};
}

describe("production dashboard overview contract", () => {
	it("owns explicit project-bound overview state and clears it during a project switch", () => {
		const state = script.match(/const S\s*=\s*\{([\s\S]*?)\n\};/)?.[1] ?? "";
		expect(state).toMatch(/\boverview\s*:\s*\{/);
		for (const field of [
			/\brange\s*:/,
			/\bmode\s*:/,
			/\b(?:metric|kpi|activeKpi)\s*:\s*["']memory["']/,
			/\bcompare\s*:/,
			/\btable\s*:/,
			/\bexpanded\s*:/,
			/\bjobsOpen\s*:/,
			/\b(?:data|payload)\s*:/,
			/\bloading\s*:/,
			/\berror\s*:/,
			/\b(?:requestId|loadId)\s*:/,
			/\b(?:updatedAt|lastUpdatedAt)\s*:/,
			/\bstale\s*:/,
		]) {
			expect(state, `missing overview state field ${field}`).toMatch(field);
		}

		const reset = fnSource("resetProjectBoundUiState");
		expect(reset).toMatch(/(?:S\.overview\s*=|Object\.assign\(S\.overview\s*,|reset(?:Dashboard|Overview)State\s*\()/);
		expect(reset).toMatch(/(?:requestId|loadId)/);
		for (const cleared of ["data", "loading", "error", "expanded", "jobsOpen", "stale"]) {
			expect(reset, `project reset does not clear ${cleared}`).toMatch(new RegExp(`\\b${cleared}\\s*:`));
		}
	});

	it("loads the overview through one race-guarded /v1/dashboard request path", () => {
		const region = overviewSource();
		const refresh = firstFunction(["refreshOverview"]);
		const endpointLiterals = region.match(/\/v1\/dashboard\b/g) ?? [];

		expect(endpointLiterals).toHaveLength(1);
		expect(refresh.source).toContain("/v1/dashboard");
		expect(refresh.source.match(/\bapi\s*\(/g) ?? []).toHaveLength(1);
		expect(refresh.source).toContain("S.overview");
		expect(refresh.source).toMatch(/\+\+/);
		expect(refresh.source).toMatch(/(?:requestId|loadId)/);
		expect(refresh.source).toMatch(/!==/);
		expect(refresh.source).toMatch(/S\.projectEpoch/);
		expect(region).not.toContain("/v1/usage");
		expect(region).not.toContain("/v1/ops/overview");
		expect(region).not.toContain("function refreshUsage(");
	});

	it("offers accessible range, compare, and v3 analysis-mode controls", () => {
		const region = overviewSource();
		const controls = fnSource("overviewModeControls");
		const { OVERVIEW_MODES } = overviewRuntime(["OVERVIEW_MODES"]);
		for (const range of ["1d", "7d", "30d", "90d"]) {
			expect(region, `missing ${range} range`).toMatch(new RegExp(`["']${range}["']`));
		}
		expect(region).not.toMatch(/["']all["']\s*,\s*["']All time["']/i);
		expect([...OVERVIEW_MODES]).toEqual(["activity", "reliability", "latency", "ai"]);
		for (const mode of ["Activity", "Reliability", "Latency", "AI usage"]) {
			expect(controls, `missing ${mode} mode`).toContain(mode);
		}
		expect(controls).not.toContain("Outcomes");
		expect(region).toMatch(/role=["']group["']/);
		expect(region).toMatch(/role=["']tablist["']/);
		expect(region).toMatch(/role=["']tab["']/);
		expect(region).toMatch(/aria-selected=/);
		expect(region).toMatch(/aria-pressed=/);
		expect(region).toMatch(/onkeydown=/);
		expect(region).toMatch(/compare/i);
		for (const handler of [
			"setOverviewRange",
			"setOverviewMode",
			"toggleOverviewCompare",
			"toggleOverviewExpanded",
			"toggleOverviewTable",
		]) {
			expect(fnSource(handler), `missing ${handler}`).not.toBe("");
		}
	});

	it("renders the six v3 KPIs as native, selectable controls in the reference order", () => {
		const selector = firstFunction(["setOverviewMetric", "setOverviewKpi"]);
		const metricField = overviewMetricStateField();
		expect(metricField, "overview state must own the selected KPI").toBeTruthy();
		const state = {
			overview: { [metricField]: "memory", mode: "activity", compare: false, table: false, expanded: false },
		};
		const ICON = new Proxy({}, { get: (_target, name) => `<svg data-icon="${String(name)}"></svg>` });
		const { overviewMetrics } = overviewRuntime(["overviewMetrics"], {
			S: state,
			ICON,
			esc: (value) => String(value),
		});
		const markup = overviewMetrics(dashboardFixture());
		const cards = markup.match(/<button\b[^>]*class=["'][^"']*\boverview-kpi\b[^"']*["'][^>]*>[\s\S]*?<\/button>/g) ?? [];
		const expected = [
			["memory", "Memory objects"],
			["saves", "Saves"],
			["recalls", "Recalls"],
			["reliability", "Reliability"],
			["latency", "Operation latency"],
			["ai", "AI write quota"],
		];

		expect(cards).toHaveLength(expected.length);
		expect(markup).not.toMatch(/<article\b[^>]*\boverview-kpi\b/);
		expect(cards.filter((card) => /aria-pressed=["']true["']/.test(card))).toHaveLength(1);
		for (const [index, [metric, label]] of expected.entries()) {
			const card = cards[index];
			expect(card, `${label} must be a native button`).toMatch(/^<button\b/);
			expect(card, `${label} needs button semantics`).toMatch(/\btype=["']button["']/);
			expect(card, `${label} needs selection state`).toMatch(/\baria-pressed=["'](?:true|false)["']/);
			expect(card, `${label} must name the chart it changes`).toMatch(/\baria-controls=["']overviewPulsePanel["']/);
			expect(card, `${label} is not wired to ${selector.name}`).toMatch(new RegExp(`onclick=["'][^"']*${selector.name}\\s*\\(\\s*["']${metric}["']\\s*\\)`));
			expect(compact(card.replace(/<[^>]+>/g, " ")), `wrong KPI at position ${index + 1}`).toContain(label);
		}
	});

	it("maps every KPI to a truthful, distinct primary visualization", () => {
		const selector = firstFunction(["setOverviewMetric", "setOverviewKpi"]);
		const metricField = overviewMetricStateField();
		expect(metricField, "overview state must own the selected KPI").toBeTruthy();
		const overview = {
			mode: "activity", compare: false, table: false, expanded: false,
			[metricField]: "memory",
		};
		const S = { overview };
		let renders = 0;
		const focusTarget = { focus() {} };
		const runtime = overviewRuntime(
			[selector.name, "setOverviewMode", "overviewPulse", "overviewChartSummary"],
			{
				S,
				ICON: new Proxy({}, { get: () => "<svg></svg>" }),
				esc: (value) => String(value),
				renderView: () => { renders++; },
				requestAnimationFrame: (callback) => callback(),
				document: {
					getElementById: () => focusTarget,
					querySelector: () => focusTarget,
				},
			},
		);
		const fixture = dashboardFixture();
		const expected = [
			["memory", "activity"],
			["saves", "activity"],
			["recalls", "activity"],
			["reliability", "reliability"],
			["latency", "latency"],
			["ai", "ai"],
		];
		const views = [];
		const summaries = {};

		for (const [metric, mode] of expected) {
			runtime[selector.name](metric);
			expect(selectedOverviewMetric(overview), `${metric} was not selected`).toBe(metric);
			expect(overview.mode, `${metric} selected the wrong analysis mode`).toBe(mode);
			views.push(compact(runtime.overviewPulse(fixture)));
			summaries[metric] = runtime.overviewChartSummary(fixture).toLowerCase();
		}

		// Re-selecting the already-active default may intentionally be a no-op.
		expect(renders).toBeGreaterThanOrEqual(expected.length - 1);
		expect(new Set(views).size, "one or more KPI buttons leave the primary visualization unchanged").toBe(expected.length);
		expect(summaries.memory).toMatch(/(?:activity|operation|save)/);
		expect(summaries.memory).toMatch(/recall/);
		expect(summaries.saves).toMatch(/(?:save|write)/);
		expect(summaries.saves).not.toMatch(/recall/);
		expect(summaries.recalls).toMatch(/recall/);
		expect(summaries.recalls).not.toMatch(/(?:save|write)/);
		expect(summaries.reliability).toMatch(/(?:reliab|settlement|outcome|failure)/);
		expect(summaries.latency).toMatch(/(?:latency|p95)/);
		expect(summaries.ai).toMatch(/ai/);

		for (const [mode, metric] of [
			["activity", "memory"],
			["reliability", "reliability"],
			["latency", "latency"],
			["ai", "ai"],
		]) {
			overview.mode = "unset";
			overview[metricField] = "saves";
			runtime.setOverviewMode(mode);
			expect(overview.mode).toBe(mode);
			expect(selectedOverviewMetric(overview), `${mode} tab did not select its canonical KPI`).toBe(metric);
		}
	});

	it("does not ship prototype data, deployment markers, or an unsupported global source filter", () => {
		const region = overviewSource();
		const lower = region.toLowerCase();
		for (const forbidden of [
			"nightingale prod",
			"preview data",
			"demo data",
			"fake data",
			"deploy 4f2a1c",
			"prototype data",
			"all sources",
		]) {
			expect(lower).not.toContain(forbidden);
		}
		expect(region).not.toMatch(/(?:sourceMenu|sourceFilter|setOverviewSource|setDashboardSource|usageBreakdown)/);
		expect(firstFunction(["refreshOverview"]).source)
			.not.toMatch(/[?&]source=/);
	});

	it("uses the reference dashboard title and explanatory copy", () => {
		const overview = compact(fnSource("viewOverview"));
		expect(overview).toContain("Memory operations");
		expect(overview).toContain("Understand what your memory layer stored, retrieved, and processed.");
	});

	it("labels processing health truthfully and keeps retries and cancellations separate", () => {
		const region = overviewSource();
		const lower = region.toLowerCase();
		expect(lower).toContain("processing health");
		for (const status of ["awaiting_source", "queued", "staged", "processing", "enriched", "failed", "completed"]) {
			expect(region, `missing real job status ${status}`).toContain(status);
		}
		expect(lower).toContain("retries");
		expect(lower).toMatch(/cancel(?:led|lations)/);
		expect(region).not.toMatch(/["']retrying["']/i);
		for (const unwanted of [
			"Every save runs through extraction and enrichment before it becomes memory.",
			"Acknowledged by the API",
			"Transient failure, will retry",
			"Needs a look",
		]) {
			expect(region).not.toContain(unwanted);
		}
	});

	it("keeps project-attributed AI series separate from the account quota", () => {
		const metrics = fnSource("overviewMetrics");
		const aiChart = fnSource("overviewAiChart");
		const aiDaily = fnSource("overviewAiDaily");
		const view = fnSource("viewOverview");
		const recallRate = fnSource("overviewRecallRate");
		expect(aiDaily).toMatch(/ai\?\.project\?\.periods/);
		expect(aiChart).toMatch(/overviewAiDaily/);
		expect(aiChart).toMatch(/project-attributed/i);
		expect(aiChart).not.toMatch(/data\.ai\?\.current/);
		expect(metrics).toMatch(/data\.ai\?\.quota/);
		expect(metrics).toMatch(/account-wide/i);
		expect(metrics).toMatch(/\bai_writes\b/);
		expect(view).not.toMatch(/Project-wide\s*·[^<]*memory spaces/i);
		expect(view).not.toMatch(/Account-wide monthly AI writes/i);
		expect(view).not.toMatch(/Copy dashboard link/i);
		expect(recallRate).toMatch(/operations\?\.matched_operations/);
		expect(recallRate).toMatch(/operations\?\.matched_samples/);
		expect(recallRate).not.toMatch(/operations\?\.matched\s*\)/);
	});

	it("matches the v3 desktop canvas and 6/3/2/1 responsive KPI geometry", () => {
		const region = overviewSource();
		expect(region).toMatch(/class=["'][^"']*\boverview-(?:kpi-grid|kpis)\b/);
		expect(region).toMatch(/class=["'][^"']*\boverview-job-grid\b/);

		const shellSelector = css.match(/\.view[^\{]*>\s*\.overview-shell/)?.[0] ?? "";
		const shell = blockAfter(css, shellSelector);
		expect(shellSelector).not.toBe("");
		expect(shell).toMatch(/max-width\s*:\s*1360px/);
		expect(shell).toMatch(/margin\s*:\s*0\s+auto/);

		const kpis = blockMatching(css, /\.overview-kpis\s*\{/);
		const card = blockMatching(css, /\.overview-kpi\s*\{/);
		expect(kpis).toMatch(/grid-template-columns\s*:\s*repeat\(6\s*,\s*minmax\(0\s*,\s*1fr\)\)/);
		expect(kpis).toMatch(/gap\s*:\s*10px/);
		expect(card).toMatch(/padding\s*:\s*15px\s+16px\s+13px/);
		expect(card).toMatch(/border-radius\s*:\s*12px/);
		expect(card).toMatch(/min-height\s*:\s*150px/);
		expect(blockMatching(css, /\.overview-title\s+h2\s*\{/)).toMatch(/font-size\s*:\s*28px/);
		expect(css).toMatch(/\.overview-job-grid\s*\{[^}]*grid-template-columns\s*:\s*repeat\(5\s*,/s);

		const mediaBlock = (width) => blockMatching(css, new RegExp(`@media\\s*\\(\\s*max-width\\s*:\\s*${width}px\\s*\\)`));
		const at1320 = mediaBlock(1320);
		const at900 = mediaBlock(900);
		const at560 = mediaBlock(560);
		expect(at1320).toMatch(/\.overview-kpis\s*\{[^}]*repeat\(3\s*,\s*minmax\(0\s*,\s*1fr\)\)/);
		expect(at1320).toMatch(/\.overview-job-grid\s*\{[^}]*repeat\(3\s*,/);
		expect(at900).toMatch(/\.overview-kpis\s*\{[^}]*repeat\(2\s*,\s*minmax\(0\s*,\s*1fr\)\)/);
		expect(at560).toMatch(/\.overview-kpis[^\{]*\{[^}]*grid-template-columns\s*:\s*minmax\(0\s*,\s*1fr\)/);
	});

	it("provides an accessible chart summary and an inspectable data table", () => {
		const region = overviewSource();
		expect(region).toMatch(/role=["']img["']/);
		expect(region).toMatch(/role=["']group["']/);
		expect(region).toMatch(/aria-describedby=/);
		expect(region).toMatch(/aria-live=["']polite["']/);
		expect(region).toMatch(/<table\b/);
		expect(region).toMatch(/<caption\b/);
		expect(region).toMatch(/Show data table/i);
		expect(region).toMatch(/aria-expanded=/);
		expect(region).toMatch(/aria-controls=["']overviewPulseDataTable["']/);
		expect(region).toMatch(/id=["']overviewPulseDataTable["'][^>]*role=["']region["']/);
	});

	it("renders four genuinely distinct daily graph modes from the additive dashboard contract", () => {
		const S = { overview: {
			mode: "activity", metric: "memory", compare: true, table: false, expanded: false,
			legendOff: {}, heatmap: true, reliabilityView: "share", data: null,
		} };
		const runtime = overviewRuntime(
			["overviewChartForMode", "overviewDataTable", "overviewChartSummary"],
			{ S, esc: (value) => String(value), ICON: new Proxy({}, { get: () => "<svg></svg>" }) },
		);
		const fixture = dashboardFixture();
		S.overview.data = fixture;
		const charts = {};
		const tables = {};
		const summaries = {};
		for (const mode of ["activity", "reliability", "latency", "ai"]) {
			S.overview.mode = mode;
			S.overview.metric = { activity: "memory", reliability: "reliability", latency: "latency", ai: "ai" }[mode];
			charts[mode] = compact(runtime.overviewChartForMode(fixture));
			tables[mode] = compact(runtime.overviewDataTable(fixture));
			summaries[mode] = runtime.overviewChartSummary(fixture).toLowerCase();
		}

		expect(new Set(Object.values(charts)).size).toBe(4);
		expect(charts.activity).toMatch(/Daily save and recall operations/i);
		expect(charts.activity).toMatch(/data-overview-series="saves"/);
		expect(charts.activity).toMatch(/data-overview-series="recalls"/);
		expect(charts.reliability).toMatch(/Daily operation reliability/i);
		expect(charts.reliability).toMatch(/Reliability chart units/i);
		expect(charts.reliability).toMatch(/Successful/i);
		expect(charts.reliability).toMatch(/Genuine failure/i);
		expect(charts.latency).toMatch(/Daily operation latency percentiles/i);
		for (const percentile of ["P50", "P95", "P99"]) expect(charts.latency).toContain(percentile);
		expect(charts.latency).toMatch(/Latency distribution/i);
		expect(charts.ai).toMatch(/Daily project-attributed AI usage/i);
		for (const series of ["AI calls", "Neurons", "Input tokens", "Output tokens"]) expect(charts.ai).toContain(series);

		expect(tables.activity).toMatch(/Daily (?:memory )?operations/i);
		expect(tables.reliability).toMatch(/Daily operation reliability/i);
		expect(tables.latency).toMatch(/Daily operation latency/i);
		expect(tables.latency).toMatch(/(?:&lt;|<)\s*50\s*ms/i);
		expect(tables.ai).toMatch(/Project-attributed AI usage/i);
		expect(summaries.activity).toMatch(/save/);
		expect(summaries.activity).toMatch(/recall/);
		expect(summaries.reliability).toMatch(/reliab|outcome/);
		expect(summaries.latency).toMatch(/p95|latency/);
		expect(summaries.ai).toMatch(/project-attributed|project ai/);
	});

	it("keeps unclassified outcomes unavailable instead of reporting false 100% reliability", () => {
		const S = { overview: { metric: "reliability", mode: "reliability", compare: false, legendOff: {} } };
		const runtime = overviewRuntime(["overviewReliabilityAggregate", "overviewMetrics"], {
			S,
			esc: (value) => String(value),
			ICON: new Proxy({}, { get: () => "<svg></svg>" }),
		});
		const fixture = dashboardFixture();
		fixture.periods.current.daily = [{
			from_ms: fixture.range.current.from_ms,
			to_ms: fixture.range.current.to_ms,
			saves: 0,
			recalls: 0,
			reliability: {
				successful: 0,
				meaningful_no_write: 0,
				policy_skipped: 0,
				cancelled: 0,
				genuine_failure: 0,
				other: 5,
				classified: 0,
				eligible: 5,
				coverage: 0,
				retry_scheduled: null,
			},
		}];
		const aggregate = runtime.overviewReliabilityAggregate(fixture);
		expect(aggregate).toMatchObject({ classified: 0, eligible: 5, other: 5, rate: null, coverage: 0 });

		// Compatibility fallback for an older additive payload must also exclude
		// `other`; otherwise it fabricates a 100% point in the KPI sparkline.
		delete fixture.periods.current.daily[0].reliability.classified;
		const markup = compact(runtime.overviewMetrics(fixture));
		const reliabilityKpi = markup.slice(
			markup.indexOf('id="overviewMetric-reliability"'),
			markup.indexOf('</button>', markup.indexOf('id="overviewMetric-reliability"')),
		);
		expect(reliabilityKpi).toContain("No classified operations");
		expect(reliabilityKpi).not.toContain("100.00%");
		expect(reliabilityKpi).not.toContain("overview-sparkline");
	});

	it("keeps one canonical implementation for each primary graph renderer", () => {
		for (const name of ["overviewActivityChart", "overviewReliabilityChart", "overviewLatencyChart", "overviewAiChart"]) {
			const declarations = script.match(new RegExp(`function\\s+${name}(?:[A-Z][A-Za-z0-9_]*)?\\s*\\(`, "g")) ?? [];
			expect(declarations, `${name} has a dead or overridden duplicate`).toHaveLength(1);
			expect(declarations[0]).toMatch(new RegExp(`function\\s+${name}\\s*\\(`));
		}
	});

	it("renders all six evidence-backed latency bands and keeps one-bucket series visible", () => {
		const S = { overview: {
			mode: "latency", metric: "latency", compare: false, table: false,
			legendOff: {}, heatmap: true, reliabilityView: "share",
		} };
		const runtime = overviewRuntime(["overviewLatencyChart"], { S, esc: (value) => String(value) });
		const fixture = dashboardFixture();
		const heatmap = compact(runtime.overviewLatencyChart(fixture));
		for (const label of ["800 ms+", "400–800", "200–400", "100–200", "50–100", "< 50 ms"]) {
			expect(heatmap).toContain(label);
		}
		expect(heatmap.match(/class="overview-heatmap-cell"/g) ?? []).toHaveLength(12);
		expect(heatmap).toContain("2 samples");
		expect(heatmap).toContain("8 samples");

		fixture.periods.current.daily = fixture.periods.current.daily.slice(0, 1);
		fixture.periods.previous.daily = fixture.periods.previous.daily.slice(0, 1);
		const oneBucket = compact(runtime.overviewLatencyChart(fixture));
		expect(oneBucket.match(/class="overview-series-dot"/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
	});

	it("keeps KPI presets visible even after users hide legends", () => {
		const focusTarget = { focus() {} };
		const S = { overview: {
			mode: "activity", metric: "memory", compare: false, table: false,
			legendOff: { saves: true, recalls: true, p95: true }, heatmap: true, reliabilityView: "share",
		} };
		const runtime = overviewRuntime(["setOverviewMetric", "setOverviewMode"], {
			S,
			renderView() {},
			requestAnimationFrame: (callback) => callback(),
			document: { getElementById: () => focusTarget, querySelector: () => focusTarget },
		});
		runtime.setOverviewMetric("saves");
		expect(S.overview).toMatchObject({ metric: "saves", mode: "activity" });
		expect(S.overview.legendOff.saves).not.toBe(true);
		runtime.setOverviewMetric("recalls");
		expect(S.overview.legendOff.recalls).not.toBe(true);
		runtime.setOverviewMode("latency");
		expect(S.overview).toMatchObject({ metric: "latency", mode: "latency" });
		expect(S.overview.legendOff.p95).not.toBe(true);
	});

	it("makes chart buckets keyboard-inspectable and the detail drawer modal-safe", () => {
		const targets = fnSource("overviewBucketTargets");
		const open = fnSource("openOverviewBucket");
		const close = fnSource("closeOverviewBucket");
		const rememberOpener = fnSource("rememberModalOpener");
		const restoreOpener = fnSource("restoreModalOpener");
		const drawer = firstFunction(["overviewBucketDrawer", "renderOverviewBucketDrawer"]);
		expect(targets).toMatch(/tabindex=["']0["']/);
		expect(targets).toMatch(/role=["']button["']/);
		expect(targets).toMatch(/event\.key\s*===\s*["']Enter["']/);
		expect(targets).toMatch(/event\.key\s*===\s*["'] ["']/);
		expect(targets).toMatch(/openOverviewBucket/);
		expect(open).toMatch(/rememberModalOpener\(\s*["']overviewBucketModal["']\s*\)/);
		expect(open).toMatch(/bucketIndex/);
		expect(close).toMatch(/bucketIndex/);
		expect(close).toMatch(/restoreModalOpener\(\s*["']overviewBucketModal["']/);
		expect(rememberOpener).toMatch(/document\.activeElement/);
		expect(rememberOpener).toMatch(/MODAL_FOCUS_RETURN\.set/);
		expect(restoreOpener).toMatch(/MODAL_FOCUS_RETURN\.get/);
		expect(restoreOpener).toMatch(/\.focus\(/);
		expect(drawer.source).toMatch(/overview-bucket-drawer/);
		expect(drawer.source).toMatch(/role=["']dialog["']/);
		expect(drawer.source).toMatch(/aria-modal=["']true["']/);
		expect(drawer.source).toMatch(/Operations/i);
		expect(drawer.source).toMatch(/Outcomes|Reliability/i);
		expect(drawer.source).toMatch(/Latency/i);
		expect(drawer.source).toMatch(/Project AI|AI (?:work|usage)/i);
		expect(drawer.source).not.toMatch(/View requests in this bucket/i);
		if (/setView\(\s*["']requests["']\s*\)/.test(drawer.source)) {
			expect(drawer.source).toMatch(/View root log/i);
		}
	});

	it("animates graph changes without violating reduced-motion preferences", () => {
		const bar = blockMatching(css, /\.overview-series-bar\s*\{/);
		const line = blockMatching(css, /\.overview-series-line\s*\{/);
		const heat = blockMatching(css, /\.overview-heatmap-cell\s*\{/);
		expect(bar).toMatch(/animation\s*:\s*overview-bar-rise/);
		expect(line).toMatch(/animation\s*:\s*overview-line-draw/);
		expect(heat).toMatch(/animation\s*:\s*overview-cell-in/);
		for (const keyframe of ["overview-bar-rise", "overview-line-draw", "overview-cell-in", "overview-drawer-in"]) {
			expect(css).toMatch(new RegExp(`@keyframes\\s+${keyframe}\\b`));
		}
		expect(fnSource("overviewPolylineSegments")).toMatch(/pathLength=["']1["']/);
		const reduced = blockMatching(css, /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/);
		for (const selector of ["overview-series-bar", "overview-series-line", "overview-heatmap-cell", "overview-bucket-drawer"]) {
			expect(reduced).toContain(selector);
		}
		expect(reduced).toMatch(/animation\s*:\s*none\s*!important/);
	});

	it("removes explanatory clutter and unsupported dashboard theater", () => {
		const view = fnSource("viewOverview");
		const pulse = fnSource("overviewPulse");
		const jobs = fnSource("overviewJobs");
		const region = overviewSource();
		for (const unwanted of [
			"Project-wide · 3,936 memory spaces",
			"Account-wide monthly AI writes",
			"Copy dashboard link",
			"Memory pulse",
			"A job is the background work Itsuki creates for each accepted save",
			"point-in-time and range figures are kept separate below",
		]) {
			expect(`${view}\n${pulse}\n${jobs}`).not.toContain(unwanted);
		}
		for (const unsupported of [
			"Claude Desktop", "Python SDK", "n8n workflow", "Webhook relay",
			"Deploy 4f2a1c", "Config change", "no data reported", "PARTIAL",
		]) {
			expect(region).not.toContain(unsupported);
		}
		expect(view).not.toMatch(/overview-copy-link|copyOverviewLink/);
		expect(pulse).not.toMatch(/overview-card-title[^\n]*<p>/);
	});

	it("makes comparison consistent across visual and assistive representations", () => {
		const S = { overview: { mode: "activity", metric: "saves", compare: false } };
		const runtime = overviewRuntime(["overviewDataTable", "overviewChartSummary", "toggleOverviewCompare"], {
			S,
			esc: (value) => String(value),
			renderView() {},
			requestAnimationFrame: (callback) => callback(),
			document: { getElementById: () => ({ focus() {} }) },
		});
		const fixture = dashboardFixture();
		expect(runtime.overviewDataTable(fixture)).not.toContain("Previous");
		expect(runtime.overviewChartSummary(fixture)).not.toMatch(/previous adjacent range/i);
		runtime.toggleOverviewCompare();
		expect(runtime.overviewDataTable(fixture)).toContain("Previous");
		expect(runtime.overviewChartSummary(fixture)).toMatch(/previous adjacent range/i);

		S.overview.metric = "memory";
		S.overview.compare = false;
		runtime.toggleOverviewCompare();
		expect(S.overview.compare).toBe(true);
		const overview = fnSource("viewOverview");
		expect(overview).not.toMatch(/comparisonUnavailable\s*=\s*state\.metric\s*===\s*["']memory["']/);
	});

	it("keeps activity charts truthful for zeroes and extreme previous periods", () => {
		const activity = fnSource("overviewActivityChart");
		expect(activity).toMatch(/previousRows\.map\(/);
		expect(activity).toMatch(/S\.overview\.compare[^\n]*values\.push\([^\n]*previousRows/);
		expect(activity).toMatch(/Math\.max\(1\s*,\s*\.\.\.values\)/);
		expect(activity).toMatch(/Math\.max\(0\s*,[^\n]*(?:height|barY)/);
		expect(activity).not.toMatch(/height=["'][^"']*Math\.max\(3\s*,/);
		expect(activity).toMatch(/<svg[^>]+role=["']img["']/);
		expect(activity).toMatch(/<title>/);
	});

	it("renders terminal load failures and cancelled jobs without false state", () => {
		const overview = fnSource("viewOverview");
		const jobs = fnSource("renderOverviewJobsPanel");
		expect(overview).toMatch(/!data\s*\?\s*\(\s*state\.loading\s*\?\s*overviewLoadingMarkup\(\)/);
		expect(overview).toMatch(/Dashboard data is unavailable/i);
		expect(jobs).toMatch(/job\.cancel_reason/);
		expect(jobs).toMatch(/cancelled_by_/);
		expect(jobs).toMatch(/const state\s*=\s*cancellation\s*\?\s*["']cancelled["']/);
		expect(jobs).toMatch(/<th>Retries<\/th>/);
	});

	it("keeps dialog isolation, contrast, and job status semantics robust", () => {
		const lockExpanded = fnSource("lockOverviewBackground");
		const lockJobs = fnSource("lockOverviewJobsBackground");
		const jobs = fnSource("overviewJobs");
		const { overviewStatusMap } = overviewRuntime(["overviewStatusMap"]);
		expect(lockExpanded).toMatch(/!node\?\.isConnected/);
		expect(lockExpanded).toContain("unlockOverviewBackground()");
		expect(lockExpanded).toMatch(/\[[^\]]*["']detail["'][^\]]*\]\.map/);
		expect(lockJobs).toMatch(/["']main["']/);
		expect(overviewStatusMap([{ status: "failed", count: 2 }, { status: "failed", count: 3 }])).toEqual({ failed: 5 });
		expect(jobs).toContain("Accepted jobs with retries");
		expect(jobs).toContain("Current job statuses:");
		expect(jobs).toContain("all-time enriched:");
		expect(css).toMatch(/\.overview-shell\s*,\s*\.overview-jobs-dialog\s*\{[^}]*--faint\s*:\s*var\(--muted\)/);
	});

	it("never substitutes account aggregates for unavailable project AI telemetry", () => {
		const S = { overview: { compare: true, legendOff: {}, mode: "ai", metric: "ai", table: false } };
		const runtime = overviewRuntime(["overviewAiChart"], { S, esc: (value) => String(value) });
		const fixture = dashboardFixture();
		const markup = compact(runtime.overviewAiChart(fixture));
		expect(markup).toMatch(/project-attributed/i);
		expect(markup).toMatch(/AI calls/i);
		fixture.ai.project = null;
		const unavailable = compact(runtime.overviewAiChart(fixture));
		expect(unavailable).toMatch(/Project-attributed AI telemetry is unavailable/i);
		expect(unavailable).not.toContain("13");
	});

	it("keeps Memory, Requests, and Jobs drill-downs wired to real actions", () => {
		const region = overviewSource();
		expect(region).toMatch(/View (?:root )?memories/i);
		expect(region).toMatch(/View jobs/i);
		expect(region).toMatch(/View (?:requests|operations|operation log|root log)/i);
		expect(region).toMatch(/View root log/i);
		expect(region).toMatch(/root memory-space operation log/i);
		expect(region).toMatch(/setView\(\s*["']memory["']/);
		expect(region).toMatch(/setView\(\s*["']requests["']/);
		expect(region).toMatch(/(?:open|show|view)[A-Za-z]*(?:Drilldown|Panel|Jobs)[A-Za-z]*\(\s*["']?jobs["']?/i);
		expect(region).not.toMatch(/\bnoop\s*\(/);
	});

	it("keeps charts dependency-free and local", () => {
		const externalScripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)]
			.map((match) => match[1])
			.filter((src) => /^https?:\/\//i.test(src));
		expect(externalScripts).toEqual([]);
		expect(overviewSource()).not.toMatch(/\b(?:Chart|ApexCharts|Plotly)\s*\(|\bd3\./);
		expect(html).not.toMatch(/(?:chart\.js|recharts|apexcharts|plotly|echarts|d3\.min\.js)/i);
	});
});
