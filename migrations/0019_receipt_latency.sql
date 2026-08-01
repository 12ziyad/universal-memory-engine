-- Migration number: 0019 	 2026-08-01T00:00:01.000Z
-- Three metadata columns the Requests page needs and receipts never recorded:
--
--   latency_ms  — how long the memory work took (extraction wall time for a
--                 save, lookup time for a recall). Not request time: what the
--                 person cares about is how long their memory took to answer.
--   matched     — how many memories a recall returned. A count, never content.
--   source_mode — which door it came through (manual_direct, auto_ingest,
--                 playground, turn...). It only existed inside the `detail`
--                 JSON, and that blob also holds the person's own words, so
--                 the Requests page could not read it without reading content.
--
-- All additive and nullable, so every existing receipt stays valid.

ALTER TABLE receipts ADD COLUMN latency_ms INTEGER;
ALTER TABLE receipts ADD COLUMN matched INTEGER;
ALTER TABLE receipts ADD COLUMN source_mode TEXT;
