-- migrate:up

ALTER TABLE messages ADD COLUMN trace_id text;
ALTER TABLE messages ADD CONSTRAINT messages_trace_id_fkey FOREIGN KEY (trace_id) REFERENCES traces(id) ON DELETE SET NULL;
CREATE INDEX messages_trace_index ON messages(trace_id);

-- 回填：user 消息归到开始时间不晚于它的最近一条 POST /chat trace；
-- assistant 消息继承它前面最近一条 user 消息的 trace（assistant 可能写在下一轮 trace 开始之后，不能按时间窗配）。
UPDATE messages m
SET trace_id = (
  SELECT t.id
    FROM traces t
   WHERE t.route = 'POST /chat'
     AND t.session_id = m.session_id
     AND t.started_at <= m.created_at
   ORDER BY t.started_at DESC
   LIMIT 1
)
WHERE m.role = 'user' AND m.trace_id IS NULL;

WITH inherited AS (
  SELECT a.id,
         (SELECT u.trace_id
            FROM messages u
           WHERE u.session_id = a.session_id
             AND u.role = 'user'
             AND u.sequence <= a.sequence
             AND u.trace_id IS NOT NULL
           ORDER BY u.sequence DESC
           LIMIT 1) AS turn_trace
    FROM messages a
   WHERE a.role = 'assistant' AND a.trace_id IS NULL
)
UPDATE messages m
SET trace_id = inherited.turn_trace
FROM inherited
WHERE m.id = inherited.id AND inherited.turn_trace IS NOT NULL;

-- migrate:down

DROP INDEX IF EXISTS messages_trace_index;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_trace_id_fkey;
ALTER TABLE messages DROP COLUMN IF EXISTS trace_id;
