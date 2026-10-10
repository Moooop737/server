-- migrate:up
-- 照 WeKnora / AD-4：HNSW 建在 embedding::halfvec(1024) 表达式索引上
DROP INDEX IF EXISTS embeddings_hnsw;
CREATE INDEX embeddings_hnsw ON embeddings
  USING hnsw ((embedding::halfvec(1024)) halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- migrate:down
DROP INDEX IF EXISTS embeddings_hnsw;
CREATE INDEX embeddings_hnsw ON embeddings
  USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64);
