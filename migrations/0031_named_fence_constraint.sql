-- SRV-09: make a fence trip identifiable BY CONSTRUCTION.
--
-- SQLite reports an unnamed CHECK failure by its expression
-- ("CHECK constraint failed: violation IS NULL"), which does not contain the
-- table name — so error classifiers matching /fence_guard/ never fired, and a
-- mid-commit fence trip was mislabelled db_write_failed (correct end state via
-- retry + pre-flight, but a dishonest receipt and a wasted retry cycle).
-- Naming the constraint puts "fence_guard" into the error text on every
-- SQLite. The table is empty by construction, so drop/recreate is safe.
DROP TABLE fence_guard;
CREATE TABLE fence_guard (
	violation INTEGER NOT NULL CONSTRAINT fence_guard_violation CHECK (violation IS NULL)
);
