---
description: Check the Itsuki memory connection — key, network, hooks door, MCP door — and report exactly what is broken and how to fix it.
---

Run the Itsuki connection check and relay its results.

1. Execute with the Bash tool:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs"
```

2. Show the user every PASS/FAIL/SKIP line verbatim — do not summarize them away.
3. If anything failed, restate the printed fix as the next action. If all four passed, tell the user Itsuki is fully connected and no further setup is needed.
4. Never print, echo, or log the value of ITSUKI_API_KEY.
