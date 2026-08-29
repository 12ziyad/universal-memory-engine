# Security Policy

## Reporting a vulnerability

Please do **not** open a public issue for a security vulnerability.

- Email **founder@itsuki.app** with the subject **"SECURITY"**, or
- use [GitHub private vulnerability reporting](https://github.com/12ziyad/universal-memory-engine/security) on this repository.

Include what you found, where, reproduction steps, and the impact as you
understand it. You will get an acknowledgment, usually within a few days and often much faster — reports go
directly to the operator.

## Scope and rules

The full policy — scope, rules of engagement, and the safe-harbor commitment
for good-faith research — is published at
**https://itsuki.app/disclosure**, and `https://itsuki.app/.well-known/security.txt`
points there.

The short version: test only against your own accounts and data, never touch
another tenant's, no denial-of-service, and good-faith research under the
policy is authorized — we will not pursue legal action for it.

## Supported versions

The hosted service at itsuki.app runs the current development line, which is
often AHEAD of what is published to the public repository — a fix can be live
in production before the commit that carries it is visible on GitHub. Security
fixes land in the hosted service first; there are no maintained older release
lines. If you are checking a claim against the source and the code you can see
does not match the behaviour you observe, the published tree is behind: say so
in your report and we will confirm what is deployed.
