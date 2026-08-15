/** Small shared helpers that are not part of the kernel contract. */

/** Never let a server response decide how many items a caller processes. */
export function bound<T>(items: T[], max: number): T[] {
	if (max <= 0) return [];
	return items.slice(0, max);
}
