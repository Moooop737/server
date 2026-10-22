-- migrate:up
-- hono-crud 约定：主键统一为 id；外键引用随列重命名自动跟随
ALTER TABLE sessions RENAME COLUMN session_id TO id;
ALTER TABLE messages RENAME COLUMN message_id TO id;
ALTER TABLE traces RENAME COLUMN trace_id TO id;
ALTER TABLE trace_stages RENAME COLUMN trace_stage_id TO id;

-- migrate:down
ALTER TABLE trace_stages RENAME COLUMN id TO trace_stage_id;
ALTER TABLE traces RENAME COLUMN id TO trace_id;
ALTER TABLE messages RENAME COLUMN id TO message_id;
ALTER TABLE sessions RENAME COLUMN id TO session_id;
