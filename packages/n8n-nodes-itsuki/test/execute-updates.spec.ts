/**
 * Execute-level tests for the safe-update operations.
 *
 * The first release only inspected the node DESCRIPTION, which proved the
 * fields existed but never that the branches build a correct request. These
 * run Itsuki.execute() for updateMemory / history / rollbackMemory and assert
 * the exact HTTP call, including the mandatory precondition and idempotency
 * key, plus the refusals for malformed input.
 */

import { describe, expect, it, vi } from 'vitest';
import type { IDataObject } from 'n8n-workflow';

import { Itsuki } from '../nodes/Itsuki/Itsuki.node';

const KEY = 'itsuki_live_secret_key_0123456789';

interface Recorded { method?: string; url?: string; body?: IDataObject; qs?: IDataObject }

/** Minimal IExecuteFunctions covering exactly what execute() touches. */
function fakeExecute(operation: string, params: Record<string, unknown>, response: IDataObject) {
	const calls: Recorded[] = [];
	const ctx = {
		calls,
		getInputData: () => [{ json: {} }],
		getNodeParameter(name: string, _i: number, fallback?: unknown) {
			if (name === 'operation') return operation;
			if (name in params) return params[name] as never;
			if (fallback !== undefined) return fallback as never;
			throw new Error(`missing parameter ${name}`);
		},
		getNode() {
			return { name: 'Itsuki', type: 'n8n-nodes-itsuki.itsuki', typeVersion: 1, position: [0, 0], parameters: {} };
		},
		async getCredentials() {
			return { apiKey: KEY, baseUrl: 'https://itsuki.app' };
		},
		continueOnFail: () => false,
		helpers: {
			httpRequestWithAuthentication: vi.fn(async (_cred: string, req: IDataObject) => {
				calls.push(req as Recorded);
				return { statusCode: 200, body: response, headers: {} };
			}),
			returnJsonArray: (data: IDataObject | IDataObject[]) =>
				(Array.isArray(data) ? data : [data]).map((json) => ({ json })),
			constructExecutionMetaData: (data: unknown) => data,
		},
	};
	return ctx;
}

const node = new Itsuki();

describe('execute: Update Memory', () => {
	it('PATCHes the memory with the expected revision and an idempotency key', async () => {
		const ctx = fakeExecute('updateMemory', {
			memoryId: 'node_abc',
			expectedRevision: 3,
			updateFields: '{"summary":"Corrected by the workflow."}',
			updateReason: 'workflow correction',
			additionalFields: {},
		}, { ok: true, revision: 4 });

		await node.execute.call(ctx as never);

		expect(ctx.calls).toHaveLength(1);
		const call = ctx.calls[0];
		expect(call.method).toBe('PATCH');
		expect(String(call.url)).toContain('/v1/memories/node_abc');
		expect(call.body?.summary).toBe('Corrected by the workflow.');
		expect(call.body?.expectedRevision).toBe(3);
		expect(call.body?.reason).toBe('workflow correction');
		expect(typeof call.body?.idempotencyKey).toBe('string');
		expect(String(call.body?.idempotencyKey).length).toBeGreaterThanOrEqual(8);
	});

	it('accepts a parsed object for Fields as well as a JSON string', async () => {
		const ctx = fakeExecute('updateMemory', {
			memoryId: 'page_xyz',
			expectedRevision: 1,
			updateFields: { title: 'New title' },
			updateReason: '',
			additionalFields: {},
		}, { ok: true, revision: 2 });
		await node.execute.call(ctx as never);
		expect(ctx.calls[0].body?.title).toBe('New title');
		expect(ctx.calls[0].body?.reason).toBeUndefined();
	});

	it('honours an explicit idempotency key from Additional Fields', async () => {
		const ctx = fakeExecute('updateMemory', {
			memoryId: 'node_abc',
			expectedRevision: 2,
			updateFields: '{"label":"Pinned"}',
			updateReason: '',
			additionalFields: { idempotencyKey: 'workflow-run-42-step-3' },
		}, { ok: true, revision: 3 });
		await node.execute.call(ctx as never);
		expect(ctx.calls[0].body?.idempotencyKey).toBe('workflow-run-42-step-3');
	});

	it('refuses malformed JSON and an empty field set without calling the API', async () => {
		for (const fields of ['{not json', '{}']) {
			const ctx = fakeExecute('updateMemory', {
				memoryId: 'node_abc',
				expectedRevision: 1,
				updateFields: fields,
				updateReason: '',
				additionalFields: {},
			}, { ok: true });
			await expect(node.execute.call(ctx as never)).rejects.toThrow();
			expect(ctx.calls).toHaveLength(0);
		}
	});

	it('refuses an empty memory id without calling the API', async () => {
		const ctx = fakeExecute('updateMemory', {
			memoryId: '   ',
			expectedRevision: 1,
			updateFields: '{"label":"x"}',
			updateReason: '',
			additionalFields: {},
		}, { ok: true });
		await expect(node.execute.call(ctx as never)).rejects.toThrow();
		expect(ctx.calls).toHaveLength(0);
	});
});

describe('execute: Memory History', () => {
	it('GETs the history with bounded paging parameters', async () => {
		const ctx = fakeExecute('history', {
			memoryId: 'node_abc',
			historyLimit: 10,
			historyCursor: '7',
			additionalFields: {},
		}, { ok: true, revisions: [] });

		await node.execute.call(ctx as never);
		const call = ctx.calls[0];
		expect(call.method).toBe('GET');
		expect(String(call.url)).toContain('/v1/memories/node_abc/history');
		expect(call.qs?.limit).toBe(10);
		expect(call.qs?.cursor).toBe('7');
	});

	it('omits an empty cursor rather than sending a blank one', async () => {
		const ctx = fakeExecute('history', {
			memoryId: 'node_abc',
			historyLimit: 20,
			historyCursor: '',
			additionalFields: {},
		}, { ok: true, revisions: [] });
		await node.execute.call(ctx as never);
		expect(ctx.calls[0].qs?.cursor).toBeUndefined();
	});
});

describe('execute: Rollback Memory', () => {
	it('POSTs the restore target together with the current head revision', async () => {
		const ctx = fakeExecute('rollbackMemory', {
			memoryId: 'event_abc',
			toRevision: 2,
			expectedRevision: 5,
			updateReason: 'restoring the original wording',
			additionalFields: {},
		}, { ok: true, revision: 6, rolled_back_to: 2 });

		await node.execute.call(ctx as never);
		const call = ctx.calls[0];
		expect(call.method).toBe('POST');
		expect(String(call.url)).toContain('/v1/memories/event_abc/rollback');
		expect(call.body?.toRevision).toBe(2);
		expect(call.body?.expectedRevision).toBe(5);
		expect(call.body?.reason).toBe('restoring the original wording');
		expect(typeof call.body?.idempotencyKey).toBe('string');
	});
});
