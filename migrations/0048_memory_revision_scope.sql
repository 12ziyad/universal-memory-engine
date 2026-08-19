-- Migration number: 0048 	 2026-08-19
-- Corrective: scope the revision-history uniqueness invariant to the tenant
-- AND the object kind.
--
-- 0047 created `idx_memory_revisions_object_rev` on (object_id, revision).
-- That is a GLOBAL constraint: two memory spaces that ever hold the same
-- object id — possible via restore, import, or a future id scheme — would
-- collide across tenants, and it also assumes object ids are unique across
-- kinds. The invariant that is actually true is per (user, kind, object,
-- revision).
--
-- Backward compatible: the new unique index is strictly WEAKER than the old
-- one, so every row that satisfied 0047 satisfies this. Creating it before
-- dropping the old one means no window exists in which uniqueness is
-- unenforced. 0047 is not edited.

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_revisions_scope_rev
	ON memory_revisions(user_id, object_kind, object_id, revision);

DROP INDEX IF EXISTS idx_memory_revisions_object_rev;

-- The history read path filters by (user_id, object_kind, object_id) and
-- orders by revision; make that the covering lookup.
CREATE INDEX IF NOT EXISTS idx_memory_revisions_scope_lookup
	ON memory_revisions(user_id, object_kind, object_id, revision DESC);

DROP INDEX IF EXISTS idx_memory_revisions_user_object;
