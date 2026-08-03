"""Edge-quality scorer (Part 6.7). Pulls a tenant's edges and measures them
against evals/edge_gold/gold.json. MEASURES precision/recall — never gates.

    python evals/edge_gold/score.py <tenant-user-id>

Precision here is mechanical: an edge is CORRECT if its endpoints match a gold
relation (label containment, either direction noted) and its type is in the
gold class; WRONG if it hits a known-wrong pattern (org/place endpoint abuse);
otherwise UNGRADED (a human judges those — this script never pretends to).
"""
from __future__ import annotations

import json
import pathlib
import re
import sys

sys.path.insert(0, r"C:\Users\ziyad\uml\sdk\python")
from itsuki import MemoryClient

GOLD = json.loads((pathlib.Path(__file__).parent / "gold.json").read_text(encoding="utf-8"))
KEY = pathlib.Path(r"C:\Users\ziyad\.itsuki_key").read_text(encoding="utf-8").strip()


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9 ]", "", str(s or "").lower()).strip()


def label_match(a: str, b: str, fuzzy: bool = False) -> bool:
    na, nb = norm(a), norm(b)
    if not na or not nb:
        return False
    if na == nb or na in nb or nb in na:
        return True
    if fuzzy:
        ta, tb = set(na.split()), set(nb.split())
        return len(ta & tb) > 0
    return False


def main() -> int:
    tenant = sys.argv[1] if len(sys.argv) > 1 else None
    c = MemoryClient(api_key=KEY, user_id=tenant, timeout=120.0)
    g = c.graph()
    labels = {n["id"]: n["label"] for n in g.get("nodes", [])}
    cats = {n["id"]: n.get("category") for n in g.get("nodes", [])}
    edges = [
        {
            "from": labels.get(e["from_node"], "?"),
            "from_cat": cats.get(e["from_node"]),
            "to": labels.get(e["to_node"], "?"),
            "to_cat": cats.get(e["to_node"]),
            "type": str(e.get("type", "")).upper(),
            "fact": e.get("fact"),
        }
        for e in g.get("edges", [])
    ]

    classes = GOLD["type_classes"]
    expected = GOLD["expected"]

    matched_gold = set()
    correct, wrong, ungraded = [], [], []
    for e in edges:
        graded = False
        for i, exp in enumerate(expected):
            types = classes[exp["class"]]
            straight = label_match(e["from"], exp["from"]) and label_match(e["to"], exp["to"], exp.get("to_fuzzy", False))
            reverse = label_match(e["from"], exp["to"], exp.get("to_fuzzy", False)) and label_match(e["to"], exp["from"])
            if (straight or reverse) and e["type"] in types:
                if reverse and exp["class"] not in ("marriage", "family", "partner"):
                    wrong.append({**e, "why": f"reversed direction of gold #{i}"})
                else:
                    correct.append({**e, "gold": i})
                    matched_gold.add(i)
                graded = True
                break
        if graded:
            continue
        # known-wrong patterns: org doing person-verbs at a place
        person_only = {"WORKS_AT", "EMPLOYED_AT", "LIVES_IN", "MARRIED_TO", "REPORTS_TO"}
        if e["type"] in person_only and e["from_cat"] in ("organization", "place", "project", "tool", "system"):
            wrong.append({**e, "why": f"{e['from_cat']} cannot {e['type']}"})
            continue
        ungraded.append(e)

    graded_n = len(correct) + len(wrong)
    required = [i for i, exp in enumerate(expected) if not exp.get("optional")]
    recall_hit = [i for i in required if i in matched_gold]
    node_labels = [norm(l) for l in labels.values()]
    nodes_present = [n for n in GOLD["expected_nodes"] if any(norm(n) in l or l in norm(n) for l in node_labels)]

    print(f"tenant: {tenant}")
    print(f"edges total: {len(edges)}  graded: {graded_n}  ungraded (human judgement): {len(ungraded)}")
    if graded_n:
        print(f"MEASURED precision on graded set: {len(correct)}/{graded_n} = {len(correct)/graded_n:.0%}")
    print(f"MEASURED gold-relation recall: {len(recall_hit)}/{len(required)} = {len(recall_hit)/len(required):.0%}")
    print(f"expected nodes present: {nodes_present} ({len(nodes_present)}/{len(GOLD['expected_nodes'])})")
    missing = [expected[i] for i in required if i not in matched_gold]
    if missing:
        print("missing gold relations:")
        for m in missing:
            print(f"  - {m['from']} -[{m['class']}]-> {m['to']}  (from {m['source']})")
    if wrong:
        print("wrong edges:")
        for w in wrong:
            print(f"  - {w['from']} -[{w['type']}]-> {w['to']}  ({w['why']})")
    print("\nungraded sample (first 10, judge by reading):")
    for e in ungraded[:10]:
        print(f"  - {e['from']} -[{e['type']}]-> {e['to']}  fact={e['fact']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
