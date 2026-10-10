-- migrate:up
-- 对齐 WeKnora：列名 dim → dimension（partial HNSW 索引的 WHERE 谓词由 Postgres 自动跟随改名）
ALTER TABLE embeddings RENAME COLUMN dim TO dimension;

-- migrate:down
ALTER TABLE embeddings RENAME COLUMN dimension TO dim;
