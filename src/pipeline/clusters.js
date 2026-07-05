import { normalizeLabel, tokens } from "../lib/text.js";

export const CLUSTERS = [
	{
		id: "identity_career",
		label: "Identity & Career",
		color: "#4cc9f0",
		x: -760,
		y: -260,
		keywords: ["identity", "work", "location", "bangalore"],
		categories: ["identity", "organization", "place", "person"],
	},
	{
		id: "career_applications",
		label: "Career & Applications",
		color: "#2dd4bf",
		x: -500,
		y: -520,
		keywords: ["application", "ats", "career", "dsa", "interview", "job", "microsoft", "recruiting", "resume", "swe"],
		categories: ["career", "goal", "organization"],
	},
	{
		id: "active_goals",
		label: "Active Goals",
		color: "#f0883e",
		x: 620,
		y: -470,
		keywords: ["goal", "income", "plan", "target", "learning", "future"],
		categories: ["goal", "life_event"],
	},
	{
		id: "projects_systems",
		label: "Projects & Systems",
		color: "#8b5cf6",
		x: 0,
		y: -40,
		keywords: ["project", "uml", "memory", "engine", "gpm", "app", "mcp", "dashboard", "graph"],
		categories: ["project", "system"],
	},
	{
		id: "software_product",
		label: "Software Product",
		color: "#38bdf8",
		x: 720,
		y: -30,
		keywords: ["architecture", "frontend", "backend", "login", "product", "software product", "ux"],
		categories: ["project", "system", "tool"],
	},
	{
		id: "business_product",
		label: "Business & Product",
		color: "#fb7185",
		x: 520,
		y: 430,
		keywords: ["business", "customer", "landing page", "launch", "pricing", "publishing", "startup"],
		categories: ["project", "goal", "organization"],
	},
	{
		id: "skills_tech",
		label: "Skills & Tech",
		color: "#22c55e",
		x: -700,
		y: 300,
		keywords: ["skill", "tech", "tool", "machine", "learning", "flutter", "d1", "vectorize", "cloudflare", "ai"],
		categories: ["skill", "tool"],
	},
	{
		id: "fitness_habits",
		label: "Fitness & Habits",
		color: "#a3e635",
		x: 60,
		y: 560,
		keywords: ["fitness", "health", "habit", "run", "diet", "boxing", "discipline", "morning"],
		categories: ["health", "habit"],
	},
	{
		id: "health_fitness",
		label: "Health & Fitness",
		color: "#facc15",
		x: -520,
		y: 610,
		keywords: ["doctor", "injury", "pain", "recovery", "return plan", "shoulder", "training"],
		categories: ["health", "habit"],
	},
	{
		id: "preferences_research",
		label: "Preferences & Research",
		color: "#f97316",
		x: 880,
		y: 310,
		keywords: ["research", "preference", "interest", "gta", "ps5", "car", "bike", "purchase"],
		categories: ["preference", "interest", "possession"],
	},
	{
		id: "life_family",
		label: "Life & Family",
		color: "#ff7ab6",
		x: 110,
		y: -620,
		keywords: ["family", "grandmother", "relationship", "married", "passed", "mother", "father"],
		categories: ["family", "relationship"],
	},
	{
		id: "general_memory",
		label: "General Memory",
		color: "#8b949e",
		x: 0,
		y: 360,
		keywords: [],
		categories: ["other"],
	},
];

const BY_ID = new Map(CLUSTERS.map((cluster) => [cluster.id, cluster]));

const SPECIAL_CLUSTER_PATTERNS = [
	{ id: "career_applications", re: /\b(microsoft|resume|recruiting|job application|swe|software engineer|interview prep|dsa)\b/ },
	{ id: "projects_systems", re: /\b(uml|universal memory|memory engine|gpmai|memory layer)\b/ },
	{ id: "business_product", re: /\b(landing page|login plan|business app|publishing|pricing|startup)\b/ },
	{ id: "software_product", re: /\b(software product|product architecture|frontend|backend|ux plan)\b/ },
	{ id: "health_fitness", re: /\b(shoulder pain|injury|recovery|return plan|doctor|diagnosed)\b/ },
	{ id: "fitness_habits", re: /\b(boxing|morning run|diet|fitness|discipline)\b/ },
	{ id: "active_goals", re: /\b(goal|income|passive income|get a job|job search)\b/ },
	{ id: "life_family", re: /\b(grandmother|grandfather|mother|father|family|married|passed away)\b/ },
	{ id: "preferences_research", re: /\b(gta|ps5|car|bike|purchase research)\b/ },
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
	return { ...item, cluster, cluster_label: meta.label, cluster_color: meta.color };
}

export function buildClusterPayload(nodes = [], pages = []) {
	const counts = new Map();
	for (const item of [...nodes, ...pages]) {
		const id = clusterForMemory(item);
		counts.set(id, (counts.get(id) ?? 0) + 1);
	}
	return CLUSTERS
		.filter((cluster) => counts.has(cluster.id))
		.map((cluster) => ({ ...cluster, count: counts.get(cluster.id) ?? 0 }));
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
	for (const node of nodesRes.results ?? []) {
		const cluster = clusterForMemory({ ...node, cluster: null });
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
			cluster: null,
		});
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
	return {
		organized: true,
		updated: stmts.length,
		nodes: nodesRes.results?.length ?? 0,
		pages: pagesRes.results?.length ?? 0,
	};
}
