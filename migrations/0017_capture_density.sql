-- Capture density preference: "standard" (selective, the product's default
-- character) or "dense" (exhaustive capture — lower gate floor, enumerate-
-- everything extraction prompt). Additive and default-preserving.
ALTER TABLE memory_rules ADD COLUMN capture_density TEXT DEFAULT 'standard';
