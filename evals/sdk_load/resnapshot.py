"""Poll until the graph is genuinely quiescent, then overwrite after.json.

The harness has a bounded quiesce deadline. With 150 messages funnelled through
a single Durable Object the backlog can outlast it, and diffing a premature
"after" would under-count what the run produced. This keeps watching and only
rewrites the snapshot once the graph has held still.
"""

from __future__ import annotations

import json
import pathlib
import sys
import time

from itsuki import MemoryClient

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import run as harness  # noqa: E402

OUTDIR = pathlib.Path(r"C:\Users\ziyad\itsuki-loadtest\results")
STABLE_FOR_S = 120
MAX_WAIT_S = int(sys.argv[1]) if len(sys.argv) > 1 else 1500


def main() -> int:
    client = MemoryClient(api_key=harness.KEY_PATH.read_text(encoding="utf-8").strip())
    last = None
    stable_since = None
    started = time.time()
    log = []

    while time.time() - started < MAX_WAIT_S:
        s = client.status()
        sig = json.dumps(s, sort_keys=True)
        stamp = int(time.time() * 1000)
        log.append({"at": stamp, "status": s})
        elapsed = int(time.time() - started)
        held = "" if last is None else ("  (changed)" if sig != last else "  (stable)")
        print(f"  +{elapsed:4d}s {json.dumps(s)}{held}", flush=True)
        if sig == last:
            if stable_since is None:
                stable_since = time.time()
            elif time.time() - stable_since >= STABLE_FOR_S:
                print(f"\nquiescent for {STABLE_FOR_S}s at +{elapsed}s")
                break
        else:
            stable_since = None
            last = sig
        time.sleep(15)
    else:
        print(f"\nWARNING: still changing after {MAX_WAIT_S}s - snapshot is a floor, not a settled state")

    snap = harness.snapshot(client)
    (OUTDIR / "after.json").write_text(json.dumps(snap, indent=1), encoding="utf-8")
    (OUTDIR / "polls_extended.json").write_text(json.dumps(log, indent=1), encoding="utf-8")
    print("AFTER:", json.dumps(snap["stats"]))

    try:
        receipts = client.receipts(limit=300)
        (OUTDIR / "receipts.json").write_text(json.dumps(receipts, indent=1), encoding="utf-8")
        print("receipts refreshed")
    except Exception as exc:  # noqa: BLE001
        print("receipt refresh failed:", str(exc)[:200])
    return 0


if __name__ == "__main__":
    sys.exit(main())
