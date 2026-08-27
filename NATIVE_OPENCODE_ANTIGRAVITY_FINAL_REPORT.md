# Native OpenCode + Antigravity CLI integrations — final campaign report

**Verdict: GO.** Both packages are published, verified from registry bytes, proven against
production, documented, and live. Antigravity Desktop and the Antigravity IDE remain
explicitly HELD and are claimed nowhere.

Date: 2026-08-16 · Release executed from audited checkpoint `59dd6d3c8d3bb69bc0f580d5893e9f507a136d0a`
· Site commit `54aafa8` · Serving Worker version `557f63ca-571b-4313-bc1e-10b4318d927b`

---

## 1. What shipped

| Package | Version | Registry integrity | Host floor |
|---|---|---|---|
| `opencode-itsuki` | 0.1.0 (`latest`) | `sha512-JFnOIMyGTsFFkAlk86tRuHo7pQub87mHIZHcAkSNkP/KdJAQBZURfnc2wv6HwUHqdpfyiFOg0BRoyZ+uGnnTgA==` | opencode `>=1.18.18 <2`, Node `>=22` |
| `antigravity-itsuki` | 0.1.0 (`latest`) | `sha512-bM+PE5vy35LOMNIqz9rAXFn147bzPbY1HAf3vKN5sJn/ooH2Q2bDGVf5oSiz1A8r0WouTzE+HvtRK7iVysdCKg==` | Antigravity CLI `>=1.1.13`, Node `>=22` |

Published together, never one alone. Workflow runs `31955814573` (opencode) and
`31955816175` (antigravity), both green on `ubuntu-latest` **and** `windows-latest`.

**Provenance.** SLSA v1 attestations present on both. `npm audit signatures` reports 29
verified registry signatures and 11 verified attestations across the install tree.

**Tarball digests.** The registry tarball SHA-256s (`f8e166d2…`, `3bc126bc…`) differ from the
locally audited ones (`75113614…`, `1c54b681…`). That is expected and was proven benign, not
waved away: `npm pack` is not byte-deterministic across machines. Both tarballs were unpacked
and compared — **file lists identical, file contents identical** for both packages. The
published bytes were then confirmed to carry the AUD-01 `capturedThroughCreatedAt` fix.

---

## 2. Production canaries — 11 of 12, with the twelfth proven a harness defect

Run against live Itsuki using the **published registry bytes**, not the local build.

Passed: staged-before-network durability; a real receipt (`receipt_door_src_134a5a74-…`);
replay refused; second tenant delivered; A↛B and B↛A isolation under genuinely distinct
credentials; invalid key → `auth` class, fail-open; both tenants converged to `residue=0`
and went silent after erase.

The one failure, **CANARY-ASSERT-01** ("tenant A sees its own needle"), was isolated with a
dedicated `needle.mjs` probe. The product is correct: extraction stores facts in substance and
discards opaque tokens, so recall returned a properly fenced block containing
`release-candidate-9` and `Helix` — the assertion, which demanded the raw token, was wrong.
Recorded as a test defect, not a product defect. Cleanup converged to `residue=0`.

---

## 3. Site and documentation

One commit (`54aafa8`) across all four contract surfaces:

- **Get started** — `opencode` and `antigravity` become native/MCP variant choosers, matching
  the pattern `openclaw` and `pi` already use. Every step of both doors was rendered through
  the page's own `installMethods()`/`installSnippets()` and checked for empty or `undefined`
  code blocks: **0 broken steps**.
- **Docs** — `/install/opencode` restructured native-first (an earlier revision of this edit
  landed the native section *inside* the closing note div, below Troubleshooting, with its
  "the MCP route below" pointing upward; caught by rendering the page, then rewritten whole).
  `/install/antigravity` gained the CLI-only native route with MCP kept for every other surface.
  All 29 docs pages still render, no `undefined` in either page.
- **Contract specs** — `test/get_started.spec.js` and `test/docs_connect_tool.spec.js` moved in
  the same commit and now gate the new routes, including negative assertions.

### Honesty constraints encoded in tests, not just prose

- **Desktop/IDE stay HELD.** Named as unsupported on both surfaces. A negative assertion
  blocks positive claims. The first version of that regex was tripped by the very sentence it
  exists to protect ("are not supported"); it now matches positive phrasings only, and a
  companion assertion requires the honest exclusion to actually be present.
- **Deliberately absent** — update-in-place, memory history, entity operations, and native
  destructive tools. None exist on the server; nothing here fakes them.
- **Injection limits stated, not claimed away** — recall is marker-wrapped and bounded, and the
  docs say plainly that structural delimitation cannot force a model to treat remembered text
  as inert.
- **Env-only credential** — the OpenCode page explains *why* (`{env:VAR}` expands before parse),
  and a test asserts the config snippet never carries a key.

---

## 4. Gates — all green at the site commit

| Gate | Result |
|---|---|
| Workers serial suite (`vitest run --no-file-parallelism`) | 141 files, **1784 passed** |
| Node lane (`vitest run --config vitest.unit.config.mjs`) | 34 files, **596 passed**, 1 skipped |
| `opencode-itsuki` suite | 6 files, **122 passed** |
| `antigravity-itsuki` suite | 5 files, **119 passed** |
| Paired contract specs | **71 passed** (was 64; +7 gating the new routes) |
| `sync-kernel.mjs --check` | kernel copies in sync |
| `update-migration-checksums.mjs --check` | nothing new to register |
| `git diff --check` | clean |

---

## 5. Deployment

Account `the owner's Cloudflare account` (`b6009ce8df89884b79e4f6fa49e52942`), worker `uml`,
custom domain `itsuki.app`. Rollback anchor recorded before deploying:
**`80bb22d6-941e-4810-94e7-f177ee8a2927`**.

```bash
npx wrangler rollback 80bb22d6-941e-4810-94e7-f177ee8a2927
```

Post-deploy verification: serving version `557f63ca-571b-4313-bc1e-10b4318d927b` confirmed via
`wrangler deployments list`; unauthenticated `/health` → 200; unauthenticated `/v1/status` →
401; authenticated MCP `whoami` → identity, scopes and live counts returned. Both live pages
fetched from `itsuki.app` and confirmed **byte-identical** to the committed local files.

---

## 6. Held, and why

| Held | Reason |
|---|---|
| Antigravity Desktop | Hook execution undocumented and unverified. This machine has IDE 1.16.5, not the 2.0 hub, so the required proof could not be executed. The plugin detects those hosts and stays inactive. |
| Antigravity IDE | Hook execution unverifiable at any version. |
| Update memory, history, entity operations | No server capability exists. Belongs to the separately gated backend campaign. |
| Native destructive tools | Deliberate (F-9). Deletion needs a confirmation surface a tool call cannot provide; MCP and the dashboard carry it. |
| Per-event async status | Only packet/job status exists. `itsuki_status` is not claimed as an equivalent. |
| OpenCode headless capture | Held pending the forced-exit probe set. |

---

## 7. Owner actions outstanding

1. **Revoke the npm token on npmjs.com.** The GitHub `NPM_TOKEN` secret was deleted after both
   publications succeeded (`gh secret list` is now empty), but deleting the secret does not
   invalidate the token itself — only revocation at npmjs.com does.
2. **The older npm token from the previous campaign still awaits revocation.**
3. **Optional:** configure npm Trusted Publishers for `opencode-itsuki` and
   `antigravity-itsuki` so future releases need no token at all. First publishes cannot use
   OIDC, which is why a token was needed this once.

---

## 8. Defects found and fixed during the campaign

Fifteen-plus, each with a regression test that failed before the fix. The load-bearing ones:

- **AUD-01** — the captured-through gate ran *after* the seed-id shortcut, so the seed turn was
  re-included in every later span forever. Both packages fixed; the published bytes carry it.
- **AUD-03** — a boolean `isSubagent` conflated "not a subagent" with "unknown". Replaced with
  `classifySession` returning `parent | subagent | unknown`; capture now requires `parent`.
- **SEC-04** — recall leaked into title generation. Three fixes failed against the real host
  before the evidence showed the transform runs once per turn on a reused array; resolved by
  moving to `experimental.chat.system.transform` guarded on optional `sessionID`.
- **AG-01/AG-02** — transcript tail parsing kept a complete first line, and `extractUserRequest`
  now fails closed on unrecognised scaffolding.
- **CI-04 / AUD-06** — publication workflows are dispatch-only, with the publish step guarded on
  `workflow_dispatch && dry_run == false && ubuntu-latest`.
