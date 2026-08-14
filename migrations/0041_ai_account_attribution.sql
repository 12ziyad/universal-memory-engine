-- AI accounting, attributed to the ACCOUNT rather than the rotatable memory
-- subject.
--
-- ai_calls.user_id is the resolved memory-scope id — the sub-tenant the caller
-- selects per request. A monthly quota keyed on it would be defeated by exactly
-- the userId-rotation attack the rate keys already refuse. flushAiMeter has
-- always received lifecycle.accountUserId / managedProjectId; from this
-- migration on they are persisted, and the quota counts account_user_id
-- (falling back to user_id only for legacy operator-door rows, which have no
-- account attribution).
--
-- No backfill: these columns did not exist when old rows were written, so the
-- quota window simply starts empty at deploy — everyone's first month begins
-- at zero.
ALTER TABLE ai_calls ADD COLUMN account_user_id TEXT;
ALTER TABLE ai_calls ADD COLUMN managed_project_id TEXT;
CREATE INDEX IF NOT EXISTS idx_ai_calls_account ON ai_calls(account_user_id, created_at);

-- One row per UTC day: the circuit breaker's read is a primary-key lookup, not
-- a table scan. measured_neurons carries ONLY what the Workers AI binding
-- reported (the ai_meter rule: derived figures never enter a column named
-- after the billed unit); the derived top-up for unreported calls is computed
-- at read time from the token sums, where it can be labelled as derived.
CREATE TABLE IF NOT EXISTS ai_daily_totals (
	day TEXT PRIMARY KEY,
	calls INTEGER NOT NULL DEFAULT 0,
	input_tokens INTEGER NOT NULL DEFAULT 0,
	output_tokens INTEGER NOT NULL DEFAULT 0,
	measured_neurons REAL NOT NULL DEFAULT 0,
	measured_neuron_calls INTEGER NOT NULL DEFAULT 0,
	updated_at INTEGER
);
