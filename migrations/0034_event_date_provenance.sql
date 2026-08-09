-- V3-D04: an event's date needs to say where it came from.
--
-- D03 fixed the parser so a date the extractor copied out of the source finally
-- reaches storage. Measuring that against LoCoMo showed no temporal improvement
-- at all, and the reason was downstream: recall renders an event as its `text`
-- and drops `happened_at`, so a correctly dated fact reaches the reader with no
-- date in it. Asked "when did Jon lose his job as a banker", the reader was
-- handed "Left job as a banker" and nothing else.
--
-- Rendering the date unconditionally would be worse than the bug. `happened_at`
-- has always fallen back to the message timestamp when nothing better was
-- known, so every event written before D03 carries ingest day. Printing those
-- as though they were real would assert a wrong date instead of omitting one,
-- and a confidently wrong date is the failure mode this campaign's temporal
-- work exists to prevent.
--
-- So the column records PROVENANCE, and recall renders a date only when the
-- provenance is trustworthy:
--
--   'extracted'    copied by the extractor from an explicit date in the source
--   'phrase'       resolved deterministically from a relative phrase against an
--                  authoritative anchor (src/pipeline/temporal.js)
--   'source_time'  the caller's authoritative write time (BF-1)
--   'observed'     fallback: when we were told, not when it happened
--
-- NULL means a row written before this migration. It is treated exactly as
-- 'observed' — unknown provenance is never promoted to trusted.

ALTER TABLE events ADD COLUMN happened_at_source TEXT;

-- Reading "which of this scope's events carry a trustworthy date" is a temporal
-- quality question we now ask often enough to index. Partial, so it costs
-- nothing for the rows that have no provenance recorded.
CREATE INDEX IF NOT EXISTS idx_events_happened_at_source
	ON events (user_id, happened_at_source)
	WHERE happened_at_source IS NOT NULL;
