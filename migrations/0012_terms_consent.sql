-- Migration number: 0012 	 2026-07-31T00:00:00.000Z
-- DPDP-style recorded consent: when the user affirmatively accepted the
-- Terms of Service and Privacy Policy at signup.

ALTER TABLE users ADD COLUMN terms_accepted_at INTEGER;
