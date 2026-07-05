import { CLUSTERS, clusterForMemory, clusterMeta } from "./clusters.js";
import { normalizeLabel } from "../lib/text.js";

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const VISUAL_RADIUS = {
	page: 44,
	node: 18,
	candidate: 13,
};
const MIN_CLUSTER_GAP = 128;
const ITEM_EXTRA_GAP = {
	page: 44,
	node: 30,
	candidate: 22,
};

function clamp(n, min, max) {
	return Math.max(min, Math.min(max, n));
}

function hash(value) {
	let h = 2166136261;
	const text = String(value ?? "");
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

function parseJsonArray(value) {
	try {
		const parsed = JSON.parse(value || "[]");
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function itemCluster(item, visualType) {
	if (visualType === "candidate") {
		return clusterForMemory({
			label: item.label,
			category: item.cluster_hint ?? "interest",
			cluster: item.cluster_hint,
		});
	}
	return clusterForMemory(item);
}

function importanceScore(item, visualType) {
	if (visualType === "page") {
		return (
			120 +
			Number(item.heat_score ?? 1) * 8 +
			(item.importance_class === "important" ? 18 : 0) +
			parseJsonArray(item.decisions_json).length * 4 +
			parseJsonArray(item.key_points_json).length
		);
	}
	if (visualType === "node") {
		return (
			40 +
			Number(item.heat_score ?? 1) * 5 +
			(item.importance_class === "important" ? 12 : 0) +
			(item.importance_class === "life_significant" ? 18 : 0) +
			(item.slices?.length ?? 0) * 3 +
			(item.events?.length ?? 0) * 5
		);
	}
	return 6 + Number(item.mentions ?? 1);
}

function clusterRadius(count) {
	return clamp(188 + Math.sqrt(Math.max(1, count)) * 42, 230, 430);
}

function clusterCollisionRadius(cluster) {
	return Math.max(cluster.radius_x ?? cluster.radius ?? 260, cluster.radius_y ?? cluster.radius ?? 180);
}

export function clusterClearance(a, b) {
	const dx = (a.x ?? 0) - (b.x ?? 0);
	const dy = (a.y ?? 0) - (b.y ?? 0);
	const dist = Math.sqrt(dx * dx + dy * dy);
	return Math.round(dist - clusterCollisionRadius(a) - clusterCollisionRadius(b));
}

function spaceClusters(clusters) {
	for (let iter = 0; iter < 28; iter++) {
		let moved = false;
		for (let i = 0; i < clusters.length; i++) {
			for (let j = i + 1; j < clusters.length; j++) {
				const a = clusters[i];
				const b = clusters[j];
				let dx = b.x - a.x;
				let dy = b.y - a.y;
				let dist = Math.sqrt(dx * dx + dy * dy);
				if (dist < 1) {
					const angle = ((i + 1) * 2.399 + j) % (Math.PI * 2);
					dx = Math.cos(angle);
					dy = Math.sin(angle);
					dist = 1;
				}
				const min = clusterCollisionRadius(a) + clusterCollisionRadius(b) + MIN_CLUSTER_GAP;
				if (dist >= min) continue;
				const push = (min - dist) / 2;
				const ux = dx / dist;
				const uy = dy / dist;
				a.x = Math.round(a.x - ux * push);
				a.y = Math.round(a.y - uy * push);
				b.x = Math.round(b.x + ux * push);
				b.y = Math.round(b.y + uy * push);
				a.label_x = a.x;
				b.label_x = b.x;
				a.label_y = Math.round(a.y - a.radius_y - 36);
				b.label_y = Math.round(b.y - b.radius_y - 36);
				moved = true;
			}
		}
		if (!moved) break;
	}
	return clusters;
}

function visualRadius(entry) {
	return VISUAL_RADIUS[entry.visual_type] ?? VISUAL_RADIUS.node;
}

function itemMinGap(a, b) {
	const largest = Math.max(ITEM_EXTRA_GAP[a.entry.visual_type] ?? 28, ITEM_EXTRA_GAP[b.entry.visual_type] ?? 28);
	return visualRadius(a.entry) + visualRadius(b.entry) + largest;
}

function clampInsideCluster(item, cluster) {
	const radius = visualRadius(item.entry);
	const rx = Math.max(48, cluster.radius_x - radius - 16);
	const ry = Math.max(48, cluster.radius_y - radius - 16);
	const dx = item.position.x - cluster.x;
	const dy = item.position.y - cluster.y;
	const norm = Math.sqrt((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry));
	if (norm <= 1) return;
	item.position.x = Math.round(cluster.x + dx / norm);
	item.position.y = Math.round(cluster.y + dy / norm);
}

function relaxItemPositions(positioned, cluster) {
	if (positioned.length < 2) return positioned;
	for (let iter = 0; iter < 22; iter++) {
		let moved = false;
		for (let i = 0; i < positioned.length; i++) {
			for (let j = i + 1; j < positioned.length; j++) {
				const a = positioned[i];
				const b = positioned[j];
				let dx = b.position.x - a.position.x;
				let dy = b.position.y - a.position.y;
				let dist = Math.sqrt(dx * dx + dy * dy);
				if (dist < 1) {
					const angle = ((i + 1) * GOLDEN_ANGLE + j) % (Math.PI * 2);
					dx = Math.cos(angle);
					dy = Math.sin(angle);
					dist = 1;
				}
				const min = itemMinGap(a, b);
				if (dist >= min) continue;
				const push = (min - dist) / 2;
				const ux = dx / dist;
				const uy = dy / dist;
				a.position.x = Math.round(a.position.x - ux * push);
				a.position.y = Math.round(a.position.y - uy * push);
				b.position.x = Math.round(b.position.x + ux * push);
				b.position.y = Math.round(b.position.y + uy * push);
				clampInsideCluster(a, cluster);
				clampInsideCluster(b, cluster);
				moved = true;
			}
		}
		if (!moved) break;
	}
	return positioned;
}

export function itemClearance(a, b) {
	const dx = (a.x ?? 0) - (b.x ?? 0);
	const dy = (a.y ?? 0) - (b.y ?? 0);
	const dist = Math.sqrt(dx * dx + dy * dy);
	return Math.round(dist - (a.radius ?? VISUAL_RADIUS.node) - (b.radius ?? VISUAL_RADIUS.node));
}

function itemPosition(entry, index, total, cluster) {
	if (total <= 1) {
		return { x: cluster.x, y: cluster.y };
	}

	const rank = total <= 1 ? 0 : index / (total - 1);
	const jitter = ((hash(entry.id) % 1000) / 1000 - 0.5) * 0.42;
	const angle = -Math.PI / 2 + index * GOLDEN_ANGLE + jitter;
	const base = entry.visual_type === "page" ? 0.16 : entry.visual_type === "candidate" ? 0.68 : 0.36;
	const spread = entry.visual_type === "page" ? 0.36 : entry.visual_type === "candidate" ? 0.18 : 0.42;
	const distance = cluster.radius * clamp(base + spread * rank, 0.08, 0.9);
	return {
		x: Math.round(cluster.x + Math.cos(angle) * distance * 1.08),
		y: Math.round(cluster.y + Math.sin(angle) * distance * 0.68),
	};
}

function decorateItem(item, entry, cluster, position, rank) {
	const meta = clusterMeta(cluster.id);
	return {
		...item,
		cluster: cluster.id,
		cluster_id: cluster.id,
		cluster_name: meta.label,
		cluster_label: meta.label,
		cluster_color: meta.color,
		x: position.x,
		y: position.y,
		radius: VISUAL_RADIUS[entry.visual_type],
		importance_rank: rank,
		importance_score: entry.score,
		visual_type: entry.visual_type,
	};
}

export function buildGraphLayout(nodes = [], pages = [], candidates = []) {
	const entries = [
		...pages.map((item) => ({ id: `page:${item.id}`, item, visual_type: "page" })),
		...nodes.map((item) => ({ id: `node:${item.id}`, item, visual_type: "node" })),
		...candidates.map((item) => ({ id: `candidate:${item.id}`, item, visual_type: "candidate" })),
	].map((entry) => ({
		...entry,
		clusterId: itemCluster(entry.item, entry.visual_type),
		score: importanceScore(entry.item, entry.visual_type),
		sortKey: normalizeLabel(entry.item.title ?? entry.item.label ?? entry.item.id),
	}));

	const byCluster = new Map();
	for (const entry of entries) {
		if (!byCluster.has(entry.clusterId)) byCluster.set(entry.clusterId, []);
		byCluster.get(entry.clusterId).push(entry);
	}

	const decorated = new Map();
	const clusterEntries = [];
	for (const meta of CLUSTERS) {
		const group = byCluster.get(meta.id) ?? [];
		if (!group.length) continue;
		group.sort((a, b) => b.score - a.score || a.sortKey.localeCompare(b.sortKey) || a.id.localeCompare(b.id));
		const activeCount = group.filter((entry) => entry.visual_type !== "candidate").length;
		const radius = clusterRadius(group.length);
		const cluster = {
			id: meta.id,
			label: meta.label,
			display_label: `${meta.label} · ${activeCount || group.length}`,
			color: meta.color,
			x: meta.x,
			y: meta.y,
			radius,
			radius_x: Math.round(radius * 1.16),
			radius_y: Math.round(radius * 0.78),
			label_x: meta.x,
			label_y: Math.round(meta.y - radius * 0.78 - 36),
			count: activeCount,
			total_count: group.length,
			candidate_count: group.length - activeCount,
			min_cluster_gap: MIN_CLUSTER_GAP,
			min_item_gap: ITEM_EXTRA_GAP.node,
		};
		clusterEntries.push({ group, cluster });
	}

	const clusters = spaceClusters(clusterEntries.map(({ cluster }) => cluster));
	for (const { group, cluster } of clusterEntries) {
		const positioned = group.map((entry, index) => ({
			entry,
			index,
			position: itemPosition(entry, index, group.length, cluster),
		}));
		relaxItemPositions(positioned, cluster);
		positioned.forEach(({ entry, index, position }) => {
			decorated.set(entry.id, decorateItem(entry.item, entry, cluster, position, index + 1));
		});
	}

	return {
		nodes: nodes.map((item) => decorated.get(`node:${item.id}`) ?? item),
		pages: pages.map((item) => decorated.get(`page:${item.id}`) ?? item),
		candidates: candidates.map((item) => decorated.get(`candidate:${item.id}`) ?? item),
		clusters,
	};
}

export function filterGraphForMode(data, mode = "clean", focus = {}) {
	const nodes = data?.nodes ?? [];
	const pages = data?.pages ?? [];
	const candidates = data?.candidates ?? [];
	const selectedCluster = focus.cluster ?? null;
	const selectedPageId = focus.pageId ?? null;
	if (mode === "debug") return { nodes, pages, candidates };
	if (mode === "all") return { nodes, pages, candidates };
	if (mode === "focus") {
		const page = selectedPageId ? pages.find((p) => p.id === selectedPageId) : null;
		const clusterId = selectedCluster ?? page?.cluster ?? null;
		return {
			nodes: clusterId ? nodes.filter((n) => n.cluster === clusterId) : nodes,
			pages: clusterId ? pages.filter((p) => p.cluster === clusterId || p.id === selectedPageId) : pages,
			candidates: [],
		};
	}
	return { nodes, pages, candidates: [] };
}
