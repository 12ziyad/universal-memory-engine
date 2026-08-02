-- Migration number: 0024 	 2026-08-02T12:00:00.000Z
-- MCP saves move onto Engine v2, receipt-first.
--
-- enrich_status is the honest-receipt contract: a page written by the MCP
-- sync phase is 'staged' (facts and relationships still extracting in the
-- background), then 'enriched' when the graph landed, or 'failed' with the
-- reason on the matching memory_jobs row. Pages from every other lane keep
-- NULL and behave exactly as before. Additive only — this database has FTS5
-- virtual tables that block full SQL exports, so nothing here rewrites rows.

ALTER TABLE memory_pages ADD COLUMN enrich_status TEXT;

CREATE INDEX idx_memory_pages_enrich_status
	ON memory_pages(user_id, enrich_status);
