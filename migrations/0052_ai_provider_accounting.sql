-- Migration number: 0052 	 2026-08-22T00:00:00.000Z
-- Multi-provider AI accounting (Phase 0A of the provider-adapter campaign).
--
-- ai_calls learns which provider/capability served a call and how it ended.
-- Every column is nullable on purpose: NULL reads as the legacy meaning
-- (Workers AI, primary role, no normalized error), so no historical row
-- changes meaning and nothing is backfilled. The billed-unit rule is
-- unchanged — a unit column only ever holds a number the provider reported.
ALTER TABLE ai_calls ADD COLUMN provider TEXT;
ALTER TABLE ai_calls ADD COLUMN capability TEXT;
ALTER TABLE ai_calls ADD COLUMN model_version TEXT;
ALTER TABLE ai_calls ADD COLUMN error_class TEXT;
ALTER TABLE ai_calls ADD COLUMN retry_count INTEGER;
ALTER TABLE ai_calls ADD COLUMN call_role TEXT;

-- Provider-sliced reads (admin card "last 50 per provider", per-day spend).
CREATE INDEX idx_ai_calls_provider_day ON ai_calls(provider, created_at);
