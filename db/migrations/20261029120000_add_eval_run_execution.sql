-- migrate:up

ALTER TABLE eval_runs
  ADD COLUMN run_config_id uuid REFERENCES eval_configs(id) ON DELETE SET NULL,
  ADD COLUMN metric_config_id uuid REFERENCES eval_configs(id) ON DELETE SET NULL,
  ADD COLUMN snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN results jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN started_at timestamptz,
  ADD COLUMN ended_at timestamptz,
  ADD COLUMN duration_ms integer,
  ADD COLUMN error_reason text,
  ADD CONSTRAINT eval_runs_snapshot_object CHECK (jsonb_typeof(snapshot) = 'object'),
  ADD CONSTRAINT eval_runs_results_array CHECK (jsonb_typeof(results) = 'array'),
  ADD CONSTRAINT eval_runs_duration_nonnegative CHECK (duration_ms IS NULL OR duration_ms >= 0);

-- migrate:down

ALTER TABLE eval_runs
  DROP CONSTRAINT IF EXISTS eval_runs_duration_nonnegative,
  DROP CONSTRAINT IF EXISTS eval_runs_results_array,
  DROP CONSTRAINT IF EXISTS eval_runs_snapshot_object,
  DROP COLUMN IF EXISTS error_reason,
  DROP COLUMN IF EXISTS duration_ms,
  DROP COLUMN IF EXISTS ended_at,
  DROP COLUMN IF EXISTS started_at,
  DROP COLUMN IF EXISTS results,
  DROP COLUMN IF EXISTS snapshot,
  DROP COLUMN IF EXISTS metric_config_id,
  DROP COLUMN IF EXISTS run_config_id;
