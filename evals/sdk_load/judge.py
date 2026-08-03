"""Live quality judgement: multi-hop recall, supersede/bi-temporal behaviour.

Reads the after-snapshot for structure and asks production the multi-hop
questions. Prints raw output for judgement rather than scoring itself.
"""

from __future__ import annotations

import json
import pathlib
import sys

from itsuki import MemoryClient

OUTDIR = pathlib.Path(r"C:\Users\ziyad\itsuki-loadtest\results")
DATASET = pathlib.Path(__file__).resolve().parent / "dataset.json"
KEY_PATH = pathlib.Path(r"C:\Users\ziyad\.itsuki_key")


def main() -> int:
    data = json.loads(DATASET.read_text(encoding="utf-8"))
    before = json.loads((OUTDIR / "before.json").read_text(encoding="utf-8"))
    after = json.loads((OUTDIR / "after.json").read_text(encoding="utf-8"))
    client = MemoryClient(api_key=KEY_PATH.read_text(encoding="utf-8").strip())

    labels = {**before["nodes"], **after["nodes"]}
    new_nodes = {k: v for k, v in after["nodes"].items() if k not in before["nodes"]}
    new_edges = {k: v for k, v in after["edges"].items() if k not in before["edges"]}
    new_slices = {k: v for k, v in after["slices"].items() if k not in before["slices"]}

    print("=" * 70)
    print("SUPERSEDE / BI-TEMPORAL")
    print("=" * 70)

    closed = {k: e for k, e in new_edges.items() if e.get("invalid_at")}
    print(f"\nedges with a CLOSED validity window (invalid_at set): {len(closed)} of {len(new_edges)}")
    for e in closed.values():
        f = labels.get(e["from"], {}).get("label", e["from"])
        t = labels.get(e["to"], {}).get("label", e["to"])
        print(f"  {f} -[{e['type']}]-> {t}  valid_at={e.get('valid_at')} invalid_at={e.get('invalid_at')}")

    dated = {k: e for k, e in new_edges.items() if e.get("valid_at")}
    print(f"\nedges carrying valid_at: {len(dated)} of {len(new_edges)}")

    superseded = {k: s for k, s in new_slices.items() if not s.get("is_current")}
    print(f"\nslices marked NOT current (superseded, history retained): {len(superseded)} of {len(new_slices)}")
    for s in list(superseded.values())[:15]:
        lbl = labels.get(s["node_id"], {}).get("label", s["node_id"])
        print(f"  [{lbl}] {s['text'][:110]}")

    print("\n--- the 7 declared temporal changes, and what the graph holds ---")
    probes = [
        ("employer", ["Cabo Verde", "Meridian"]),
        ("manager", ["Rui Salgado", "Nils Andersen"]),
        ("city", ["Lisbon", "Rotterdam"]),
        ("swim club", ["Tagus", "Maas"]),
        ("class day", ["Tuesday", "Thursday"]),
        ("drink", ["coffee", "rooibos"]),
        ("shoulder", ["shoulder", "recovered"]),
    ]
    for name, needles in probes:
        hits = []
        for s in new_slices.values():
            if any(n.lower() in s["text"].lower() for n in needles):
                lbl = labels.get(s["node_id"], {}).get("label", "?")
                hits.append(f"[{lbl}] cur={s.get('is_current')} {s['text'][:80]}")
        for e in new_edges.values():
            f = labels.get(e["from"], {}).get("label", "")
            t = labels.get(e["to"], {}).get("label", "")
            blob = f"{f} {t} {e.get('fact') or ''}"
            if any(n.lower() in blob.lower() for n in needles):
                hits.append(f"EDGE {f} -[{e['type']}]-> {t} inval={e.get('invalid_at')}")
        print(f"\n  * {name}: {len(hits)} matching objects")
        for h in hits[:6]:
            print(f"      {h}")

    print("\n" + "=" * 70)
    print("MULTI-HOP RECALL")
    print("=" * 70)
    for i, q in enumerate(data["multi_hop_questions"], 1):
        try:
            r = client.search(q)
        except Exception as exc:  # noqa: BLE001
            print(f"\n{i}. {q}\n   ERROR: {exc}")
            continue
        ctx = (r.get("context") or "").strip()
        print(f"\n{i}. Q: {q}")
        print(f"   mode={r.get('recall_mode')} matched={r.get('count')}")
        print("   context:")
        for line in ctx.splitlines()[:8]:
            print(f"     {line[:150]}")
        if not ctx:
            print("     (empty)")

    print("\n" + "=" * 70)
    print("NEW NODE / EDGE TOTALS")
    print("=" * 70)
    print(f"  new nodes: {len(new_nodes)}  new edges: {len(new_edges)}  new slices: {len(new_slices)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
