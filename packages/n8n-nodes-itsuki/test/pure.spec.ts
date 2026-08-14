import { describe, expect, it } from 'vitest';

import {
	codePointLength,
	computeBackoffMs,
	INGEST_LIMITS,
	mapApiError,
	redactSecrets,
	validateBaseUrl,
	validateConversation,
} from '../nodes/Itsuki/GenericFunctions';

describe('validateBaseUrl', () => {
	it('accepts the production origin and strips trailing slashes', () => {
		expect(validateBaseUrl('https://itsuki.app/')).toBe('https://itsuki.app');
	});
	it('accepts loopback http for development', () => {
		expect(validateBaseUrl('http://localhost:8787')).toBe('http://localhost:8787');
		expect(validateBaseUrl('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
	});
	it('rejects plain http on non-loopback hosts', () => {
		expect(() => validateBaseUrl('http://itsuki.app')).toThrow(/HTTPS/);
		expect(() => validateBaseUrl('http://10.0.0.5')).toThrow(/HTTPS/);
		expect(() => validateBaseUrl('http://169.254.169.254')).toThrow(/HTTPS/);
	});
	it('rejects embedded credentials, query strings, and fragments', () => {
		expect(() => validateBaseUrl('https://user:pass@itsuki.app')).toThrow(/credentials/);
		expect(() => validateBaseUrl('https://itsuki.app?x=1')).toThrow(/query/);
		expect(() => validateBaseUrl('https://itsuki.app#frag')).toThrow(/fragment/);
	});
	it('rejects garbage and whitespace', () => {
		expect(() => validateBaseUrl('')).toThrow(/empty/);
		expect(() => validateBaseUrl('not a url')).toThrow();
		expect(() => validateBaseUrl('https://itsuki.app /x')).toThrow(/whitespace/);
	});
});

describe('validateConversation', () => {
	it('preserves order and normalizes roles', () => {
		const out = validateConversation([
			{ role: 'USER', content: 'first' },
			{ role: 'assistant', content: 'second' },
		]);
		expect(out.map((m) => m.content)).toEqual(['first', 'second']);
		expect(out[0].role).toBe('user');
	});
	it('rejects empty batches, bad roles, and empty content by index', () => {
		expect(() => validateConversation([])).toThrow(/at least one/);
		expect(() => validateConversation([{ role: 'robot', content: 'x' }])).toThrow(/messages\[0\]\.role/);
		expect(() => validateConversation([{ role: 'user', content: '  ' }])).toThrow(/messages\[0\]\.content/);
	});
	it('enforces the published per-message and per-batch limits locally', () => {
		const big = 'x'.repeat(INGEST_LIMITS.maxMessageCharacters + 1);
		expect(() => validateConversation([{ role: 'user', content: big }])).toThrow(/per-message limit/);
		const many = Array.from({ length: INGEST_LIMITS.maxMessages + 1 }, () => ({ role: 'user', content: 'hi' }));
		expect(() => validateConversation(many)).toThrow(/Too many messages/);
		// 30 × 4,000 = exactly 120,000 — AT the total limit, which is legal.
		// The limits compose exactly, so the total check is defensive only.
		const atMax = 'y'.repeat(INGEST_LIMITS.maxMessageCharacters);
		const batch = Array.from({ length: INGEST_LIMITS.maxMessages }, () => ({ role: 'user', content: atMax }));
		expect(validateConversation(batch)).toHaveLength(INGEST_LIMITS.maxMessages);
	});
	it('counts unicode code points the way the server does', () => {
		expect(codePointLength('a👍b')).toBe(3);
	});
});

describe('mapApiError', () => {
	it('names credential failure on 401 without echoing anything', () => {
		const mapped = mapApiError(401, { error: 'unauthorized' });
		expect(mapped.message).toMatch(/rejected the API key/);
		expect(mapped.retriable).toBe(false);
	});
	it('distinguishes quota exhaustion, capacity pause, and plain rate limiting on 429', () => {
		const quota = mapApiError(429, { error: 'ai_quota_exhausted', usage: { used: 1000, limit: 1000, resets_at: '2026-09-01' } });
		expect(quota.message).toMatch(/plan exhausted/i);
		expect(quota.retriable).toBe(false);

		const paused = mapApiError(429, { error: 'ai_capacity_paused', retry_after_s: 3600 });
		expect(paused.retriable).toBe(true);
		expect(paused.description).not.toMatch(/your account is/i);

		const rate = mapApiError(429, { error: 'too_many_requests', bucket: 'save', retry_after_s: 60 }, { 'retry-after': '60' });
		expect(rate.retriable).toBe(true);
		expect(rate.retryAfterSeconds).toBe(60);
		expect(rate.description).toMatch(/bucket: save/);
	});
	it('reads Retry-After from headers when the body lacks it', () => {
		const mapped = mapApiError(503, {}, { 'retry-after': '30' });
		expect(mapped.retryAfterSeconds).toBe(30);
		expect(mapped.retriable).toBe(true);
	});
	it('treats 404 and 428 as non-retriable with named guidance', () => {
		expect(mapApiError(404, {}).retriable).toBe(false);
		expect(mapApiError(428, {}).message).toMatch(/Confirmation required/);
	});
});

describe('computeBackoffMs', () => {
	it('honours Retry-After exactly and caps it', () => {
		expect(computeBackoffMs(0, 30)).toBe(30_000);
		expect(computeBackoffMs(5, 999_999)).toBe(120_000);
	});
	it('backs off exponentially with jitter otherwise', () => {
		const first = computeBackoffMs(0);
		expect(first).toBeGreaterThanOrEqual(500);
		expect(first).toBeLessThanOrEqual(1_000);
		const later = computeBackoffMs(10);
		expect(later).toBeLessThanOrEqual(20_000);
	});
});

describe('redactSecrets', () => {
	it('removes every occurrence of the key from arbitrary text', () => {
		const key = 'itsuki_live_abcdef123456';
		const text = `failed: Bearer ${key} rejected; retry with ${key}`;
		const out = redactSecrets(text, [key]);
		expect(out).not.toContain(key);
		expect(out).toContain('***');
	});
	it('ignores short or missing secrets rather than shredding text', () => {
		expect(redactSecrets('abc', [undefined, 'ab'])).toBe('abc');
	});
});
