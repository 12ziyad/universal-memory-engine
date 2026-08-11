# Stage B invalid product run 04

- Classification: **PRODUCT HIGH + HARNESS MEDIUM / INVALID AND UNSCORED**.
- The clean replacement passed frozen inputs, billing, configuration, preclean,
  concurrent subtenant writes, same-key convergence, same-tenant/project/index
  lag, persistence isolation, rules, secrets, export, cross-scope recall, exact
  source expansion, and the bounded 200-recall soak.
- It stopped in the delete-during-extraction state-machine test and wrote no
  result artifact. No partial Stage B result is valid or salvageable.
- At the fixed 15-second assertion there were zero episodes, candidates,
  projections, graph rows, pages or staging rows; one job was still in flight
  and later terminated `failed/cancelled_by_delete` without a commit.
- Independently, one E4 capture-run audit row was created after the deletion
  barrier and survived as `cancelled_by_delete`, with zero proposed/accepted/
  stored atoms. This is V3-D12 and violates zero-residue erasure convergence.
- The fixed 15-second assumption is V3-H12. It is replaced with a bounded
  terminal-drain poll that still requires every residue count to reach zero.
- Stage B must restart from the unchanged preregistration only after V3-D12's
  full HIGH lifecycle closes and all invalid-run state is erased by product API.
