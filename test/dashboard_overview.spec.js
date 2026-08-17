import { describe, expect, it } from "vitest";
import html from "../public/index.html?raw";

const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
const script = scripts.at(-1) ?? "";
const css = [...html.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/g)]
	.map((match) => match[1])
	.join("\n")
	.replace(/\r\n/g, "\n");

function fnSource(name) {
	let start = script.indexOf(`function ${name}(`);
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
	return {
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
				daily: [
					{ from_ms: from, to_ms: from + 86_400_000, total: 19, saves: 7, recalls: 12, saved_objects: 9, skipped: 1 },
					{ from_ms: from + 86_400_000, to_ms: from + 172_800_000, total: 27, saves: 10, recalls: 17, saved_objects: 14, skipped: 2 },
				],
				latency_ms: { p50: 71, p95: 416, p99: 854, samples: 40, eligible: 46, coverage: 40 / 46 },
			},
			previous: {
				operations: {
					total: 39, saves: 14, recalls: 25, saved_objects: 18, skipped: 2,
					matched: 18, matched_operations: 18, matched_samples: 25,
					outcomes: [{ outcome: "successful", count: 32 }, { outcome: "genuine_failure", count: 1 }],
				},
				daily: [
					{ from_ms: from - 172_800_000, total: 17, saves: 6, recalls: 11 },
					{ from_ms: from - 86_400_000, total: 22, saves: 8, recalls: 14 },
				],
				latency_ms: { p50: 65, p95: 370, p99: 790, samples: 34, eligible: 39, coverage: 34 / 39 },
			},
		},
		ai: {
			available: true,
			current: { calls: 13, successful_calls: 12, failed_calls: 1, input_tokens: 1_300, output_tokens: 420, total_tokens: 1_720, total_neurons_estimate: 8_100 },
			previous: { calls: 9, successful_calls: 9, failed_calls: 0, input_tokens: 900, output_tokens: 300, total_tokens: 1_200, total_neurons_estimate: 5_600 },
			quota: { used: 812, limit: 1_000, remaining: 188, capped: false, resets_at: Date.UTC(2026, 8, 1) },
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
		expect(summaries.memory).toMatch(/(?:memory object|inventory|composition)/);
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

	it("labels current job state truthfully and keeps retries and cancellations separate", () => {
		const region = overviewSource();
		const lower = region.toLowerCase();
		expect(lower).toContain("current job state");
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

	it("distinguishes project metrics from account-wide monthly AI writes", () => {
		const region = compact(overviewSource());
		const recallRate = fnSource("overviewRecallRate");
		expect(region).toMatch(/project-wide/i);
		expect(region).toMatch(/account-wide monthly AI writes/i);
		expect(region).toMatch(/all AI figures are account-wide/i);
		expect(region).toMatch(/\bai_writes\b/);
		expect(region).not.toMatch(/\bAI budget\b/i);
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
		expect(card).toMatch(/padding\s*:\s*13px\s+14px\s+12px/);
		expect(card).toMatch(/border-radius\s*:\s*12px/);
		expect(blockMatching(css, /\.overview-title\s+h2\s*\{/)).toMatch(/font-size\s*:\s*23px/);
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
		expect(S.overview.compare).toBe(false);
		const overview = fnSource("viewOverview");
		expect(overview).toMatch(/comparisonUnavailable\s*=\s*state\.metric\s*===\s*["']memory["']/);
		expect(overview).toMatch(/comparisonUnavailable[^\n]*disabled/);
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

	it("treats increased AI failures as unfavorable", () => {
		const S = { overview: { compare: true } };
		const { overviewAiChart } = overviewRuntime(["overviewAiChart"], { S, esc: (value) => String(value) });
		const fixture = dashboardFixture();
		fixture.ai.current.failed_calls = 4;
		fixture.ai.previous.failed_calls = 3;
		const markup = compact(overviewAiChart(fixture));
		expect(markup).toMatch(/Failed calls<\/span><strong>4<\/strong><span class="overview-delta warn">\+33\.3% vs previous<\/span>/);
	});

	it("keeps Memory, Requests, and Jobs drill-downs wired to real actions", () => {
		const region = overviewSource();
		for (const label of ["View memories", "View jobs"]) {
			expect(region).toMatch(new RegExp(label, "i"));
		}
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
