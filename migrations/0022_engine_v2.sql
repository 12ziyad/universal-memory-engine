-- Migration number: 0022 	 2026-08-02T00:00:00.000Z
-- Engine v2: bi-temporal truth and provenance.
--
-- Additive only, deliberately: this database has FTS5 virtual tables that
-- `wrangler d1 export` cannot serialize, so there is no SQL backup to fall
-- back on. Nothing here rewrites or drops existing data.
--
-- valid_at / invalid_at are WHEN THE FACT WAS TRUE IN THE WORLD, alongside
-- created_at (when we recorded it). A contradiction CLOSES the old validity
-- window (sets invalid_at); it never deletes the row — history stays
-- queryable, which the landing page promises.
--
-- fact: the sentence the edge asserts ("Kaka runs on Cloudflare Workers"),
-- from the v2 edge pass. Old edges keep NULL and render from type as before.
--
-- source_snippet: a capped, scrubbed excerpt of the message that produced the
-- object — enough to answer "why do you think that?", never a transcript.

ALTER TABLE edges ADD COLUMN valid_at INTEGER;
ALTER TABLE edges ADD COLUMN invalid_at INTEGER;
ALTER TABLE edges ADD COLUMN fact TEXT;
ALTER TABLE edges ADD COLUMN source_snippet TEXT;

ALTER TABLE events ADD COLUMN valid_at INTEGER;
ALTER TABLE events ADD COLUMN invalid_at INTEGER;
ALTER TABLE events ADD COLUMN source_snippet TEXT;

ALTER TABLE slices ADD COLUMN source_snippet TEXT;

CREATE INDEX idx_edges_validity ON edges(user_id, invalid_at);

-- Per-API-key memory rules (the SDK profile): a key may carry its own rules,
-- which sit between the account's rules and any per-request override.
ALTER TABLE connection_tokens ADD COLUMN rules_json TEXT;
