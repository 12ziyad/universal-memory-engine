/** Tiny id helper so every table gets a readable, prefixed, unique id. */
export function newId(prefix) {
	return `${prefix}_${crypto.randomUUID()}`;
}
