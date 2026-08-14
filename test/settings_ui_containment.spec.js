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

function build(names, globals) {
	const keys = Object.keys(globals);
	return new Function(
		...keys,
		`${names.map(fnSource).join("\n")}\nreturn { ${names.join(", ")} };`,
	)(...keys.map((key) => globals[key]));
}

describe("Settings containment", () => {
	it("keeps user-facing source free of mojibake", () => {
		expect(html).not.toMatch(/[ÃÂâ]/);
	});
	it("keeps Personal account personal and has one memory-policy editor", () => {
		expect(script).not.toContain('["personal-memory", "What to remember"]');
		expect(script).not.toContain("function setPersonalMemory(");
		const personal = fnSource("viewSettingsMain");
		expect(personal).not.toContain("managedProjectName");
		expect(personal).not.toContain("Memory Controls");
		expect(personal).not.toContain("viewReset(");
	});

	it("uses the capability belonging to each membership table", () => {
		expect(fnSource("setMemberTable")).toContain("setLocked(capability)");
		expect(fnSource("setMemberTable")).toContain("Last activity");
		expect(fnSource("setMemberTable")).toContain('Number(m.last_activity_at) > 0 ? esc(ago(m.last_activity_at)) : "Never"');
		expect(fnSource("setProjectMembers")).toContain('capability: "project.members.manage"');
		expect(fnSource("setOrgMembers")).toContain('capability: "org.members.manage"');
	});

	it("clears every project-scoped Settings draft and warns before discarding", () => {
		const clear = fnSource("setClearTransient");
		for (const state of ["draft", "baseline", "invite", "inviteForm", "preview", "previewText", "audit"]) {
			expect(clear, state).toContain(`${state}:`);
		}
		expect(fnSource("resetProjectBoundUiState")).toContain("setClearTransient()");
		expect(fnSource("switchManagedProject")).toContain('setConfirmDiscard("switch projects")');
		expect(fnSource("setSection")).toContain('setConfirmDiscard("open another section")');
		expect(fnSource("setView")).toContain('setConfirmDiscard("leave Settings")');
		expect(clear).not.toContain("busy:");
		expect(clear).not.toContain("inviteBusy:");
	});

	it("blocks every ordinary Settings navigation while a save is in flight", () => {
		for (const name of ["setSection", "setView", "handlePopState"]) {
			expect(fnSource(name), name).toContain("setBlockBusyNavigation(");
		}
		expect(fnSource("projectSwitchBlocked")).toContain("setMutationBusy()");
		expect(fnSource("setBlockBusyNavigation")).toContain('SET.inviteBusy ? "invitation" : "access update"');
		expect(fnSource("installKeyGuard")).toContain("!setMutationBusy()");
	});

	it("shows truthful invite expiry and audit failures", () => {
		expect(fnSource("setOrgMembers")).toContain("inviteExpiryCopy(i.expires_at)");
		expect(fnSource("setOrgMembers")).not.toContain("ago(i.expires_at)");
		expect(script).toContain('if (remainingMs <= 0) return "expired";');
		expect(fnSource("loadAuditPage")).toContain("SET.auditError = error.message");
		expect(fnSource("loadAuditPage")).not.toContain("SET.audit = { events: [] }");
		expect(fnSource("setProjectAudit")).toContain('role="alert"');
	});

	it("never hides a visible copy-once invitation behind a refresh failure", () => {
		const load = fnSource("loadSettings");
		expect(load).toContain("if (SET.invite && SET.data)");
		expect(load).not.toContain("preserveVisibleInvite");
		expect(fnSource("setRevokeInvite")).toContain("SET.invite?.invitation?.id === id");
		expect(fnSource("setRevokeInvite")).toContain("SET.invite = null");
		expect(fnSource("setRevokeInvite")).toContain("Its link no longer works.");
	});

	it("locks every extraction-rule mutation while its save is in flight", () => {
		const render = fnSource("setProjectExtraction");
		expect(render).toContain("const editable = canEdit && !SET.busy");
		expect(render.match(/\$\{editable \? \"\" : \" disabled\"\}/g) || []).toHaveLength(9);
		expect(fnSource("setAddTerm")).toContain('if (SET.busy || !setCan("project.rules.edit")');
		expect(fnSource("setRemoveTerm")).toContain('if (SET.busy || !setCan("project.rules.edit")');
	});

	it("requires a real rules version on both browser rule writers", () => {
		const settingsSave = fnSource("saveExtractionRules");
		expect(settingsSave).toContain("setRulesVersionToken(SET.data?.rules_version)");
		expect(settingsSave).toContain("expected_version: expectedVersion");
		expect(settingsSave).toContain("setRulesVersionToken(res.rules_version)");
		const directLoad = fnSource("loadRules");
		expect(directLoad).toContain("setRulesVersionToken(res.rules_version)");
		const directSave = fnSource("saveRulesForm");
		expect(directSave).toContain("setRulesVersionToken(RULES_FORM.version)");
		expect(directSave).toContain("expected_version: expectedVersion");
		expect(fnSource("rulesReviewConflict")).toContain("Continue with my text");
		expect(fnSource("rulesResolveConflict")).toContain("RULES_FORM.version = version");
		expect(fnSource("api")).toContain("failure.status = res.status");
		expect(fnSource("api")).toContain("failure.body = body");
	});

	it("never bypasses rules CAS when the loaded version is absent", async () => {
		let calls = 0;
		const SET = {
			section: "project-extraction",
			data: { rules_version: null, membership: { capabilities: ["project.rules.edit"] } },
			draft: { includes: ["local"], excludes: [], captureDefault: "auto", captureDensity: "standard", autoCollect: true },
			baseline: { includes: [], excludes: [], captureDefault: "auto", captureDensity: "standard", autoCollect: true },
			draftSection: "project-extraction", busy: false, mutationId: 0, mutation: null,
			status: "", statusKind: "", rulesConflict: null,
		};
		const built = build([
			"setRulesVersionToken", "setCan", "setClone", "setStartMutation", "setStatus",
			"setOwnsMutation", "setRuleValues", "saveExtractionRules",
		], {
			SET, S: { projectId: "proj_a", projectEpoch: 1, view: "settings" },
			document: { getElementById: () => null }, renderSettingsSection: () => {},
			api: async () => { calls++; return {}; },
		});
		await built.saveExtractionRules();
		expect(calls).toBe(0);
		expect(SET.busy).toBe(false);
		expect(SET.draft.includes).toEqual(["local"]);
		expect(SET.status).toContain("version is unavailable");
		expect(SET.statusKind).toBe("error");
	});

	it("retains a stale tab draft and rebases only after explicit review", async () => {
		const currentRules = {
			customInstructions: "",
			includes: ["remote"], excludes: ["secret"], captureDefault: "graph_only",
			captureDensity: "dense", autoCollect: false,
		};
		const localRules = {
			customInstructions: "",
			includes: ["local"], excludes: [], captureDefault: "auto",
			captureDensity: "standard", autoCollect: true,
		};
		const pending = [];
		const SET = {
			section: "project-extraction",
			data: { rules: {}, rules_version: "rules-v1", membership: { capabilities: ["project.rules.edit"] } },
			draft: structuredClone(localRules), baseline: { ...localRules, includes: [], excludes: [] },
			draftSection: "project-extraction", busy: false, mutationId: 0, mutation: null,
			status: "", statusKind: "", rulesConflict: null,
		};
		const built = build([
			"setRulesVersionToken", "setRuleValues", "setCan", "setClone", "setDraftDirty",
			"setStartMutation", "setOwnsMutation", "setStatus", "setResolveRulesConflict",
			"saveExtractionRules",
		], {
			SET, S: { projectId: "proj_a", projectEpoch: 2, view: "settings" },
			document: { getElementById: () => null }, renderSettingsSection: () => {}, confirm: () => true,
			api: (_path, init) => new Promise((resolve, reject) => pending.push({ init, resolve, reject })),
		});
		const secondPending = [];
		const SECOND_SET = {
			section: "project-extraction",
			data: { rules: {}, rules_version: "rules-v1", membership: { capabilities: ["project.rules.edit"] } },
			draft: structuredClone(currentRules), baseline: { ...currentRules, includes: [], excludes: [] },
			draftSection: "project-extraction", busy: false, mutationId: 0, mutation: null,
			status: "", statusKind: "", rulesConflict: null,
		};
		const secondTab = build([
			"setRulesVersionToken", "setRuleValues", "setCan", "setClone", "setDraftDirty",
			"setStartMutation", "setOwnsMutation", "setStatus", "setResolveRulesConflict",
			"saveExtractionRules",
		], {
			SET: SECOND_SET, S: { projectId: "proj_a", projectEpoch: 2, view: "settings" },
			document: { getElementById: () => null }, renderSettingsSection: () => {}, confirm: () => true,
			api: (_path, init) => new Promise((resolve, reject) => secondPending.push({ init, resolve, reject })),
		});

		const first = built.saveExtractionRules();
		const concurrent = secondTab.saveExtractionRules();
		expect(JSON.parse(pending[0].init.body).expected_version).toBe("rules-v1");
		expect(JSON.parse(secondPending[0].init.body).expected_version).toBe("rules-v1");
		const secondMetadata = { version: "rules-v2", updated_at: 2_000, updated_by: { id: "user_b", name: "Second", email: "second@example.test" } };
		secondPending[0].resolve({ ok: true, changed: true, rules: currentRules, rules_version: "rules-v2", rules_metadata: secondMetadata });
		await concurrent;
		expect(SECOND_SET.data.rules_version).toBe("rules-v2");
		expect(SECOND_SET.data.rules_metadata).toBe(secondMetadata);
		const conflict = new Error("These settings changed in another tab.");
		Object.assign(conflict, {
			status: 409, code: "settings_conflict",
			body: { error: "settings_conflict", rules: currentRules, rules_version: "rules-v2" },
		});
		pending[0].reject(conflict);
		await first;

		expect(SET.data.rules_version).toBe("rules-v1");
		expect(SET.draft).toEqual(localRules);
		expect(SET.rulesConflict).toMatchObject({ rules_version: "rules-v2", rules: currentRules });
		expect(SET.status).toContain("draft is unchanged");

		built.setResolveRulesConflict(true);
		expect(SET.data.rules_version).toBe("rules-v2");
		expect(SET.baseline).toEqual(currentRules);
		expect(SET.draft).toEqual(localRules);
		expect(SET.rulesConflict).toBeNull();
		expect(SET.statusKind).toBe("dirty");

		const retry = built.saveExtractionRules();
		expect(JSON.parse(pending[1].init.body).expected_version).toBe("rules-v2");
		const finalMetadata = { version: "rules-v3", updated_at: 3_000, updated_by: null };
		pending[1].resolve({ ok: true, changed: true, rules: localRules, rules_version: "rules-v3", rules_metadata: finalMetadata });
		await retry;
		expect(SET.data.rules_version).toBe("rules-v3");
		expect(SET.data.rules_metadata).toBe(finalMetadata);
		expect(SET.baseline).toEqual(localRules);
		expect(SET.statusKind).toBe("success");
	});

	it("renders an honest conflict review instead of replacing the draft", () => {
		const render = fnSource("setRulesConflictPanel");
		expect(render).toContain("Your draft is still here and has not been overwritten");
		expect(render).toContain("Review saved version");
		expect(render).toContain("Reload saved version");
		expect(render).toContain("Continue with my draft");
		expect(fnSource("setProjectExtraction")).toContain("Boolean(SET.rulesConflict)");
	});

	it("exposes no browser path to the incomplete scoped delete-all route", () => {
		const danger = fnSource("setDangerZone");
		expect(danger).toContain("primary and SDK subtenant storage space");
		expect(danger).toContain("The existing scoped compatibility reset is intentionally not exposed");
		expect(danger).toContain("disabled");
		for (const forbidden of [
			"function viewReset(", "function showResetMemoryConfirm(", "function resetSelectedUserMemory(",
			"function deleteAllMemory(", "/v1/actions/delete-all", "resetConfirmOpen", "DELETE ALL",
		]) expect(script, forbidden).not.toContain(forbidden);
		expect(fnSource("renderView")).not.toContain("reset:");
		expect(fnSource("viewSaves")).not.toContain("Open Reset");
	});

	it("maps Playground UI to the four server capabilities", () => {
		expect(html).toContain('data-view="playground" hidden');
		expect(fnSource("viewPlayground")).toContain('playgroundCapabilityState("project.playground.read")');
		expect(fnSource("viewPlayground")).toContain("Playground is not available for viewers");
		expect(fnSource("loadPlayground")).toContain('playgroundCan("project.playground.read")');
		expect(fnSource("playgroundSend")).toContain('playgroundCan("project.playground.use")');
		expect(fnSource("renderPlaygroundSettings")).toContain('playgroundCan("project.playground.policy.edit")');
		expect(fnSource("renderPlaygroundSettings")).toContain("Only project admins can change it");
		expect(fnSource("pgThreadMenu")).toContain('playgroundCan("project.playground.delete")');
		expect(fnSource("playgroundDeleteThread")).toContain('playgroundCan("project.playground.delete")');
	});

	it("fails closed and distinguishes unavailable project access from a denied role", () => {
		const notices = [];
		const S = { projectId: "proj_a", projectCapabilitiesLoading: false, projectCapabilities: null };
		const built = build([
			"projectCapabilityState", "projectCan", "projectCapabilityError", "requireProjectCapability",
		], { S, toast: (message, bad) => notices.push({ message, bad }) });
		expect(built.requireProjectCapability("project.keys.manage", "Denied by role.")).toBe(false);
		expect(notices.pop().message).toContain("could not be verified");
		S.projectCapabilities = { projectId: "proj_a", capabilities: [], error: "network down" };
		expect(built.requireProjectCapability("project.keys.manage", "Denied by role.")).toBe(false);
		expect(notices.pop().message).toContain("could not be verified");
		S.projectCapabilities = { projectId: "proj_a", capabilities: [], error: "" };
		expect(built.requireProjectCapability("project.keys.manage", "Denied by role.")).toBe(false);
		expect(notices.pop().message).toBe("Denied by role.");
	});

	it("maps project creation and key surfaces to their server capabilities", () => {
		expect(html).toContain('data-view="keys" hidden');
		expect(fnSource("updatePlaygroundVisibility")).toContain('keys: "project.keys.view"');
		for (const name of ["openProjectModal", "submitProjectModal"]) {
			expect(fnSource(name), name).toContain('"project.create"');
		}
		for (const name of ["onboardCreateLink", "createKeyFor", "openKeyModal", "submitKeyModal", "deleteToken"]) {
			expect(fnSource(name), name).toContain('"project.keys.manage"');
		}
		expect(fnSource("createInstallKey")).toContain('openKeyModal("mcp")');
		expect(fnSource("installCodeBlock")).toContain('projectCan("project.keys.manage")');
		expect(fnSource("viewKeys")).toContain('"project.keys.view"');
		expect(fnSource("refreshTokens")).toContain("S.tokensError");
	});

	it("keeps read surfaces while gating integration and memory mutations", () => {
		expect(html).toContain('data-view="webhooks" hidden');
		expect(fnSource("updatePlaygroundVisibility")).toContain('webhooks: "project.integrations.view"');
		for (const name of ["viewWebhooks", "loadWebhooks", "toggleWebhookLog", "refreshWebhookLog"]) {
			expect(fnSource(name), name).toContain('"project.integrations.view"');
		}
		for (const name of ["createWebhookNow", "deleteWebhookNow", "sendWebhookTest"]) {
			expect(fnSource(name), name).toContain('"project.integrations.manage"');
		}
		for (const name of ["saveFactFromForm", "saveConversationFromForm", "candidatePromote", "candidateReject", "candidateMerge"]) {
			expect(fnSource(name), name).toContain('"project.memory.write"');
		}
		for (const name of ["archiveSelected", "deleteSelected"]) {
			expect(fnSource(name), name).toContain('"project.memory.delete"');
		}
		expect(fnSource("viewMemory")).toContain("projectCapabilityActionCopy(");
		expect(fnSource("viewMemoryMain")).toContain("projectCapabilityActionCopy(");
		expect(fnSource("viewCandidates")).toContain("projectCapabilityActionCopy(");
	});

	it("fails closed on every project export surface", () => {
		expect(html).toContain('data-view="exports" hidden');
		expect(fnSource("updatePlaygroundVisibility")).toContain('exports: "project.export"');
		expect(fnSource("viewExports")).toContain('renderProjectAccessGate(v, "project.export"');
		for (const name of ["loadExports", "createExportJob", "downloadPreparedExport", "downloadExport"]) {
			expect(fnSource(name), name).toContain('requireProjectCapability("project.export"');
		}
		const personal = fnSource("viewSettingsMain");
		expect(personal).toContain('projectCan("project.export")');
		expect(personal).toContain('projectCapabilityActionCopy("project.export"');
		expect(personal).toContain('onclick="downloadExport()"');
		expect(personal).toContain('disabled title=');
	});

	it("does not offer or fetch Audit history without audit capability", () => {
		expect(fnSource("setSectionAllowed")).toContain('setCan("project.audit.view")');
		expect(fnSource("viewSettings")).toContain("filter(([id]) => setSectionAllowed(id))");
		expect(fnSource("setSection")).toContain("setSectionAllowed(id)");
		expect(fnSource("setProjectAudit")).toContain('setCan("project.audit.view")');
		expect(fnSource("loadAuditPage")).toContain('setCan("project.audit.view")');
	});

	it("owns key creation until the one-time result is explicitly closed", async () => {
		let resolveCreate;
		let calls = 0;
		const KEYMODAL = {
			open: true, type: "api", busy: false, result: null, error: "", name: "",
			projectId: "proj_a", projectEpoch: 3, mutationId: 0, mutation: null,
		};
		const S = { projectId: "proj_a", projectEpoch: 3, view: "keys", oneTimeToken: null };
		const WH = { secret: null };
		const notices = [];
		const built = build([
			"installKey", "webhookSecretVisible", "keyModalOwnsMutation", "closeKeyModal", "submitKeyModal",
		], {
			KEYMODAL, S, WH,
			$: () => ({ value: "Production" }),
			api: async () => { calls++; return new Promise((resolve) => { resolveCreate = resolve; }); },
			renderKeyModal: () => {}, renderView: () => {}, refreshTokens: async () => {},
			mcpUrlForToken: (token) => `mcp:${token}`,
			toast: (message, bad) => notices.push({ message, bad }), setView: () => {},
		});
		const pending = built.submitKeyModal();
		void built.submitKeyModal();
		expect(calls).toBe(1);
		expect(KEYMODAL.busy).toBe(true);
		expect(built.closeKeyModal({ explicit: true })).toBe(false);
		resolveCreate({ token: "secret", tokenRecord: { type: "api" } });
		await pending;
		expect(KEYMODAL.result.secret).toBe("secret");
		expect(S.oneTimeToken.projectId).toBe("proj_a");
		expect(built.closeKeyModal()).toBe(false);
		expect(KEYMODAL.result.secret).toBe("secret");
		built.closeKeyModal({ explicit: true });
		expect(KEYMODAL.result).toBeNull();
		expect(S.oneTimeToken).toBeNull();
		expect(notices.some(({ message }) => message.includes("finish creating"))).toBe(true);
	});

	it("keeps a visible MCP install secret project-bound until explicit dismissal", () => {
		const S = {
			projectId: "proj_a", projectEpoch: 5, onboardKeyBusy: false, view: "install",
			oneTimeToken: {
				token: "mcp-once", tokenRecord: { type: "mcp" }, projectId: "proj_a", projectEpoch: 5,
			},
		};
		const KEYMODAL = { busy: false, result: null };
		const WH = { creating: false, secret: null };
		let allowDismiss = false;
		const notices = [];
		const built = build([
			"installKey", "webhookSecretVisible", "copyOnceLifecycleActive",
			"blockCopyOnceNavigation", "dismissInstallSecret",
		], {
			S, KEYMODAL, WH, confirm: () => allowDismiss, renderView: () => {},
			toast: (message, bad) => notices.push({ message, bad }),
		});
		expect(built.installKey()).toBe("mcp-once");
		expect(built.copyOnceLifecycleActive()).toBe(true);
		expect(built.blockCopyOnceNavigation("switching projects")).toBe(true);
		built.dismissInstallSecret();
		expect(S.oneTimeToken.token).toBe("mcp-once");
		allowDismiss = true;
		built.dismissInstallSecret();
		expect(S.oneTimeToken).toBeNull();
		expect(built.copyOnceLifecycleActive()).toBe(false);
		expect(fnSource("projectSwitchBlocked")).toContain("installKey()");
		expect(fnSource("setView")).toContain("allowCopyOnce = false");
		expect(fnSource("onboardCreateLink")).toContain('setView("connect", { allowCopyOnce: true })');
		expect(fnSource("closeKeyModal")).toContain('setView("connect", { allowCopyOnce: true })');
		expect(fnSource("viewInstall")).toContain('onclick="dismissInstallSecret()"');
	});

	it("never renders a webhook secret outside the project epoch that created it", () => {
		const host = { hidden: true, innerHTML: "unchanged" };
		const S = { projectId: "proj_new", projectEpoch: 8, view: "webhooks" };
		const WH = {
			secret: { value: "old-secret", projectId: "proj_old", projectEpoch: 7 }, creating: false,
		};
		const notices = [];
		const built = build(["webhookSecretVisible", "showWebhookSecret", "closeWebhookSecret"], {
			S, WH, $: () => host, esc: (value) => String(value), ICON: { copy: "copy" },
			toast: (message) => notices.push(message), renderView: () => {},
		});
		expect(built.showWebhookSecret()).toBe(false);
		expect(host.innerHTML).toBe("unchanged");
		WH.secret = { value: "current-secret", projectId: "proj_new", projectEpoch: 8 };
		expect(built.showWebhookSecret()).toBe(true);
		expect(host.innerHTML).toContain("current-secret");
		expect(built.closeWebhookSecret()).toBe(false);
		expect(WH.secret.value).toBe("current-secret");
		expect(built.closeWebhookSecret({ explicit: true })).toBe(true);
		expect(WH.secret).toBeNull();
	});

	it("serializes every access mutation for the same person and sends the row revision", async () => {
		let resolveUpdate;
		const calls = [];
		const SET = {
			section: "project-members",
			data: {
				membership: { capabilities: ["project.members.manage", "org.members.manage"] },
				members: [{ user_id: "user_a", role: "viewer", revision: "project-r1" }],
				org_members: [{ user_id: "user_a", role: "member", revision: "org-r1" }],
			},
			targetMutationId: 0, targetMutations: new Map(),
		};
		const S = { projectId: "proj_a", projectEpoch: 4, view: "settings" };
		const built = build([
			"setCan", "setTargetMutationKey", "setTargetMutationFor", "setStartTargetMutation",
			"setOwnsTargetMutation", "setFinishTargetMutation", "setChangeProjectRole", "setChangeOrgRole",
		], {
			SET, S, renderSettingsSection: () => {}, loadSettings: async () => {},
			api: async (path, init) => { calls.push({ path, init }); return new Promise((resolve) => { resolveUpdate = resolve; }); },
			toast: () => {},
		});
		const pending = built.setChangeProjectRole("user_a", "admin");
		void built.setChangeOrgRole("user_a", "admin");
		expect(calls).toHaveLength(1);
		expect(calls[0].init.headers).toEqual({ "If-Match": "project-r1" });
		expect(JSON.parse(calls[0].init.body)).toEqual({ role: "admin" });
		resolveUpdate({ ok: true });
		await pending;
		expect(SET.targetMutations.size).toBe(0);
		for (const name of ["setChangeProjectRole", "setRemoveProjectMember", "setChangeOrgRole", "setRemoveOrgMember"]) {
			expect(fnSource(name), name).toContain('headers: { "If-Match": member.revision }');
		}
	});

	it("does not overwrite a visible invitation link and dismisses it explicitly", async () => {
		let allowed = false;
		let apiCalls = 0;
		const SET = {
			data: { membership: { capabilities: ["org.members.manage"] }, invitations: [] },
			inviteBusy: false,
			invite: { link: "https://invite/once", invitation: { id: "inv_a", email: "a@example.com", status: "pending" } },
			inviteForm: { email: "b@example.com", org_role: "member", project_role: "viewer" },
			targetMutations: new Map(),
		};
		const notices = [];
		const built = build(["setCan", "setTargetMutationKey", "setTargetMutationFor", "setSendInvite", "setDismissInvite"], {
			SET,
			document: { getElementById: () => null }, api: async () => { apiCalls++; },
			toast: (message) => notices.push(message), confirm: () => allowed,
			renderSettingsSection: () => {},
		});
		await built.setSendInvite();
		expect(apiCalls).toBe(0);
		expect(notices.at(-1)).toContain("visible invitation link first");
		built.setDismissInvite();
		expect(SET.invite.link).toContain("/once");
		allowed = true;
		built.setDismissInvite();
		expect(SET.invite).toBeNull();
		expect(SET.data.invitations).toEqual([expect.objectContaining({ id: "inv_a", status: "pending" })]);
		expect(fnSource("setOrgMembers")).toContain("Dismiss link");
		expect(fnSource("setOrgMembers")).toContain("Revoke invitation");
	});

	it("offers resend only for a live pending invitation and preserves the displayed access contract", () => {
		const now = Date.now();
		const SET = {
			data: {
				invitations: [
					{ id: "inv_live", email: "live@example.com", status: "pending", expires_at: now + 60_000, org_role: "member", project_role: "viewer" },
					{ id: "inv_expired", email: "expired@example.com", status: "pending", expires_at: now - 1, org_role: "member", project_role: "viewer" },
					{ id: "inv_accepted", email: "accepted@example.com", status: "accepted", expires_at: now + 60_000, org_role: "admin", project_role: "admin" },
					{ id: "inv_revoked", email: "revoked@example.com", status: "revoked", expires_at: now + 60_000, org_role: "member", project_role: null },
				],
				org_members: [],
			},
			invite: null,
			inviteBusy: false,
			inviteForm: { email: "", org_role: "member", project_role: "viewer", access_starts_at: "", access_duration: "never", access_expires_at: "" },
			targetMutations: new Map(),
		};
		const built = build(["setOrgMembers"], {
			SET,
			esc: (value) => String(value ?? ""),
			invitationDeliveryCopy: () => ({ kind: "", label: "Copy link only", detail: "Share the copy link." }),
			setTargetMutationFor: () => null,
			setLocked: () => "",
			inviteExpiryCopy: () => "expires soon",
			memberAccessWindow: () => ({ copy: "Immediately — no expiry" }),
			setMemberTable: () => "",
		});
		const rendered = built.setOrgMembers();
		expect(rendered).toContain("setResendInvite('inv_live')");
		expect(rendered).not.toContain("setResendInvite('inv_expired')");
		expect(rendered).not.toContain("setResendInvite('inv_accepted')");
		expect(rendered).not.toContain("setResendInvite('inv_revoked')");
		expect(rendered).toContain("organization role, project role and access dates do not change");
		SET.invite = {
			invitation: { ...SET.data.invitations[0] },
			link: "https://itsuki.app/app#invite=visible",
			email_delivery: { status: "copy_link_only" },
		};
		const visibleLinkLock = built.setOrgMembers();
		expect(visibleLinkLock).toContain(`onclick="setResendInvite('inv_live')" disabled title="Copy, dismiss, or revoke the visible invitation link first."`);
		SET.invite = null;
		SET.inviteBusy = true;
		const inFlightLock = built.setOrgMembers();
		expect(inFlightLock).toContain(`onclick="setResendInvite('inv_live')" disabled title="Another invitation link is being created."`);
	});

	it("routes resend through the existing copy-once state and blocks concurrent link lifecycles", async () => {
		let releaseApi;
		let loadCount = 0;
		const calls = [];
		const result = {
			invitation: {
				id: "inv_a", email: "a@example.com", status: "pending", expires_at: Date.now() + 86_400_000,
				org_role: "member", project_role: "viewer", access_starts_at: null, access_expires_at: null,
			},
			link: "https://itsuki.app/app#invite=copy-once",
			email_delivery: { status: "queued" },
		};
		const SET = {
			section: "org-members",
			data: {
				membership: { capabilities: ["org.members.manage"] },
				invitations: [{ ...result.invitation }],
			},
			invite: null,
			inviteBusy: false,
			inviteMutation: null,
			targetMutationId: 0,
			targetMutations: new Map(),
			busy: false,
		};
		const S = { projectId: "proj_a", projectEpoch: 3, view: "settings" };
		const built = build([
			"setCan", "setInviteLinkLifecycleActive", "setTargetMutationKey", "setTargetMutationFor",
			"setStartTargetMutation", "setOwnsTargetMutation", "setFinishTargetMutation",
			"setOwnsInviteMutation", "setMutationBusy", "setResendInvite",
		], {
			SET, S,
			api: (path, init) => {
				calls.push({ path, init });
				return new Promise((resolve) => { releaseApi = () => resolve(result); });
			},
			loadSettings: async () => { loadCount++; },
			renderSettingsSection: () => {},
			toast: () => {},
		});
		const pending = built.setResendInvite("inv_a");
		expect(calls).toEqual([{ path: "/v1/settings/invitations/inv_a/resend", init: { method: "POST" } }]);
		expect(SET.inviteBusy).toBe(true);
		expect(SET.targetMutations.get("invitation:inv_a")).toMatchObject({ action: "resend" });
		expect(built.setMutationBusy()).toBe(true);
		releaseApi();
		await pending;
		expect(SET.invite).toBe(result);
		expect(loadCount).toBe(1);
		expect(SET.inviteBusy).toBe(false);
		expect(SET.inviteMutation).toBeNull();
		expect(SET.targetMutations.size).toBe(0);
		expect(fnSource("setHasUnsavedWork")).toContain("Boolean(SET.invite)");
		expect(fnSource("projectSwitchBlocked")).toContain("setMutationBusy()");
		expect(script).toContain('window.addEventListener("beforeunload"');
	});

	it("fails resend closed for insufficient access, stale rows, visible links and HTTP errors", async () => {
		async function run({ capabilities = ["org.members.manage"], invitation, visible = null, failure = null }) {
			let apiCalls = 0;
			const notices = [];
			const SET = {
				section: "org-members",
				data: { membership: { capabilities }, invitations: invitation ? [invitation] : [] },
				invite: visible,
				inviteBusy: false,
				inviteMutation: null,
				targetMutationId: 0,
				targetMutations: new Map(),
			};
			const S = { projectId: "proj_a", projectEpoch: 1, view: "settings" };
			const built = build([
				"setCan", "setInviteLinkLifecycleActive", "setTargetMutationKey", "setTargetMutationFor",
				"setStartTargetMutation", "setOwnsTargetMutation", "setFinishTargetMutation",
				"setOwnsInviteMutation", "setResendInvite",
			], {
				SET, S,
				api: async () => { apiCalls++; throw failure ?? new Error("unexpected request"); },
				loadSettings: async () => {}, renderSettingsSection: () => {},
				toast: (message) => notices.push(message),
			});
			await built.setResendInvite(invitation?.id ?? "missing");
			return { SET, apiCalls, notices };
		}
		const live = { id: "inv_live", status: "pending", expires_at: Date.now() + 60_000 };
		const unauthorized = await run({ capabilities: [], invitation: live });
		expect(unauthorized.apiCalls).toBe(0);
		expect(unauthorized.notices.at(-1)).toContain("cannot resend");
		const terminal = await run({ invitation: { ...live, status: "accepted" } });
		expect(terminal.apiCalls).toBe(0);
		expect(terminal.notices.at(-1)).toContain("live pending invitation");
		const visible = await run({ invitation: live, visible: { invitation: live, link: "https://invite/once" } });
		expect(visible.apiCalls).toBe(0);
		expect(visible.notices.at(-1)).toContain("visible invitation link");
		const rejected = await run({ invitation: live, failure: new Error("Resend was refused") });
		expect(rejected.apiCalls).toBe(1);
		expect(rejected.notices.at(-1)).toBe("Resend was refused");
		expect(rejected.SET.invite).toBeNull();
		expect(rejected.SET.inviteBusy).toBe(false);
		expect(rejected.SET.inviteMutation).toBeNull();
		expect(rejected.SET.targetMutations.size).toBe(0);
	});

	it("ignores an older Settings refresh after a newer member snapshot lands", async () => {
		const pending = [];
		const SET = {
			loading: false, loadId: 0, invite: null, data: null, error: "",
			draft: null, baseline: null, draftSection: "", status: "", statusKind: "",
		};
		const S = { projectId: "proj_a", projectEpoch: 2, view: "settings", projectCapabilities: null };
		const built = build(["loadSettings"], {
			SET, S,
			api: () => new Promise((resolve) => pending.push(resolve)),
			updatePlaygroundVisibility: () => {}, toast: () => {}, renderView: () => {},
		});
		const oldLoad = built.loadSettings();
		const newLoad = built.loadSettings();
		pending[1]({ project: { name: "new" }, membership: { capabilities: [] } });
		await newLoad;
		pending[0]({ project: { name: "old" }, membership: { capabilities: [] } });
		await oldLoad;
		expect(SET.data.project.name).toBe("new");
		expect(SET.loading).toBe(false);
	});
});

describe("Project General form state", () => {
	function harness(apiImpl) {
		const SET = {
			section: "project-general",
			data: { project: { name: "Before", description: "Old", revision: "prv1.old" }, membership: { capabilities: ["project.edit"] } },
			draft: { name: "Before", description: "Old" },
			baseline: { name: "Before", description: "Old" },
			draftSection: "project-general",
			busy: false,
			mutationId: 0,
			mutation: null,
			status: "",
			statusKind: "",
			generalConflict: null,
		};
		const elements = {
			setProjName: { value: "  Canonical me  " },
			setProjDesc: { value: "Typed description" },
			setGeneralStatus: { textContent: "", dataset: {} },
			setGeneralSave: { disabled: false },
			setGeneralCancel: { disabled: false },
		};
		const calls = [];
		const api = apiImpl ?? (async (_path, init) => {
			calls.push({ path: _path, init });
			return { project: { name: "Canonical me", description: "Typed description", revision: "prv1.new" } };
		});
		const built = build([
			"setCan", "setClone", "setDraftDirty", "setStatus", "setSyncGeneralActions",
			"setGeneralValues", "setRevisionToken", "setHandleGeneralConflict", "setReadGeneralInputs",
			"setStartMutation", "setOwnsMutation", "saveProjectGeneral",
		], {
			SET,
			S: { projectId: "proj_current", projectEpoch: 4, view: "settings" },
			document: { getElementById: (id) => elements[id] ?? null },
			api,
			renderSettingsSection: () => {},
			refreshProjects: async () => {},
		});
		return { ...built, SET, elements, calls };
	}

	it("sends current inputs, adopts the canonical response, and ends idle", async () => {
		const h = harness();
		await h.saveProjectGeneral();
		expect(h.calls[0].path).toBe("/v1/settings/project");
		expect(h.calls[0].init.headers).toEqual({ "If-Match": "prv1.old" });
		expect(JSON.parse(h.calls[0].init.body)).toEqual({ name: "  Canonical me  ", description: "Typed description" });
		expect(h.SET.data.project).toEqual({ name: "Canonical me", description: "Typed description", revision: "prv1.new" });
		expect(h.SET.draft).toEqual({ name: "Canonical me", description: "Typed description" });
		expect(h.SET.baseline).toEqual(h.SET.draft);
		expect(h.SET.busy).toBe(false);
		expect(h.SET.status).toBe("Saved.");
		expect(h.SET.statusKind).toBe("success");
	});

	it("preserves the typed draft and reports a failed save honestly", async () => {
		const h = harness(async () => { throw new Error("Conflict: reload first."); });
		await h.saveProjectGeneral();
		expect(h.SET.draft).toEqual({ name: "  Canonical me  ", description: "Typed description" });
		expect(h.SET.busy).toBe(false);
		expect(h.SET.status).toBe("Conflict: reload first.");
		expect(h.SET.statusKind).toBe("error");
	});

	it("ignores a save response after its Settings scope is invalidated", async () => {
		let resolveSave;
		const h = harness(() => new Promise((resolve) => { resolveSave = resolve; }));
		const pending = h.saveProjectGeneral();
		expect(h.SET.busy).toBe(true);
		h.SET.mutation = null;
		h.SET.section = "project-members";
		h.SET.data.project = { name: "New scope", description: "Do not overwrite" };
		resolveSave({ project: { name: "Late old scope", description: "Stale", revision: "prv1.late" } });
		await pending;
		expect(h.SET.data.project).toEqual({ name: "New scope", description: "Do not overwrite" });
		expect(h.SET.section).toBe("project-members");
	});

	it("retains a stale project draft and requires an explicit rebase", async () => {
		const conflict = new Error("Project changed elsewhere.");
		Object.assign(conflict, {
			status: 412, code: "project_conflict",
			body: { project: { name: "Remote", description: "Current", revision: "prv1.remote" } },
		});
		const h = harness(async () => { throw conflict; });
		await h.saveProjectGeneral();
		expect(h.SET.draft).toEqual({ name: "  Canonical me  ", description: "Typed description" });
		expect(h.SET.data.project.revision).toBe("prv1.remote");
		expect(h.SET.baseline).toEqual({ name: "Remote", description: "Current" });
		expect(h.SET.generalConflict).toMatchObject({ scope: "project", record: { revision: "prv1.remote" } });
		expect(h.SET.status).toContain("draft is unchanged");
	});

	it("renders Save, Cancel, live status, and canonical response adoption for both scopes", () => {
		for (const name of ["setProjectGeneral", "setOrgGeneral"]) {
			const source = fnSource(name);
			expect(source).toContain('id="setGeneralSave"');
			expect(source).toContain('id="setGeneralCancel"');
			expect(source).toContain('aria-live="polite"');
		}
		for (const name of ["saveProjectGeneral", "saveOrgGeneral"]) {
			const source = fnSource(name);
			expect(source).toContain('headers: { "If-Match": revision }');
			expect(source).toContain("setStartMutation(");
			expect(source).toContain("setOwnsMutation(mutation)");
			expect(source).toContain("SET.baseline = setGeneralValues(");
			expect(source).toContain('setStatus("Saved.", "success")');
		}
		expect(fnSource("saveExtractionRules")).toContain('setStartMutation("project-extraction")');
		expect(fnSource("setSendInvite")).toContain("setOwnsInviteMutation(mutation)");
	});
});

describe("Stage 3 enterprise Settings UI", () => {
	it("creates a project only inside the verified selected organization", async () => {
		const PROJECT_CREATE = { open: true, busy: false, name: "", description: "", error: "" };
		const SET = { data: { project: { id: "proj_current" }, organization: { id: "org_a", name: "Acme" } } };
		const S = {
			projectId: "proj_current", projectEpoch: 2,
			projects: [{ id: "proj_current", organization_id: "org_a" }],
			projectCapabilities: null,
		};
		const fields = {
			projectModalName: { value: "Production" },
			projectModalDescription: { value: "Customer-facing memory" },
		};
		const calls = [];
		let switched = "";
		const built = build([
			"selectedManagedProject", "selectedOrganizationId", "submitProjectModal",
		], {
			PROJECT_CREATE, SET, S,
			document: { getElementById: (id) => fields[id] ?? null },
			requireProjectCapability: () => true,
			api: async (path, init) => {
				calls.push({ path, init });
				return { project: { id: "proj_new", name: "Production", organization_id: "org_a" } };
			},
			refreshProjects: async () => {}, renderProjectModal: () => {}, restoreModalOpener: () => {},
			switchManagedProject: async (id) => { switched = id; }, toast: () => {},
		});
		await built.submitProjectModal();
		expect(calls).toHaveLength(1);
		expect(calls[0].path).toBe("/auth/projects");
		expect(JSON.parse(calls[0].init.body)).toEqual({
			name: "Production", description: "Customer-facing memory", organization_id: "org_a",
		});
		expect(switched).toBe("proj_new");
		expect(PROJECT_CREATE.open).toBe(false);
	});

	it("uses organization CAS and preserves its draft on a structured conflict", async () => {
		const SET = {
			section: "org-general",
			data: {
				organization: { name: "Before", description: "Old", revision: "orv1.old" },
				membership: { capabilities: ["org.edit"] },
			},
			draft: { name: "Before", description: "Old" }, baseline: { name: "Before", description: "Old" },
			draftSection: "org-general", busy: false, mutationId: 0, mutation: null,
			status: "", statusKind: "", generalConflict: null,
		};
		const elements = {
			setOrgName: { value: "Local name" }, setOrgDesc: { value: "Local description" },
			setGeneralStatus: { textContent: "", dataset: {} },
			setGeneralSave: { disabled: false }, setGeneralCancel: { disabled: false },
		};
		const calls = [];
		const conflict = new Error("Organization changed elsewhere.");
		Object.assign(conflict, {
			status: 412, code: "organization_conflict",
			body: { organization: { name: "Remote", description: "Current", revision: "orv1.remote" } },
		});
		const built = build([
			"setCan", "setClone", "setDraftDirty", "setStatus", "setSyncGeneralActions", "setGeneralValues",
			"setRevisionToken", "setHandleGeneralConflict", "setReadGeneralInputs", "setStartMutation",
			"setOwnsMutation", "saveOrgGeneral",
		], {
			SET, S: { projectId: "proj_a", projectEpoch: 1, view: "settings" },
			document: { getElementById: (id) => elements[id] ?? null }, renderSettingsSection: () => {},
			api: async (path, init) => { calls.push({ path, init }); throw conflict; },
		});
		await built.saveOrgGeneral();
		expect(calls[0].path).toBe("/v1/settings/organization");
		expect(calls[0].init.headers).toEqual({ "If-Match": "orv1.old" });
		expect(SET.draft).toEqual({ name: "Local name", description: "Local description" });
		expect(SET.data.organization.revision).toBe("orv1.remote");
		expect(SET.generalConflict).toMatchObject({ scope: "organization" });
	});

	it("shows a human organization owner while keeping the immutable id secondary", () => {
		const render = fnSource("setOrgGeneral");
		expect(render).toContain("org.owner?.name || org.owner?.email");
		expect(render).toContain("ownerEmail");
		expect(render).toContain("immutable id");
		expect(render).toContain("projectOrganizationId(project)");
		const projectRender = fnSource("setProjectGeneral");
		expect(projectRender).toContain("SET.data.organization?.owner");
		expect(projectRender).toContain("organizationOwner?.name || organizationOwner?.email");
		expect(projectRender).not.toContain("SET.data.organization?.owner_user_id || \"Unavailable\"");
	});

	it("preserves invitation tokens across password and OAuth authentication without durable storage", () => {
		const location = { hash: "#invite=once%2Btoken", pathname: "/app", search: "", href: "" };
		const historyCalls = [];
		const sessionValues = new Map();
		const S = { me: null };
		const built = build([
			"invitationTokenFromHash", "routeMode", "pushUrl", "startGoogle",
		], {
			location, history: { pushState: (_state, _title, url) => historyCalls.push(url) },
			sessionStorage: { setItem: (key, value) => sessionValues.set(key, value) }, S,
		});
		expect(built.routeMode()).toBe("login");
		built.pushUrl("/signup");
		expect(historyCalls.at(-1)).toBe("/signup#invite=once%2Btoken");
		built.startGoogle();
		expect(sessionValues.get("itsuki_pending_invite")).toBe("once+token");
		expect(location.href).toBe("/auth/google/start");
		expect(fnSource("startGoogle")).not.toContain('localStorage.setItem("itsuki_pending_invite"');
	});

	it("describes, rejects wrong-account redemption honestly, and switches after acceptance", async () => {
		const INVITE_ACCEPT = {
			token: "", loading: false, accepting: false, detail: null, error: "", reason: "", done: false,
		};
		const S = { me: { user: { id: "user_a" } }, projects: [], view: "overview" };
		const location = { hash: "#invite=secret" };
		const calls = [];
		const historyCalls = [];
		let switched = "";
		let mode = "describe";
		const api = async (path, init) => {
			calls.push({ path, init });
			if (mode === "describe") return {
				ok: true, organization: "Acme", account_matches: true, org_role: "member", project_role: "viewer",
			};
			if (mode === "wrong") {
				const error = new Error("Wrong account");
				error.body = { reason: "wrong_account", message: "Sign in with member@example.com." };
				throw error;
			}
			return { ok: true, org_id: "org_a", project_id: "proj_b" };
		};
		const built = build([
			"invitationTokenFromHash", "invitationReasonCopy", "beginInvitationRedemption", "acceptInvitationNow",
		], {
			INVITE_ACCEPT, S, location, api,
			sessionStorage: { getItem: () => "", removeItem: () => {} },
			history: { replaceState: (_state, _title, url) => historyCalls.push(url) },
			APP_VIEWS: new Set(["overview"]), renderInvitationModal: () => {},
			refreshProjects: async () => { S.projects = [{ id: "proj_b" }]; },
			switchManagedProject: async (id) => { switched = id; }, loadSettings: async () => {},
		});
		await built.beginInvitationRedemption();
		expect(JSON.parse(calls[0].init.body)).toEqual({ token: "secret" });
		expect(calls[0].init.projectBound).toBe(false);
		expect(INVITE_ACCEPT.detail.organization).toBe("Acme");

		mode = "wrong";
		await built.acceptInvitationNow();
		expect(INVITE_ACCEPT.reason).toBe("wrong_account");
		expect(INVITE_ACCEPT.error).toContain("another email address");
		expect(INVITE_ACCEPT.error).not.toContain("member@example.com");
		expect(switched).toBe("");

		mode = "accept";
		INVITE_ACCEPT.error = "";
		await built.acceptInvitationNow();
		expect(INVITE_ACCEPT.done).toBe(true);
		expect(switched).toBe("proj_b");
		expect(historyCalls.at(-1)).toBe("/app#overview");
	});

	it("keeps Settings responsive, keyboard reachable, and role explanations explicit", () => {
		expect(html).toContain("@media (max-width: 980px)");
		expect(html).toContain("@media (max-width: 640px)");
		expect(fnSource("viewSettings")).toContain('if(setSection(this.value)===false)this.value=SET.section');
		expect(fnSource("setSection")).toContain("return false");
		expect(fnSource("trapModalFocus")).toContain('event.key !== "Tab"');
		expect(fnSource("setProjectMembers")).toContain("Viewer");
		expect(fnSource("setOrgMembers")).toContain("Organization roles");
		expect(fnSource("setProjectExtraction")).toContain("Credential, request, and Playground rules may narrow");
		expect(html).toContain('--font-ui: "Fustat"');
	});

	it("separates Appearance and presents integrations from the real project APIs", () => {
		expect(script).toContain('["project-integrations", "Integrations"]');
		expect(script).toContain('["personal-appearance", "Appearance"]');
		expect(fnSource("viewSettingsMain")).not.toContain("Appearance theme");
		expect(fnSource("setPersonalAppearance")).toContain("setAppearancePicker()");
		const render = fnSource("setProjectIntegrations");
		expect(render).toContain('setCan("project.keys.view")');
		expect(render).toContain('setCan("project.integrations.view")');
		expect(render).toContain("Delivery health");
		expect(render).toContain("healthUnavailable");
		const load = fnSource("loadSettingsIntegrations");
		expect(load).toContain('api("/auth/tokens")');
		expect(load).toContain('api("/v1/webhooks")');
		expect(load).toContain("/deliveries");
		expect(load).toContain("loadId !== SET.integrationsLoadId");
		expect(fnSource("setOpenIntegrationSurface")).toContain("if (!setCan(capability))");
		expect(fnSource("settingsIntegrationHealth")).toContain('deliveries === null');
		expect(load).toContain("return [webhook.id, null]");
	});

	it("renders only the server-masked webhook endpoint", () => {
		const display = build(["webhookDisplayUrl"], {}).webhookDisplayUrl;
		const raw = "https://hooks.example.test/tenant/private-token?signature=secret";
		const masked = "https://hooks.example.test/tenant/...";
		expect(display({ url: raw, display_url: masked })).toBe(masked);
		expect(display({ url: raw })).toBe("Endpoint hidden");
		expect(display({ url: raw })).not.toContain("private-token");
		expect(fnSource("renderWebhooksTable")).toContain("webhookDisplayUrl(w)");
		expect(fnSource("setProjectIntegrations")).toContain("webhookDisplayUrl(webhook)");
		expect(fnSource("renderWebhooksTable")).not.toContain("w.url");
		expect(fnSource("setProjectIntegrations")).not.toContain("webhook.url");
	});

	it("models bounded temporal access and the effective org/project intersection", () => {
		const ACCESS_DAY_MS = 86_400_000;
		const ACCESS_MAX_HORIZON_MS = 10 * 366 * ACCESS_DAY_MS;
		const built = build(["dateTimeLocalMs", "accessWindowFromForm", "memberAccessWindow"], {
			ACCESS_DAY_MS, ACCESS_MAX_HORIZON_MS,
			ACCESS_PRESET_DAYS: new Set(["30", "90", "180", "365"]), fmtDate: (value) => String(value),
		});
		const now = Date.now();
		const preset = built.accessWindowFromForm({ access_starts_at: "", access_duration: "90", access_expires_at: "" }, now);
		expect(preset).toEqual({ access_starts_at: null, access_expires_at: now + 90 * ACCESS_DAY_MS, error: "" });
		expect(built.accessWindowFromForm({
			access_starts_at: "2030-01-02T00:00", access_duration: "custom", access_expires_at: "2030-01-01T00:00",
		}, now).error).toContain("after it starts");
		const effective = built.memberAccessWindow(
			{ role: "member", access_starts_at: now - 1000, access_expires_at: now + 10_000 },
			{ role: "member", access_starts_at: now - 2000, access_expires_at: now + 5_000 },
		);
		expect(effective.status).toBe("active");
		expect(effective.end).toBe(now + 5_000);
		const send = fnSource("setSendInvite");
		expect(send).toContain("access_starts_at: window.access_starts_at");
		expect(send).toContain("access_expires_at: window.access_expires_at");
		const save = fnSource("saveMemberAccess");
		expect(save).toContain('headers: { "If-Match": editor.revision }');
		expect(save).toContain("access_starts_at: window.access_starts_at");
		expect(save).toContain("access_expires_at: window.access_expires_at");
		expect(fnSource("setHasUnsavedWork")).toContain("Boolean(SET.accessEditor)");
	});

	it("lets project admins add only existing active organization members", () => {
		const picker = fnSource("setOpenProjectMemberPicker");
		expect(picker).toContain('setCan("project.members.manage")');
		expect(picker).not.toMatch(/if\s*\(\s*!?setCan\("org\.members\.manage"\)\s*\)\s*return/);
		const eligible = fnSource("setEligibleProjectMembers");
		expect(eligible).toContain('member.role === "member"');
		expect(eligible).toContain('["active", "permanent"]');
		expect(eligible).toContain("!assigned.has(member.user_id)");
		const add = fnSource("setAddProjectMember");
		expect(add).toContain('api("/v1/settings/members"');
		expect(add).toContain("user_id: picker.user_id");
		expect(add).toContain("access_starts_at: window.access_starts_at");
		expect(add).toContain("access_expires_at: window.access_expires_at");
		expect(fnSource("setContextActions")).toContain("Add organization member");
	});

	it("fails closed when a signed-in account does not match an invitation", () => {
		const render = fnSource("renderInvitationModal");
		expect(render).toContain('detail.account_matches === false ? "inviteAcceptClose" : "inviteAcceptButton"');
		const accept = fnSource("acceptInvitationNow");
		expect(accept).toContain("INVITE_ACCEPT.detail.account_matches === false");
	});

	it("uses the governed category contract instead of prompt-driven fake controls", () => {
		expect(script).not.toContain('prompt("Category name');
		expect(fnSource("setContextActions")).toContain("setOpenCategoryEditor()");
		const render = fnSource("setProjectCategories");
		expect(render).toContain("Search categories");
		expect(render).toContain("setCategoryUsage(category)");
		expect(render).toContain("category.color_token");
		expect(render).toContain("separate from the Graph's cluster colour");
		expect(render).toContain("setDeleteCategory");
		const modal = fnSource("renderCategorySettingsModal");
		expect(modal).toContain("maxlength=\"40\"");
		expect(modal).toContain("maxlength=\"160\"");
		expect(modal).toContain("set-color-grid");
		expect(modal).toContain("Uncategorized");
		expect(fnSource("setCategoryPalette")).toContain("category_color_tokens");
	});

	it("protects category edits and lifecycle operations with canonical CAS", () => {
		const save = fnSource("saveCategoryEditor");
		expect(save).toContain('headers: editor.mode === "edit" ? { "If-Match": editor.revision }');
		expect(save).toContain("result.category.revision");
		expect(save).toContain('error.status === 412 && error.code === "category_conflict"');
		expect(save).toContain("SET.categoryEditor.conflict = error.body.category");
		const archive = fnSource("setArchiveCategory");
		expect(archive).toContain("setCategoryUsage(category).total > 0");
		expect(archive).toContain("setOpenCategoryReassignment(categoryId, \"archive\")");
		expect(archive).toContain('{ "If-Match": category.revision }');
		const remove = fnSource("setDeleteCategory");
		expect(remove).toContain("setOpenCategoryReassignment(categoryId, \"delete\")");
		expect(remove).toContain('error.code === "category_in_use"');
		const reassign = fnSource("saveCategoryReassignment");
		expect(reassign).toContain("/reassign");
		expect(reassign).toContain("target_category_id: editor.target_category_id || null");
		expect(reassign).toContain("editor.revision = reassigned.category.revision");
		expect(reassign).toContain('{ "If-Match": editor.revision }');
		expect(fnSource("setTargetMutationKey")).toContain('kind === "category" ? "category"');
	});

	it("scopes category drafts and modal lifecycle to the selected project", () => {
		expect(fnSource("setHasUnsavedWork")).toContain("setCategoryEditorDirty()");
		const clear = fnSource("setClearTransient");
		expect(clear).toContain("categoryEditor: null");
		expect(clear).toContain('categorySearch: ""');
		expect(fnSource("closeSettingsModal")).toContain("SET.categoryEditor?.busy");
		expect(fnSource("renderSettingsModal")).toContain("renderCategorySettingsModal(host, categoryEditor)");
	});

	it("keeps a category draft intact when a stale editor receives the canonical row", async () => {
		const SET = {
			categoryEditor: {
				mode: "edit", categoryId: "cat_1", revision: "crv1.old", name: "Local name",
				description: "Local description", color_token: "violet", baseline: {}, busy: false, error: "", conflict: null,
			},
		};
		const canonical = { id: "cat_1", revision: "crv1.new", name: "Remote name", description: "Remote", color_token: "blue" };
		const conflict = Object.assign(new Error("conflict"), {
			status: 412, code: "category_conflict", body: { category: canonical },
		});
		const mutation = {};
		const built = build(["saveCategoryEditor"], {
			SET,
			document: { getElementById: (id) => ({ value: id === "setCategoryName" ? "Local name" : "Local description" }) },
			setCan: () => true,
			setStartTargetMutation: () => mutation,
			renderSettingsModal: () => {},
			api: async () => { throw conflict; },
			setOwnsTargetMutation: () => true,
			setUpsertCategory: () => {},
			restoreModalOpener: () => {},
			toast: () => {},
			setFinishTargetMutation: () => {},
			S: { view: "settings" },
			renderSettingsSection: () => {},
		});
		await built.saveCategoryEditor();
		expect(SET.categoryEditor.name).toBe("Local name");
		expect(SET.categoryEditor.description).toBe("Local description");
		expect(SET.categoryEditor.conflict).toEqual(canonical);
		expect(SET.categoryEditor.busy).toBe(false);
	});

	it("wires retention as seven separate, admin-only policies with content-free runs", () => {
		expect(script).toContain('["project-retention", "Retention"]');
		const render = fnSource("setProjectRetention");
		expect(render).toContain('setCan("project.retention.view")');
		expect(render).toContain('setCan("project.retention.manage")');
		expect(render).toContain("storage-lane names only - never memory or transcript content");
		expect(render).toContain("setProcessRetentionRun");
		const load = fnSource("loadRetentionSettings");
		expect(load).toContain('api("/v1/settings/retention?limit=25")');
		expect(load).toContain("projectEpoch !== S.projectEpoch");
		expect(load).toContain("loadId !== SET.retentionLoadId");
	});

	it("keeps the privacy copy aligned with the class-aware retention contract", () => {
		expect(html).toContain("Project data:</b> follows the active policy for its data class");
		expect(html).toContain("Operational records:</b> receipts and jobs follow the selected project's operational-records policy");
		expect(html).toContain("Security and audit records:</b> governed separately from memory retention");
		expect(html).toContain("Sessions:</b> stop authorizing access when they expire or are revoked");
		expect(html).not.toContain("Security logs and receipts:</b> retained up to 12 months");
		expect(html).not.toContain("Memory content:</b> kept until you delete it");
		expect(html).not.toContain("session rows are pruned thereafter");
		expect(html).toContain("short-lived first-party OAuth state cookie");
		expect(html).not.toContain("We use exactly one cookie");
	});

	it("requires a verified retention preview, exact confirmation, and policy version", () => {
		const preview = fnSource("previewRetentionPolicy");
		expect(preview).toContain('api("/v1/settings/retention/preview"');
		expect(preview).toContain("expected_version: editor.expected_version");
		expect(preview).toContain("result.preview.mutation_free !== true");
		const apply = fnSource("applyRetentionPolicy");
		expect(apply).toContain('api("/v1/settings/retention"');
		expect(apply).toContain('method: "PUT"');
		expect(apply).toContain("preview_cutoff_at: editor.preview.cutoff_at");
		expect(apply).toContain("preview_inventory_hash: editor.preview.inventory_hash");
		expect(apply).toContain("editor.confirmation !== RETENTION_CONFIRMATION");
		expect(apply).toContain("result.policy.version");
		expect(fnSource("setProcessRetentionRun")).toContain('api("/v1/settings/retention/process"');
	});

	it("preserves a chosen retention lifetime across a stale-policy conflict", () => {
		const SET = {
			retention: { policies: [{ class: "source_episodes", days: null, version: 1 }], runs: [] },
			retentionEditor: {
				class: "source_episodes", choice: "30", custom_days: "", expected_version: 1,
				current_days: null, preview: { inventory_hash: "old" }, confirmation: "APPLY RETENTION", conflict: null, error: "",
			},
		};
		const built = build(["setRetentionPolicy", "setHandleRetentionConflict"], { SET });
		const handled = built.setHandleRetentionConflict({
			status: 412, code: "retention_conflict",
			body: { current: { class: "source_episodes", days: 90, version: 2 } },
		});
		expect(handled).toBe(true);
		expect(SET.retentionEditor.choice).toBe("30");
		expect(SET.retentionEditor.expected_version).toBe(2);
		expect(SET.retentionEditor.preview).toBe(null);
		expect(SET.retentionEditor.confirmation).toBe("");
	});

	it("reports invitation email transport honestly while always retaining the link", () => {
		const built = build(["invitationDeliveryCopy"], {});
		expect(built.invitationDeliveryCopy({ status: "sent" })).toMatchObject({ label: "Sent" });
		expect(built.invitationDeliveryCopy({ status: "sent" }).detail).toContain("Mailbox delivery is not guaranteed");
		expect(built.invitationDeliveryCopy({ status: "queue_failed" }).detail).toContain("Share the copy link");
		expect(fnSource("invitationDeliveryCopy")).not.toContain("Delivered");
		const members = fnSource("setOrgMembers");
		expect(members).toContain("invitationDeliveryCopy");
		expect(members).toContain("SET.invite.link");
		expect(members).toContain("Email is a delivery aid, not the authority");
	});

	it("groups the project chooser by organization and searches collaborator context", () => {
		const render = fnSource("renderProjectMenu");
		expect(render).toContain("projectOrganizationId(project)");
		expect(render).toContain("projectOrganization(project)");
		expect(render).toContain("project.description");
		expect(render).toContain("project.organization_name");
		expect(render).toContain('class="project-group"');
		expect(render).toContain("project-option-description");
		expect(render).toContain("Description is context only; it does not change extraction or access.");
		expect(render).toContain("openOrganizationModal()");
		expect(fnSource("refreshProjects")).toContain('api("/auth/organizations", { projectBound: false })');
		expect(fnSource("renderProjectSwitcher")).toContain("The description is collaborator context only");
	});

	it("creates an organization atomically and enters only its verified starter project", async () => {
		const ORG_CREATE = { open: true, busy: false, name: "", description: "", error: "" };
		const S = { projects: [] };
		const fields = {
			projectModalName: { value: "Acme AI" },
			projectModalDescription: { value: "Shared customer context" },
		};
		const calls = [];
		let switched = "";
		const built = build(["projectOrganizationId", "submitOrganizationModal"], {
			ORG_CREATE, S,
			document: { getElementById: (id) => fields[id] ?? null },
			renderProjectModal: () => {}, restoreModalOpener: () => {}, toast: () => {},
			api: async (path, init) => {
				calls.push({ path, init });
				return {
					organization: { id: "org_new", name: "Acme AI" },
					project: { id: "proj_starter", effective_organization_id: "org_new" },
				};
			},
			refreshProjects: async () => { S.projects = [{ id: "proj_starter", effective_organization_id: "org_new" }]; },
			switchManagedProject: async (id) => { switched = id; },
		});
		await built.submitOrganizationModal();
		expect(calls).toHaveLength(1);
		expect(calls[0].path).toBe("/auth/organizations");
		expect(calls[0].init.projectBound).toBe(false);
		expect(JSON.parse(calls[0].init.body)).toEqual({ name: "Acme AI", description: "Shared customer context" });
		expect(switched).toBe("proj_starter");
		expect(ORG_CREATE.open).toBe(false);
		expect(ORG_CREATE.busy).toBe(false);
	});

	it("contains project and organization creation across keyboard and history navigation", () => {
		expect(fnSource("closeProjectModal")).toContain("PROJECT_CREATE.busy || ORG_CREATE.busy");
		expect(fnSource("projectSwitchBlocked")).toContain("ORG_CREATE.busy");
		expect(fnSource("setView")).toContain("blockProjectCreateNavigation(");
		expect(fnSource("handlePopState")).toContain("blockProjectCreateNavigation(");
		expect(fnSource("installKeyGuard")).toContain("!PROJECT_CREATE.open && !ORG_CREATE.open");
		expect(script).toContain('modal?.id === "projectModal"');
		expect(fnSource("submitOrganizationModal")).toContain("if (ORG_CREATE.busy) return");
	});

	it("keeps cluster identity while rendering a bounded project-category accent", () => {
		const graphNode = fnSource("graphNode");
		const graphPage = fnSource("graphPage");
		const graphCandidate = fnSource("graphCandidate");
		for (const source of [graphNode, graphPage, graphCandidate]) {
			expect(source).toContain("projectCategoryColor(");
			expect(source).toContain("clusterColor: color");
			expect(source).toContain("border: accent");
		}
		expect(fnSource("projectCategoryToken")).toContain("CATEGORY_TOKEN_COLORS");
		expect(fnSource("projectCategoryColor")).toContain("categoryTokenColor(token)");
		expect(fnSource("projectCategoryBadge")).not.toContain("item.project_category.color");
		expect(fnSource("drawGraph")).toContain("Outlined rings show project categories");
		expect(fnSource("drawGraph")).toContain("Project category accent; cluster grouping is unchanged");
		for (const source of [fnSource("filteredPages"), fnSource("filteredNodes")]) {
			expect(source).toContain("project_category?.name");
			expect(source).toContain("project_category?.slug");
		}
		expect(fnSource("renderDetail")).toContain("projectCategoryBadge(n)");
		expect(fnSource("renderPageDetail")).toContain("projectCategoryBadge(p)");
	});

	it("paginates, filters and independently gates content-free audit CSV", () => {
		const render = fnSource("setProjectAudit");
		expect(render).toContain("setAuditAction");
		expect(render).toContain("setAuditFrom");
		expect(render).toContain("setAuditTo");
		expect(render).toContain("SET.audit?.next_cursor");
		expect(render).toContain("loadAuditPage({ append: true })");
		expect(render).toContain('setCan("project.audit.export")');
		expect(render).toContain("Request ID");
		expect(render).toContain("e.request_id");
		expect(render).toContain("Request ID copied");
		expect(fnSource("setAuditFilterQuery")).toContain('params.set("cursor", cursor)');
		const load = fnSource("loadAuditPage");
		expect(load).toContain("SET.auditLoadId");
		expect(load).toContain("...(SET.audit?.events ?? [])");
		const download = fnSource("downloadAuditCsv");
		expect(download).toContain('setCan("project.audit.export")');
		expect(download).toContain("/v1/settings/audit/export?");
		expect(download).toContain('headers: { "x-itsuki-project": projectId }');
		expect(download).toContain("x-itsuki-export-truncated");
	});

	it("describes inherited organization-admin access instead of stale project rows", () => {
		const { effectiveProjectRole } = build(["effectiveProjectRole"], {});
		expect(effectiveProjectRole({ org_role: "admin", project_role: "viewer" }))
			.toBe("organization admin");
		expect(fnSource("memberAccessWindow")).toContain("Inherited organization admin access");
		const members = fnSource("setOrgMembers");
		expect(members).toContain("every project through organization admin");
		expect(members).toContain("Organization admins already reach every project");
	});

	it("includes free-text extraction guidance in CAS, conflict review and dry runs", () => {
		expect(fnSource("setRuleValues")).toContain('customInstructions: String(rules.customInstructions ?? "")');
		const render = fnSource("setProjectExtraction");
		expect(render).toContain('id="setCustomInstructions"');
		expect(render).toContain('maxlength="4000"');
		expect(render).toContain("may be missed");
		expect(render).toContain("rules_metadata");
		expect(render).toContain("Policy version");
		expect(fnSource("setRulesConflictPanel")).toContain("saved.customInstructions");
		expect(fnSource("setRunPreview")).toContain('customInstructions: SET.draft?.customInstructions ?? ""');
		const save = fnSource("saveExtractionRules");
		expect(save).toContain("const payload = setClone(SET.draft)");
		expect(save).toContain("metadataVersion !== nextVersion");
		expect(save).toContain("SET.data.rules_metadata = res.rules_metadata");
	});

	it("renders the project-wide key inventory with privacy-safe member ownership", () => {
		const view = fnSource("viewKeys");
		expect(view).toContain("project-wide key inventory");
		expect(view).toContain("review and remove keys created by other members");
		const table = fnSource("renderKeysTable");
		expect(table).toContain("t.owner?.name || t.owner?.email");
		expect(table).toContain("Unknown member");
		expect(table).toContain('colspan="7"');
	});

	it("shows deterministic admission plus bounded no-write category proposals", () => {
		expect(html).toContain("A future verified workflow will permanently delete this project");
		expect(html).not.toContain("Permanently deletes this project and everything in it");
		expect(html).toContain("optional no-write category preview");
		expect(html).toContain("Preview samples are not written to Itsuki memory");
		expect(html).toContain("Thirty days after an invitation becomes accepted, revoked, or expired");
		expect(html).toContain("provider message identifier");
		const render = fnSource("setProjectExtraction");
		expect(render).toContain('row.kept ? "Allow" : `Deny:');
		expect(render).toContain("setPreviewCategoryCopy(row)");
		expect(render).toContain("one bounded model call proposes a governed filing category");
		expect(render).toContain("never creates a memory, source packet, receipt, usage record, or graph item");
		expect(render).toContain("SET.previewBusy");
		expect(render).toContain("SET.previewActiveCategoryCount");
		const copy = fnSource("setPreviewCategoryCopy");
		expect(copy).toContain("not_evaluated_blocked");
		expect(copy).toContain("model_proposed");
		expect(copy).toContain("no_clear_category");
		expect(copy).toContain("preview_unavailable");
		expect(copy).toContain("no_active_categories");
		const run = fnSource("setRunPreview");
		expect(run).toContain('!setCan("project.rules.edit")');
		expect(run).toContain("loadId !== SET.previewLoadId");
		expect(run).toContain("projectEpoch !== S.projectEpoch");
		expect(run).toContain("res.active_category_count");
		expect(run).toContain("SET.preview = res.results");
	});
});
