-- Honest analytics v2: aggregate-only day counters. No raw IPs, user agents,
-- cookies, or per-visitor rows are ever stored — hashes are computed, counted,
-- and discarded; the salt rotates daily so a visitor cannot be tracked across
-- days even in theory.

-- Approximate unique visitors per day. sketch holds a HyperLogLog-lite set of
-- truncated daily-salted hashes; it is opaque and useless outside its own day.
CREATE TABLE IF NOT EXISTS visit_uniques (
	day TEXT NOT NULL,
	kind TEXT NOT NULL,
	sketch TEXT NOT NULL DEFAULT '',
	count INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (day, kind)
);

-- Aggregate dimension counters: referrer domain, country, device class, and
-- funnel steps all share one shape: (day, dim, value) -> count.
CREATE TABLE IF NOT EXISTS visit_dims (
	day TEXT NOT NULL,
	dim TEXT NOT NULL,
	value TEXT NOT NULL,
	count INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (day, dim, value)
);
