/**
 * Passwordless entry and first-run contract.
 *
 * These are deliberately frontend-focused: the route suites exercise server
 * behavior, while this file prevents the shipped page from drifting back to a
 * password form, snake_case payloads, client-authoritative scope, or persisted
 * copy-once secrets.
 */

import { describe, expect, it } from "vitest";
import html from "../public/index.html?raw";

const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";

function fnSource(name) {
	let start = script.indexOf(`function ${name}(`);
	if (start === -1) throw new Error(`no function ${name} in the page`);
	if (script.slice(Math.max(0, start - 6), start) === "async ") start -= 6;
	let parens = 0;
	let sawParams = false;
	let bodyStart = -1;
	for (let i = start; i < script.length; i++) {
		if (script[i] === "(") { parens++; sawParams = true; }
		else if (script[i] === ")") parens--;
		else if (script[i] === "{" && sawParams && parens === 0) { bodyStart = i; break; }
	}
	if (bodyStart === -1) throw new Error(`no body for ${name}`);
	let depth = 0;
	for (let i = bodyStart; i < script.length; i++) {
		if (script[i] === "{") depth++;
		else if (script[i] === "}") {
			depth--;
			if (depth === 0) return script.slice(start, i + 1);
		}
	}
	throw new Error(`unbalanced ${name}`);
}

describe("passwordless authentication UI", () => {
	it("offers Google, GitHub, and a six-digit email-code path without a primary password form", () => {
		const render = fnSource("renderAuth");
		expect(render).toContain("startGoogle(event)");
		expect(render).toContain("startGithub(event)");
		expect(render).toContain("Email me a code");
		expect(render).toContain('autocomplete="one-time-code"');
		expect(render).toContain('pattern="[0-9]{6}"');
		expect(render).not.toContain('type="password"');
		expect(render).not.toContain("authPassword");
	});

	it("uses the passwordless route contract and keeps invitation handoff tab-scoped", () => {
		expect(fnSource("startGoogle")).toContain('location.href = "/auth/google/start"');
		expect(fnSource("startGithub")).toContain('location.href = "/auth/github"');
		expect(fnSource("submitAuth")).toContain('fetch("/auth/email/start"');
		expect(fnSource("submitAuthCode")).toContain('fetch("/auth/email/verify"');
		const invitation = fnSource("stashPendingInvitation");
		expect(invitation).toContain('sessionStorage.setItem("itsuki_pending_invite"');
		expect(invitation).not.toContain("localStorage.setItem");
	});
});

describe("first-run onboarding UI", () => {
	it("submits the strict camelCase onboarding shape and gates the optional sample on consent", () => {
		const submit = fnSource("submitOnboarding");
		expect(submit).toContain('api("/auth/onboarding"');
		for (const field of [
			"workspaceName", "useScope", "useCase", "useCaseOther", "heardAbout",
			"heardAboutOther", "conversationSample", "conversationSampleConsent",
		]) expect(submit).toContain(`${field}:`);
		expect(submit).toContain("fields.conversationSampleConsent ? String(fields.conversationSample).trim() : null");
		expect(submit).toContain("fields.conversationSampleConsent === true");
		expect(submit).not.toMatch(/workspace_name|use_scope|use_case|heard_about|conversation_sample/);
	});

	it("requires the server-created organization and Default project before issuing a key", () => {
		const submit = fnSource("submitOnboarding");
		expect(submit).toContain("result.onboarding?.completed");
		expect(submit).toContain("!organization || !project || !project.is_default");
		expect(submit).toContain('stage: "key"');
	});
});

describe("bootstrap scope and one-time key safety", () => {
	it("clears the previous account scope and one-time secret before invitation account switching", () => {
		const signOut = fnSource("signOutForInvitation");
		expect(signOut).toContain("S.oneTimeToken = null");
		expect(signOut).toContain('S.organizationId = ""');
		expect(signOut).toContain("resetAuthFlow()");
	});

	it("hydrates selectors from bootstrap and persists scope with revision CAS", () => {
		expect(fnSource("refreshProjects")).toContain('api("/auth/bootstrap", { projectBound: false })');
		const persist = fnSource("persistScopeSelection");
		expect(persist).toContain('api("/auth/scope"');
		expect(persist).toContain("organizationId");
		expect(persist).toContain("projectId");
		expect(persist).toContain("expectedRevision");
		expect(persist).not.toMatch(/organization_id|project_id|expected_revision/);
	});

	it("holds the first secret in memory, reveals Proceed only after copy, and opens Get started directly", () => {
		const create = fnSource("createFirstRunKey");
		expect(create).toContain('api("/auth/tokens"');
		expect(create).toContain("FIRST_RUN.key = result.token");
		expect(create).not.toContain("localStorage.setItem");
		expect(create).not.toContain("sessionStorage.setItem");
		const copy = fnSource("copyFirstRunKey");
		expect(copy).toContain("await navigator.clipboard.writeText(FIRST_RUN.key)");
		expect(copy).toContain("FIRST_RUN.keyCopied = true");
		expect(fnSource("proceedFirstRunKey")).toContain("!FIRST_RUN.keyCopied");
		expect(fnSource("renderFirstRunKey")).toContain("FIRST_RUN.keyCopied ? '<div");
		expect(fnSource("proceedFirstRunKey")).toContain('S.view = "install"');
		expect(fnSource("proceedFirstRunKey")).toContain("await completeFirstRun()");
	});
});
