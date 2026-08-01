# Itsuki — session handoff

Paste this whole file as your first message in a new chat.

---

## What Itsuki is

**Itsuki** (樹, "tree") is a personal memory engine — one private memory graph shared by
every AI you use. Live at **https://uml.gpmai.workers.dev** (domain still says "uml"; the
product was renamed to Itsuki on 2026-08-01 and a custom domain hasn't been bought yet).

Repo: `C:\Users\ziyad\uml` → github.com/12ziyad/universal-memory-engine (Apache-2.0, **public** —
verified 2026-08-01 with `gh repo view`; this file previously said private, which is why the
plugin-marketplace item below was listed as blocked. Re-check that blocker before trusting it).
Owner/admin account: ejziyad@gmail.com. Cloudflare: **Workers Paid**, $10,000 startup credits
active since 2026-06-17 (credits pay the invoice; card untouched).

**Stack:** Cloudflare Workers · D1 (`uml-memory`) · Vectorize · Workers AI (Qwen3-30B
extraction via `LLM_MODEL`) · Durable Objects (per-user, `idFromName`). Frontend is ONE file,
`public/index.html` (~5k lines, no build step, no bundler). Docs are a second self-contained
file, `public/docs/index.html`. Tests: **499 passing** (`npx vitest run`).

**One engine, many doors** — the same extraction → graph-write → recall pipeline is reached via
the app UI, REST `/v1/*`, the MCP server, and the SDKs. New doors are never new engines.

**Positioning vs mem0 (the moat):** mem0 only onboards *developer tools* (Claude Code, Codex,
Cursor). Itsuki connects **claude.ai and ChatGPT directly** — a non-technical person pastes one
link and their chat remembers them. That difference is the product.

---

## Architecture quick map

| Area | Where |
|---|---|
| Routes (exact-match `"METHOD /path"` map) | `src/index.js` |
| Auth, tokens, Google OAuth | `src/auth.js` |
| MCP server (3 tools) | `src/mcp/server.js` |
| Extraction pipeline | `src/pipeline/` (`extract.js`, `llm.js`, `gates.js`, `write.js`, `recall.js`, `rules.js`) |
| App UI (landing + SPA) | `public/index.html` |
| Docs site | `public/docs/index.html` → served at `/docs/` |
| SDKs | `sdk/js/` (npm `itsuki`), `sdk/python/` (pip `itsuki`) |
| Plugin manifests | `.claude-plugin/` |
| Benchmark harness | `evals/locomo/` |
| Migrations | `migrations/` (latest **0017**) |

**Auth model:** session cookie (app) · `itsuki_live_` Bearer keys (API/SDK; legacy `uml_live_`
keys still accepted forever) · legacy `x-api-key` + explicit `userId` (admin/tools). Passing a
`userId` different from the key owner creates an **isolated sub-tenant memory space** — that's
how one key serves many end users, and how the benchmark isolates conversations.

**App IA:** rail with **Setup** (Get started · Playground · API Keys) and **Activity**
(Dashboard · Memories · Graph · History), then Docs↗ · Settings · Admin. `VIEW_ALIASES` keeps
old deep links (`#connect` → install, `#candidates` → memory, `#rules` → settings) working.

---

## Done (all deployed, tested, pushed)

- **Rebrand to Itsuki** everywhere visible; `PRODUCT` constant in index.html is the naming source
- **Platform v2**: Get started (3 method cards → client tabs → numbered stepper), Playground
  (live save/recall), API Keys (table w/ rotate/revoke), Dashboard (range picker, usage chart,
  Explore grid), `/docs` (14 pages, search, copy buttons)
- **`GET /v1/usage`** — per-day rollups from receipts + content tables
- **SDKs** — JS (zero-dep, live-smoked green against prod) and Python (httpx, 7 pytest green).
  Package name `itsuki` is **free on both npm and PyPI** (verified)
- **CORS** — built, tested, shipped **OFF** (`ENABLE_CORS` env var). Cross-origin allows Bearer
  only; sessions/legacy key refused; `allow-credentials` never sent
- **Capture fixes** (migration 0017): event dates preserved (`happened_at` = model-proposed date
  ?? newest message ts ?? now) and **dense capture mode** (`rules.captureDensity` or per-request
  `body.captureDensity`) — private smoke measured **51 memories vs the 25-node baseline**
- **Honest analytics** — ~unique visitors, bot filter, referrer/country/device, funnel,
  activation; admin excluded from app counts; failed logins no longer counted as logins
- **Per-user journey** in admin (metadata only — never memory content)
- **Error hygiene** — users only ever see friendly messages; everything auto-reports to admin
- Font: **self-hosted Inter** (62 KB Latin subset). Deliberately NOT Google Fonts — that would
  send visitor IPs to a third party and break the "no third-party trackers" privacy promise

**Two real bugs found and fixed by measuring, worth remembering:**
1. `recallGate` gated retrieval on `classifyMessage()`, an *ingest* classifier that calls any
   question without "I"/"my" a utility query → "When is Sarah's birthday?" never searched memory.
   87.5% of benchmark questions were silently skipped.
2. `buildContext` dropped the whole context when the first line exceeded the char budget →
   recall returned "found 8 matches" with an empty context string.

---

## Immediate next task (agreed, not yet built)

**Make tool-calling reliable + honest.** Plain MCP means the model *decides* whether to call
`save_memory` — benchmarks put that near 72% on hard tasks. Get started currently says
*"simply say 'remember this'"*, which overpromises and contradicts our own landing-page honesty
note. Ship:

1. Rewrite Get started **step 3** honestly → *"say: save this to itsuki"* (naming the tool is a
   much stronger hint than "remember this")
2. Add **step 4 "Make it automatic"** with a copy-paste block for Claude Projects instructions
   and ChatGPT → Settings → Personalization → Custom instructions:
   > *At the start of a conversation, call `recall_memory` to load what you already know about
   > me. When I share something durable — a decision, preference, plan, person, or project —
   > call `save_memory` without being asked. Never say you saved something unless you got the
   > receipt back.*
3. **ChatGPT click-path** — there is **no** documented deep link (Claude has one:
   `claude.ai/settings/connectors?modal=add-custom-connector`). Do NOT invent a URL. Note that
   the menu may read *Connectors*, *Apps*, or *Plugins* depending on their build
4. Mirror the same guidance into `/docs` Concepts

---

## Backlog (ranked)

1. **Plugin hooks** — a plugin can run code at lifecycle moments (before each answer → auto
   recall; session end → auto save). This is the *guaranteed* version of #2 above. Blocked:
   Claude Code and Codex both install plugins from a **public repo** — ours is private.
   Manifests already written for both (`.claude-plugin/`, and Codex's
   `.agents/plugins/marketplace.json` format is in the UI)
2. **Publish the SDKs** — blocked on the founder creating **npm + PyPI accounts**; everything
   else is ready
3. **Custom domain** → then move dashboard + docs; brand-hygiene test already forbids hardcoding
   "gpmai" anywhere outside the literal contact email
4. **Playground + API Keys** restyled to the Get started stepper rhythm (visual consistency)
5. **Benchmark phase** — harness is ready (`evals/locomo/`, `SMOKE_USER` + `CAPTURE_DENSITY`
   env hooks). Remaining gap: harness sends no per-message `ts`, so dates don't anchor.
   **Founder's standing rules: conv-0 private smoke only, no full runs, no published numbers,
   never run competitor systems.**
6. Turnstile (needs founder to create the widget), Google client-secret rotation (secret was
   pasted in chat once), MCP directory listings

---

## How to work with me (founder's stated preferences)

- **Build and deploy, don't just plan** — when told "go", ship it: small commits, tests green,
  `npx wrangler deploy`, then push
- **Verify live, never assume.** Green tests have repeatedly hidden real breakage. Probe the
  deployed worker. Cloudflare's edge serves **stale HTML for several minutes** after deploy —
  poll with a cache-buster before concluding a fix failed
- **Users must never see raw errors.** Friendly message to the user, real detail auto-reported
  to admin. This rule is absolute and applies everywhere
- **Say what's actually true.** If something is unverified, blocked, or was my mistake, say so
  plainly. The founder catches overclaims and dislikes them more than bugs
- Ask before spending their money or touching billing; never enter payment details

---

## Useful commands

```bash
npx vitest run                                    # 499 tests
npx wrangler deploy                               # deploy
npx wrangler d1 migrations apply uml-memory --remote
node evals/locomo/ingest.js 0                     # benchmark ingest (see evals/locomo/README.md)
```

Memory files for context live in `~/.claude/projects/C--Users-ziyad-uml/memory/`
(`uml-project.md`, `workers-ai-verify-live-model.md`, `uml-locomo-coverage-gap.md`).
