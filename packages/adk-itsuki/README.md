# adk-itsuki

Itsuki memory for [Google ADK](https://github.com/google/adk-python): a native
`BaseMemoryService`, plus the automatic capture ADK does not ship.

> **Status: unpublished.** This package has not been released to PyPI. The
> install command below will not work yet.

## Why the plugin exists

ADK has a memory *interface* but nothing that fills it. Searching the framework
for `add_session_to_memory` finds exactly two call sites: a convenience method
your own callback can call, and an HTTP endpoint a client must invoke. The dev
UI never calls either. So an ADK app gets retrieval for free and remembers
nothing unless the application writes the plumbing.

`ItsukiMemoryPlugin` is that plumbing, placed where it fires **once per
invocation** rather than once per agent.

## Requirements

| | |
|---|---|
| `google-adk` | **2.5.0 – 2.7.x** |
| Python | 3.10 – 3.13 |
| Runtime dependencies | `itsuki`, `google-adk` |

The floor is 2.5.0 for a specific reason: it is the first release whose normal
run path invokes `after_run_callback` under a `run_error` guard *and* exposes
`on_run_error_callback`. Below that, automatic capture and identity cleanup
cannot work. The ceiling is the highest minor actually tested, because ADK
ships breaking changes in minor releases.

## Use

```python
from google.adk.agents import LlmAgent
from google.adk.apps.app import App
from google.adk.runners import Runner
from google.adk.tools import preload_memory
from adk_itsuki import ItsukiMemoryService, ItsukiMemoryPlugin

memory = ItsukiMemoryService()          # reads ITSUKI_API_KEY
agent = LlmAgent(name="assistant", model="gemini-2.0-flash", tools=[preload_memory])

app = App(name="my_app", root_agent=agent, plugins=[ItsukiMemoryPlugin(service=memory)])
runner = Runner(app=app, app_name="my_app", session_service=..., memory_service=memory)
```

`preload_memory` gives you recall before every model call; the plugin gives you
capture after every settled turn.

### The `itsuki://` URI route is partial

```python
# services.py, next to your agent
import adk_itsuki
adk_itsuki.register()
```

```bash
adk web --memory_service_uri=itsuki://
```

This lets the CLI and dev UI *construct* the service. It does **not** attach
`preload_memory` or the capture plugin — ADK has no mechanism for a service to
do that. Treat it as a partial installation, not an automatic one.

## What gets remembered

Only the user's message and the **root agent's** final answer. Specifically
excluded: tool calls and their results, code execution, inline and file data,
sub-agent intermediate output, partial streaming events, and anything from an
invocation that errored or is still waiting on a long-running tool.

Attribution is by author name rather than by branch, because a `SequentialAgent`
child can keep the root branch. The root agent's name is recorded once per
invocation in session state (content-free) so that a restart, a delta import and
an explicit re-import all reach the same verdict. An invocation with no marker
is skipped rather than guessed at.

## Honest limits

- **Capture is durable to process life, not across restarts.** Pending chunks
  live in memory. Recovery is an explicit `add_session_to_memory(session)`,
  which regenerates identical idempotency keys, so re-importing costs nothing
  and duplicates nothing.
- **A root `SequentialAgent`'s children are not captured** unless they author
  under the root's name. That is deliberate: guessing which sub-agent output a
  person actually saw would be worse than remembering less.
- **`add_memory` is not implemented.** Direct memory writes are a surface we
  have not audited yet.
- **`user_id` is whatever your application passes.** Hashing it prevents
  encoding and delimiter attacks; it cannot prevent impersonation. Bind
  `user_id` to an authenticated principal in your own auth layer.
- **ADK 1.x is not supported.**

## Licence

Apache-2.0.
