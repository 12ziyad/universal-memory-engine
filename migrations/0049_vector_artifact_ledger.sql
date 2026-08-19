-- Migration number: 0049 	 2026-08-19
-- Corrective: a durable ledger of every physical vector artifact ever submitted.
--
-- Revision-qualified vector ids (`<objectId>#rN`) made ordering safe, but left
-- deletion guessing: cleanup enumerated a fixed window of recent revisions, so
-- a gapped artifact (r25, r50) survived canonical deletion — deleted customer
-- content persisting in a search index. Guessing is not deletion.
--
-- This table is the authority for "what did we actually put in Vectorize".
-- Every submission records a row; every deletion path enumerates from it with
-- keyset iteration until nothing remains. It also closes the late-write race:
-- an upsert that becomes visible AFTER the canonical row is gone is still
-- listed here, so the reconciler finds and removes it.
--
-- Content-free by construction: ids, revisions and provider mutation handles
-- only. No labels, no summaries, no embeddings.

CREATE TABLE memory_vector_artifacts (
	user_id TEXT NOT NULL,
	object_id TEXT NOT NULL,
	vector_id TEXT NOT NULL,
	-- NULL for a legacy bare id written before the revision-qualified scheme.
	revision INTEGER,
	-- submitted: upsert accepted by the provider, visibility unconfirmed
	-- live:      readback confirmed
	-- orphaned:  canonical row is gone; must be deleted from the provider
	-- deleted:   provider delete issued and confirmed absent
	state TEXT NOT NULL DEFAULT 'submitted',
	mutation_id TEXT,
	attempts INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (user_id, vector_id)
);

-- Deletion enumerates by object, in keyset order over vector_id.
CREATE INDEX idx_vector_artifacts_object ON memory_vector_artifacts(user_id, object_id, vector_id);
-- The reconciler scans by state, oldest first.
CREATE INDEX idx_vector_artifacts_state ON memory_vector_artifacts(state, updated_at);
