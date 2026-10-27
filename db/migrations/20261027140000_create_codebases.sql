-- migrate:up

CREATE TABLE codebases (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title                       text NOT NULL,
  original_filename           text NOT NULL,
  data_uri                    text NOT NULL,
  content_type                text NOT NULL DEFAULT 'application/zip',
  status                      text NOT NULL DEFAULT 'uploading',
  error_reason                text,
  storage_size_bytes          bigint,
  manifest                    jsonb NOT NULL DEFAULT '[]'::jsonb,
  file_count                  integer NOT NULL DEFAULT 0,
  declared_uncompressed_bytes bigint NOT NULL DEFAULT 0,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT codebases_status_check
    CHECK (status IN ('uploading', 'processing', 'ready', 'failed')),
  CONSTRAINT codebases_storage_size_nonnegative
    CHECK (storage_size_bytes IS NULL OR storage_size_bytes >= 0),
  CONSTRAINT codebases_storage_size_limit
    CHECK (storage_size_bytes IS NULL OR storage_size_bytes <= 104857600),
  CONSTRAINT codebases_manifest_array
    CHECK (jsonb_typeof(manifest) = 'array'),
  CONSTRAINT codebases_file_count_nonnegative
    CHECK (file_count >= 0),
  CONSTRAINT codebases_declared_uncompressed_nonnegative
    CHECK (declared_uncompressed_bytes >= 0)
);

CREATE UNIQUE INDEX codebases_data_uri_uidx ON codebases (data_uri);
CREATE INDEX codebases_created_idx ON codebases (created_at DESC);

-- migrate:down

DROP TABLE codebases;
