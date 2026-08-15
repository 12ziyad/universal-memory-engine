# Changelog

## 0.1.0 — unreleased

First release.

- `withItsuki(model, config)` wraps any AI SDK language model with automatic
  bounded recall and settled-exchange capture, implemented as
  `LanguageModelV4Middleware` over `wrapLanguageModel`. No provider SDKs are
  bundled and the package has zero runtime dependencies.
- `createItsuki(config)` returns the middleware plus the standalone calls
  sharing one validated configuration; `itsukiMiddleware(config)` is available
  for callers composing their own middleware chain.
- Standalone helpers: `retrieveMemories`, `getMemories`, `saveMemories`,
  `waitForMemory`.
- Recall is injected as a marker-fenced system block labelled as data, bounded
  by characters and item count.
- Capture requires both a user turn and settled assistant prose, so a tool-only
  step never stores half an exchange; keys are derived from content and tenancy
  so retries, stream reconnects and re-executed steps deduplicate server-side.
- Per-call tenancy overrides through `providerOptions.itsuki`, stripped before
  the provider sees them.
- `capture: "background" | "blocking" | "off"`, with `waitUntil` support for
  platforms that freeze after the response.
- Content-free event hook for metrics.
