# Changelog

## 0.1.0 — unreleased

First release.

- `createItsuki(config, options)` returns an input processor, an output
  processor, model-callable tools and a shared client from one validated
  configuration.
- `ItsukiRecall` implements `processInput`: bounded, marker-fenced memory is
  added as a system message before the model call.
- `ItsukiCapture` implements `processOutputResult`: the settled exchange is
  stored after the agent answers. The user turn is read from the host's
  MessageList, because a processor is handed only the messages the model just
  produced.
- Tools: `itsuki-search-memory`, `itsuki-save-memory`, `itsuki-list-memories`,
  `itsuki-get-memory`, and `itsuki-delete-memory` only when explicitly enabled
  (and only with `confirmed: true`).
- Identity maps Mastra's own `resource`/`thread` to memory space and
  conversation; no tool accepts a tenancy parameter, and a run with no identity
  is skipped rather than guessed.
- Neither processor can fail a run; failures surface through a content-free
  event hook.
- Zero runtime dependencies.
