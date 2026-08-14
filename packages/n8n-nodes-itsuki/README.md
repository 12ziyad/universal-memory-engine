# n8n-nodes-itsuki

Long-term memory for n8n workflows and AI Agents, backed by [Itsuki](https://itsuki.app). Save durable facts in one run, recall them in any later run, and hand memory to an AI Agent as a tool it calls itself.

This is a community node for **self-hosted n8n**. n8n Cloud carries only nodes n8n has verified; until that happens, Cloud users can connect Itsuki with the built-in HTTP Request or MCP Client Tool nodes instead — see the [Itsuki n8n guide](https://itsuki.app/docs/#/integrations/n8n).

## Install

In n8n: **Settings → Community Nodes → Install**, enter `n8n-nodes-itsuki`, acknowledge the risk notice, install. Only instance owners can install community nodes.

## Credential

Create an **Itsuki API** credential with a project key from the [Itsuki dashboard](https://itsuki.app) (API Keys). The key travels only as an `Authorization` header — never in URLs, exports, or logs. The built-in credential test calls a content-free status endpoint. Base URL stays `https://itsuki.app` unless you run a development server (HTTPS required; plain HTTP only for localhost).

## Operations

| Operation | What it does |
|---|---|
| Save Memory | Store one durable fact. Returns the real receipt. |
| Save Conversation | Store a batch of chat messages (≤30, order preserved) for extraction, with optional narrowing (last-N / topic / summary). |
| Recall Memory | Semantic recall: a prompt-ready `context` string plus structured items. Zero results is a result, not an error. |
| List Memories | One page, or Return All with bounded automatic pagination (hard cap, loop detection). |
| Get Memory | Fetch one memory by prefixed ID. |
| Delete Memory | Delete one memory by ID. Destructive; a missing ID is an error, never a silent success. |
| Delete All Memories | **Previews by default.** Destroys only with the explicit Confirm Destruction toggle. |
| Who Am I | Connection health, identity, and plan usage. Never memory content, never the key. |
| Wait for Packet | Poll a save receipt until extraction settles. |

**Wait for Completion** is on by default for both save operations: extraction is asynchronous, and waiting means the next node sees the settled state. On timeout the output says, honestly, that the save was **accepted and still processing** — a timeout is not a failure.

## Use as an AI Agent tool

The node is `usableAsTool`. Attach one node set to **Recall Memory** and one set to **Save Memory** (or Save Conversation) to a Tools Agent; keep the User ID stable across both. On self-hosted n8n, community nodes additionally require the environment variable `N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true` to appear as tools.

Destructive operations are deliberately unattractive as tools: the node defaults to Recall, Delete All previews unless a human enables Confirm Destruction, and nothing auto-escalates.

## Scoping

Tenancy comes from the credential (one key = one project) and can never be widened by a request. Optional fields narrow attribution: **User ID** isolates one end user's memory space under your key (use the same stable value on save and recall), and Conversation/Thread/Source IDs record where a memory came from.

Deliberately absent, because the backend governs them at the project level rather than per call: per-request extraction instructions, custom categories, verbatim (no-inference) storage, and arbitrary metadata. What extraction keeps is project policy in Itsuki, not a per-call knob. There is also no Update operation yet — the backend has no safe versioned-correction contract, and this node does not fake one.

## Reliability

Bounded timeouts; cancellation propagates to in-flight requests and backoff sleeps; `Retry-After` is honoured exactly; reads retry with jittered backoff; writes retry only when an Idempotency Key protects them; deletes never retry. Rate-limit (429), quota, and backlog responses map to named, friendly errors with no secrets in them.

## License

Apache-2.0
