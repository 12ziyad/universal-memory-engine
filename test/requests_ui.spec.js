/**
 * Requests UI lifecycle.
 *
 * Execute the shipped view/load functions against a scripted API. Empty and
 * failed results are settled states, while newer ranges and projects fence out
 * stale responses.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import html from "../public/index.html?raw";

const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";

function fnSource(name) {
	let start = script.indexOf(`function ${name}(`);
	if (start === -1) throw new Error(`no function ${name} in the page`);
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

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

function requestsHarness(apiImpl, timeoutMs = 15_000) {
	return new Function("apiImpl", "timeoutMs", `
		const S = { view: "requests", projectEpoch: 7, projectController: new AbortController() };
		const REQUEST_TIMEOUT_MS = timeoutMs;
		const REQUEST_TYPES = { all: "All types", save: "Saves", recall: "Recalls", system: "System" };
		const RQ = {
			rows: [], range: "7d", type: "all", query: "", loading: false,
			loaded: false, loadingRange: "", error: "", requestId: 0,
		};
		const api = apiImpl;
		const fakeView = { appendChild() {} };
		let renders = 0;
		function filteredRequests() { return RQ.rows; }
		function el() { return { innerHTML: "" }; }
		function esc(value) { return String(value ?? ""); }
		function requestChart() { return ""; }
		function renderRequestsTable() {}
		function renderView() { renders += 1; viewRequests(fakeView); }
		${fnSource("viewRequests")}
		${fnSource("setRequestRange")}
		${fnSource("loadRequests")}
		return {
			state: () => RQ,
			renders: () => renders,
			start: renderView,
			refresh: loadRequests,
			setRange: setRequestRange,
			changeProject() {
				S.projectEpoch += 1;
				S.projectController.abort();
				S.projectController = new AbortController();
				RQ.requestId += 1;
				Object.assign(RQ, { rows: [], loading: false, loaded: false, loadingRange: "", error: "" });
			},
		};
	`)(apiImpl, timeoutMs);
}

async function settle() {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

afterEach(() => vi.useRealTimers());

describe("Requests loading lifecycle", () => {
	it("treats a successful empty range as loaded and never auto-retries", async () => {
		const api = vi.fn(async () => ({ requests: [] }));
		const harness = requestsHarness(api);
		harness.start();
		await settle();

		expect(api).toHaveBeenCalledTimes(1);
		expect(harness.state()).toMatchObject({ rows: [], loading: false, loaded: true, error: "" });
		await settle();
		expect(api).toHaveBeenCalledTimes(1);
	});

	it("settles an initial failure and retries only after an explicit refresh", async () => {
		const api = vi.fn()
			.mockRejectedValueOnce(new Error("temporarily unavailable"))
			.mockResolvedValueOnce({ requests: [] });
		const harness = requestsHarness(api);
		harness.start();
		await settle();

		expect(api).toHaveBeenCalledTimes(1);
		expect(harness.state()).toMatchObject({ loading: false, loaded: true, error: "temporarily unavailable" });
		await harness.refresh();
		expect(api).toHaveBeenCalledTimes(2);
		expect(harness.state()).toMatchObject({ loading: false, loaded: true, error: "" });
	});

	it("coalesces duplicate loads for the same range", async () => {
		const pending = deferred();
		const api = vi.fn(() => pending.promise);
		const harness = requestsHarness(api);
		harness.start();
		await settle();
		await harness.refresh();
		expect(api).toHaveBeenCalledTimes(1);

		pending.resolve({ requests: [] });
		await settle();
		expect(harness.state()).toMatchObject({ loading: false, loaded: true });
	});

	it("lets a newer range win when responses settle out of order", async () => {
		const oldRange = deferred();
		const newRange = deferred();
		const api = vi.fn((path) => path.includes("range=7d") ? oldRange.promise : newRange.promise);
		const harness = requestsHarness(api);
		harness.start();
		await settle();
		harness.setRange("30d");
		await settle();

		newRange.resolve({ requests: [{ id: "new" }] });
		await settle();
		oldRange.resolve({ requests: [{ id: "old" }] });
		await settle();

		expect(api).toHaveBeenCalledTimes(2);
		expect(harness.state()).toMatchObject({ range: "30d", rows: [{ id: "new" }], loading: false, loaded: true });
	});

	it("bounds a request that never settles and exposes a retryable error", async () => {
		vi.useFakeTimers();
		const api = vi.fn((_path, options) => new Promise((_resolve, reject) => {
			options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
		}));
		const harness = requestsHarness(api, 25);
		harness.start();
		await vi.advanceTimersByTimeAsync(25);
		await settle();

		expect(api).toHaveBeenCalledTimes(1);
		expect(harness.state().loading).toBe(false);
		expect(harness.state().loaded).toBe(true);
		expect(harness.state().error).toContain("too long");
	});

	it("the real project reset invalidates the active request lane", () => {
		const reset = fnSource("resetProjectBoundUiState");
		expect(reset).toContain("loaded: false");
		expect(reset).toContain("requestId: RQ.requestId + 1");
	});
});
