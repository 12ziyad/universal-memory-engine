---
description: Verify Itsuki through its trusted hook, protected outbox, production REST path, and MCP lifecycle.
argument-hint: [--bind-outbox]
disable-model-invocation: true
---

The trusted Itsuki `UserPromptExpansion` hook must intercept every user-typed
`/itsuki:doctor` command and show the complete PASS/FAIL/WARN/SKIP report
directly. It is the only process in this flow that receives sensitive plugin
configuration.

If this fallback prompt reaches Claude, do not run Bash or any other tool and
do not claim that diagnostics passed. Tell the user exactly:

`FAIL  trusted doctor hook -- the UserPromptExpansion hook did not run. Confirm the Itsuki hook in /hooks, run /reload-plugins, and type /itsuki:doctor again.`

If protected entries need rebinding, only the user may confirm it by typing
`/itsuki:doctor --bind-outbox` directly. Never synthesize that slash command,
never run a script as a substitute, and never print or request the API key.
