"""Generate the cleanup SQL + vector-id list for exactly the objects this run created.

Why this is SQL and not API calls: every control route (delete-object,
delete-all, clean-junk) is gated by requireControlUser, which sets
allowTokenAuth: false. An `itsuki_live_` API key is refused with
403 token_not_allowed. Deletion is session-cookie only (the app UI) or the
legacy x-api-key admin path. So a key-holding integrator has no programmatic
delete at all, and cleanup for this run goes through D1 directly.

The SQL mirrors src/pipeline/cleanup.js deleteObject() exactly, with
suppress = false so no memory_suppressions rows are left behind:

  node   -> soft-delete node, its slices, its events, and every edge touching it
  page   -> soft-delete the page
  cand.  -> soft-delete the candidate

Nothing is hard-deleted and nothing outside the manifest is touched.
"""

from __future__ import annotations

import json
import pathlib
import sys

OUTDIR = pathlib.Path(r"C:\Users\ziyad\itsuki-loadtest\results")
USER = "user_f6e5dd30-2805-4fc2-a6a2-ecf1c925d9a9"


def q(v: str) -> str:
    return "'" + str(v).replace("'", "''") + "'"


def main() -> int:
    manifest = json.loads((OUTDIR / "cleanup_manifest.json").read_text(encoding="utf-8"))
    nodes = manifest["nodes"]
    pages = manifest["pages"]
    cands = manifest["candidates"]
    orphan_edges = manifest.get("edges_between_preexisting_nodes", [])

    stmts: list[str] = []
    u = q(USER)

    if nodes:
        ids = ", ".join(q(n) for n in nodes)
        stmts += [
            f"UPDATE nodes SET deleted_at = unixepoch()*1000 WHERE user_id = {u} AND id IN ({ids});",
            f"UPDATE slices SET deleted_at = unixepoch()*1000 WHERE user_id = {u} AND node_id IN ({ids});",
            f"UPDATE events SET deleted_at = unixepoch()*1000 WHERE user_id = {u} AND node_id IN ({ids});",
            f"UPDATE edges SET deleted_at = unixepoch()*1000 WHERE user_id = {u} "
            f"AND (from_node IN ({ids}) OR to_node IN ({ids}));",
            f"DELETE FROM manual_node_identities WHERE user_id = {u} AND node_id IN ({ids});",
            f"DELETE FROM manual_fact_identities WHERE user_id = {u} "
            f"AND (owner_node_id IN ({ids}) OR related_node_id IN ({ids}));",
            f"DELETE FROM node_topic_communities WHERE user_id = {u} AND node_id IN ({ids});",
            f"DELETE FROM manual_search_profiles WHERE user_id = {u} AND object_kind = 'node' AND object_id IN ({ids});",
        ]
    if pages:
        pids = ", ".join(q(p) for p in pages)
        stmts += [
            f"UPDATE memory_pages SET deleted_at = unixepoch()*1000 WHERE user_id = {u} AND id IN ({pids});",
            f"DELETE FROM manual_page_identities WHERE user_id = {u} AND page_id IN ({pids});",
            f"DELETE FROM manual_page_versions WHERE user_id = {u} AND page_id IN ({pids});",
            f"DELETE FROM manual_search_profiles WHERE user_id = {u} AND object_kind = 'page' AND object_id IN ({pids});",
        ]
    if cands:
        cids = ", ".join(q(c) for c in cands)
        stmts.append(f"UPDATE candidates SET deleted_at = unixepoch()*1000 WHERE user_id = {u} AND id IN ({cids});")

    # Edges the run added between two pre-existing nodes are NOT covered by the
    # node cascade, so they are targeted explicitly.
    if orphan_edges:
        eids = ", ".join(q(e) for e in orphan_edges)
        stmts.append(f"UPDATE edges SET deleted_at = unixepoch()*1000 WHERE user_id = {u} AND id IN ({eids});")

    sql_path = OUTDIR / "cleanup.sql"
    sql_path.write_text("\n".join(stmts) + "\n", encoding="utf-8")

    # Node vectors are keyed by node id; page vectors by "page:<id>".
    vec_ids = list(nodes) + [f"page:{p}" for p in pages]
    ndjson = "\n".join(json.dumps({"id": v}) for v in vec_ids)
    (OUTDIR / "vector_ids.ndjson").write_text(ndjson + "\n", encoding="utf-8")

    print(f"statements:        {len(stmts)}")
    print(f"nodes:             {len(nodes)}")
    print(f"pages:             {len(pages)}")
    print(f"candidates:        {len(cands)}")
    print(f"orphan edges:      {len(orphan_edges)}")
    print(f"vector ids:        {len(vec_ids)}")
    print(f"\nSQL      -> {sql_path}")
    print(f"vectors  -> {OUTDIR / 'vector_ids.ndjson'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
