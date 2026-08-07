/**
 * A6 — cross-door project identity (campaign 2026-08-07).
 *
 * The product promises "One memory service. Multiple ways to connect", and the
 * campaign requires "Claude plugin capture -> terminal enrichment -> recall
 * from Codex". Both plugins scope project captures with sourceScope "project"
 * and recall with project_then_global, so that promise reduces to one
 * question: do the two plugins derive the SAME project id for the same
 * working directory?
 *
 * Their derivations are byte-identical (resolve -> realpath -> normalize ->
 * lowercase on win32 -> sha256 -> "local_" + 32 hex) and differ in exactly one
 * thing: the salt string. This test states the contract so the answer cannot
 * drift silently in either direction.
 */

import { describe, expect, it } from "vitest";

import { resolveProjectIdentity } from "../hooks/project-identity.mjs";
import { resolveCodexProjectScope } from "../plugins/itsuki/hooks/codex-outbox.mjs";

const SHARED = process.platform === "win32" ? "C:\\Users\\shared\\itsuki-cross-door" : "/tmp/itsuki-cross-door";

describe("cross-door project identity", () => {
	it("both plugins address the same project for the same directory", async () => {
		const claude = await resolveProjectIdentity(SHARED);
		const codex = await resolveCodexProjectScope(SHARED);
		expect(claude.projectId).toMatch(/^local_[0-9a-f]{32}$/);
		expect(codex.projectId).toMatch(/^local_[0-9a-f]{32}$/);
		// The shared-memory promise lives or dies here: a project capture from
		// one tool is addressable by the other only if these agree.
		expect(codex.projectId).toBe(claude.projectId);
	});

	it("still separates genuinely different directories", async () => {
		const a = await resolveProjectIdentity(SHARED);
		const b = await resolveProjectIdentity(`${SHARED}-other`);
		expect(a.projectId).not.toBe(b.projectId);
		const ca = await resolveCodexProjectScope(SHARED);
		const cb = await resolveCodexProjectScope(`${SHARED}-other`);
		expect(ca.projectId).not.toBe(cb.projectId);
	});

	it("an explicit ITSUKI_PROJECT_ID overrides both doors identically", async () => {
		const explicit = "team-shared-project";
		const claude = await resolveProjectIdentity(SHARED, { projectIdOverride: explicit });
		const codex = await resolveCodexProjectScope(SHARED, { projectId: explicit });
		expect(claude.projectId).toBe(explicit);
		expect(codex.projectId).toBe(explicit);
	});
});
