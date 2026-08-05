# Sanitized Claude Code transcript fixtures

These JSONL fixtures preserve the row keys, content-block topology, and
tool-use/result pairing observed in local Claude Code 2.1.219 and 2.1.221
transcripts on 2026-08-05. Every prompt, response, command, path, UUID, tool
result, signature, and credential-shaped value was replaced with synthetic
test data before the fixture was committed. No raw personal transcript content
is present.

The fixtures intentionally include a synthetic private-reasoning sentinel and
a synthetic credential. Tests assert that neither can leave the capture
boundary.
