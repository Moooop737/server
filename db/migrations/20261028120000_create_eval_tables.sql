-- migrate:up

CREATE TABLE eval_datasets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  note            text NOT NULL DEFAULT '',
  baseline_run_id uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT eval_datasets_name_nonempty CHECK (btrim(name) <> '')
);

CREATE UNIQUE INDEX eval_datasets_name_uidx ON eval_datasets (name);

CREATE TABLE eval_runs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id uuid NOT NULL REFERENCES eval_datasets(id) ON DELETE RESTRICT,
  status     text NOT NULL DEFAULT 'queued',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT eval_runs_status_check CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled'))
);

CREATE INDEX eval_runs_dataset_idx ON eval_runs (dataset_id, created_at DESC);

CREATE TABLE eval_cases (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id uuid NOT NULL REFERENCES eval_datasets(id) ON DELETE CASCADE,
  case_key   text NOT NULL,
  level      text NOT NULL,
  query      text NOT NULL,
  negative   boolean NOT NULL DEFAULT false,
  note       text NOT NULL DEFAULT '',
  gold       jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT eval_cases_dataset_key_unique UNIQUE (dataset_id, case_key),
  CONSTRAINT eval_cases_case_key_nonempty CHECK (btrim(case_key) <> ''),
  CONSTRAINT eval_cases_level_nonempty CHECK (btrim(level) <> ''),
  CONSTRAINT eval_cases_query_nonempty CHECK (btrim(query) <> ''),
  CONSTRAINT eval_cases_gold_array CHECK (jsonb_typeof(gold) = 'array'),
  CONSTRAINT eval_cases_negative_empty_gold CHECK (NOT negative OR gold = '[]'::jsonb)
);

CREATE TABLE eval_configs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text NOT NULL,
  name       text NOT NULL,
  config     jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT eval_configs_kind_check CHECK (kind IN ('run', 'metric')),
  CONSTRAINT eval_configs_name_nonempty CHECK (btrim(name) <> ''),
  CONSTRAINT eval_configs_config_object CHECK (jsonb_typeof(config) = 'object')
);

CREATE INDEX eval_configs_kind_idx ON eval_configs (kind, created_at DESC);

-- migrate:down

DROP TABLE IF EXISTS eval_configs;
DROP TABLE IF EXISTS eval_cases;
DROP TABLE IF EXISTS eval_runs;
DROP TABLE IF EXISTS eval_datasets;
