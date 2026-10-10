-- migrate:up
CREATE EXTENSION IF NOT EXISTS vector;      -- pgvector：提供 halfvec + HNSW
CREATE EXTENSION IF NOT EXISTS pg_search;   -- ParadeDB：提供 BM25 + 中文分词

-- migrate:down
DROP EXTENSION IF EXISTS pg_search;
DROP EXTENSION IF EXISTS vector;
