-- migrate:up

CREATE TABLE swarm_defs (
  id          text PRIMARY KEY,
  version     integer NOT NULL DEFAULT 1,
  nodes       jsonb NOT NULL,
  edges       jsonb NOT NULL,
  output_node text NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT swarm_defs_nodes_array CHECK (jsonb_typeof(nodes) = 'array'),
  CONSTRAINT swarm_defs_edges_array CHECK (jsonb_typeof(edges) = 'array'),
  CONSTRAINT swarm_defs_version_positive CHECK (version >= 1),
  CONSTRAINT swarm_defs_output_node_nonempty CHECK (length(btrim(output_node)) > 0)
);

-- migrate:down

DROP TABLE IF EXISTS swarm_defs;
