# Final Stage B deployment

- Git HEAD/origin: `969bb161457a4e85d2c9f3fc25bfedc24f4d81bc`.
- Production deployment: `45b2d68a-85ea-42fb-8f62-be8bfdbcd814`.
- Worker version: `c9c133a6-4353-4c2a-8c50-ba3abbe209a1`, 100% traffic.
- Focused accepted-lane regression: 40/40 pass.
- Wrangler 4.120.0 dry deploy: pass.
- Propagation proof: 20/20 uncached health responses across `itsuki.app` and
  `uml.gpmai.workers.dev` agreed on parent allowlist 30, capture/projection and
  source expansion treatment-only 10, hybrid historical+d04 treatment 20.
- Rejected lanes remained OFF: E2-B1, E6M coalescing, E9B episode fallback and
  E10 adaptive context.
- Normal users remained outside all nested V3 lanes.
- No migration was required.
