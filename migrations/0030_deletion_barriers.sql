-- SRV-08: deletion barriers + the commit fence guard.
--
-- A confirmed unscoped bulk delete is an ERASURE: it records a per-tenant
-- barrier, and no extraction whose work was ACCEPTED before that barrier may
-- produce durable rows after it. The barrier row is the tombstone timestamp
-- (Cassandra semantics, adapted: late pre-barrier writes are refused with an
-- honest receipt rather than silently shadowed).
CREATE TABLE deletion_barriers (
	user_id TEXT PRIMARY KEY,
	barrier_at INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	by TEXT
);

-- Unsatisfiable by construction: `violation` can be neither NULL (NOT NULL)
-- nor non-NULL (CHECK), so no row can ever exist and ANY insert errors. A
-- writer puts a conditional INSERT into its atomic D1 batch: when the fence
-- condition is violated the INSERT produces a row, the constraint fires, and
-- the whole batch — graph rows included — rolls back.
CREATE TABLE fence_guard (
	violation INTEGER NOT NULL CHECK (violation IS NULL)
);
