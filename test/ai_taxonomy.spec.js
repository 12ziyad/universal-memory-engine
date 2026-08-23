/**
 * Routing taxonomy, made honest at both doors.
 *
 *   Cross-provider inference fallback is not implemented and therefore is
 *   not writable or advertised for any lane. Historical rows fail closed.
 *   admission_reroute remains new-run-only, at claim time, on the durable pin.
 *   Space-bound lanes can never reach a foreign space automatically.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { legalModesFor, resetPolicyCacheForTests, resolveRoute, ROUTING_MODES, validatePolicyWrite } from "../src/ai/policy.js";
import { applyPolicyChange } from "../src/ai/admin.js";
import { dispatchAi } from "../src/ai/dispatch.js";

beforeEach(() => resetPolicyCacheForTests());

describe("policy legality matrix", () => {
	it("retired fallback modes are absent and rejected for every lane class", () => {
		const retired = ["cf_primary_google_fallback", "google_primary_cf_fallback"];
		for (const mode of retired) expect(ROUTING_MODES).not.toContain(mode);
		for (const lane of ["extract", "rerank", "embed", "playground_chat"]) {
			for (const mode of retired) {
				expect(legalModesFor(lane)).not.toContain(mode);
				expect(validatePolicyWrite(lane, { mode })).toContain(`unknown mode ${mode}`);
			}
		}
	});

	it("embedding lanes are space-bound and do not advertise an unimplemented shadow experiment", () => {
		for (const lane of ["embed", "embed_profile"]) {
			expect(legalModesFor(lane)).toEqual(["cloudflare_only"]);
			expect(validatePolicyWrite(lane, { mode: "google_only" }).length).toBeGreaterThan(0);
			expect(validatePolicyWrite(lane, {
				mode: "shadow",
				shadow_provider: "google-vertex",
				shadow_model: "gemini-embedding-001",
			}).length).toBeGreaterThan(0);
		}
	});

	it("ad-hoc and retry-unsafe interactive lanes stay Cloudflare-only", () => {
		for (const lane of ["manual_router", "mcp_title", "rules_category_preview", "playground_preview", "playground_chat"]) {
			expect(legalModesFor(lane)).toEqual(["cloudflare_only"]);
			expect(validatePolicyWrite(lane, { mode: "google_only" })).not.toEqual([]);
		}
	});

	it("an illegally stored playground route cannot admit a billable provider on request replay", async () => {
		await env.DB.prepare(
			`INSERT INTO ai_routing_policies (capability, mode, primary_provider, primary_model, updated_at, updated_by)
			 VALUES ('playground_chat', 'google_only', 'google-vertex', 'gemini-2.5-flash-lite', ?, 'smuggled')
			 ON CONFLICT(capability) DO UPDATE SET
			   mode='google_only', primary_provider='google-vertex', primary_model='gemini-2.5-flash-lite', disabled=0`,
		).bind(Date.now()).run();
		resetPolicyCacheForTests();
		const onEnv = Object.assign(Object.create(Object.getPrototypeOf(env)), env, { AI_ROUTING: "on" });
		const first = await resolveRoute(onEnv, "playground_chat", {});
		resetPolicyCacheForTests();
		const replay = await resolveRoute(onEnv, "playground_chat", {});
		expect(first).toMatchObject({ provider: "workers-ai", source: "illegal_mode" });
		expect(replay).toMatchObject({ provider: "workers-ai", source: "illegal_mode" });
		await env.DB.prepare("DELETE FROM ai_routing_policies WHERE capability = 'playground_chat'").run();
	});

	it("the admin door refuses retired fallbacks and historical rows resolve Cloudflare-only", async () => {
		for (const mode of ["google_primary_cf_fallback", "cf_primary_google_fallback"]) {
			const refused = await applyPolicyChange(env, {
				lane: "rerank",
				patch: { mode },
				actorUserId: "spec-admin",
			});
			expect(refused).toMatchObject({ error: "invalid_policy" });
			expect(refused.problems).toContain(`unknown mode ${mode}`);

			await env.DB.prepare(
				`INSERT INTO ai_routing_policies
				 (capability, mode, primary_provider, primary_model, fallback_provider, fallback_model, updated_at, updated_by)
				 VALUES ('rerank', ?, 'google-vertex', 'semantic-ranker-default-004', 'google-vertex', 'semantic-ranker-default-004', ?, 'historical')
				 ON CONFLICT(capability) DO UPDATE SET
				   mode=excluded.mode, primary_provider=excluded.primary_provider,
				   primary_model=excluded.primary_model, fallback_provider=excluded.fallback_provider,
				   fallback_model=excluded.fallback_model, disabled=0`,
			).bind(mode, Date.now()).run();
			resetPolicyCacheForTests();
			const onEnv = Object.assign(Object.create(Object.getPrototypeOf(env)), env, { AI_ROUTING: "on" });
			const route = await resolveRoute(onEnv, "rerank", { accountUserId: "allowlisted-account" });
			expect(route).toMatchObject({ provider: "workers-ai", mode: "cloudflare_only", source: "illegal_mode" });
			expect(route.fallback).toBeNull();
		}
		await env.DB.prepare("DELETE FROM ai_routing_policies WHERE capability = 'rerank'").run();

		// Defense in depth: neither a live Google embedding route nor the old
		// metadata-only shadow mode can be smuggled past the read door.
		const onEnv = Object.assign(Object.create(Object.getPrototypeOf(env)), env, { AI_ROUTING: "on" });
		for (const mode of ["google_only", "shadow"]) {
			await env.DB.prepare(
				`INSERT INTO ai_routing_policies
				 (capability, mode, primary_provider, shadow_provider, shadow_model, updated_at, updated_by)
				 VALUES ('embed', ?, 'google-vertex', 'google-vertex', 'gemini-embedding-001', ?, 'smuggled')
				 ON CONFLICT(capability) DO UPDATE SET
				   mode=excluded.mode, primary_provider='google-vertex',
				   shadow_provider='google-vertex', shadow_model='gemini-embedding-001', disabled=0`,
			).bind(mode, Date.now()).run();
			resetPolicyCacheForTests();
			const route = await resolveRoute(onEnv, "embed", {});
			expect(route.provider).toBe("workers-ai");
			expect(route.source).toBe("illegal_mode");
			expect(route.shadow).toBeNull();
		}
		await env.DB.prepare("DELETE FROM ai_routing_policies WHERE capability = 'embed'").run();
	});

	it("a legal policy write lands with CAS + audit, and version conflicts refuse", async () => {
		const lane = "digest";
		const first = await applyPolicyChange(env, {
			lane,
			patch: { mode: "cloudflare_only", allowlist: ["audit-private-account"] },
			actorUserId: "spec-admin",
			note: "taxonomy spec",
		});
		expect(first.ok).toBe(true);
		const stale = await applyPolicyChange(env, {
			lane,
			patch: { mode: "cloudflare_only" },
			actorUserId: "spec-admin",
			expectedVersion: 999,
		});
		expect(stale.error).toBe("version_conflict");
		const audit = await env.DB.prepare(
			"SELECT actor_user_id, new_json, note FROM ai_routing_policy_audit WHERE capability = ? ORDER BY changed_at DESC LIMIT 1",
		).bind(lane).first();
		expect(audit).toMatchObject({ actor_user_id: "spec-admin", note: "taxonomy spec" });
		expect(audit.new_json).not.toContain("audit-private-account");
		expect(JSON.parse(audit.new_json)).toMatchObject({ allowlist_count: 1 });
		expect(JSON.parse(audit.new_json)).not.toHaveProperty("allowlist_json");
		expect(JSON.parse(audit.new_json)).not.toHaveProperty("updated_by");
	});

	it("requires an explicit non-empty account allowlist for every Google route", async () => {
		const lane = "digest";
		const googlePolicies = [
			{
				mode: "google_only",
				primary_provider: "google-vertex",
				primary_model: "gemini-2.5-flash-lite",
			},
			{
				mode: "canary",
				primary_provider: "google-vertex",
				primary_model: "gemini-2.5-flash-lite",
				canary_pct: 100,
			},
			{
				mode: "shadow",
				primary_provider: "workers-ai",
				shadow_provider: "google-vertex",
				shadow_model: "gemini-2.5-flash-lite",
				shadow_sample_pct: 100,
			},
		];
		for (const policy of googlePolicies) {
			for (const allowlistJson of [
				undefined,
				null,
				"",
				"[]",
				"{malformed",
				"{}",
				"[null]",
				"[42]",
				'[""]',
				'["   "]',
			]) {
				const candidate = { ...policy };
				if (allowlistJson !== undefined) candidate.allowlist_json = allowlistJson;
				expect(validatePolicyWrite(lane, candidate)).toContain(
					"Google routes require an explicit non-empty account allowlist",
				);
			}
			expect(validatePolicyWrite(lane, {
				...policy,
				allowlist_json: '["explicit-member"]',
			})).not.toContain("Google routes require an explicit non-empty account allowlist");
		}

		for (const allowlist of [undefined, null, []]) {
			await env.DB.prepare("DELETE FROM ai_routing_policies WHERE capability = ?").bind(lane).run();
			const patch = { ...googlePolicies[0] };
			if (allowlist !== undefined) patch.allowlist = allowlist;
			const refused = await applyPolicyChange(env, {
				lane,
				patch,
				actorUserId: "allowlist-gate-admin",
			});
			expect(refused).toMatchObject({ error: "invalid_policy" });
			expect(refused.problems).toContain(
				"Google routes require an explicit non-empty account allowlist",
			);
		}
		const malformed = await applyPolicyChange(env, {
			lane,
			patch: { allowlist: "not-an-array" },
			actorUserId: "allowlist-gate-admin",
		});
		expect(malformed).toMatchObject({
			error: "invalid_policy",
			problems: ["allowlist must be an array, null, or omitted"],
		});
	});

	it("fails closed for bypassed allowlist rows and routes only an explicit member", async () => {
		const lane = "digest";
		const onEnv = Object.assign(Object.create(Object.getPrototypeOf(env)), env, { AI_ROUTING: "on" });
		const policies = [
			{ mode: "google_only", primary: "google-vertex", primaryModel: "gemini-2.5-flash-lite" },
			{ mode: "canary", primary: "google-vertex", primaryModel: "gemini-2.5-flash-lite", canaryPct: 100 },
			{ mode: "shadow", primary: "workers-ai", shadow: "google-vertex", shadowModel: "gemini-2.5-flash-lite", shadowPct: 100 },
		];
		const seedBypassedPolicy = async (policy, allowlistJson) => {
			await env.DB.prepare("DELETE FROM ai_routing_policies WHERE capability = ?").bind(lane).run();
			await env.DB.prepare(
				`INSERT INTO ai_routing_policies
				 (capability, mode, primary_provider, primary_model, shadow_provider, shadow_model,
				  canary_pct, shadow_sample_pct, allowlist_json, updated_at, updated_by)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'bypassed')`,
			).bind(
				lane,
				policy.mode,
				policy.primary,
				policy.primaryModel ?? null,
				policy.shadow ?? null,
				policy.shadowModel ?? null,
				policy.canaryPct ?? 0,
				policy.shadowPct ?? 100,
				allowlistJson,
				Date.now(),
			).run();
			resetPolicyCacheForTests();
		};

		for (const policy of policies) {
			for (const allowlistJson of [null, "", "[]", "{malformed", "{}", "[null]", "[42]", '[""]']) {
				await seedBypassedPolicy(policy, allowlistJson);
				await expect(resolveRoute(onEnv, lane, { accountUserId: "any-account" }))
					.resolves.toMatchObject({ provider: "workers-ai", source: "invalid_policy" });
			}

			await seedBypassedPolicy(policy, '["explicit-member"]');
			const member = await resolveRoute(onEnv, lane, { accountUserId: "explicit-member" });
			if (policy.mode === "shadow") {
				expect(member).toMatchObject({
					provider: "workers-ai",
					shadow: { provider: "google-vertex", model: "gemini-2.5-flash-lite" },
				});
			} else {
				expect(member).toMatchObject({ provider: "google-vertex", source: "policy" });
			}
			resetPolicyCacheForTests();
			const nonmember = await resolveRoute(onEnv, lane, { accountUserId: "other-account" });
			expect(nonmember.provider).toBe("workers-ai");
			expect(nonmember.shadow).toBeNull();
			if (policy.mode !== "shadow") expect(nonmember.source).toBe("not_allowlisted");
		}
	});

	it("a concurrent policy CAS loser cannot append a ghost audit event", async () => {
		const clock = vi.spyOn(Date, "now").mockReturnValue(1_787_364_000_000);
		try {
		const lane = "rerank";
		const seeded = await applyPolicyChange(env, {
			lane,
			patch: { mode: "cloudflare_only", disabled: false },
			actorUserId: "race-seed",
		});
		expect(seeded.ok).toBe(true);
		const before = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM ai_routing_policy_audit WHERE capability = ?",
		).bind(lane).first();

		let arrivals = 0;
		let releaseReads;
		const bothRead = new Promise((resolve) => { releaseReads = resolve; });
		const DB = new Proxy(env.DB, {
			get(target, property) {
				if (property === "prepare") return (sql) => {
					const statement = target.prepare(sql);
					if (!String(sql).includes("SELECT * FROM ai_routing_policies WHERE capability = ?")) return statement;
					const pauseFirst = (current) => new Proxy(current, {
						get(statementTarget, statementProperty) {
							if (statementProperty === "bind") return (...args) => pauseFirst(statementTarget.bind(...args));
							if (statementProperty === "first") return async (...args) => {
								const row = await statementTarget.first(...args);
								arrivals += 1;
								if (arrivals === 2) releaseReads();
								await bothRead;
								return row;
							};
							const value = Reflect.get(statementTarget, statementProperty);
							return typeof value === "function" ? value.bind(statementTarget) : value;
						},
					});
					return pauseFirst(statement);
				};
				const value = Reflect.get(target, property);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const raceEnv = Object.assign(Object.create(Object.getPrototypeOf(env)), env, { DB });
		const outcomes = await Promise.all([
			applyPolicyChange(raceEnv, {
				lane,
				patch: { disabled: true },
				actorUserId: "same-admin",
				expectedVersion: seeded.version,
				note: "race a",
			}),
			applyPolicyChange(raceEnv, {
				lane,
				patch: { disabled: false },
				actorUserId: "same-admin",
				expectedVersion: seeded.version,
				note: "race b",
			}),
		]);
		expect(outcomes.filter((result) => result.ok)).toHaveLength(1);
		expect(outcomes.filter((result) => result.error === "version_conflict")).toHaveLength(1);

		const after = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM ai_routing_policy_audit WHERE capability = ?",
		).bind(lane).first();
		expect(Number(after.n) - Number(before.n)).toBe(1);
		const current = await env.DB.prepare(
			"SELECT updated_by, version FROM ai_routing_policies WHERE capability = ?",
		).bind(lane).first();
		const audit = await env.DB.prepare(
			"SELECT actor_user_id, new_json FROM ai_routing_policy_audit WHERE capability = ? ORDER BY rowid DESC LIMIT 1",
		).bind(lane).first();
		expect(audit.actor_user_id).toBe(current.updated_by);
		expect(JSON.parse(audit.new_json).disabled).toBe(Number((await env.DB.prepare(
			"SELECT disabled FROM ai_routing_policies WHERE capability = ?",
		).bind(lane).first()).disabled));
		expect(current.version).toBe(seeded.version + 1);
		} finally {
			clock.mockRestore();
		}
	});

	it("track mode evaluates and records the would-route while executing only Workers AI", async () => {
		const lane = "rerank";
		await env.DB.prepare(
			`INSERT INTO ai_routing_policies
			 (capability, mode, primary_provider, primary_model, allowlist_json, updated_at, updated_by)
			 VALUES (?, 'google_only', 'google-vertex', 'semantic-ranker-default-004', '["track-account"]', ?, 'spec-admin')
			 ON CONFLICT(capability) DO UPDATE SET
			   mode='google_only', primary_provider='google-vertex',
			   primary_model='semantic-ranker-default-004', allowlist_json='["track-account"]', disabled=0,
			   updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
		).bind(lane, Date.now()).run();
		resetPolicyCacheForTests();
		const calls = [];
		const logs = [];
		const originalLog = console.log;
		console.log = (line) => logs.push(String(line));
		try {
			const trackEnv = Object.assign(Object.create(Object.getPrototypeOf(env)), env, {
				AI_ROUTING: "track",
				AI: { run: async (...args) => {
					calls.push(args);
					return { response: "workers-only" };
				} },
			});
			const result = await dispatchAi(trackEnv, {
				model: "@cf/legacy/model",
				inputs: { query: "bounded test input", contexts: ["one"] },
				options: undefined,
				meta: { task: lane },
				lifecycle: { accountUserId: "track-account" },
			});
			expect(result).toEqual({ response: "workers-only" });
			expect(calls).toHaveLength(1);
			expect(calls[0][0]).toBe("@cf/legacy/model");
			const record = logs.map((line) => {
				try { return JSON.parse(line); } catch { return null; }
			}).find((entry) => entry?.event === "ai_routing_track");
			expect(record).toMatchObject({
				lane,
				provider: "google-vertex",
				model: "semantic-ranker-default-004",
				mode: "google_only",
				source: "policy",
			});
			expect(record).not.toHaveProperty("accountUserId");
		} finally {
			console.log = originalLog;
			await env.DB.prepare("DELETE FROM ai_routing_policies WHERE capability = ?").bind(lane).run();
			resetPolicyCacheForTests();
		}
	});
});
