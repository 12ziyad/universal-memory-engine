# Changelog

## 0.1.0 — unreleased

First implementation of the native Hermes Agent memory provider. Not yet
published to PyPI.

- Recall bounded by count, characters and a 3-second budget, identified by a
  provider-local RXID so an asynchronous session switch can never make it stale.
- Capture staged to an authority-partitioned spool before any network call, and
  delivered under a content-derived idempotency key.
- Read-only tool surface: `itsuki_recall`, `itsuki_status`.
- `hermes-itsuki install | doctor | uninstall [--purge]`.
