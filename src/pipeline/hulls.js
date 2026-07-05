const DEFAULT_OPTIONS = {
	padding: 58,
	minRadiusX: 112,
	minRadiusY: 78,
	labelGap: 34,
	minClusterGap: 80,
};

function num(value, fallback = 0) {
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
}

function itemRadius(item) {
	return Math.max(4, num(item.hullRadius ?? item.visualRadius ?? item.radius ?? item.size, 18));
}

function clusterIdOf(item) {
	return item.cluster ?? item.cluster_id ?? item.clusterId ?? "";
}

function clusterLookup(clusters = []) {
	const map = new Map();
	for (const cluster of clusters || []) {
		if (!cluster?.id) continue;
		map.set(cluster.id, cluster);
	}
	return map;
}

function sortedClusterIds(groups, clusters = []) {
	const known = clusters.map((cluster) => cluster.id).filter((id) => id && groups.has(id));
	const extras = [...groups.keys()].filter((id) => !known.includes(id)).sort();
	return [...known, ...extras];
}

export function hullClearance(a, b) {
	const dx = (a.x ?? 0) - (b.x ?? 0);
	const dy = (a.y ?? 0) - (b.y ?? 0);
	const dist = Math.sqrt(dx * dx + dy * dy);
	const ra = Math.max(a.radiusX ?? 0, a.radiusY ?? 0);
	const rb = Math.max(b.radiusX ?? 0, b.radiusY ?? 0);
	return Math.round(dist - ra - rb);
}

function refreshHullBounds(hull, opts = DEFAULT_OPTIONS) {
	if (hull.sourceBounds) {
		hull.radiusX = Math.max(
			hull.radiusX,
			Math.abs(hull.sourceBounds.left - hull.x),
			Math.abs(hull.sourceBounds.right - hull.x),
		);
		hull.radiusY = Math.max(
			hull.radiusY,
			Math.abs(hull.sourceBounds.top - hull.y),
			Math.abs(hull.sourceBounds.bottom - hull.y),
		);
	}
	hull.labelX = hull.x;
	hull.labelY = Math.round(hull.y - hull.radiusY - opts.labelGap);
	hull.bounds = {
		left: hull.x - hull.radiusX,
		right: hull.x + hull.radiusX,
		top: hull.y - hull.radiusY,
		bottom: hull.y + hull.radiusY,
	};
	return hull;
}

function separateHulls(hulls, opts) {
	for (let iter = 0; iter < 20; iter++) {
		let moved = false;
		for (let i = 0; i < hulls.length; i++) {
			for (let j = i + 1; j < hulls.length; j++) {
				const a = hulls[i];
				const b = hulls[j];
				let dx = b.x - a.x;
				let dy = b.y - a.y;
				let dist = Math.sqrt(dx * dx + dy * dy);
				if (dist < 1) {
					const angle = ((i + 1) * 2.399 + j) % (Math.PI * 2);
					dx = Math.cos(angle);
					dy = Math.sin(angle);
					dist = 1;
				}
				const min = Math.max(a.radiusX, a.radiusY) + Math.max(b.radiusX, b.radiusY) + opts.minClusterGap;
				if (dist >= min) continue;
				const push = (min - dist) / 2;
				const ux = dx / dist;
				const uy = dy / dist;
				a.x = Math.round(a.x - ux * push);
				a.y = Math.round(a.y - uy * push);
				b.x = Math.round(b.x + ux * push);
				b.y = Math.round(b.y + uy * push);
				refreshHullBounds(a, opts);
				refreshHullBounds(b, opts);
				moved = true;
			}
		}
		if (!moved) break;
	}
	return hulls;
}

export function computeClusterHulls(items = [], clusters = [], options = {}) {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const groups = new Map();
	for (const item of items || []) {
		const clusterId = clusterIdOf(item);
		const x = num(item.x, NaN);
		const y = num(item.y, NaN);
		if (!clusterId || !Number.isFinite(x) || !Number.isFinite(y)) continue;
		if (!groups.has(clusterId)) groups.set(clusterId, []);
		groups.get(clusterId).push({ ...item, x, y, radius: itemRadius(item) });
	}

	const meta = clusterLookup(clusters);
	const hulls = [];
	for (const clusterId of sortedClusterIds(groups, clusters)) {
		const group = groups.get(clusterId) || [];
		if (!group.length) continue;

		const minX = Math.min(...group.map((item) => item.x - item.radius));
		const maxX = Math.max(...group.map((item) => item.x + item.radius));
		const minY = Math.min(...group.map((item) => item.y - item.radius));
		const maxY = Math.max(...group.map((item) => item.y + item.radius));
		const spreadX = maxX - minX;
		const spreadY = maxY - minY;
		const count = group.length;
		const growth = count >= 4 ? Math.min(44, Math.sqrt(count) * 9) : 0;
		const padding = opts.padding + growth;
		const centerX = Math.round((minX + maxX) / 2);
		const centerY = Math.round((minY + maxY) / 2);
		const radiusX = Math.round(Math.max(opts.minRadiusX + growth, spreadX / 2 + padding));
		const radiusY = Math.round(Math.max(opts.minRadiusY + growth * 0.72, spreadY / 2 + padding * 0.82));
		const cluster = meta.get(clusterId) || {};

		hulls.push({
			id: clusterId,
			cluster: clusterId,
			label: cluster.label || cluster.display_label || clusterId.replace(/_/g, " "),
			color: cluster.color || "#8b949e",
			count,
			x: centerX,
			y: centerY,
			radiusX,
			radiusY,
			padding,
			labelX: centerX,
			labelY: Math.round(centerY - radiusY - opts.labelGap),
			bounds: {
				left: centerX - radiusX,
				right: centerX + radiusX,
				top: centerY - radiusY,
				bottom: centerY + radiusY,
			},
			sourceBounds: {
				left: centerX - radiusX,
				right: centerX + radiusX,
				top: centerY - radiusY,
				bottom: centerY + radiusY,
			},
			spreadX,
			spreadY,
			itemIds: group.map((item) => item.id).filter(Boolean),
		});
	}
	return separateHulls(hulls, opts);
}

export function itemInsideHull(item, hull, extraPadding = 0) {
	if (!item || !hull) return false;
	const x = num(item.x, NaN);
	const y = num(item.y, NaN);
	if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
	const radius = itemRadius(item);
	return (
		x - radius >= hull.bounds.left - extraPadding &&
		x + radius <= hull.bounds.right + extraPadding &&
		y - radius >= hull.bounds.top - extraPadding &&
		y + radius <= hull.bounds.bottom + extraPadding
	);
}

export function clusterHullAnchors(hulls = []) {
	return (hulls || []).flatMap((hull) => [
		{ id: `hull:${hull.id}:nw`, cluster: hull.id, x: hull.bounds.left, y: hull.bounds.top },
		{ id: `hull:${hull.id}:ne`, cluster: hull.id, x: hull.bounds.right, y: hull.bounds.top },
		{ id: `hull:${hull.id}:sw`, cluster: hull.id, x: hull.bounds.left, y: hull.bounds.bottom },
		{ id: `hull:${hull.id}:se`, cluster: hull.id, x: hull.bounds.right, y: hull.bounds.bottom },
		{ id: `hull:${hull.id}:label`, cluster: hull.id, x: hull.labelX, y: hull.labelY - 18 },
	]);
}
