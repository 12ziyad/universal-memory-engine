# V3 SECURITY LEDGER

V3 adds source episodes and broader retrieval, so privacy testing must be DEEPER
than V1, not equal to it. Batteries: tenant / sub-tenant / project isolation,
secret battery, rules battery, erasure convergence, replay and delete-resurrection,
failure-path leakage.

## Final live Stage B — PASS (2026-08-11)

The valid preregistered production reattack passed tenant, subtenant,
project-only and project-then-global isolation across persistence, recall and
exact source expansion. Eleven secret/rules storage audits and three path-aware
export audits found no surviving prohibited values; rules configuration was
unchanged. Delete-during-extraction, erased replay, late commit, new post-delete
write and ten post-erasure recalls all met contract. Final checks across 34
markers found zero episode FTS, semantic FTS or packet-content hits and every
live V3/job count was zero. V3-D10, V3-D11 and V3-D12 HIGH are closed; no open
CRITICAL/HIGH defect remains at this boundary. Full evidence:
`final/STAGE-B-FINAL.md` and `final/live/evidence/stage-b-live-reattack.json`.

## Results

### E9B bounded episode fallback — safety PASS, architecture REJECT

- SQL binds tenant and project/project-then-global predicates before FTS
  ordering and `LIMIT`; the nested flag requires exact V3 + E7 + E9A + E9B
  membership and defaults/fails closed.
- Candidate/query/render/context bounds passed on every treatment recall;
  render-time canonical re-scrubbing and synthetic secret tests passed; failure
  telemetry is content-free. Lookup failures were zero.
- E9B added no evidence and is rejected for quality/latency, so it is OFF/0 in
  production rather than promoted merely because its security tests passed.
- Both arms retained one exact fingerprint; cleanup proved zero across every
  episode/semantic surface and final routing passed 20/20 uncached edge checks.
- Complete implementation gates: Worker 1,302/1,302; unit/cross-door 539 plus
  one intentional skip; audit 0. The initial three unrelated runner timeouts
  passed 49/49 in isolation before the bounded-concurrency full gate.

### E9A exact source expansion — PASS at this boundary

- Exact tenant/project/packet/message/episode and owner/external/memory-user
  identities are constrained before source text is returned.
- Render-time canonical scrub is mandatory; all ten path-aware exports passed
  their secret audit; zero source lookup failures occurred.
- Control OFF/0 and treatment exact allowlist/10 were proved on both domains;
  normal users and the frozen control cohort were never selected.
- Both arms retained the same source/semantic fingerprint; cleanup proved zero
  live episodes, candidates, projections, graph state, pages and non-terminal
  jobs. No episode vector index exists.
- Focused E9/flag/health/E7 tests pass 55/55; broader episode/projection/rules/
  erasure/replay/security regressions passed 161/161 and the complete Worker
  gate passed 1,294/1,294 at implementation.

This paragraph recorded the pre-final state at E9A; the final reattack described
above now supersedes it.

## V3 isolation and privacy — what is proven, and by what

Every row below is a passing assertion, not a claim. Suite totals at the time of
writing: Workers pool **99 files / 1173 tests**, unit **33 / 539 (+1 skipped)**.

### Tenant, sub-tenant and project isolation

| property | proof |
|---|---|
| One account never sees another's episodes, by search or by packet id | `source_episodes.spec.js` — "one account never sees another's episodes" |
| `project_only` never returns a global or sibling-project episode | `source_episodes.spec.js` — "project_only never returns a global or other-project episode" |
| `project_then_global` returns project + global, never a sibling project | `source_episodes.spec.js` — same suite |
| `project_only` with no project returns nothing, not everything | `source_episodes.spec.js` — the fail-closed direction |
| Scope is filtered in SQL, not after the fact | `episodes.js` `episodeProjectFilter` binds into the WHERE clause; a post-filter would let another project's rows fill the LIMIT before the requested one is seen |
| A delete for one account never touches another's episodes | `source_episodes.spec.js` — "a delete for one account never touches another's episodes" |
| The V3 flag cannot bleed across accounts | `memory_v3_flag.spec.js` — whole-string, case-sensitive, env-only resolution; `source_episodes.spec.js` — "does not bleed across accounts when only one is selected" |
| A caller cannot opt themselves in | `memory_v3_flag.spec.js` — the resolver takes `(env, userId)` and nothing else; no request body, header or scope object reaches it |

### Secrets

| property | proof |
|---|---|
| A secret in an ingested message never reaches an episode row | `source_episodes.spec.js` — "stores the SCRUBBED text", end to end through the real `/v1/ingest` door with an AWS-shaped key |
| A scrubbed secret is not findable in the episode FTS index | same test, queried through `findSourceEpisodes` |
| Scrubbing precedes persistence structurally | `ingest.js` calls `scrubMessages` before `normalizeSourcePacket`; episodes are written from the normalised messages |

### Rules

| property | proof |
|---|---|
| Excluded content never becomes an episode | `source_episodes.spec.js` — "never stores content the account's exclude rules refuse" |
| Excluded content is not reachable through episode search | same test |
| An UNREADABLE rules store writes nothing, rather than everything | `rules_unavailable.spec.js` — 7 assertions; this is defect **V3-D01** |
| A missing rules TABLE still means defaults | `rules_unavailable.spec.js` — the pre-migration case is preserved deliberately |
| A door-resolved rules object is never second-guessed (SRV-04) | `rules_unavailable.spec.js` — "never consults the store at all when the door already resolved the rules" |

### Erasure

| property | proof |
|---|---|
| A confirmed erasure removes episode rows | `source_episodes.spec.js` — "a confirmed unscoped delete removes the rows and their search tokens" |
| The FTS index has nothing left to find | same suite — queries `source_episodes_fts` **directly**, because a stale token there is a leak the API would hide |
| Deletion is hard, not soft | asserted on the raw table: zero rows remain, nothing is left to un-delete |
| `deleteAllMemories` takes episodes with it | `source_episodes.spec.js` |
| Erasure converges when an episode lands after the first sweep | `source_episodes.spec.js`; `cleanup.js` counts episodes inside the convergence loop |
| A dry run removes nothing | `source_episodes.spec.js` |
| A scoped curation is not an erasure in disguise | `source_episodes.spec.js` — a source-scoped delete matching no run manifests removes nothing |

### Not yet proven — and why

| gap | reason |
|---|---|
| Live production re-attack of any of the above | Requires an ingest, which requires inference. **Cost gate closed.** |
| Concurrency and soak behaviour of the episode layer | Both need real ingests at volume. **Cost gate closed.** |
| Vector-index isolation for episodes | Episodes are deliberately **not** vector-indexed. Campaign §20 requires an ablation before adding it, and that ablation needs inference. |


## 2026-08-10 E3 production/security boundary

E3 revalidated the source layer after acceptance became episode-dependent:

- 252/252 permitted source messages were exact on text, role, message identity,
  order, scope, source packet, and source time across three seeds.
- Secret/rules scrubbing remained upstream of persistence; source rows and FTS
  had zero excluded/scrubbed-value survivors in focused tests.
- Tenant/project predicates execute inside the episode SQL; cross-scope FTS
  failures were zero.
- Hard episode deletion, FTS token deletion, late-write convergence, retry,
  replay, and no-resurrection tests pass in the 1,218-test Worker gate.
- V3-D06's production reattack proved an erased terminal packet cannot regain an
  acceptance-shaped 200: it returns 409 `source_write_erased`, leaves zero
  episodes/non-terminal jobs, and does not increment replay state.
- The live feature flag remains allowlist-only for 30 campaign tenants; normal
  users remain on the legacy path and E2-B1 remains off.

E3 introduces no episode vectors, public source export, reader source dumping,
or cross-tenant entity behavior. Those surfaces remain absent rather than
untested claims. Full final secret/rules/concurrency/soak reattack is still
required after E4–E10 stabilize.

## E4 local security boundary

The atomic lane remains nested-default-OFF and has no public read/export API.
Focused tests prove exact parent+nested allowlist membership, no tenant/project
flag bleed, exact episode-backed scope at commit, post-inference deletion-barrier
cancellation, hard candidate/run erasure, replay idempotence, rules/secret
rejection, malformed-output non-persistence, and no raw-output logging.

Candidate tenant/project/provenance values are selected from the durable source
episode rather than trusted from model output. Every candidate insert shares one
D1 batch with deletion and source-existence fence guards. No candidate vector,
FTS index, entity merge, retrieval lane, reader input, or operator content
surface exists yet. Production reattack remains pending migration/deployment;
normal-user behavior must remain unchanged with the nested flag OFF.

## E5 production security boundary

E5 adds nullable temporal metadata only to the already scope-fenced candidate
rows. It introduces no new public read/export/vector/entity surface. The clean
production proof bound every candidate to the selected tenant, project, source
packet, and source episode; receipt counts conserved; exact replay changed no
state; confirmed erasure removed candidates, runs, episodes, graph rows, and
nonterminal work. D1-primary verification found zero residue.

V3-D08's repair carries only `persistedSourceTime()`'s canonical bounded shape
through the Durable Object; it does not trust an arbitrary caller object. Both
domains now report nested atomic capture OFF/count 0. Final post-E10 secret,
rules, cross-scope, concurrency, and resurrection reattack remains mandatory.

## E10 security boundary and closure

E10 introduced no new storage, search lane, model or cross-scope query. Its
nested flag requires exact parent V3 + E7 + E10 account membership and is OFF/0
after rejection. Focused and full gates covered flag bleed, tenant/project
binding, bounded Unicode-safe rendering, exact source grouping and legacy
byte-equivalence. The paired live cell used one sealed tenant/project-bound
state and changed no selected item or semantic fingerprint.

Cleanup hard-deleted all ten synthetic states across episodes, candidates,
projections and graph surfaces; direct D1-primary counts are zero. Production
closure passed 20/20 uncached health checks on both domains with all write,
source/fallback and adaptive flags OFF. No private text or raw model output was
written to ordinary logs. The final comprehensive security reattack remains
mandatory before any production-enable recommendation.
