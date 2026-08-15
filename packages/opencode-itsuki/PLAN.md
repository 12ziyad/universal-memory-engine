# opencode-itsuki — implementation record

Built from FROZEN ARCHITECTURE REPORT v2.1 §10.1/§12, against the host contract
measured in Phase 0 (run `31911313462`, 248 hook invocations).
Host pinned: `opencode-ai@1.18.18` / `@opencode-ai/plugin@1.18.18` / `@opencode-ai/sdk@1.18.18`.

## Divergences from the frozen architecture (each forced by evidence)

### D-1 — recall is triggered in `chat.message` but INJECTED in `experimental.chat.messages.transform` *(material)*

The frozen report specified injection by pushing a `TextPart` onto
`chat.message`'s `output.parts`. Phase 0 proved that works — the loopback stub
recorded `sawMarker: true` on every completion — **and** proved it leaks: each
main call was paired with a `nMsgs:2` title-generation call that also reported
`sawMarker: true`. The tagged v1.18.18 source explains why: the title path's
filter is `!m.parts.every(p => p.synthetic)`, which drops a message only when
*every* part is synthetic, so a real user message carrying one injected part
sails through. Issue #42386 closed 17 hours *after* the 1.18.18 release.

Injecting in the transform hook instead keeps the model informed while leaving
the persisted transcript untouched, which removes the leak at the source rather
than mitigating it. `chat.message` remains the per-human-turn trigger, so recall
still runs exactly once per turn.

### D-2 — the requirement's stated `finish` allowlist is exactly one value *(minor, tightening)*

Phase 0 observed `finish === "stop"` on both successful turns and
`finish === undefined` with `error` set on the failed one. Since the errored
message *also* carried `time.completed`, the allowlist is `["stop"]` and
completion alone is never treated as success.

### D-3 — the kernel is vendored unmodified, with per-package timeouts *(as frozen)*

`packages/_kernel/ts` is untouched. The 10s kernel default sits too close to the
service's 9s save budget, so the transport is constructed with an explicit
30,000ms budget instead. `TS_CONSUMERS` gained both new packages.

## Files

`src/{index,config,identity,messages,coordinator,spool,sessionstate,statetree,tools}.ts`
plus `src/kernel/` (vendored). Tests in `test/{messages,durability,tenancy,watermark,hooks,adversarial}.spec.ts`.

## Defects found and fixed

| ID | Severity | Defect |
|---|---|---|
| SEC-01 | HIGH | The option-secret guard used the kernel's `looksSecret`, which needs 32+ chars and real entropy — right for scrubbing prose, wrong for a config guard, so `itsuki_live_abc123` passed. Now name-matched and shape-matched, recursively through nested options. |
| SEC-02 | HIGH | A memory containing our own closing marker ended the data fence early, so text after it read as ordinary prompt — a working prompt-injection escape via poisoned memory. Markers in stored content are now defanged before wrapping. |
| REL-01 | MEDIUM | The `event` hook destructured its parameter, which throws before any handler can catch it; the host dispatches that hook fire-and-forget, so it became a process-level unhandled rejection. |
| REL-02 | HIGH | The recall budget trusted the transport to honour an abort signal. A fetch that ignores it hangs the turn — which on this host means the user's prompt is silently lost (#39031). The budget is now enforced independently of the transport. |
| REL-03 | HIGH | The double-idle guard keyed on `lastCapturedMessageID`, which only advances on success, so one refused turn pinned the key and silently blocked every later capture in that session. Replaced with a per-session in-flight lock. |

## Gates

Typecheck clean · 111 tests · zero runtime dependencies · no postinstall ·
62-file pack with no unexpected entries · no credential-shaped strings in
shipped sources.
