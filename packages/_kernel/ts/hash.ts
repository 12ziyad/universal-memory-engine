/**
 * A synchronous, dependency-free SHA-256.
 *
 * The audited adapters (Pi, OpenClaw) reach for `node:crypto`, which is right
 * for a Gateway process. These packages run wherever their host runs — a
 * Vercel edge function, a Cloudflare Worker, a browser-side dev server — and
 * `node:crypto`'s synchronous `createHash` is not reliably there. Web Crypto
 * is, but only asynchronously, and the echo-suppression and idempotency paths
 * are synchronous by design (a fingerprint must be derivable inside a
 * middleware's parameter transform without making it await).
 *
 * So: one small, exact implementation, pinned in test/hash.spec.ts against
 * both the NIST vectors and node:crypto over a randomized corpus. If those
 * ever disagree, the tests fail loudly rather than idempotency keys silently
 * diverging between runtimes.
 */

const K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(value: number, bits: number): number {
	return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

/** Lowercase hex SHA-256 of a UTF-8 string. */
export function sha256Hex(message: string): string {
	const bytes = new TextEncoder().encode(message);
	const length = bytes.length;
	// Message + 0x80 + zero padding, ending 8 bytes short of a 64-byte boundary
	// so the 64-bit big-endian bit length lands exactly at the end.
	const padded = length + 1;
	const zeros = (((56 - (padded % 64)) % 64) + 64) % 64;
	const total = padded + zeros + 8;
	const buffer = new Uint8Array(total);
	buffer.set(bytes);
	buffer[length] = 0x80;

	const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	const bitLength = length * 8;
	view.setUint32(total - 8, Math.floor(bitLength / 0x1_0000_0000), false);
	view.setUint32(total - 4, bitLength >>> 0, false);

	let h0 = 0x6a09e667;
	let h1 = 0xbb67ae85;
	let h2 = 0x3c6ef372;
	let h3 = 0xa54ff53a;
	let h4 = 0x510e527f;
	let h5 = 0x9b05688c;
	let h6 = 0x1f83d9ab;
	let h7 = 0x5be0cd19;

	const w = new Uint32Array(64);
	for (let offset = 0; offset < total; offset += 64) {
		for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4, false);
		for (let i = 16; i < 64; i += 1) {
			const x = w[i - 15]!;
			const y = w[i - 2]!;
			const s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
			const s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0;
			w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
		}

		let a = h0;
		let b = h1;
		let c = h2;
		let d = h3;
		let e = h4;
		let f = h5;
		let g = h6;
		let h = h7;

		for (let i = 0; i < 64; i += 1) {
			const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
			const ch = ((e & f) ^ (~e & g)) >>> 0;
			const temp1 = (h + S1 + ch + K[i]! + w[i]!) >>> 0;
			const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
			const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
			const temp2 = (S0 + maj) >>> 0;
			h = g;
			g = f;
			f = e;
			e = (d + temp1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (temp1 + temp2) >>> 0;
		}

		h0 = (h0 + a) >>> 0;
		h1 = (h1 + b) >>> 0;
		h2 = (h2 + c) >>> 0;
		h3 = (h3 + d) >>> 0;
		h4 = (h4 + e) >>> 0;
		h5 = (h5 + f) >>> 0;
		h6 = (h6 + g) >>> 0;
		h7 = (h7 + h) >>> 0;
	}

	let out = "";
	for (const value of [h0, h1, h2, h3, h4, h5, h6, h7]) {
		out += value.toString(16).padStart(8, "0");
	}
	return out;
}
