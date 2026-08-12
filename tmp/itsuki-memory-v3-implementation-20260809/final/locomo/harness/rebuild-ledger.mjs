export const CONTAINMENT_REBUILD_SAMPLE = "conv-43";
export const CONTAINMENT_REBUILD_SESSIONS = 29;

export function overlayContainmentRebuild({
	historicalRows,
	rebuildRows,
	sampleId = CONTAINMENT_REBUILD_SAMPLE,
	expectedSessions = CONTAINMENT_REBUILD_SESSIONS,
	required = true,
}) {
	if (!Array.isArray(historicalRows) || !Array.isArray(rebuildRows)) {
		throw new Error("containment ledger rows must be arrays");
	}
	if (!required && rebuildRows.length === 0) return [...historicalRows];
	if (rebuildRows.length !== expectedSessions) {
		throw new Error(`${sampleId}: containment rebuild ${rebuildRows.length}/${expectedSessions} sessions`);
	}
	const indexes = new Set();
	for (const row of rebuildRows) {
		if (row?.sampleId !== sampleId || !Number.isInteger(Number(row?.sessionIndex))) {
			throw new Error(`${sampleId}: invalid containment rebuild row`);
		}
		const index = Number(row.sessionIndex);
		if (index < 1 || index > expectedSessions || indexes.has(index)) {
			throw new Error(`${sampleId}: duplicate/out-of-range containment session ${index}`);
		}
		indexes.add(index);
	}
	for (let index = 1; index <= expectedSessions; index += 1) {
		if (!indexes.has(index)) throw new Error(`${sampleId}: missing containment session ${index}`);
	}
	const historicalSample = historicalRows.filter((row) => row?.sampleId === sampleId);
	if (historicalSample.length !== expectedSessions) {
		throw new Error(`${sampleId}: historical ledger ${historicalSample.length}/${expectedSessions} sessions`);
	}
	const merged = [
		...historicalRows.filter((row) => row?.sampleId !== sampleId),
		...rebuildRows,
	];
	if (merged.length !== historicalRows.length) {
		throw new Error(`${sampleId}: containment overlay changed total session count`);
	}
	return merged;
}
