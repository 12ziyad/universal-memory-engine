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

describe("production dashboard overview contract", () => {
	it("owns explicit project-bound overview state and clears it during a project switch", () => {
		const state = script.match(/const S\s*=\s*\{([\s\S]*?)\n\};/)?.[1] ?? "";
		expect(state).toMatch(/\boverview\s*:\s*\{/);
		for (const field of [
			/\brange\s*:/,
			/\bmode\s*:/,
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

	it("offers accessible range, compare, and analysis-mode controls", () => {
		const region = overviewSource();
		for (const range of ["1d", "7d", "30d", "90d"]) {
			expect(region, `missing ${range} range`).toMatch(new RegExp(`["']${range}["']`));
		}
		expect(region).not.toMatch(/["']all["']\s*,\s*["']All time["']/i);
		for (const mode of ["Activity", "Outcomes", "Latency", "AI"]) {
			expect(region, `missing ${mode} mode`).toContain(mode);
		}
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
		expect(region).toMatch(/\bai_writes\b/);
		expect(region).not.toMatch(/\bAI budget\b/i);
		expect(recallRate).toMatch(/operations\?\.matched_operations/);
		expect(recallRate).toMatch(/operations\?\.matched_samples/);
		expect(recallRate).not.toMatch(/operations\?\.matched\s*\)/);
	});

	it("uses dedicated responsive KPI and current-job grids", () => {
		const region = overviewSource();
		expect(region).toMatch(/class=["'][^"']*\boverview-(?:kpi-grid|kpis)\b/);
		expect(region).toMatch(/class=["'][^"']*\boverview-job-grid\b/);
		expect(css).toMatch(/\.overview-(?:kpi-grid|kpis)\s*\{[^}]*grid-template-columns\s*:\s*repeat\(3\s*,/s);
		expect(css).toMatch(/\.overview-job-grid\s*\{[^}]*grid-template-columns\s*:\s*repeat\(5\s*,/s);

		const twoColumnKpis = /@media[^\{]*max-width[^\{]*\{[\s\S]*?\.overview-(?:kpi-grid|kpis)[^\{]*\{[^}]*grid-template-columns\s*:\s*repeat\(2\s*,/;
		const threeColumnJobs = /@media[^\{]*max-width[^\{]*\{[\s\S]*?\.overview-job-grid[^\{]*\{[^}]*grid-template-columns\s*:\s*repeat\(3\s*,/;
		const oneColumn = /@media[^\{]*max-width[^\{]*\{[\s\S]*?\.overview-(?:kpi-grid|kpis)[\s\S]*?\.overview-job-grid[\s\S]*?grid-template-columns\s*:\s*(?:repeat\(1\s*,\s*)?minmax\(0\s*,\s*1fr\)?/;
		expect(css).toMatch(twoColumnKpis);
		expect(css).toMatch(threeColumnJobs);
		expect(css).toMatch(oneColumn);
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
	});

	it("keeps activity charts truthful for zeroes and extreme previous periods", () => {
		const activity = fnSource("overviewActivityChart");
		expect(activity).toMatch(/previousRows\.map\(/);
		expect(activity).toMatch(/Math\.min\(100\s*,/);
		expect(activity).not.toMatch(/<button[^>]+overview-bucket/);
		expect(activity).toMatch(/<span[^>]+overview-bucket[^>]+role=["']img["']/);
		expect(css).toMatch(/\.overview-bar\s*\{[^}]*min-height\s*:\s*0\b/s);
	});

	it("renders terminal load failures and cancelled jobs without false state", () => {
		const overview = fnSource("viewOverview");
		const jobs = fnSource("renderOverviewJobsPanel");
		expect(overview).toMatch(/!data\s*\?\s*\(\s*state\.loading\s*\?\s*overviewLoadingMarkup\(\)/);
		expect(overview).toMatch(/Dashboard data is unavailable/i);
		expect(jobs).toMatch(/job\.cancel_reason/);
		expect(jobs).toMatch(/cancelled_by_/);
		expect(jobs).toMatch(/const state\s*=\s*cancellation\s*\?\s*["']cancelled["']/);
	});

	it("keeps Memory, Requests, and Jobs drill-downs wired to real actions", () => {
		const region = overviewSource();
		for (const label of ["View memories", "View jobs"]) {
			expect(region).toMatch(new RegExp(label, "i"));
		}
		expect(region).toMatch(/View (?:requests|operations|operation log|root log)/i);
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
