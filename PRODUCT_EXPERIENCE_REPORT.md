# Product-Experience Campaign — Delivery Report

Date: 2026-08-24 · Branch: `codex/prod-google-plus-unified-theme` · Rollback checkpoint: branch `codex/checkpoint-pre-experience-campaign-20260824`, production version `f8c9e253-47b3-4872-b622-a207be783826`

## Production verdict: [PENDING — filled after production verification]

## What changed

**Landing (content only — visual identity preserved).** Hero: *"Not more context. Better memory."* with the wedge subhead (source-linked, versioned, reversible; applications/assistants/agents/workflows breadth). Title/OG metadata aligned. Closing CTA gained a support line and a docs secondary action. A full enterprise footer replaced the six-link strip: brand column with Japanese detail and truthful trust chips (Tenant-isolated · Source-backed · Versioned · Deletable by design — no invented compliance badges), Developers / Product / Company groups linking only real destinations, © base bar. Zero dead links.

**Dark theme.** The warm brown-black ramp (`#11100d`…) became neutral near-black (`#0f0f10` bg, charcoal panels, achromatic borders/text) with terracotta reserved for actions, active nav, links, focus, and selection edges. The letterpress slab is ink again (was solid orange-on-orange). Fixed: white-on-accent contrast bugs, the blue/yellow avatar, dead-purple theme-preview swatches, warm graph housing, orange row washes, legal overlay palette.

**Header profile menu.** Compact avatar control (house popover contract: `aria-haspopup`/`aria-expanded`, outside-click + Escape close, focus return): identity, Light/Dark/System segmented control, Settings, Support, Log out.

**Settings.** Project and Organization General: Save/Cancel sit directly under the editable fields; ids, lifecycle, dates, ownership, role, and usage moved into a collapsed "Technical details" disclosure. All draft/CAS/conflict behavior preserved. Audit filters became draft-vs-applied: Apply enables only when filters differ from what is shown, Clear only when there is something to clear, both quiet during any in-flight load, and validation errors no longer wipe typed fields.

**Truthful rules preview.** The backend now runs a second bounded no-write model call that judges extraction-worthiness per allowed sample using the real pipeline's criteria. The response separates deterministic policy (`kept`), model assessment (`durable` / `not_durable` / `uncertain` — explicit uncertainty), and filing category. The UI says "Allowed by rules" / "Blocked by policy" and never presents rule passage as storage. Verified live: *"Thanks, that's all for today"* → Allowed by rules · **Not durable — would not be stored**. No-write, no-D1, no-meter contract intact; denied text never reaches any model payload; ≤2 model calls per preview.

**Auth & onboarding.** All gating fetches (email start/verify, `/auth/me`, bootstrap) now have bounded timeouts with recoverable errors; a hung bootstrap lands on a visible Reconnect screen instead of a blank landing under `/app`. Resend gained a live countdown that actually re-enables; the expiry note counts down. The first API key can be named. OTP and invitation emails share one editorial template (`src/lib/email_template.js`) — branded HTML + plain text, no external resources, no tracking; the OTP sender address is now format-validated; `AUTH_EMAIL_SECRET` documented in `.dev.vars.example`.

**Membership lifecycle.** Self-service **Leave project** / **Leave organization** (routes `POST /v1/settings/members/leave`, `/v1/settings/org-members/leave`): atomic seat removal + credential/OAuth-grant quarantine, audited (`project.member.left`, `org.member.left`), idempotent repeats, org-owner refusal, implicit-access refusal; response carries fresh authorized scope. Client-side: a revoked seat is now detected on the next failing project-bound call — scope revalidates once per epoch, dead orgs/projects fall out of the switchers, and the app hops cleanly to an authorized scope.

## Intentionally preserved

Editorial cream/orange identity, Memory Bonsai brand set, typography/grid, all section headlines and narrative structure, API/SDK/MCP contracts, tenant boundaries, all auth security machinery (HMAC codes, browser binding, attempt limits, enumeration safety), invitation outbox, switcher placement, danger-zone flows, and every completed prior campaign (provider adapter stays dark behind `AI_ROUTING="off"`).

## Landing messaging strategy

Enemy-claim hero (the field sells *more context*; Itsuki sells *better memory*) grounded in the only unclaimed wedge among active competitors (Mem0/Supermemory/Zep/Cognee/Honcho all verified this week): auditable memory — source-linked, versioned, reversible. Category stays in the eyebrow; mechanism in the subhead; no benchmark numbers on the hero; no superiority claims.

## Tests

Added: `test/product_experience.spec.js` (22), `test/product_experience_css.unit.js` (6), `test/membership_leave.spec.js` (9), `test/email_template.spec.js` (5), extensions to `rules_preview` (+5), `passwordless_auth` (+2), `invitation_email`. Provider-campaign gates updated for the intentional preview change (golden fixtures recaptured via the sanctioned script; schema census now expects both preview schemas).

- Full regression: **[PENDING — filled at completion]**
- Local live verification (wrangler dev, real Worker/D1/AI): full email-code signup → branded OTP email → live countdown → atomic onboarding (Canary Workspace + Default project + root space, consent-gated sample) → named first key, copy-gated Proceed, no secret in browser storage → app shell → profile menu behaviors → neutral dark (`rgb(15,15,16)` computed) → settings layout → conditional audit filters → truthful preview with real model calls → 375 px: zero horizontal overflow, 42 px touch targets.

## Migration status

None added by this campaign. Remote D1 already carries 0052–0057 (verified `No migrations to apply`). Deploy is code-only; rollback needs no schema work.

## Production deployment

- Version: **[PENDING]**
- Verified journeys: **[PENDING]**

## Known limits stated honestly

- Production new-user E2E (receiving a real email) cannot be exercised without an inbox; it was verified end-to-end against wrangler dev with the real Worker/D1 semantics and real Workers AI, plus production surface checks (landing, health, login render, email-start 202 contract, OAuth start redirects).
- The truthful preview adds a second model call; measured locally through the dev tunnel it is slow, in-colo it is a few seconds. The button communicates progress and the endpoint stays rate-limited (60/min) and unmetered by its documented contract.
- Screenshots were unavailable in this environment (browser pane not compositing); verification used the accessibility tree, computed styles, and live network/log evidence instead.
