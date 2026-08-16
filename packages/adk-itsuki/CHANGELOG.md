# Changelog

## 0.1.0 — unreleased

First implementation of the native Google ADK memory service. Not yet
published to PyPI.

- `ItsukiMemoryService` implementing `BaseMemoryService`: bounded recall that
  never raises and never hangs, plus settled-only capture.
- `ItsukiMemoryPlugin` supplying the automatic capture ADK does not ship,
  guarded so that `AgentTool` child runs can never write tool arguments.
- `register()` for the `itsuki://` service-URI route (partial installation).
