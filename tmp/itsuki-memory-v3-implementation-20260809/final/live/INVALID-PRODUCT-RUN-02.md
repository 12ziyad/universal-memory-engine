# Stage B invalid product run 02

- Classification: **PRODUCT HIGH / INVALID AND UNSCORED**.
- The replacement run passed billing, preclean, ten concurrent subtenant
  ingests, same-key convergence, project mixing, same-tenant burst and
  immediate-read checks.
- It stopped at the first persistence privacy audit. Needle index 9 was the
  request-scoped rules exclusion marker; it survived in `source_packets` only.
- Episodes, FTS, semantic candidates, graph state and staging did not contain
  the marker. No benchmark or quality result was emitted or salvaged.
- Product source independently confirms the ordering: secret scrubbing ran
  before packet normalization, but packet preview/provenance persisted before
  rules were enforced by episodes, staging and semantic gates.
- The pre-fix cleanup removed all live memory and jobs but could not remove the
  packet plaintext because that is the defect. The packet must be minimized by
  the fixed production erasure path before V3-D10 can close.
- Original replacement-run stdout/stderr and the pre-fix cleanup evidence are
  retained. Stage B must restart from its unchanged preregistration after the
  full HIGH lifecycle closes.
