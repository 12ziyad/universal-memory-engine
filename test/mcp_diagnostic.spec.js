import { describe, expect, it, vi } from "vitest";

import { probeMcp } from "../hooks/mcp-diagnostic.mjs";

const OPTIONS = {
	apiKey: "itsuki_live_MCP_DIAGNOSTIC_CANARY_82731",
	baseUrl: "https://itsuki.example",
	timeoutMs: 50,
};

describe("trusted MCP diagnostic transport", () => {
	it("cancels a rejected response body before returning the credential category", async () => {
		const cancel = vi.fn(async () => {});
		const fetchFn = vi.fn(async () => ({
			status: 401,
			ok: false,
			headers: new Headers({ "content-type": "application/json" }),
			body: { cancel },
		}));

		await expect(probeMcp({ ...OPTIONS, fetchFn })).resolves.toMatchObject({
			outcome: "credential_rejected",
			httpStatus: 401,
			toolsValid: false,
		});
		expect(cancel).toHaveBeenCalledOnce();
		expect(fetchFn).toHaveBeenCalledOnce();
	});

	it("cancels a reader when response streaming fails after headers", async () => {
		const cancel = vi.fn(async () => {});
		const releaseLock = vi.fn();
		const fetchFn = vi.fn(async () => ({
			status: 200,
			ok: true,
			headers: new Headers({ "content-type": "application/json" }),
			body: {
				getReader: () => ({
					read: vi.fn(async () => { throw new Error("stream failed"); }),
					cancel,
					releaseLock,
				}),
			},
		}));

		await expect(probeMcp({ ...OPTIONS, fetchFn })).resolves.toMatchObject({
			outcome: "network_error",
			toolsValid: false,
		});
		expect(cancel).toHaveBeenCalledOnce();
		expect(releaseLock).toHaveBeenCalledOnce();
		expect(fetchFn).toHaveBeenCalledOnce();
	});
});
