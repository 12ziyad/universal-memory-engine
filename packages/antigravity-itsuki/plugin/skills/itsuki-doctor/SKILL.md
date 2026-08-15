---
name: itsuki-doctor
description: Check the Itsuki memory connection and report what is queued, held, or misconfigured. Use when memory does not appear to be working.
---

# Itsuki doctor

Run the diagnostic and report its output verbatim:

```bash
npx antigravity-itsuki@latest doctor
```

It reports, without ever printing the API key:

- whether a credential is present and where it came from (environment or the protected file)
- the detected Antigravity CLI version and whether it meets the supported floor
- how many memories are queued for delivery, and whether any are quarantined
- which lifecycle behaviours are currently HELD, and why

If it reports that automatic capture is held pending a verified transcript
schema, that is expected on this release: the transcript format is not publicly
documented and has not yet been verified against a live host. Recall and the
manual routes are unaffected.
