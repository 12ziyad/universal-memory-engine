-- V3 / BF-1: the authoritative source-time contract.
--
-- Itsuki already recorded `received_at` — when we were handed the content. It
-- had no way to be told when the content was WRITTEN, so a relative phrase
-- ("yesterday", "last week") had nothing to resolve against except extraction
-- day. That is the leading explanation for temporal recall at 6.23%.
--
-- Three columns, all nullable, all additive. Every packet written before this
-- migration keeps NULL and behaves exactly as it did.
--
--   source_time                 UTC instant, epoch milliseconds.
--   source_time_offset_minutes  The offset the caller wrote it in. Kept, not
--                               folded away: "yesterday" said at 00:30+09:00
--                               means the previous LOCAL day, and the UTC date
--                               of that instant is a different day.
--                               NULL means a bare calendar date with no zone.
--   source_time_precision       'day' for YYYY-MM-DD, 'time' otherwise. A date
--                               without a time is never promoted to midnight.

ALTER TABLE source_packets ADD COLUMN source_time INTEGER;
ALTER TABLE source_packets ADD COLUMN source_time_offset_minutes INTEGER;
ALTER TABLE source_packets ADD COLUMN source_time_precision TEXT;

-- Ordering a scope's packets by when their content was written, not by when we
-- happened to receive it. Partial so the index costs nothing for the packets
-- that carry no source time.
CREATE INDEX IF NOT EXISTS idx_source_packets_source_time
	ON source_packets (user_id, source_time)
	WHERE source_time IS NOT NULL;
