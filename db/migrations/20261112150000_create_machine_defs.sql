-- migrate:up

CREATE TABLE machine_defs (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  swarm_id    text NOT NULL REFERENCES swarm_defs(id) ON DELETE RESTRICT,
  enabled     boolean NOT NULL DEFAULT true,
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT machine_defs_id_nonempty CHECK (length(btrim(id)) > 0),
  CONSTRAINT machine_defs_name_nonempty CHECK (length(btrim(name)) > 0),
  CONSTRAINT machine_defs_swarm_id_nonempty CHECK (length(btrim(swarm_id)) > 0),
  CONSTRAINT machine_defs_version_positive CHECK (version >= 1)
);

CREATE INDEX machine_defs_swarm_id_idx ON machine_defs (swarm_id);

-- migrate:down

DROP TABLE IF EXISTS machine_defs;
