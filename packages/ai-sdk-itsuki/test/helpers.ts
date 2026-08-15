/** Shared test scaffolding. No network, no clock dependence, no real keys. */

import type { ItsukiConfig } from "../src/config.js";

export const TEST_KEY = "itsuki_live_abcdefgh12345678";
export const BASE_URL = "https://api.example";

export interface RecordedCall {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: Record<string, unknown> | undefined;
	redirect: string | undefined;
}

export interface FakeFetch {
	fetch: typeof fetch;
	calls: RecordedCall[];
}

type Responder = (call: RecordedCall, index: number) => Response | Promise<Response>;

/** A fetch that records what it was asked and answers from a script. */
export function fakeFetch(responder: Responder): FakeFetch {
	const calls: RecordedCall[] = [];
	const impl = (async (input: URL | RequestInfo, init?: RequestInit) => {
		const headers: Record<string, string> = {};
		for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
			headers[key.toLowerCase()] = value;
		}
		const call: RecordedCall = {
			url: String(input),
			method: init?.method ?? "GET",
			headers,
			body: typeof init?.body === "string"
				? (JSON.parse(init.body) as Record<string, unknown>)
				: undefined,
			redirect: init?.redirect,
		};
		calls.push(call);
		return await responder(call, calls.length - 1);
	}) as unknown as typeof fetch;
	return { fetch: impl, calls };
}

export function json(status: number, payload: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

/** Recall answers with context, saves answer with a receipt. */
export function scriptedApi(options: {
	context?: string;
	count?: number;
	packetId?: string;
} = {}): FakeFetch {
	return fakeFetch((call) => {
		if (call.url.endsWith("/v1/recall")) {
			return json(200, {
				ok: true,
				context: options.context ?? "",
				count: options.count ?? (options.context ? 1 : 0),
			});
		}
		if (call.url.endsWith("/v1/save")) {
			return json(200, {
				ok: true,
				source_packet_id: options.packetId ?? "pkt_test",
				counts: { savedTotal: 1 },
			});
		}
		return json(200, { ok: true });
	});
}

export function config(overrides: Partial<ItsukiConfig> & { fetchImpl?: typeof fetch } = {}): ItsukiConfig {
	return {
		apiKey: TEST_KEY,
		baseUrl: BASE_URL,
		userId: "u_test",
		conversationId: "conv_test",
		capture: "blocking",
		// Tests must never wait on real backoff.
		sleepImpl: async () => undefined,
		random: () => 0.5,
		...overrides,
	} as ItsukiConfig;
}

export function saveCalls(calls: RecordedCall[]): RecordedCall[] {
	return calls.filter((call) => call.url.endsWith("/v1/save"));
}

export function recallCalls(calls: RecordedCall[]): RecordedCall[] {
	return calls.filter((call) => call.url.endsWith("/v1/recall"));
}

/** Wait for detached background work to settle. */
export async function flushMicrotasks(times = 5): Promise<void> {
	for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}
