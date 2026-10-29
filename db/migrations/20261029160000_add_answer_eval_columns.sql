-- migrate:up

ALTER TABLE eval_cases
  ADD COLUMN assertions jsonb NOT NULL DEFAULT '{"expect":[],"reject":[]}'::jsonb,
  ADD CONSTRAINT eval_cases_assertions_object CHECK (jsonb_typeof(assertions) = 'object'),
  ADD CONSTRAINT eval_cases_assertions_shape CHECK (
    jsonb_typeof(assertions -> 'expect') = 'array' AND jsonb_typeof(assertions -> 'reject') = 'array'
  );

ALTER TABLE eval_runs
  ADD COLUMN human_results jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT eval_runs_human_results_array CHECK (jsonb_typeof(human_results) = 'array');

-- migrate:down

ALTER TABLE eval_runs
  DROP CONSTRAINT IF EXISTS eval_runs_human_results_array,
  DROP COLUMN IF EXISTS human_results;

ALTER TABLE eval_cases
  DROP CONSTRAINT IF EXISTS eval_cases_assertions_shape,
  DROP CONSTRAINT IF EXISTS eval_cases_assertions_object,
  DROP COLUMN IF EXISTS assertions;
