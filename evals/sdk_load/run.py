"""SDK load test against production itsuki.app, using the PUBLISHED PyPI package.

Run with the venv interpreter from the clean directory outside the repo, e.g.

    C:\\Users\\ziyad\\itsuki-loadtest\\.venv\\Scripts\\python.exe evals\\sdk_load\\run.py

Design notes that matter for reading the numbers:

* sys.path[0] is THIS directory, which contains no `itsuki` package, so
  `import itsuki` resolves to site-packages. Asserted at startup — the whole
  point is to exercise the published wheel, not sdk/python.
* SAVE_LIMITER is 60 requests / 60s per user, so sustained throughput is
  limiter-bound, not engine-bound. Phases are paced accordingly; the two
  bursts deliberately probe what happens at the edge.
* Writes are NOT given an idempotencyKey except in the explicit duplicate
  phase. 0.1.1 only retries writes that carry one, so leaving it off means a
  429 surfaces as a real error instead of being silently retried inside the
  SDK — which is what we want to measure.
* The API key is read from disk and never printed.
"""

from __future__ import annotations

import json
import os
import pathlib
import statistics
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import itsuki
from itsuki import MemoryClient, MemoryAPIError

KEY_PATH = pathlib.Path(r"C:\Users\ziyad\.itsuki_key")
HERE = pathlib.Path(__file__).resolve().parent
DATASET = HERE / "dataset.json"
OUTDIR = pathlib.Path(r"C:\Users\ziyad\itsuki-loadtest\results")
EXPECTED_USER = "user_f6e5dd30-2805-4fc2-a6a2-ecf1c925d9a9"

_log_lock = threading.Lock()
CALLS: list[dict] = []


def now_ms() -> int:
    return int(time.time() * 1000)


def log_call(phase: str, kind: str, sent_at: int, started: float, result=None, error=None, meta=None) -> dict:
    """One row per SDK call. Never contains the API key."""
    entry = {
        "phase": phase,
        "kind": kind,
        "sent_at": sent_at,
        "latency_ms": int((time.perf_counter() - started) * 1000),
        "ok": error is None,
        "meta": meta or {},
    }
    if error is not None:
        entry["error"] = {
            "type": type(error).__name__,
            "status": getattr(error, "status", None),
            "code": getattr(error, "code", None),
            "message": str(error)[:300],
        }
    if isinstance(result, dict):
        receipt = result.get("receipt") or {}
        entry["response"] = {
            "outcome": receipt.get("outcome"),
            "processing": result.get("processing"),
            "fired": result.get("fired"),
            "summary": (result.get("summary") or "")[:200],
            "receipt_id": result.get("receipt_id"),
            "source_packet_id": result.get("source_packet_id"),
            "extraction_run_id": receipt.get("extraction_run_id"),
            "saved_total": receipt.get("savedTotal"),
            "saved": receipt.get("saved"),
            "held": result.get("held"),
            "skipped": result.get("skipped"),
            "page_id": result.get("page_id"),
        }
    with _log_lock:
        CALLS.append(entry)
    return entry


def call(client: MemoryClient, phase: str, kind: str, fn, meta=None):
    sent = now_ms()
    started = time.perf_counter()
    try:
        res = fn()
        return log_call(phase, kind, sent, started, result=res, meta=meta)
    except MemoryAPIError as exc:
        return log_call(phase, kind, sent, started, error=exc, meta=meta)
    except Exception as exc:  # noqa: BLE001 - we want every failure shape recorded
        return log_call(phase, kind, sent, started, error=exc, meta=meta)


def snapshot(client: MemoryClient) -> dict:
    """Full graph snapshot, used for before/after diffing and cleanup targeting."""
    g = client.graph()
    return {
        "at": now_ms(),
        "stats": g.get("stats"),
        "nodes": {n["id"]: {"label": n.get("label"), "category": n.get("category")} for n in g.get("nodes", [])},
        "edges": {
            e["id"]: {
                "from": e.get("from_node"),
                "to": e.get("to_node"),
                "type": e.get("type"),
                "fact": e.get("fact"),
                "valid_at": e.get("valid_at"),
                "invalid_at": e.get("invalid_at"),
            }
            for e in g.get("edges", [])
        },
        "pages": {p["id"]: {"title": p.get("title")} for p in g.get("pages", [])},
        "candidates": {c["id"]: {"label": c.get("label")} for c in g.get("candidates", [])},
        "slices": {
            s["id"]: {"node_id": n["id"], "text": s.get("text"), "is_current": s.get("is_current")}
            for n in g.get("nodes", [])
            for s in (n.get("slices") or [])
        },
        "events": {
            ev["id"]: {"node_id": n["id"], "text": ev.get("text")}
            for n in g.get("nodes", [])
            for ev in (n.get("events") or [])
        },
    }


def main() -> int:
    OUTDIR.mkdir(parents=True, exist_ok=True)

    # --- guardrail: the published wheel, not the local source ---------------
    if "site-packages" not in itsuki.__file__:
        print(f"ABORT: itsuki resolved to {itsuki.__file__} (expected site-packages)")
        return 2
    print(f"SDK: itsuki {itsuki.VERSION} from site-packages")
    print(f"base URL default: {itsuki.DEFAULT_BASE_URL}")

    key = KEY_PATH.read_text(encoding="utf-8").strip()
    client = MemoryClient(api_key=key)

    data = json.loads(DATASET.read_text(encoding="utf-8"))
    msgs = {m["id"]: m for m in data["messages"]}
    order = [m["id"] for m in data["messages"]]

    def wire(ids):
        return [{"id": i, "role": "user", "content": msgs[i]["content"]} for i in ids]

    # --- before state -------------------------------------------------------
    before = snapshot(client)
    print("BEFORE:", json.dumps(before["stats"]))
    (OUTDIR / "before.json").write_text(json.dumps(before, indent=1), encoding="utf-8")

    run_started = now_ms()

    # === Phase A: sequential steady, ingest batches of 4, ~1.5s apart =======
    phase_a = order[0:60]
    batches = [phase_a[i:i + 4] for i in range(0, len(phase_a), 4)]
    print(f"\n[A] sequential steady: {len(batches)} ingest calls, 4 msgs each, 1.5s apart")
    for b in batches:
        call(client, "A_sequential", "ingest", lambda b=b: client.ingest(wire(b), flush=True), meta={"ids": b})
        time.sleep(1.5)

    time.sleep(10)  # let the limiter window breathe before the burst

    # === Phase B: concurrent burst 1 - 20 add() calls fired at once =========
    phase_b = order[60:80]
    print(f"[B] burst 1: {len(phase_b)} concurrent add() calls")
    with ThreadPoolExecutor(max_workers=20) as pool:
        list(pool.map(
            lambda i: call(client, "B_burst1", "add", lambda i=i: client.add(msgs[i]["content"]), meta={"ids": [i]}),
            phase_b,
        ))

    time.sleep(20)

    # === Phase C: interleaved reads and writes ==============================
    phase_c = order[80:110]
    c_batches = [phase_c[i:i + 5] for i in range(0, len(phase_c), 5)]
    queries = [
        "where does my partner work",
        "who is my manager",
        "what do I do on Saturdays",
        "where does my sister live",
        "what am I working on at work",
        "what do I drink",
    ]
    print(f"[C] interleaved: {len(c_batches)} ingest calls + {len(queries)} recalls, concurrent pairs")
    with ThreadPoolExecutor(max_workers=4) as pool:
        futs = []
        for idx, b in enumerate(c_batches):
            futs.append(pool.submit(call, client, "C_interleaved", "ingest",
                                    lambda b=b: client.ingest(wire(b), flush=True), {"ids": b}))
            q = queries[idx % len(queries)]
            futs.append(pool.submit(call, client, "C_interleaved", "search",
                                    lambda q=q: client.search(q), {"query": q}))
            time.sleep(2.0)
        for f in futs:
            f.result()

    time.sleep(20)

    # === Phase D: concurrent burst 2 - 20 mixed calls =======================
    phase_d = order[110:140]
    d_singles = phase_d[:10]
    d_batches = [phase_d[10:15], phase_d[15:20], phase_d[20:25], phase_d[25:30]]
    print(f"[D] burst 2: {len(d_singles)} add() + {len(d_batches)} ingest, all concurrent")
    with ThreadPoolExecutor(max_workers=20) as pool:
        futs = [
            pool.submit(call, client, "D_burst2", "add",
                        lambda i=i: client.add(msgs[i]["content"]), {"ids": [i]})
            for i in d_singles
        ] + [
            pool.submit(call, client, "D_burst2", "ingest",
                        lambda b=b: client.ingest(wire(b), flush=True), {"ids": b})
            for b in d_batches
        ]
        for f in futs:
            f.result()

    time.sleep(20)

    # === Phase E: the long message =========================================
    print("[E] long message (m145)")
    call(client, "E_long", "ingest", lambda: client.ingest(wire(["m145"]), flush=True), meta={"ids": ["m145"]})
    time.sleep(3)

    # remaining tail messages so the whole dataset is delivered
    tail = [i for i in order[140:] if i != "m145"]
    call(client, "E_long", "ingest", lambda: client.ingest(wire(tail), flush=True), meta={"ids": tail})

    time.sleep(10)

    # === Phase F: duplicate / idempotency ==================================
    print("[F] duplicate: identical content twice with the same idempotencyKey")
    dup_key = f"loadtest-dup-{run_started}"
    dup_content = msgs["m001"]["content"]
    for attempt in (1, 2):
        call(client, "F_duplicate", "add",
             lambda: client.add(dup_content, idempotencyKey=dup_key),
             meta={"attempt": attempt, "idempotencyKey": dup_key})
        time.sleep(2)

    writes_done = now_ms()
    print(f"\nall writes issued in {(writes_done - run_started)/1000:.1f}s")

    # === quiesce: poll until the graph stops changing =======================
    print("waiting for the enrichment tail to clear...")
    stable_since = None
    last_sig = None
    quiesced_at = None
    poll_log = []
    deadline = time.time() + 420
    while time.time() < deadline:
        time.sleep(10)
        try:
            s = client.status()
        except Exception as exc:  # noqa: BLE001
            poll_log.append({"at": now_ms(), "error": str(exc)[:200]})
            continue
        sig = json.dumps(s, sort_keys=True)
        poll_log.append({"at": now_ms(), "status": s})
        print("   ", json.dumps(s))
        if sig == last_sig:
            if stable_since and (now_ms() - stable_since) >= 60_000:
                quiesced_at = now_ms()
                break
            if stable_since is None:
                stable_since = now_ms()
        else:
            stable_since = None
            last_sig = sig

    after = snapshot(client)
    print("AFTER:", json.dumps(after["stats"]))
    (OUTDIR / "after.json").write_text(json.dumps(after, indent=1), encoding="utf-8")

    # receipts covering the run window, for cost + outcome attribution
    try:
        receipts = client.receipts(limit=200)
    except Exception as exc:  # noqa: BLE001
        receipts = {"error": str(exc)[:200]}

    summary = {
        "sdk_version": itsuki.VERSION,
        "sdk_path": itsuki.__file__,
        "expected_user": EXPECTED_USER,
        "run_started": run_started,
        "writes_done": writes_done,
        "quiesced_at": quiesced_at,
        "write_window_s": (writes_done - run_started) / 1000,
        "tail_to_clear_s": ((quiesced_at or now_ms()) - writes_done) / 1000,
        "before_stats": before["stats"],
        "after_stats": after["stats"],
        "dataset": {
            "total": len(order),
            "durable": sum(1 for m in data["messages"] if m["marker"] == "durable"),
            "noise": sum(1 for m in data["messages"] if m["marker"] == "noise"),
        },
    }
    (OUTDIR / "calls.jsonl").write_text(
        "\n".join(json.dumps(c) for c in CALLS), encoding="utf-8")
    (OUTDIR / "receipts.json").write_text(json.dumps(receipts, indent=1), encoding="utf-8")
    (OUTDIR / "polls.json").write_text(json.dumps(poll_log, indent=1), encoding="utf-8")
    (OUTDIR / "summary.json").write_text(json.dumps(summary, indent=1), encoding="utf-8")

    # --- quick console read-out --------------------------------------------
    lat = {}
    for c in CALLS:
        lat.setdefault(c["kind"], []).append(c["latency_ms"])
    print("\nlatency by call kind (ms):")
    for k, v in sorted(lat.items()):
        v = sorted(v)
        p50 = statistics.median(v)
        p95 = v[min(len(v) - 1, int(round(0.95 * (len(v) - 1))))]
        print(f"  {k:8s} n={len(v):3d}  p50={p50:7.0f}  p95={p95:7.0f}  max={v[-1]:7.0f}")

    errs = [c for c in CALLS if not c["ok"]]
    print(f"\nerrors: {len(errs)} / {len(CALLS)} calls")
    by_cause = {}
    for e in errs:
        k = f"{e['error'].get('status')}:{e['error'].get('code')}"
        by_cause[k] = by_cause.get(k, 0) + 1
    for k, n in sorted(by_cause.items()):
        print(f"  {k}: {n}")

    print(f"\nwrote results to {OUTDIR}")
    print(f"write window {summary['write_window_s']:.1f}s, tail {summary['tail_to_clear_s']:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
