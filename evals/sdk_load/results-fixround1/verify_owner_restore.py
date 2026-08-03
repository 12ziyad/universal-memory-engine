"""Verify the owner account is back to its pre-run state.

    python evals/sdk_load/results-fixround1/verify_owner_restore.py

Compares live state against owner_account_snapshot.json: counts first, then
every node's label and summary, then a residue grep for dataset entities.
Exit code 0 only if all three agree.
"""
from __future__ import annotations

import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[3] / "sdk" / "python"))
from itsuki import MemoryClient  # noqa: E402

SNAP = pathlib.Path(__file__).with_name("owner_account_snapshot.json")
KEY_PATH = pathlib.Path.home() / ".itsuki_key"

FICTION = ["Meridian", "Cabo Verde", "Yusuf", "Marta Coelho", "Halyard",
           "Atelier Barro", "Ines Barbosa", "Teodor", "Rui Salgado", "Nils Andersen"]


def main() -> int:
    snap = json.loads(SNAP.read_text(encoding="utf-8"))
    c = MemoryClient(api_key=KEY_PATH.read_text(encoding="utf-8").strip(), timeout=180.0)
    g = c.graph()
    problems = []

    for key, want in snap["stats"].items():
        got = g["stats"].get(key)
        if got != want:
            problems.append(f"{key}: expected {want}, found {got}")

    live_nodes = {n["id"]: n for n in g.get("nodes", [])}
    for nid, base in snap["nodes"].items():
        now = live_nodes.get(nid)
        if not now:
            problems.append(f"node MISSING: {base['label']}")
            continue
        if now.get("label") != base.get("label"):
            problems.append(f"node label changed: {base['label']} -> {now.get('label')}")
        if (now.get("summary") or "") != (base.get("summary") or ""):
            problems.append(f"node summary changed: {base['label']}")

    blob = json.dumps(g, ensure_ascii=False)
    residue = [f for f in FICTION if f in blob]
    if residue:
        problems.append(f"dataset residue still present: {residue}")

    print("live :", json.dumps(g["stats"]))
    print("snap :", json.dumps(snap["stats"]))
    if problems:
        print(f"\nNOT RESTORED — {len(problems)} problem(s):")
        for p in problems:
            print(f"  - {p}")
        return 1
    print(f"\nRESTORED EXACTLY — counts, all {len(snap['nodes'])} node labels + summaries, zero residue.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
