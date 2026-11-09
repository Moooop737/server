-- migrate:up

CREATE TABLE providers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL UNIQUE,
  kind                text NOT NULL,
  base_url            text,
  api_key_ciphertext  text,
  headers_ciphertext  text,
  query               jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled             boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT providers_name_format CHECK (name ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  CONSTRAINT providers_kind_check CHECK (kind IN ('deepseek', 'dashscope', 'openai-compatible', 'ollama', 'ollama-compat')),
  CONSTRAINT providers_base_url_check CHECK (
    (kind IN ('deepseek', 'dashscope') AND base_url IS NULL)
    OR (kind IN ('openai-compatible', 'ollama', 'ollama-compat') AND base_url IS NOT NULL)
  ),
  CONSTRAINT providers_query_object CHECK (jsonb_typeof(query) = 'object')
);

CREATE TABLE models (
  id            text PRIMARY KEY,
  provider_id   uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_id      text NOT NULL,
  kind          text NOT NULL,
  display_name  text NOT NULL,
  dimensions    integer,
  enabled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT models_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT models_id_kind_shape CHECK (
    (kind = 'default' AND id IN ('default', 'embedding'))
    OR (kind <> 'default' AND id LIKE '%:%')
  ),
  CONSTRAINT models_provider_model_kind_unique UNIQUE (provider_id, model_id, kind),
  CONSTRAINT models_model_id_nonempty CHECK (btrim(model_id) <> ''),
  CONSTRAINT models_display_name_nonempty CHECK (btrim(display_name) <> ''),
  CONSTRAINT models_kind_check CHECK (kind IN ('language', 'embedding', 'default')),
  CONSTRAINT models_dimensions_check CHECK (
    (kind = 'embedding' AND dimensions IS NOT NULL AND dimensions BETWEEN 1 AND 16000)
    OR (kind IN ('language', 'default') AND dimensions IS NULL)
  )
);

CREATE INDEX models_provider_id_idx ON models (provider_id);
CREATE INDEX models_kind_idx ON models (kind);

-- migrate:down

DROP TABLE IF EXISTS models;
DROP TABLE IF EXISTS providers;
