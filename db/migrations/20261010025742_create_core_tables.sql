-- migrate:up
CREATE TYPE resource_status AS ENUM ('processing','ready','failed');
CREATE TYPE resource_content_type AS ENUM ('url','markdown','plaintext');

CREATE TABLE resources (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title        text NOT NULL,
  source       text,                              -- URL 来源（粘贴则 NULL）
  data_uri     text NOT NULL,                     -- 内容来源标识（FR-11 自动生成）
  content_type resource_content_type NOT NULL,
  status       resource_status NOT NULL DEFAULT 'processing',
  error_reason text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz                        -- 软删（FR-5）
);

CREATE TABLE chunks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id  uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  resource_uri text NOT NULL,
  chunk_index  int  NOT NULL,
  content      text NOT NULL,
  start_offset int,
  end_offset   int,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
CREATE INDEX chunks_resource_idx ON chunks(resource_id);

CREATE TABLE embeddings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id   uuid NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,  -- 关联 chunk（AD-3 分表）
  source_type text NOT NULL DEFAULT 'chunk',
  dim         int  NOT NULL,                      -- 记录维度，供 NFR-6 校验
  model       text NOT NULL,                      -- 记录产向量的模型
  embedding   halfvec(1024) NOT NULL,             -- AD-4：锁 1024 维
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
-- AD-4：HNSW 余弦索引（1024 < 4000，halfvec 可直接建）
CREATE INDEX embeddings_hnsw ON embeddings
  USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- AD-5：pg_search BM25，中文 Lindera 分词
CREATE INDEX chunks_bm25 ON chunks
  USING bm25 (id, content)
  WITH (
    key_field   = 'id',
    text_fields = '{"content": {"tokenizer": {"type": "chinese_lindera"}}}'
  );

CREATE TABLE sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title      text NOT NULL DEFAULT '',
  user_id    text NOT NULL DEFAULT 'local',       -- P1 预留，不建 auth（AD-3 去 tenant）
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('user','assistant','tool')),
  content    text NOT NULL,
  sources    jsonb,                               -- CitationSource[]，随消息落库（AD-6）
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX messages_session_idx ON messages(session_id);

-- migrate:down
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS embeddings;
DROP TABLE IF EXISTS chunks;
DROP TABLE IF EXISTS resources;
DROP TYPE IF EXISTS resource_status;
DROP TYPE IF EXISTS resource_content_type;
