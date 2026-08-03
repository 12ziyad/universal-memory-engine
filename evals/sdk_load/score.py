"""Score a completed load-test run: diff the graph, sample edges/nodes, and
assemble the raw material for the quality judgement.

This does the counting and the sampling. Classifying an edge as correct or
wrong is a judgement call made by reading the quoted output, not something
this script pretends to automate.
"""

from __future__ import annotations

import json
import pathlib
import random
import statistics
import sys

# The dataset carries non-ASCII place names; the Windows console defaults to
# cp1252 and would kill the run partway through printing the samples.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

OUTDIR = pathlib.Path(r"C:\Users\ziyad\itsuki-loadtest\results")
DATASET = pathlib.Path(__file__).resolve().parent / "dataset.json"
SEED = 20260803


def load(name):
    p = OUTDIR / name
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def main() -> int:
    before = load("before.json")
    after = load("after.json")
    summary = load("summary.json")
    data = json.loads(DATASET.read_text(encoding="utf-8"))
    calls = []
    cp = OUTDIR / "calls.jsonl"
    if cp.exists():
        calls = [json.loads(l) for l in cp.read_text(encoding="utf-8").splitlines() if l.strip()]

    if not (before and after):
        print("missing before/after snapshot")
        return 1

    # ---- what the run created -------------------------------------------
    new = {}
    for kind in ("nodes", "edges", "pages", "candidates", "slices", "events"):
        b, a = before.get(kind, {}), after.get(kind, {})
        new[kind] = {k: v for k, v in a.items() if k not in b}

    node_label = {**before["nodes"], **after["nodes"]}

    print("=" * 70)
    print("CREATED BY THIS RUN")
    print("=" * 70)
    for kind in ("nodes", "edges", "slices", "events", "pages", "candidates"):
        print(f"  {kind:11s} {len(new[kind]):4d}   (before {len(before.get(kind, {})):3d} -> after {len(after.get(kind, {})):3d})")

    n_nodes, n_edges = len(new["nodes"]), len(new["edges"])
    print(f"\n  edge:node ratio for new objects: {n_edges / n_nodes:.2f}" if n_nodes else "")

    # ---- saves in vs memories out ---------------------------------------
    durable = [m for m in data["messages"] if m["marker"] == "durable"]
    memories_out = sum(len(new[k]) for k in ("nodes", "slices", "events", "edges", "pages"))
    print(f"\n  durable messages in: {len(durable)}")
    print(f"  memory objects out:  {memories_out}")
    print(f"  objects per durable message: {memories_out / len(durable):.2f}")

    # ---- latency ---------------------------------------------------------
    print("\n" + "=" * 70)
    print("LATENCY (SDK call, ms)")
    print("=" * 70)
    by_kind = {}
    for c in calls:
        by_kind.setdefault(c["kind"], []).append(c["latency_ms"])
    for k, v in sorted(by_kind.items()):
        v = sorted(v)
        p50 = statistics.median(v)
        p95 = v[min(len(v) - 1, int(round(0.95 * (len(v) - 1))))]
        print(f"  {k:8s} n={len(v):3d}  p50={p50:7.0f}  p95={p95:7.0f}  min={v[0]:6.0f}  max={v[-1]:7.0f}")

    by_phase = {}
    for c in calls:
        by_phase.setdefault(c["phase"], []).append(c["latency_ms"])
    print("\n  by phase:")
    for k, v in sorted(by_phase.items()):
        v = sorted(v)
        print(f"    {k:16s} n={len(v):3d}  p50={statistics.median(v):7.0f}  max={v[-1]:7.0f}")

    # ---- errors ----------------------------------------------------------
    print("\n" + "=" * 70)
    print("ERRORS")
    print("=" * 70)
    errs = [c for c in calls if not c["ok"]]
    print(f"  {len(errs)} / {len(calls)} calls failed")
    causes = {}
    for e in errs:
        k = f"HTTP {e['error'].get('status')} / {e['error'].get('code')}"
        causes.setdefault(k, []).append(e)
    for k, v in sorted(causes.items()):
        print(f"    {k}: {len(v)}   e.g. {v[0]['error']['message'][:120]}")

    # success-but-wrote-nothing
    silent = [c for c in calls if c["ok"] and c.get("response", {}).get("outcome") in ("wrote",)
              and (c["response"].get("saved_total") or 0) == 0]
    print(f"\n  'wrote' receipts with savedTotal == 0: {len(silent)}")
    accepted = [c for c in calls if c["ok"] and c.get("response", {}).get("outcome") == "accepted"]
    print(f"  'accepted/processing' responses (enrichment deferred): {len(accepted)}")

    # ---- edge sample -----------------------------------------------------
    print("\n" + "=" * 70)
    print("EDGE SAMPLE (30, seeded) - classify each by reading it")
    print("=" * 70)
    rng = random.Random(SEED)
    edge_ids = sorted(new["edges"].keys())
    sample = rng.sample(edge_ids, min(30, len(edge_ids)))
    for i, eid in enumerate(sample, 1):
        e = new["edges"][eid]
        f = node_label.get(e["from"], {}).get("label", e["from"])
        t = node_label.get(e["to"], {}).get("label", e["to"])
        fact = e.get("fact") or ""
        val = ""
        if e.get("valid_at") or e.get("invalid_at"):
            val = f"   [valid_at={e.get('valid_at')} invalid_at={e.get('invalid_at')}]"
        print(f"  {i:2d}. {f} -[{e['type']}]-> {t}{val}")
        if fact:
            print(f"      fact: {fact}")

    # ---- node sample -----------------------------------------------------
    print("\n" + "=" * 70)
    print("NODE SAMPLE (30, seeded)")
    print("=" * 70)
    node_ids = sorted(new["nodes"].keys())
    nsample = rng.sample(node_ids, min(30, len(node_ids)))
    for i, nid in enumerate(nsample, 1):
        n = new["nodes"][nid]
        sl = [s["text"] for s in new["slices"].values() if s["node_id"] == nid][:2]
        ev = [s["text"] for s in new["events"].values() if s["node_id"] == nid][:2]
        print(f"  {i:2d}. {n['label']!r} ({n['category']})")
        for s in sl:
            print(f"      slice: {s[:120]}")
        for s in ev:
            print(f"      event: {s[:120]}")

    # ---- all new node labels, for gate scoring ---------------------------
    print("\n" + "=" * 70)
    print("ALL NEW NODE LABELS")
    print("=" * 70)
    labels = sorted(v["label"] for v in new["nodes"].values())
    for l in labels:
        print(f"  - {l}")

    # ---- scrubber check --------------------------------------------------
    print("\n" + "=" * 70)
    print("SCRUBBER CHECK (secrets must not appear anywhere)")
    print("=" * 70)
    needles = ["sk-live-4f9d2b8a1c6e3057fa2b9d4c",
               "ghp_9fKq2mZ7xLp4Rt8vNw1JbC3dY6hS0aG5eU2i",
               "Tr4d3W1nds99"]
    blob = json.dumps(after)
    for n in needles:
        print(f"  {'LEAKED' if n in blob else 'clean '}  {n[:24]}...")

    # ---- cleanup manifest -------------------------------------------------
    manifest = {
        "nodes": sorted(new["nodes"].keys()),
        "pages": sorted(new["pages"].keys()),
        "candidates": sorted(new["candidates"].keys()),
        "edges_new": sorted(new["edges"].keys()),
        "edges_between_preexisting_nodes": [
            eid for eid, e in new["edges"].items()
            if e["from"] in before["nodes"] and e["to"] in before["nodes"]
        ],
    }
    (OUTDIR / "cleanup_manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    print("\n" + "=" * 70)
    print("CLEANUP MANIFEST")
    print("=" * 70)
    print(f"  nodes to delete:      {len(manifest['nodes'])}")
    print(f"  pages to delete:      {len(manifest['pages'])}")
    print(f"  candidates to delete: {len(manifest['candidates'])}")
    print(f"  new edges:            {len(manifest['edges_new'])} (removed via node cascade)")
    print(f"  edges joining two PRE-EXISTING nodes: {len(manifest['edges_between_preexisting_nodes'])}"
          f"  <- these need direct D1, no API path")
    print(f"\n  written to {OUTDIR / 'cleanup_manifest.json'}")

    if summary:
        print("\n" + "=" * 70)
        print("TIMING")
        print("=" * 70)
        print(f"  write window: {summary['write_window_s']:.1f}s")
        print(f"  tail to clear: {summary['tail_to_clear_s']:.1f}s")
        writes = [c for c in calls if c["kind"] in ("add", "ingest")]
        if writes and summary["write_window_s"]:
            print(f"  write calls: {len(writes)}  -> {len(writes)/summary['write_window_s']:.2f} calls/s sustained")
    return 0


if __name__ == "__main__":
    sys.exit(main())
