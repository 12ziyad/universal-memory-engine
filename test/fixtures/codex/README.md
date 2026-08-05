# Codex transcript fixture

`0.146.0-alpha.9.2-lifecycle.jsonl` is a sanitized structural capture derived
from local Codex CLI `0.146.0-alpha.9.2` rollout transcripts on 2026-08-05.
Only envelope names, field placement, content-block types, roles, phases, and
call-ID relationships were retained from the observed format. All text, IDs,
commands, outputs, and encrypted bytes in this fixture are synthetic canaries.

The observed shapes include:

- `response_item.payload.type: message` with `user`/`assistant` roles,
  `commentary`/`final_answer` assistant phases, and `input_text`/`output_text`;
- `function_call`/`function_call_output` and
  `custom_tool_call`/`custom_tool_call_output` linked by `call_id`;
- duplicate `event_msg` user/agent messages;
- private `reasoning.encrypted_content`, developer messages, and session/meta
  rows that must never become capture text.

Codex documents `transcript_path` as convenient but explicitly unstable. The
fixture is therefore a regression sample, not a promise to accept unknown
future fields or payload types.
