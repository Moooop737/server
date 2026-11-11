-- migrate:up

CREATE TABLE pipeline_defs (
  id          text PRIMARY KEY,
  kind        text NOT NULL,
  version     integer NOT NULL DEFAULT 1,
  nodes       jsonb NOT NULL,
  output_node text,
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pipeline_defs_kind_check CHECK (kind IN ('retrieval')),
  CONSTRAINT pipeline_defs_nodes_array CHECK (jsonb_typeof(nodes) = 'array'),
  CONSTRAINT pipeline_defs_version_positive CHECK (version >= 1)
);

INSERT INTO pipeline_defs (id, kind, version, nodes, output_node)
VALUES (
  'default',
  'retrieval',
  1,
  '[
    {"id":"dimension_check","component":"dimension_check","config":{},"inputs":{}},
    {"id":"q","component":"query_source","config":{},"inputs":{}},
    {"id":"embed","component":"embed_query","config":{},"inputs":{"text":"q.text"}},
    {"id":"vector","component":"vector_recall","config":{"top_k":10,"min_similarity":0.42},"inputs":{"embedding":"embed.embedding"}},
    {"id":"bm25","component":"bm25_recall","config":{"top_k":10},"inputs":{"text":"q.text"}},
    {"id":"rrf","component":"rrf_fusion","config":{"k":60},"inputs":{"a":"vector.list","b":"bm25.list"}},
    {"id":"result","component":"result","config":{"limit":6},"inputs":{"list":"rrf.list"}}
  ]'::jsonb,
  'result'
);

-- migrate:down

DROP TABLE IF EXISTS pipeline_defs;
