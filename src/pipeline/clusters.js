import { normalizeLabel, tokens } from "../lib/text.js";

function layout(x, y, count = 1) {
	const n = Math.max(1, Number(count || 1));
	const radiusX = Math.round(Math.min(460, Math.max(210, 160 + Math.sqrt(n) * 68)));
	const radiusY = Math.round(Math.min(310, Math.max(150, 112 + Math.sqrt(n) * 46)));
	return {
		x,
		y,
		radiusX,
		radiusY,
		width: radiusX * 2,
		height: radiusY * 2,
		labelX: x,
		labelY: y - radiusY - 32,
	};
}

export const CLUSTERS = [
	{
		id: "identity_career",
		label: "Identity & Career",
		color: "#58a6ff",
		x: -620,
		y: -300,
		keywords: ["identity", "career", "job", "work", "software", "engineer", "location", "bangalore"],
		categories: ["identity", "organization", "place", "person"],
	},
	{
		id: "active_goals",
		label: "Active Goals",
		color: "#f0883e",
		x: 0,
		y: -330,
		keywords: ["goal", "income", "job", "plan", "target", "learning", "future"],
		categories: ["goal", "life_event"],
	},
	{
		id: "life_family",
		label: "Life & Family",
		color: "#ff7ab6",
		x: 620,
		y: -300,
		keywords: ["family", "grandmother", "grandfather", "mother", "father", "relationship", "married", "passed"],
		categories: ["family", "relationship"],
	},
	{
		id: "projects_systems",
		label: "Projects & Systems",
		color: "#bc8cff",
		x: -380,
		y: 90,
		keywords: ["project", "uml", "universal memory", "memory", "engine", "gpm", "app", "mcp", "dashboard", "graph"],
		categories: ["project", "system"],
	},
	{
		id: "skills_tech",
		label: "Skillset & Tech",
		color: "#a371f7",
		x: 390,
		y: 90,
		keywords: ["skill", "tech", "tool", "machine", "learning", "flutter", "d1", "vectorize", "cloudflare", "ai"],
		categories: ["skill", "tool"],
	},
	{
		id: "fitness_habits",
		label: "Fitness & Habits",
		color: "#7ee787",
		x: -620,
		y: 465,
		keywords: ["fitness", "health", "habit", "run", "diet", "boxing", "discipline", "morning"],
		categories: ["health", "habit"],
	},
	{
		id: "preferences_research",
		label: "Preferences & Research",
		color: "#d29922",
		x: 0,
		y: 500,
		keywords: ["research", "preference", "interest", "gta", "ps5", "car", "bike", "purchase"],
		categories: ["preference", "interest", "possession"],
	},
	{
		id: "general_memory",
		label: "General Memory",
		color: "#8b949e",
		x: 620,
		y: 465,
		keywords: [],
		categories: ["other"],
	},
];

const BY_ID = new Map(CLUSTERS.map((cluster) => [cluster.id, cluster]));

const SPECIAL_CLUSTER_PATTERNS = [
	{ id: "projects_systems", re: /\b(uml|universal memory|memory engine|gpmai|memory layer|mcp|dashboard|d1|vectorize)\b/ },
	{ id: "fitness_habits", re: /\b(boxing|morning run|diet|fitness|discipline|workout|training)\b/ },
	{ id: "active_goals", re: /\b(goal|income|passive income|get a job|job search|target|plan)\b/ },
	{ id: "life_family", re: /\b(grandmother|grandfather|mother|father|family|married|passed away)\b/ },
	{ id: "preferences_research", re: /\b(gta|ps5|car|bike|purchase research|emi|loan)\b/ },
];

function scoreCluster(cluster, haystack, category) {
	let score = cluster.categories.includes(category) ? 4 : 0;
	const words = new Set(tokens(haystack));
	for (const keyword of cluster.keywords) {
		const norm = normalizeLabel(keyword);
		if (haystack.includes(norm)) score += 3;
		else if (words.has(norm)) score += 2;
	}
	return score;
}

export function clusterForMemory({ label, title, category, summary, text, cluster }) {
	if (cluster && BY_ID.has(cluster)) return cluster;
	const haystack = normalizeLabel([label, title, category, summary, text].filter(Boolean).join(" "));
	const cat = normalizeLabel(category);
	const special = SPECIAL_CLUSTER_PATTERNS.find((item) => item.re.test(haystack));
	if (special) return special.id;
	let best = CLUSTERS[CLUSTERS.length - 1];
	let bestScore = -1;
	for (const candidate of CLUSTERS) {
		const score = scoreCluster(candidate, haystack, cat);
		if (score > bestScore) {
			best = candidate;
			bestScore = score;
		}
	}
	return best.id;
}

export function clusterMeta(id) {
	return BY_ID.get(id) ?? BY_ID.get("general_memory");
}

export function withCluster(item) {
	const cluster = clusterForMemory(item);
	const meta = clusterMeta(cluster);
	return {
		...item,
		cluster,
		cluster_label: meta.label,
		cluster_color: meta.color,
		cluster_layout: layout(meta.x, meta.y, 1),
	};
}

export function buildClusterPayload(nodes = [], pages = []) {
	const counts = new Map();
	for (const item of [...nodes, ...pages]) {
		const id = clusterForMemory(item);
		counts.set(id, (counts.get(id) ?? 0) + 1);
	}
	return CLUSTERS
		.filter((cluster) => counts.has(cluster.id))
		.map((cluster) => {
			const count = counts.get(cluster.id) ?? 0;
			return {
				...cluster,
				count,
				layout: layout(cluster.x, cluster.y, count),
			};
		});
}

export function clusterCounts(nodes = [], pages = []) {
	const counts = {};
	for (const cluster of buildClusterPayload(nodes, pages)) counts[cluster.id] = cluster.count;
	return counts;
}

export async function organizeUserClusters(env, userId) {
	const [nodesRes, pagesRes] = await env.DB.batch([
		env.DB.prepare(
			`SELECT id, label, category, summary, cluster FROM nodes
			 WHERE user_id = ? AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL`,
		).bind(userId),
		env.DB.prepare(
			`SELECT id, title, topic_filter, short_summary, cluster FROM memory_pages
			 WHERE user_id = ? AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL`,
		).bind(userId),
	]);
	const now = Date.now();
	const stmts = [];
	const organizedNodes = [];
	const organizedPages = [];
	for (const node of nodesRes.results ?? []) {
		const cluster = clusterForMemory(node);
		organizedNodes.push({ ...node, cluster });
		if (node.cluster !== cluster) {
			stmts.push(
				env.DB.prepare("UPDATE nodes SET cluster = ?, updated_at = ? WHERE id = ? AND user_id = ?").bind(
					cluster,
					now,
					node.id,
					userId,
				),
			);
		}
	}
	for (const page of pagesRes.results ?? []) {
		const cluster = clusterForMemory({
			title: page.title,
			category: page.topic_filter,
			summary: page.short_summary,
			cluster: page.cluster,
		});
		organizedPages.push({ ...page, cluster });
		if (page.cluster !== cluster) {
			stmts.push(
				env.DB.prepare("UPDATE memory_pages SET cluster = ?, updated_at = ? WHERE id = ? AND user_id = ?").bind(
					cluster,
					now,
					page.id,
					userId,
				),
			);
		}
	}
	if (stmts.length) await env.DB.batch(stmts);
	const clusters = buildClusterPayload(organizedNodes, organizedPages);
	return {
		organized: true,
		updated: stmts.length,
		nodes: nodesRes.results?.length ?? 0,
		pages: pagesRes.results?.length ?? 0,
		clusters,
		cluster_counts: Object.fromEntries(clusters.map((cluster) => [cluster.id, cluster.count])),
	};
}
