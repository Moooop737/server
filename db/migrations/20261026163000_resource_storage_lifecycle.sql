-- migrate:up

ALTER TABLE resources ADD COLUMN storage_size_bytes bigint;
ALTER TABLE resources ADD CONSTRAINT resources_storage_size_nonnegative
  CHECK (storage_size_bytes IS NULL OR storage_size_bytes >= 0);

ALTER TABLE resources ALTER COLUMN status DROP DEFAULT;
ALTER TYPE resource_status RENAME TO resource_status_old;
CREATE TYPE resource_status AS ENUM (
  'uploading', 'uploaded', 'processing', 'ready', 'upload_failed', 'process_failed'
);
ALTER TABLE resources
  ALTER COLUMN status TYPE resource_status
  USING (
    CASE status::text
      WHEN 'failed' THEN 'process_failed'
      ELSE status::text
    END
  )::resource_status;
ALTER TABLE resources ALTER COLUMN status SET DEFAULT 'uploading';
DROP TYPE resource_status_old;

ALTER TABLE resources
  ALTER COLUMN content_type TYPE text
  USING (
    CASE content_type::text
      WHEN 'url' THEN 'text/html'
      WHEN 'markdown' THEN 'text/markdown'
      WHEN 'plaintext' THEN 'text/plain'
      ELSE 'application/octet-stream'
    END
  );
DROP TYPE resource_content_type;

CREATE UNIQUE INDEX resources_storage_uri_uidx
  ON resources (data_uri)
  WHERE data_uri LIKE 'kc://%';

-- migrate:down

DROP INDEX IF EXISTS resources_storage_uri_uidx;

CREATE TYPE resource_content_type AS ENUM ('url', 'markdown', 'plaintext');
ALTER TABLE resources
  ALTER COLUMN content_type TYPE resource_content_type
  USING (
    CASE content_type
      WHEN 'text/markdown' THEN 'markdown'
      WHEN 'text/plain' THEN 'plaintext'
      ELSE 'url'
    END
  )::resource_content_type;

ALTER TABLE resources ALTER COLUMN status DROP DEFAULT;
ALTER TYPE resource_status RENAME TO resource_status_new;
CREATE TYPE resource_status AS ENUM ('processing', 'ready', 'failed');
ALTER TABLE resources
  ALTER COLUMN status TYPE resource_status
  USING (
    CASE status::text
      WHEN 'uploading' THEN 'processing'
      WHEN 'uploaded' THEN 'processing'
      WHEN 'upload_failed' THEN 'failed'
      WHEN 'process_failed' THEN 'failed'
      ELSE status::text
    END
  )::resource_status;
ALTER TABLE resources ALTER COLUMN status SET DEFAULT 'processing';
DROP TYPE resource_status_new;

ALTER TABLE resources DROP CONSTRAINT IF EXISTS resources_storage_size_nonnegative;
ALTER TABLE resources DROP COLUMN IF EXISTS storage_size_bytes;
