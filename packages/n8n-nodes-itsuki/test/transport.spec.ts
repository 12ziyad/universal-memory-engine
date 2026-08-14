import { describe, expect, it, vi } from 'vitest';
import type { IDataObject } from 'n8n-workflow';

import { itsukiApiRequest, listAllMemories, waitForPacket } from '../nodes/Itsuki/GenericFunctions';

const KEY = 'itsuki_live_secret_key_0123456789';

interface FakeResponse {
	statusCode: number;
	body: IDataObject;
	headers?: IDataObject;
}

/** Minimal IExecuteFunctions stand-in: credentials + HTTP + node identity. */
function fakeContext(responses: Array<FakeResponse | Error>, options: IDataObject = {}) {
	const calls: IDataObject[] = [];
	let cursor = 0;
	const ctx = {
		calls,
		async getCredentials() {
			return { apiKey: KEY, baseUrl: options.baseUrl ?? 'https://itsuki.app' };
		},
		getNode() {
			return { name: 'Itsuki', type: 'n8n-nodes-itsuki.itsuki', typeVersion: 1, position: [0, 0], parameters: {} };
		},
		helpers: {
			httpRequestWithAuthentication: vi.fn(async (_cred: string, req: IDataObject) => {
				calls.push(req);
				const next = responses[Math.min(cursor, responses.length - 1)];
				cursor += 1;
				if (next instanceof Error) throw next;
				return { statusCode: next.statusCode, body: next.body, headers: next.headers ?? {} };
			}),
		},
	};
	return ctx as unknown as Parameters<typeof itsukiApiRequest>[0] extends never
		? never
		: typeof ctx;
}

describe('itsukiApiRequest', () => {
	it('returns the body on 2xx and sends no key in the URL or query', async () => {
		const ctx = fakeContext([{ statusCode: 200, body: { ok: true } }]);
		const out = await itsukiApiRequest.call(ctx as never, { method: 'GET', path: '/v1/status' });
		expect(out.ok).toBe(true);
		const req = (ctx as unknown as { calls: IDataObject[] }).calls[0];
		expect(String(req.url)).toBe('https://itsuki.app/v1/status');
		expect(JSON.stringify(req.qs ?? {})).not.toContain(KEY);
		expect(String(req.url)).not.toContain(KEY);
	});

	it('retries GETs on 429 honouring Retry-After, then succeeds', async () => {
		const ctx = fakeContext([
			{ statusCode: 429, body: { error: 'too_many_requests', retry_after_s: 0 }, headers: { 'retry-after': '0' } },
			{ statusCode: 200, body: { ok: true } },
		]);
		const out = await itsukiApiRequest.call(ctx as never, { method: 'GET', path: '/v1/memories' });
		expect(out.ok).toBe(true);
		expect((ctx as unknown as { calls: unknown[] }).calls.length).toBe(2);
	});

	it('never retries a write without an idempotency key', async () => {
		const ctx = fakeContext([
			{ statusCode: 429, body: { error: 'too_many_requests', retry_after_s: 0 } },
			{ statusCode: 200, body: { ok: true } },
		]);
		await expect(
			itsukiApiRequest.call(ctx as never, { method: 'POST', path: '/v1/save', body: { content: 'x' } }),
		).rejects.toThrow();
		expect((ctx as unknown as { calls: unknown[] }).calls.length).toBe(1);
	});

	it('retries an idempotent write on retriable failure', async () => {
		const ctx = fakeContext([
			{ statusCode: 503, body: { error: 'unavailable' }, headers: { 'retry-after': '0' } },
			{ statusCode: 200, body: { ok: true, receipt_id: 'r1' } },
		]);
		const out = await itsukiApiRequest.call(ctx as never, {
			method: 'POST', path: '/v1/save', body: { content: 'x', idempotencyKey: 'k1' }, idempotent: true,
		});
		expect(out.receipt_id).toBe('r1');
	});

	it('does not retry quota exhaustion (non-retriable 429)', async () => {
		const ctx = fakeContext([
			{ statusCode: 429, body: { error: 'ai_quota_exhausted', usage: { used: 1, limit: 1 } } },
		]);
		await expect(
			itsukiApiRequest.call(ctx as never, { method: 'GET', path: '/v1/memories' }),
		).rejects.toThrow(/plan exhausted/i);
		expect((ctx as unknown as { calls: unknown[] }).calls.length).toBe(1);
	});

	it('redacts the API key from every error surface', async () => {
		const ctx = fakeContext([
			{ statusCode: 400, body: { error: 'bad_request', message: `echoed ${KEY} somehow` } },
		]);
		try {
			await itsukiApiRequest.call(ctx as never, { method: 'GET', path: '/v1/status' });
			expect.unreachable('should have thrown');
		} catch (error) {
			expect(JSON.stringify(error)).not.toContain(KEY);
			expect(String((error as Error).message)).not.toContain(KEY);
		}
	});

	it('redacts the key from network-level failures too', async () => {
		const ctx = fakeContext([new Error(`connect failed for Bearer ${KEY}`)]);
		try {
			await itsukiApiRequest.call(ctx as never, { method: 'POST', path: '/v1/save', body: { content: 'x' } });
			expect.unreachable('should have thrown');
		} catch (error) {
			expect(JSON.stringify(error)).not.toContain(KEY);
		}
	});

	it('refuses a non-HTTPS non-loopback base URL before any request', async () => {
		const ctx = fakeContext([{ statusCode: 200, body: { ok: true } }], { baseUrl: 'http://internal.host' });
		await expect(
			itsukiApiRequest.call(ctx as never, { method: 'GET', path: '/v1/status' }),
		).rejects.toThrow(/HTTPS/);
		expect((ctx as unknown as { calls: unknown[] }).calls.length).toBe(0);
	});
});

describe('waitForPacket', () => {
	it('polls with the sub-tenant userId so the lookup hits the right memory space', async () => {
		// Regression: a save scoped to a userId must be polled with the same
		// userId — without it the status endpoint 404s (found in runtime test).
		const ctx = fakeContext([{ statusCode: 200, body: { status: 'enriched' } }]);
		await waitForPacket.call(ctx as never, 'src_1', { timeoutMs: 5_000, intervalMs: 1, userId: 'tenant_a' });
		const req = (ctx as unknown as { calls: IDataObject[] }).calls[0];
		expect((req.qs as IDataObject)?.userId).toBe('tenant_a');
	});

	it('polls to a terminal state and returns it', async () => {
		const ctx = fakeContext([
			{ statusCode: 200, body: { status: 'processing' } },
			{ statusCode: 200, body: { status: 'enriched', nodes: 2 } },
		]);
		const out = await waitForPacket.call(ctx as never, 'src_1', { timeoutMs: 5_000, intervalMs: 1 });
		expect(out.status).toBe('enriched');
		expect(out.timed_out).toBeUndefined();
	});

	it('returns an honest timed_out state, never a fabricated failure', async () => {
		const ctx = fakeContext([{ statusCode: 200, body: { status: 'processing' } }]);
		const out = await waitForPacket.call(ctx as never, 'src_1', { timeoutMs: 5, intervalMs: 1 });
		expect(out.timed_out).toBe(true);
		expect(out.status).toBe('processing');
	});
});

describe('listAllMemories', () => {
	it('follows cursors, respects the max-items cap', async () => {
		const page = (n: number, next: string | null) => ({
			statusCode: 200,
			body: {
				ok: true,
				items: Array.from({ length: n }, (_, i) => ({ id: `node_${i}` })),
				next_cursor: next,
			} as IDataObject,
		});
		const ctx = fakeContext([page(50, 'c1'), page(50, 'c2'), page(50, null)]);
		const items = await listAllMemories.call(ctx as never, {}, { returnAll: true, maxItems: 120, pageSize: 50 });
		expect(items.length).toBe(120);
	});

	it('detects a cursor loop and stops instead of looping forever', async () => {
		const looped = {
			statusCode: 200,
			body: { ok: true, items: [{ id: 'node_x' }], next_cursor: 'same' } as IDataObject,
		};
		const ctx = fakeContext([looped, looped, looped]);
		await expect(
			listAllMemories.call(ctx as never, {}, { returnAll: true, maxItems: 1000, pageSize: 50 }),
		).rejects.toThrow(/loop detected/i);
	});
});
