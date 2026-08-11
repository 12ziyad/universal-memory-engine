# V3-D10 — source-packet rules and erasure privacy

Severity: **HIGH**
Classification: product privacy / erasure defect

## Finding

The V3 privacy battery inserted a benign synthetic marker into a message and
excluded that marker through the request-scoped rules contract. Every intended
memory surface rejected it, but the Stage B direct D1 audit found one plaintext
copy in `source_packets.content_preview` / `raw_meta_json`.

The row was not searchable and did not reach recall or export. It was still a
durable content copy. Worse, unscoped erasure intentionally retained packet and
job bookkeeping so an exact replay could be answered with
`409 source_write_erased`; the retained packet was not content-minimized.

## Root cause

`ingestMessages` scrubbed secrets, normalized the complete packet, and stored
it before `writeSourceEpisodes`, `stageMemoryText`, extraction and graph gates
resolved/enforced admission rules. V3-D01 made those downstream boundaries
fail closed, but the earlier source-packet boundary was outside that repair.

## Repair

1. For V3-selected writes, resolve admission rules before packet durability.
   An unreadable rules store returns the existing retryable source-unavailable
   response and writes no packet, job, episode or semantic row.
2. Preserve exact-request hashing for idempotency, but include plaintext
   preview/provenance only for messages admitted by the resolved rules.
3. On confirmed unscoped erasure, minimize every pre-barrier packet to a
   content-free replay fence: null preview, `{}` provenance, zero message count,
   cleared non-routing user metadata, and a fixed non-content digest sentinel.
4. Recognize that sentinel before normal hash comparison so reuse of an erased
   key still returns named non-retryable `source_write_erased`.
5. Preserve immutable context coordinates needed for already-cancelled Durable
   Object entries to validate ownership and drain without resurrection.
6. Extend final Stage B erasure auditing to search retained packet fields for
   every synthetic marker in addition to both FTS indexes.

No migration or binding change is needed.

## Verification

| gate | result |
|---|---:|
| failing-first source episode suite | 29 pass / 2 fail |
| exact repaired source episode suite | 31 / 31 pass |
| focused rules/replay/delete/crash/ingest | 15 files / 201 pass |
| full serialized Worker | 110 files / 1,310 pass |
| unit and cross-door | 33 files / 539 pass, 1 intentional skip |
| npm audit | 0 vulnerabilities |
| Wrangler 4.120.0 dry deploy | pass |

Production deployment, exact production reattack and fixed-path cleanup remain
required before this HIGH can be marked closed.
