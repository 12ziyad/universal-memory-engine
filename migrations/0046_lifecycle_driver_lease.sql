-- Migration number: 0046 	 2026-08-19T02:15:00.000Z
-- Lifecycle driver lease: at most one driver advances a run at a time.
--
-- Status polls opportunistically nudge convergence, the execute door drives
-- the fence, and the cron resumes stragglers — without a lease those drivers
-- can stack onto one run during a long per-space erase and contend D1 into
-- transient failures. The lease is a single CAS-claimed expiry timestamp:
-- crash-safe (expiry), additive, and invisible to the previous Worker.

ALTER TABLE project_lifecycle_runs ADD COLUMN driver_lease_until INTEGER;
