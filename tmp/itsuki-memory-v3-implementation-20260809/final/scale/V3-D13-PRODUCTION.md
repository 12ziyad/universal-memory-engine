# V3-D13 production closure

Date: 2026-08-11

Verdict: **CLOSED**.

Implementation/origin commit `5f11d750386c6f276ed0188c8eb7cdb102a988a6`
was deployed as Worker version `052d9b68-b131-45cb-b792-1804c86a50d6`,
deployment `29d876c2-fdd1-45b4-a784-314ae6feac7e`, at 100% traffic. No
migration or binding changed.

Twenty uncached checks across both domains passed. Parent V3 remains allowlist
30; hybrid E7 remains only the historical ten; every write, source, fallback,
adaptive and rejected lane is OFF/0. Normal users remain on the legacy path.

After a passing first-party Workers AI billing preflight, one exact previously
evaluated d04 product-input question was recalled at depth 200. No reference was
supplied and no re-ingest occurred. Production returned HTTP 200 with bounded
corpus telemetry, zero lane failures, every lane/corpus cap respected, 66 final
items, 9,301 context characters, 1,459 ms server latency and 2,659 ms client
latency. The one embedding call changed the rounded GraphQL campaign total by
zero neurons; the post-call total is 1,914,249 / 3,000,000.

Production-primary cleanup remains zero across all live Stage B treatment
surfaces and non-terminal jobs. All 809 retained packet fences are minimized
and content-free, the global benchmark lock is absent, temporary credential/
payload files are zero, and the timed-out tail helper tree was explicitly
stopped. Invalid local transport attempts remain unscored and are classified as
V3-H15.

Full machine-readable evidence:
`evidence/v3-d13-production-reattack.json`.
