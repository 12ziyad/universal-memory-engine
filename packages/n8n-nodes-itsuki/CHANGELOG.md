# Changelog

## 0.2.0

- New operations: **Update Memory** (optimistic-concurrency correction with a
  required Expected Revision — stale revisions are refused, never overwritten),
  **Memory History** (bounded revision history), and **Rollback Memory**
  (restore an earlier revision as a new forward revision).
- Idempotency keys are always sent for update/rollback (auto-generated when
  the Additional Field is empty).

## 0.1.0 (unpublished)

First release: nine operations (Save Memory, Save Conversation, Recall, List with bounded Return All, Get, Delete, preview-first Delete All, Who Am I, Wait for Packet), Itsuki API credential with content-free connection test, wait-for-completion on saves by default with honest timeout semantics, Retry-After-aware retries gated on idempotency, cancellation propagation, and secret redaction on every error path. `usableAsTool` for n8n AI Agents.
