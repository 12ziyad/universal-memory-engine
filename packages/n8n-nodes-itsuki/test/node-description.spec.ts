import { describe, expect, it } from 'vitest';
import type { INodeProperties } from 'n8n-workflow';

import { Itsuki } from '../nodes/Itsuki/Itsuki.node';
import { ItsukiApi } from '../credentials/ItsukiApi.credentials';

const node = new Itsuki();
const props = node.description.properties as INodeProperties[];
const find = (name: string) => props.find((p) => p.name === name);

describe('node description contract', () => {
	it('registers as a tool-capable memory node with the Itsuki credential', () => {
		expect(node.description.usableAsTool).toBe(true);
		expect(node.description.credentials).toEqual([{ name: 'itsukiApi', required: true }]);
		expect(node.description.name).toBe('itsuki');
	});

	it('defaults to the safest operation (recall), never a destructive one', () => {
		expect(find('operation')?.default).toBe('recall');
	});

	it('previews Delete All by default: confirmation is an explicit opt-in', () => {
		const confirm = find('confirmDestruction');
		expect(confirm?.type).toBe('boolean');
		expect(confirm?.default).toBe(false);
	});

	it('waits for completion by default on saves, with bounded knobs', () => {
		expect(find('waitForCompletion')?.default).toBe(true);
		const waitOptions = find('waitOptions');
		const timeout = (waitOptions?.options as INodeProperties[]).find((o) => o.name === 'timeoutSeconds');
		expect(timeout?.typeOptions?.maxValue).toBe(300);
	});

	it('bounds pagination: page size and max items are capped', () => {
		expect(find('pageSize')?.typeOptions?.maxValue).toBe(200);
		expect(find('maxItems')?.typeOptions?.maxValue).toBe(5000);
	});

	it('carries destructive warnings on both delete operations', () => {
		const notices = props.filter((p) => p.type === 'notice').map((p) => p.displayName);
		expect(notices.some((t) => /permanently deletes/i.test(t))).toBe(true);
		expect(notices.some((t) => /previews by default/i.test(t))).toBe(true);
	});

	it('exposes only truthful fields — no infer/metadata/custom-instruction fields the backend lacks', () => {
		const names = props.map((p) => p.name);
		for (const absent of ['infer', 'metadata', 'customInstructions', 'customCategories', 'includes', 'excludes']) {
			expect(names).not.toContain(absent);
		}
	});
});

describe('credential contract', () => {
	const cred = new ItsukiApi();

	it('masks the key and authenticates via header only', () => {
		const keyProp = cred.properties.find((p) => p.name === 'apiKey');
		expect(keyProp?.typeOptions?.password).toBe(true);
		expect(JSON.stringify(cred.authenticate)).toContain('Authorization');
		expect(JSON.stringify(cred.authenticate)).not.toContain('qs');
	});

	it('tests against the content-free status endpoint', () => {
		expect(cred.test.request.url).toBe('/v1/status');
	});

	it('defaults to the production origin', () => {
		const base = cred.properties.find((p) => p.name === 'baseUrl');
		expect(base?.default).toBe('https://itsuki.app');
	});
});

describe('safe memory update operations', () => {
	const operations = (find('operation')?.options ?? []) as Array<{ value: string }>;
	const values = operations.map((option) => option.value);

	it('registers update, history, and rollback operations', () => {
		expect(values).toContain('updateMemory');
		expect(values).toContain('history');
		expect(values).toContain('rollbackMemory');
	});

	it('requires an exact expected revision on update and rollback — no blind overwrite field', () => {
		const expected = find('expectedRevision');
		expect(expected?.required).toBe(true);
		expect(expected?.displayOptions?.show?.operation).toEqual(['updateMemory', 'rollbackMemory']);
		// No wildcard/force escape hatch exists anywhere on the node.
		expect(props.some((p) => /force|overwrite/i.test(p.name))).toBe(false);
	});

	it('shares the memory ID parameter across get/delete/update/history/rollback', () => {
		expect(find('memoryId')?.displayOptions?.show?.operation).toEqual(
			['get', 'delete', 'updateMemory', 'history', 'rollbackMemory'],
		);
	});

	it('bounds history pagination', () => {
		expect(find('historyLimit')?.typeOptions?.maxValue).toBe(50);
	});
});
