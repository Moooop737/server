-- migrate:up
-- 照 WeKnora / AD-4：单表混维。embedding 列改为不定长 halfvec，
-- HNSW 用「按 dim 分区 + 表达式 cast」，dim 决定该行走哪个索引；未来加维度只需加索引，不改表。
DROP INDEX IF EXISTS embeddings_hnsw;
ALTER TABLE embeddings ALTER COLUMN embedding TYPE halfvec;
CREATE INDEX embeddings_hnsw ON embeddings
  USING hnsw ((embedding::halfvec(1024)) halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE dim = 1024;

-- migrate:down
DROP INDEX IF EXISTS embeddings_hnsw;
ALTER TABLE embeddings ALTER COLUMN embedding TYPE halfvec(1024);
CREATE INDEX embeddings_hnsw ON embeddings
  USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64);
