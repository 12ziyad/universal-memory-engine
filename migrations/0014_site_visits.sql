-- Migration number: 0014 	 2026-07-31T00:00:02.000Z
-- First-party, privacy-safe visit counting: aggregate counters only.
-- No cookies, no IPs, no identifiers — one row per (day, page kind).

CREATE TABLE site_visits (
	day TEXT NOT NULL,
	kind TEXT NOT NULL,
	count INTEGER DEFAULT 0,
	PRIMARY KEY (day, kind)
);
