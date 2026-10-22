-- migrate:up
CREATE TABLE traces (
  trace_id          text PRIMARY KEY,              -- UUID 或 OTel 32 位 hex
  session_id        uuid,                          -- chat 关联键；不建外键
  resource_id       uuid,                          -- ingest 关联键；不建外键
  route             text NOT NULL,                 -- METHOD + 路由模板，如 POST /chat
  http_status       integer,
  started_at        timestamptz NOT NULL,
  ended_at          timestamptz,
  duration_ms       integer,
  status            text NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running','ok','error','cancelled')),
  error_code        text,
  langfuse_trace_id text,                          -- chat 的跨系统外链
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX traces_started_at_index ON traces(started_at DESC);
CREATE INDEX traces_session_started_index ON traces(session_id, started_at DESC);
CREATE INDEX traces_resource_started_index ON traces(resource_id, started_at DESC);
CREATE INDEX traces_route_started_index ON traces(route, started_at DESC);

CREATE TABLE trace_stages (
  trace_stage_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id       text NOT NULL REFERENCES traces(trace_id) ON DELETE CASCADE,
  stage          text NOT NULL,
  input          jsonb NOT NULL,                   -- 阶段专用 payload
  output         jsonb NOT NULL,                   -- 阶段专用 payload
  duration_ms    integer NOT NULL,
  status         text NOT NULL CHECK (status IN ('ok','error')),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX trace_stages_trace_created_index ON trace_stages(trace_id, created_at);

-- migrate:down
DROP TABLE IF EXISTS trace_stages;
DROP TABLE IF EXISTS traces;
