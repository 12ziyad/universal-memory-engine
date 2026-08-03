# The dataset in the owner account — inspection run

The 150-message load dataset was ingested into the **owner's own graph** (not a
sub-tenant) on 2026-08-03 so the ungraded edges could be judged by eye in the UI.
It is deliberately **left in place**.

## Before-state (the thing a restore must match)

`owner_account_snapshot.json`, committed before the run:

| | count |
|---|---|
| nodes | 48 |
| edges | 24 |
| slices | 36 |
| events | 20 |
| pages | 12 |
| candidates | 0 |

It also carries every node's label, category and summary, every edge, slice,
event, page and candidate, plus the pre-existing job ids — so the delete window
can be derived from **server** timestamps rather than any client clock.

## One thing that surprised us mid-run

The first attempt ingested nothing: every batch came back `received 4, skipped 4`.
The account had already seen `m001`–`m150` during the Aug 2 load test, and the
Durable Object's seen-set correctly refuses re-sends. The re-run gives each
message a fresh id with byte-identical content. The de-dup was working as
designed — worth remembering before re-running any dataset against an account
that has seen it.

## Deleting it afterwards

The window comes from the run's own earliest job row (server-side `created_at`),
never from a local clock. Dry run first — it is the default and destroys nothing:

```bash
AFTER=$(curl -s -H "Authorization: Bearer $(cat ~/.itsuki_key)" \
  "https://itsuki.app/v1/jobs?limit=250" \
  | python -c "import json,sys;j=json.load(sys.stdin)['jobs'];print(min(x['created_at'] for x in j if x['created_at']>$(date -d '2026-08-03' +%s)000)-1000)")
curl -s -X DELETE -H "Authorization: Bearer $(cat ~/.itsuki_key)" \
  "https://itsuki.app/v1/memories?after=$AFTER"
```

Then the destructive pass, which needs `confirm=true`:

```bash
curl -s -X DELETE -H "Authorization: Bearer $(cat ~/.itsuki_key)" \
  "https://itsuki.app/v1/memories?after=$AFTER&confirm=true&dry_run=false"
```

Afterwards the account should read exactly 48 / 24 / 36 / 20 / 12 / 0 again.
Verify against the snapshot:

```bash
python evals/sdk_load/results-fixround1/verify_owner_restore.py
```

Measured expectation: the acceptance run restored a seeded baseline **exactly**
in one pass — node labels, summaries and all — because deleting a run's slices
triggers summary regeneration from the facts that survive. Candidates are
covered too (migration 0027, added because the acceptance gate caught them
escaping). The one thing a delete cannot un-merge is a pre-existing node that
absorbed dataset facts by exact-name match; its summary is regenerated from
surviving facts, which is what made the acceptance restore exact.
