import { describe, expect, it } from "vitest";
import {
	hashText,
	normalizeSourcePacket,
	sourceContextDescriptor,
	sourceContextIdentity,
	sourceMeta,
} from "../src/pipeline/source.js";

describe("source extraction-context identity", () => {
	it("uses the canonical tuple and conversation-first precedence", async () => {
		const input = {
			conversationId: "conversation-a",
			threadId: "thread-a",
			sourcePacketId: "packet-a",
			jobId: "job-a",
			acceptanceId: "accept-a",
			scope: {
				workspaceId: "workspace-a",
				appId: "app-a",
				agentId: "agent-a",
				sessionId: "session-a",
				sourceScope: "plugin-a",
				projectId: "project-a",
				projectName: "Display only",
				topic: "ignored",
			},
		};
		const descriptor = sourceContextDescriptor("memory-a", input);
		expect(descriptor).toEqual([
			"itsuki.extract-context/v1",
			"memory-a",
			"project-a",
			"workspace-a",
			"app-a",
			"agent-a",
			"plugin-a",
			"conversation",
			"conversation-a",
		]);

		const identity = await sourceContextIdentity("memory-a", input);
		expect(identity).toEqual({
			contextKey: `context:v1:${await hashText(JSON.stringify(descriptor))}`,
			descriptor,
		});
		expect(identity.contextKey).toMatch(/^context:v1:[a-f0-9]{64}$/);
	});

	it("uses thread, then an explicitly supplied session", () => {
		expect(sourceContextDescriptor("memory-a", {
			threadId: "thread-a",
			scope: { sessionId: "session-a" },
			sourcePacketId: "packet-a",
		}).slice(-2)).toEqual(["thread", "thread-a"]);
		expect(sourceContextDescriptor("memory-a", {
			scope: { sessionId: "session-a" },
			sourcePacketId: "packet-a",
		}).slice(-2)).toEqual(["session", "session-a"]);
		expect(sourceContextDescriptor("memory-a", {
			scope: { sessionId: "memory-a" },
			sourcePacketId: "packet-a",
		}).slice(-2)).toEqual(["session", "memory-a"]);
	});

	it("does not mistake the normalized user-id session fallback for an explicit session", async () => {
		const normalized = await normalizeSourcePacket("memory-fallback", {
			content: "A source packet without a conversation.",
			messageId: "message-a",
		});
		expect(normalized.packet.session_id).toBe("memory-fallback");
		expect(normalized.packet.session_id_explicit).toBe(false);
		expect(JSON.parse(normalized.packet.raw_meta_json).session_id_explicit).toBe(false);
		expect(sourceContextDescriptor("memory-fallback", {
			sourcePacket: { ...normalized.packet, id: "packet-fallback" },
		}).slice(-2)).toEqual(["source_packet", "packet-fallback"]);
		expect(sourceContextDescriptor("memory-fallback", {
			...normalized.packet,
			id: "packet-direct",
		}).slice(-2)).toEqual(["source_packet", "packet-direct"]);

		const legacyPersisted = {
			...normalized.packet,
			id: "packet-legacy",
			raw_meta_json: JSON.stringify({ messages: [] }),
		};
		delete legacyPersisted.session_id_explicit;
		expect(sourceContextDescriptor("memory-fallback", legacyPersisted).slice(-2)).toEqual([
			"source_packet",
			"packet-legacy",
		]);
		expect(sourceContextDescriptor("memory-fallback", {
			meta: {
				source_packet_id: "packet-legacy-meta",
				scope_json: JSON.stringify({ session_id: "memory-fallback" }),
			},
		}).slice(-2)).toEqual(["source_packet", "packet-legacy-meta"]);
	});

	it("preserves explicit-session provenance through persisted packet metadata", async () => {
		const normalized = await normalizeSourcePacket("memory-session", {
			content: "A session-bound source packet.",
			messageId: "message-session",
			scope: { sessionId: "caller-session" },
		});
		const persisted = {
			...normalized.packet,
			id: "packet-session",
		};
		delete persisted.session_id_explicit;
		const legacyRawMeta = JSON.parse(persisted.raw_meta_json);
		delete legacyRawMeta.session_id_explicit;
		persisted.raw_meta_json = JSON.stringify(legacyRawMeta);
		const metadata = sourceMeta(persisted);
		expect(JSON.parse(metadata.scope_json).session_id_explicit).toBe(true);
		expect(sourceContextDescriptor("memory-session", { sourcePacket: persisted }).slice(-2)).toEqual([
			"session",
			"caller-session",
		]);

		const topLevelA = await normalizeSourcePacket("memory-session", {
			content: "Same message in two explicit sessions.",
			messageId: "same-message",
			sessionId: "session-a",
		});
		const topLevelB = await normalizeSourcePacket("memory-session", {
			content: "Same message in two explicit sessions.",
			messageId: "same-message",
			sessionId: "session-b",
		});
		expect(topLevelA.packet.session_id_explicit).toBe(true);
		expect(topLevelA.packet.content_hash).not.toBe(topLevelB.packet.content_hash);
	});

	it("falls back through source packet, job, handoff, and per-acceptance identity", () => {
		expect(sourceContextDescriptor("memory-a", { sourcePacketId: "packet-a" }).slice(-2))
			.toEqual(["source_packet", "packet-a"]);
		expect(sourceContextDescriptor("memory-a", { jobId: "job-a", handoffId: "handoff-a" }).slice(-2))
			.toEqual(["job", "job-a"]);
		expect(sourceContextDescriptor("memory-a", { handoffId: "handoff-a", acceptanceId: "accept-a" }).slice(-2))
			.toEqual(["handoff", "handoff-a"]);
		expect(sourceContextDescriptor("memory-a", { acceptanceId: "accept-a" }).slice(-2))
			.toEqual(["acceptance", "accept-a"]);
		expect(sourceContextDescriptor("memory-a", {
			meta: { source_packet_id: "packet-from-meta", job_id: "job-from-meta" },
		}).slice(-2)).toEqual(["source_packet", "packet-from-meta"]);
		expect(() => sourceContextDescriptor("memory-a")).toThrow(/acceptanceId is required/);
	});

	it("is stable across display metadata but isolates project, agent, and conversation", async () => {
		const base = {
			conversationId: "conversation-a",
			scope: {
				projectId: "project-a",
				projectName: "Old project name",
				agentId: "agent-a",
				topic: "old topic",
				sourceMode: "old mode",
			},
		};
		const first = await sourceContextIdentity("memory-a", base);
		const displayChanged = await sourceContextIdentity("memory-a", {
			...base,
			scope: {
				...base.scope,
				projectName: "Renamed project",
				topic: "new topic",
				sourceMode: "new mode",
			},
		});
		expect(displayChanged.contextKey).toBe(first.contextKey);

		for (const changed of [
			{ ...base, conversationId: "conversation-b" },
			{ ...base, scope: { ...base.scope, projectId: "project-b" } },
			{ ...base, scope: { ...base.scope, agentId: "agent-b" } },
		]) {
			expect((await sourceContextIdentity("memory-a", changed)).contextKey).not.toBe(first.contextKey);
		}
	});

	it("canonicalizes missing workspace and app identifiers", () => {
		expect(sourceContextDescriptor("memory-a", { acceptanceId: "accept-a" })).toEqual([
			"itsuki.extract-context/v1",
			"memory-a",
			null,
			"default",
			"uml",
			null,
			null,
			"acceptance",
			"accept-a",
		]);
	});
});
