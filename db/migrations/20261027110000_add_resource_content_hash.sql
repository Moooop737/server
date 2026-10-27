-- migrate:up

ALTER TABLE resources ADD COLUMN content_hash text;
ALTER TABLE resources ADD CONSTRAINT resources_content_hash_sha256
  CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$');

-- 含软删行：同一内容只能有一条资源；旧资源已清空，不回填
CREATE UNIQUE INDEX resources_content_hash_uidx
  ON resources (content_hash)
  WHERE content_hash IS NOT NULL;

-- migrate:down

DROP INDEX IF EXISTS resources_content_hash_uidx;
ALTER TABLE resources DROP CONSTRAINT IF EXISTS resources_content_hash_sha256;
ALTER TABLE resources DROP COLUMN IF EXISTS content_hash;
