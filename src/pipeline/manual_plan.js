import { ACTION_TO_STATE } from "../config.js";
import { newId } from "../lib/ids.js";
import { clusterForMemory } from "./clusters.js";
import {
	candidateMatchesManualNode,
	canonicalIdentity,
	manualIdentityNames,
	manualIdentitySimilarity,
	manualNodeAliases,
	resolveManualIdentity,
} from "./manual_identity.js";

const ONE_OFF_EVENTS = new Set(["passed_away", "born", "married", "diagnosed"]);
const SINGLE_VALUE_SLICES = new Set(["preference"]);
const CORRECTION_RE = /\b(?:actually|correction|instead|no longer|not anymore|replace|replaced|switched|from now on|it is now|it's now)\b/i;
const FACT_STOPWORDS = new Set(["a", "an", "and", "for", "from", "in", "is", "of", "on", "the", "to", "user", "with"]);

function parseJsonArray(value) {
	if (Array.isArray(value)) return value;
	try {
		const parsed = JSON.parse(value || "[]");
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

export async function loadManualGraphState(env, userId) {
	const now = Date.now();
	const [nodes, slices, events, edges, candidates, suppressions] = await env.DB.batch([
		env.DB.prepare(
			`SELECT id, label, canonical_label, aliases_json, category, role, state, summary,
				mention_count, session_count, last_seen_at, heat_score, confidence,
				health_state, importance_class, cluster
			 FROM nodes
			 WHERE user_id = ? AND deleted_at IS NULL AND archived_at IS NULL AND suppressed_at IS NULL`,
		).bind(userId),
		env.DB.prepare(
			`SELECT id, node_id, text, kind, is_current, created_at, reinforcement_count, last_seen_at
			 FROM slices WHERE user_id = ? AND deleted_at IS NULL`,
		).bind(userId),
		env.DB.prepare(
			`SELECT id, node_id, action, text, importance, happened_at, created_at,
				reinforcement_count, last_seen_at, confidence
			 FROM events WHERE user_id = ? AND deleted_at IS NULL`,
		).bind(userId),
		env.DB.prepare(
			`SELECT id, from_node, to_node, type, reinforcement_count, weight, evidence_count,
				last_seen_at, confidence
			 FROM edges WHERE user_id = ? AND deleted_at IS NULL`,
		).bind(userId),
		env.DB.prepare(
			`SELECT id, label, label_guess, canonical_key, role_guess, cluster_guess,
				possible_existing_node_id, status, evidence_json
			 FROM candidates
			 WHERE user_id = ? AND deleted_at IS NULL AND suppressed_at IS NULL
				AND COALESCE(status, 'pending') = 'pending'`,
		).bind(userId),
		env.DB.prepare(
			`SELECT kind, canonical_key, label, reason, source_object_id
			 FROM memory_suppressions
			 WHERE user_id = ? AND (suppressed_until IS NULL OR suppressed_until > ?)`,
		).bind(userId, now),
	]);
	return {
		nodes: nodes.results ?? [],
		slices: slices.results ?? [],
		events: events.results ?? [],
		edges: edges.results ?? [],
		candidates: candidates.results ?? [],
		suppressions: suppressions.results ?? [],
	};
}

function planBase() {
	return {
		newNodes: [],
		nodeStateUpdates: [],
		nodeTouches: [],
		nodeAliasUpdates: [],
		nodeSummaryUpdates: [],
		identityClaims: [],
		sliceSupersede: [],
		newSlices: [],
		sliceTouches: [],
		newEvents: [],
		eventTouches: [],
		newEdges: [],
		edgeTouches: [],
		edgeSupersede: [],
		newCandidates: [],
		candidateBumps: [],
		candidateResolutions: [],
		newPages: [],
		pageUpdates: [],
		affectedNodeIds: new Set(),
		autoCreated: [],
		rejected: [],
		identityDecisions: [],
		conflicts: [],
		resolvedCandidates: [],
		correctionActions: [],
	};
}

function factWords(value) {
	return canonicalIdentity(value)
		.split(" ")
		.filter((word) => word.length > 1 && !FACT_STOPWORDS.has(word))
		.map((word) => {
			if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
			if (word.length > 4 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
			return word;
		});
}

function textSimilarity(left, right) {
	const aText = canonicalIdentity(left);
	const bText = canonicalIdentity(right);
	if (!aText || !bText) return 0;
	if (aText === bText) return 1;
	const shorter = aText.length <= bText.length ? aText : bText;
	const longer = aText.length > bText.length ? aText : bText;
	if (shorter.length >= 16 && (` ${longer} `).includes(` ${shorter} `)) return 0.92;
	const a = new Set(factWords(aText));
	const b = new Set(factWords(bText));
	if (!a.size || !b.size) return 0;
	let shared = 0;
	for (const word of a) if (b.has(word)) shared++;
	return shared / (a.size + b.size - shared);
}

function manualFactKey(kind, ...parts) {
	return JSON.stringify([kind, ...parts.map((part) => canonicalIdentity(part))]);
}

function sameSlice(left, right) {
	const score = textSimilarity(left, right);
	return score === 1 || (Math.min(factWords(left).length, factWords(right).length) >= 3 && score >= 0.72);
}

function sameEvent(existing, memory) {
	if (existing.action !== memory.action) return false;
	if (ONE_OFF_EVENTS.has(memory.action)) return true;
	return textSimilarity(existing.text, memory.text) >= 0.78;
}

function uniquePush(list, item, key) {
	if (list.some((existing) => key(existing) === key(item))) return;
	list.push(item);
}

function suppressedIdentity(state, label) {
	const key = canonicalIdentity(label);
	return state.suppressions.find((row) =>
		row.kind === "node" && canonicalIdentity(row.canonical_key ?? row.label) === key) ?? null;
}

function aliasesAfterObservation(node, observedLabels) {
	const aliases = [...manualNodeAliases(node)];
	for (const label of observedLabels ?? []) {
		if (!label || manualIdentitySimilarity(label, node.label) < 0.88) continue;
		if (manualIdentityNames({ ...node, aliases }).some((name) => canonicalIdentity(name) === canonicalIdentity(label))) continue;
		aliases.push(label);
	}
	return aliases.slice(0, 24);
}

function candidateIdentityMatchesNode(candidate, node, observedLabels = []) {
	const candidateNames = [candidate?.label_guess, candidate?.label, candidate?.canonical_key].filter(Boolean);
	const nodeNames = [...manualIdentityNames(node), ...observedLabels].filter(Boolean);
	return candidateNames.some((candidateName) =>
		nodeNames.some((nodeName) => manualIdentitySimilarity(candidateName, nodeName) >= 0.92));
}

function deterministicSummary(node, slices, events, stateOverride = null) {
	const currentSlices = [...(slices ?? [])]
		.filter((slice) => Number(slice.is_current ?? 1) === 1)
		.sort((left, right) =>
			Number(right.created_at ?? 0) - Number(left.created_at ?? 0) ||
			Number(left.manual_order ?? Number.MAX_SAFE_INTEGER) - Number(right.manual_order ?? Number.MAX_SAFE_INTEGER) ||
			String(left.id).localeCompare(String(right.id)));
	const recentEvents = [...(events ?? [])]
		.sort((left, right) =>
			Number(right.happened_at ?? right.created_at ?? 0) - Number(left.happened_at ?? left.created_at ?? 0) ||
			Number(left.manual_order ?? Number.MAX_SAFE_INTEGER) - Number(right.manual_order ?? Number.MAX_SAFE_INTEGER) ||
			String(left.id).localeCompare(String(right.id)));
	const details = [];
	for (const item of [...currentSlices, ...recentEvents]) {
		const text = String(item.text ?? "").replace(/\s+/g, " ").trim();
		if (!text || details.some((existing) => canonicalIdentity(existing) === canonicalIdentity(text))) continue;
		details.push(text);
		if (details.length >= 3) break;
	}
	if (details.length) return `${node.label}: ${details.join("; ")}`.slice(0, 320);
	const state = stateOverride ?? node.state ?? "active";
	return `${node.label} is an active ${node.category ?? "memory"} (${state}).`.replace(/\s+/g, " ").slice(0, 320);
}

function runLists(plan) {
	return {
		createdNodes: plan.newNodes.map((node) => ({ id: node.id, label: node.label })),
		createdSlices: plan.newSlices.map((slice) => ({ id: slice.id, node_id: slice.node_id, kind: slice.kind })),
		createdEvents: plan.newEvents.map((event) => ({ id: event.id, node_id: event.node_id, action: event.action })),
		createdEdges: plan.newEdges.map((edge) => ({ id: edge.id, from_node: edge.from_node, to_node: edge.to_node, type: edge.type })),
		updatedObjects: [
			...plan.nodeTouches.map((touch) => ({ kind: "node", id: touch.id ?? touch })),
			...plan.edgeSupersede.map((edge) => ({ kind: "edge", id: edge.id, status: "superseded" })),
		],
		reinforcedObjects: [
			...plan.sliceTouches.map((item) => ({ kind: "slice", id: item.id })),
			...plan.eventTouches.map((item) => ({ kind: "event", id: item.id })),
			...plan.edgeTouches.map((item) => ({ kind: "edge", id: item.id })),
		],
		skippedObjects: plan.rejected,
	};
}

/** Convert grounded manual facts into an atomic write plan. */
export function buildManualGraphPlan(userId, integrity, state, input = {}) {
	const now = Date.now();
	const plan = planBase();
	plan.rejected.push(...(integrity?.rejected ?? []));
	const allNodes = [...(state.nodes ?? [])];
	const virtualByLabel = new Map();
	const virtualById = new Map();
	const observedByNode = new Map();
	const supportTextByNode = new Map();
	const touchedNodeIds = new Set();
	const stateByNode = new Map((state.nodes ?? []).map((node) => [node.id, node.state ?? "active"]));

	function observe(nodeId, label, supportText = null) {
		if (!observedByNode.has(nodeId)) observedByNode.set(nodeId, new Set());
		if (label) observedByNode.get(nodeId).add(label);
		if (supportText && !supportTextByNode.has(nodeId)) supportTextByNode.set(nodeId, supportText);
		plan.affectedNodeIds.add(nodeId);
	}

	function touchExisting(nodeId) {
		if (touchedNodeIds.has(nodeId)) return;
		touchedNodeIds.add(nodeId);
		plan.nodeTouches.push({ id: nodeId, increment_session: true });
	}

	function resolve(identity, supportText = null) {
		const labelKey = canonicalIdentity(identity?.label);
		if (virtualByLabel.has(labelKey)) {
			const known = virtualByLabel.get(labelKey);
			observe(known.node.id, identity?.label, supportText);
			return known;
		}
		const suppression = suppressedIdentity(state, identity?.label);
		if (suppression) {
			plan.rejected.push({ kind: "identity", label: identity?.label, reason: "suppressed_blocked" });
			return null;
		}
		const decision = resolveManualIdentity(identity, allNodes);
		plan.identityDecisions.push({
			label: identity?.label,
			decision: decision.decision,
			node_id: decision.node?.id ?? null,
			matched_by: decision.matched_name ?? null,
			score: decision.score ?? null,
		});
		if (decision.decision === "ambiguous") {
			plan.conflicts.push({
				label: decision.label,
				reason: decision.reason,
				matches: decision.matches ?? [],
			});
			return null;
		}
		if (decision.decision === "invalid") {
			plan.rejected.push({ kind: "identity", label: decision.label, reason: decision.reason });
			return null;
		}

		let node;
		let existed;
		if (decision.decision === "existing") {
			node = decision.node;
			existed = !node._manual_new;
			if (existed) touchExisting(node.id);
		} else {
			const id = newId("node");
			const category = identity.category ?? "other";
			node = {
				id,
				user_id: userId,
				label: identity.label,
				canonical_label: canonicalIdentity(identity.label),
				aliases_json: JSON.stringify(identity.aliases ?? []),
				category,
				role: null,
				state: "active",
				summary: null,
				identity_key: canonicalIdentity(identity.label),
				created_at: now,
				updated_at: now,
				last_seen_at: now,
				mention_count: 1,
				session_count: 1,
				heat_score: 1,
				confidence: Number.isFinite(Number(identity.confidence)) ? Number(identity.confidence) : null,
				health_state: "active",
				importance_class: "ordinary",
				cluster: clusterForMemory({ label: identity.label, category }),
				_manual_new: true,
			};
			plan.newNodes.push(node);
			allNodes.push(node);
			stateByNode.set(id, node.state);
			existed = false;
		}
		uniquePush(plan.identityClaims, {
			canonical_key: canonicalIdentity(identity.label),
			node_id: node.id,
			created_at: now,
		}, (claim) => claim.canonical_key);
		const virtual = { node, existed };
		virtualByLabel.set(labelKey, virtual);
		virtualById.set(node.id, virtual);
		observe(node.id, identity?.label, supportText);
		return virtual;
	}

	function resolveExistingOnly(identity) {
		const decision = resolveManualIdentity(identity, allNodes);
		plan.identityDecisions.push({
			label: identity?.label,
			decision: decision.decision === "new" ? "historical_not_found" : decision.decision,
			node_id: decision.node?.id ?? null,
			matched_by: decision.matched_name ?? null,
			score: decision.score ?? null,
		});
		if (decision.decision === "ambiguous") {
			plan.conflicts.push({ label: decision.label, reason: decision.reason, matches: decision.matches ?? [] });
			return null;
		}
		if (decision.decision !== "existing") {
			plan.rejected.push({ kind: "correction_old_target", label: identity?.label, reason: "historical_identity_not_found" });
			return null;
		}
		return { node: decision.node, existed: true };
	}

	function addSlice(virtual, fact) {
		const memory = fact.memory;
		const existingSlices = [
			...(state.slices ?? []).filter((slice) => slice.node_id === virtual.node.id && slice.kind === memory.slice_kind),
			...plan.newSlices.filter((slice) => slice.node_id === virtual.node.id && slice.kind === memory.slice_kind),
		];
		const duplicate = existingSlices.find((slice) => sameSlice(slice.text, memory.text));
		if (duplicate) {
			if ((state.slices ?? []).some((slice) => slice.id === duplicate.id)) {
				uniquePush(plan.sliceTouches, { id: duplicate.id, node_id: virtual.node.id, kind: duplicate.kind }, (item) => item.id);
			}
			return;
		}
		const id = newId("slice");
		const supersedes = fact.supersedes || CORRECTION_RE.test(input.submittedContent ?? "") || SINGLE_VALUE_SLICES.has(memory.slice_kind);
		if (supersedes) {
			for (const planned of plan.newSlices) {
				if (planned.node_id === virtual.node.id && planned.kind === memory.slice_kind) planned.is_current = 0;
			}
			// Always queue the supersede. A concurrent transaction may create a current
			// value after this snapshot. The write is guarded by this replacement's fact
			// claim so an identical losing save cannot clear the winner.
			const prior = plan.sliceSupersede.find((item) =>
				item.node_id === virtual.node.id && item.kind === memory.slice_kind);
			if (prior) prior.replacement_id = id;
			else plan.sliceSupersede.push({ node_id: virtual.node.id, kind: memory.slice_kind, replacement_id: id });
		}
		plan.newSlices.push({
			id,
			user_id: userId,
			node_id: virtual.node.id,
			text: memory.text,
			kind: memory.slice_kind,
			is_current: 1,
			created_at: now,
			manual_order: plan.newSlices.length,
			manual_fact_key: manualFactKey("slice", virtual.node.id, memory.slice_kind, memory.text),
		});
	}

	function addEvent(virtual, fact) {
		const memory = fact.memory;
		const existingEvents = [
			...(state.events ?? []).filter((event) => event.node_id === virtual.node.id),
			...plan.newEvents.filter((event) => event.node_id === virtual.node.id),
		];
		const duplicate = existingEvents.find((event) => sameEvent(event, memory));
		if (duplicate) {
			if ((state.events ?? []).some((event) => event.id === duplicate.id)) {
				uniquePush(plan.eventTouches, { id: duplicate.id, node_id: virtual.node.id, action: duplicate.action }, (item) => item.id);
			}
		} else {
			const id = newId("event");
			plan.newEvents.push({
				id,
				user_id: userId,
				node_id: virtual.node.id,
				action: memory.action,
				text: memory.text,
				importance: memory.importance ?? "ordinary",
				happened_at: memory.happened_at ?? now,
				created_at: now,
				confidence: fact.confidence ?? null,
				manual_order: plan.newEvents.length,
				manual_fact_key: manualFactKey(
					"event",
					virtual.node.id,
					memory.action,
					ONE_OFF_EVENTS.has(memory.action) ? "one_off" : memory.text,
				),
			});
		}
		const nextState = ACTION_TO_STATE[memory.action];
		if (nextState && stateByNode.get(virtual.node.id) !== nextState) {
			stateByNode.set(virtual.node.id, nextState);
			if (!virtual.existed) {
				virtual.node.state = nextState;
				return;
			}
			const prior = plan.nodeStateUpdates.find((update) => update.id === virtual.node.id);
			if (prior) prior.state = nextState;
			else plan.nodeStateUpdates.push({ id: virtual.node.id, state: nextState, increment_session: virtual.existed });
		}
	}

	function addRelationship(from, to, relationship) {
		const duplicate = (state.edges ?? []).find((edge) =>
			edge.from_node === from.node.id && edge.to_node === to.node.id && edge.type === relationship.type);
		if (duplicate) {
			uniquePush(plan.edgeTouches, {
				id: duplicate.id,
				from_node: duplicate.from_node,
				to_node: duplicate.to_node,
				type: duplicate.type,
			}, (item) => item.id);
			return duplicate;
		}
		const planned = plan.newEdges.find((edge) =>
			edge.from_node === from.node.id && edge.to_node === to.node.id && edge.type === relationship.type);
		if (planned) return planned;
		const edge = {
			id: newId("edge"),
			user_id: userId,
			from_node: from.node.id,
			to_node: to.node.id,
			type: relationship.type,
			created_at: now,
			confidence: relationship.confidence ?? null,
			evidence_count: 1,
			manual_fact_key: manualFactKey("edge", from.node.id, to.node.id, relationship.type),
		};
		plan.newEdges.push(edge);
		return edge;
	}

	function correctionCurrentSlice(subject, oldTarget, correction) {
		const text = String(correction.current_text ?? "").trim();
		if (!text) return null;
		const duplicate = [
			...(state.slices ?? []).filter((slice) =>
				slice.node_id === subject.node.id &&
				Number(slice.is_current ?? 1) === 1 &&
				sameSlice(slice.text, text)),
			...plan.newSlices.filter((slice) => slice.node_id === subject.node.id && sameSlice(slice.text, text)),
		][0];
		let current = duplicate ?? null;
		if (duplicate && (state.slices ?? []).some((slice) => slice.id === duplicate.id)) {
			uniquePush(plan.sliceTouches, {
				id: duplicate.id,
				node_id: subject.node.id,
				kind: duplicate.kind,
			}, (item) => item.id);
		}
		if (!current) {
			current = {
				id: newId("slice"),
				user_id: userId,
				node_id: subject.node.id,
				text,
				kind: "technical_detail",
				is_current: 1,
				created_at: now,
				manual_order: plan.newSlices.length,
				manual_fact_key: manualFactKey("slice", subject.node.id, "technical_detail", text),
			};
			plan.newSlices.push(current);
		}

		if (!oldTarget?.node?.id || !correction.old_target?.label) return current;
		const subjectKey = canonicalIdentity(subject.node.label);
		const oldTargetKey = canonicalIdentity(correction.old_target.label);
		const predicate = correction.type === "depends_on" ? /\b(?:depends? on|powered by)\b/i : /\buses?\b/i;
		for (const slice of state.slices ?? []) {
			if (![subject.node.id, oldTarget.node.id].includes(slice.node_id)) continue;
			if (Number(slice.is_current ?? 1) !== 1 || slice.id === current.id) continue;
			const sliceKey = canonicalIdentity(slice.text);
			if (!sliceKey.includes(subjectKey) || !sliceKey.includes(oldTargetKey) || !predicate.test(slice.text)) continue;
			uniquePush(plan.sliceSupersede, {
				id: slice.id,
				node_id: slice.node_id,
				kind: slice.kind,
				replacement_id: current.id,
			}, (item) => item.id ?? `${item.node_id}:${item.kind}`);
			plan.affectedNodeIds.add(slice.node_id);
		}
		return current;
	}

	for (const fact of integrity?.facts ?? []) {
		const virtual = resolve(fact.identity, fact.memory?.text);
		if (!virtual) continue;
		if (fact.memory.kind === "event") addEvent(virtual, fact);
		else addSlice(virtual, fact);
	}

	for (const correction of integrity?.corrections ?? []) {
		const subject = resolve(correction.subject, correction.current_text ?? correction.text);
		const oldTarget = correction.old_target ? resolveExistingOnly(correction.old_target) : null;
		const newTarget = correction.new_target
			? resolve(correction.new_target, correction.current_text ?? correction.text)
			: null;
		if (!subject || (correction.new_target && !newTarget)) continue;
		if (oldTarget && newTarget && oldTarget.node.id === newTarget.node.id) {
			plan.rejected.push({ kind: "correction", label: correction.subject.label, reason: "correction_same_target" });
			continue;
		}

		let replacementEdge = null;
		if (newTarget) {
			replacementEdge = addRelationship(subject, newTarget, {
				type: correction.type,
				confidence: correction.confidence,
			});
		}
		const currentSlice = correctionCurrentSlice(subject, oldTarget, correction);
		let supersededEdge = null;
		if (oldTarget) {
			supersededEdge = (state.edges ?? []).find((edge) =>
				edge.from_node === subject.node.id &&
				edge.to_node === oldTarget.node.id &&
				edge.type === correction.type) ?? null;
			if (supersededEdge && supersededEdge.id !== replacementEdge?.id) {
				uniquePush(plan.edgeSupersede, {
					id: supersededEdge.id,
					from_node: supersededEdge.from_node,
					to_node: supersededEdge.to_node,
					type: supersededEdge.type,
					replacement_edge_id: replacementEdge?.id ?? null,
					history_text: correction.history_text,
				}, (item) => item.id);
			}
		}

		if (correction.history_text) {
			addEvent(subject, {
				confidence: correction.confidence,
				memory: {
					kind: "event",
					action: "changed_plan",
					text: correction.history_text,
					importance: "important",
					happened_at: now,
				},
			});
		}
		plan.correctionActions.push({
			subject_node_id: subject.node.id,
			subject_label: subject.node.label,
			type: correction.type,
			old_target_node_id: oldTarget?.node.id ?? null,
			old_target_label: correction.old_target?.label ?? null,
			new_target_node_id: newTarget?.node.id ?? null,
			new_target_label: correction.new_target?.label ?? null,
			superseded_edge_id: supersededEdge?.id ?? null,
			replacement_edge_id: replacementEdge?.id ?? null,
			current_slice_id: currentSlice?.id ?? null,
			history_text: correction.history_text,
			current_text: correction.current_text,
		});
	}

	for (const relationship of integrity?.relationships ?? []) {
		const from = resolve(relationship.from, relationship.text);
		const to = resolve(relationship.to, relationship.text);
		if (!from || !to) continue;
		if (from.node.id === to.node.id) {
			plan.rejected.push({ kind: "edge", label: relationship.from.label, reason: "edge_self_loop" });
			continue;
		}
		addRelationship(from, to, relationship);
	}

	// Edge endpoints are real durable identities too. A new endpoint without its
	// own fact receives the grounded relationship sentence as supporting detail.
	for (const node of plan.newNodes) {
		const hasDetail = plan.newSlices.some((slice) => slice.node_id === node.id) ||
			plan.newEvents.some((event) => event.node_id === node.id);
		if (hasDetail) continue;
		const support = supportTextByNode.get(node.id);
		if (!support) continue;
		const id = newId("slice");
		plan.newSlices.push({
			id,
			user_id: userId,
			node_id: node.id,
			text: support,
			kind: "technical_detail",
			is_current: 1,
			created_at: now,
			manual_order: plan.newSlices.length,
			manual_fact_key: manualFactKey("slice", node.id, "technical_detail", support),
		});
	}

	const completeNewNodeIds = new Set([
		...plan.newSlices.map((slice) => slice.node_id),
		...plan.newEvents.map((event) => event.node_id),
	]);
	for (const node of [...plan.newNodes]) {
		if (completeNewNodeIds.has(node.id)) continue;
		plan.rejected.push({ kind: "node", label: node.label, reason: "node_without_grounded_detail" });
		plan.newNodes = plan.newNodes.filter((candidate) => candidate.id !== node.id);
		plan.affectedNodeIds.delete(node.id);
	}

	// Record safely observed aliases only after every identity decision is known.
	for (const [nodeId, labels] of observedByNode) {
		const virtual = virtualById.get(nodeId) ?? { node: allNodes.find((node) => node.id === nodeId), existed: true };
		if (!virtual.node) continue;
		const aliases = aliasesAfterObservation(virtual.node, [...labels]);
		if (virtual.existed && JSON.stringify(aliases) !== JSON.stringify(manualNodeAliases(virtual.node))) {
			plan.nodeAliasUpdates.push({ id: nodeId, aliases_json: aliases });
		} else if (!virtual.existed) {
			virtual.node.aliases_json = JSON.stringify(aliases);
		}
	}

	// Manual promotion/merge clears the corresponding review item atomically.
	for (const candidate of state.candidates ?? []) {
		for (const [nodeId, labels] of observedByNode) {
			const node = allNodes.find((item) => item.id === nodeId);
			if (
				!node ||
				!candidateMatchesManualNode(candidate, node, [...labels]) ||
				!candidateIdentityMatchesNode(candidate, node, [...labels])
			) continue;
			const existed = !node._manual_new;
			const resolution = {
				id: candidate.id,
				status: existed ? "merged" : "promoted",
				node_id: node.id,
				node_kind: "node",
				reviewed_at: now,
				label: candidate.label_guess ?? candidate.label,
			};
			plan.candidateResolutions.push(resolution);
			plan.resolvedCandidates.push(resolution);
			break;
		}
	}

	// Simulate the post-write current facts and compute deterministic summaries.
	for (const nodeId of plan.affectedNodeIds) {
		const node = allNodes.find((item) => item.id === nodeId);
		if (!node || (node._manual_new && !plan.newNodes.some((item) => item.id === nodeId))) continue;
		const supersededSliceIds = new Set(plan.sliceSupersede
			.filter((item) => item.node_id === nodeId && item.id)
			.map((item) => item.id));
		const supersededKinds = new Set(plan.sliceSupersede
			.filter((item) => item.node_id === nodeId && !item.id)
			.map((item) => item.kind));
		const slices = [
			...(state.slices ?? []).filter((slice) =>
				slice.node_id === nodeId && Number(slice.is_current ?? 1) === 1 &&
				!supersededSliceIds.has(slice.id) && !supersededKinds.has(slice.kind)),
			...plan.newSlices.filter((slice) => slice.node_id === nodeId && Number(slice.is_current ?? 1) === 1),
		];
		const events = [
			...(state.events ?? []).filter((event) => event.node_id === nodeId),
			...plan.newEvents.filter((event) => event.node_id === nodeId),
		];
		const summary = deterministicSummary(node, slices, events, stateByNode.get(nodeId));
		const cluster = clusterForMemory({ ...node, summary });
		plan.nodeSummaryUpdates.push({ id: nodeId, summary, cluster });
		if (node._manual_new) {
			node.summary = summary;
			node.cluster = cluster;
			delete node._manual_new;
		}
	}

	plan.hasGraphWrites = Boolean(
		plan.newNodes.length || plan.nodeTouches.length || plan.nodeStateUpdates.length || plan.nodeAliasUpdates.length ||
		plan.newSlices.length || plan.sliceTouches.length || plan.sliceSupersede.length ||
		plan.newEvents.length || plan.eventTouches.length || plan.newEdges.length || plan.edgeTouches.length || plan.edgeSupersede.length ||
		plan.candidateResolutions.length || plan.nodeSummaryUpdates.length,
	);
	plan.hasWrites = plan.hasGraphWrites;
	plan.runLists = runLists(plan);
	return plan;
}
