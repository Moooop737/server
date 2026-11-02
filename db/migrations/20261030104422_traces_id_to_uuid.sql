-- migrate:up
-- traces.id 实测全是 UUID 形状（OTel 的 32 位 hex 走 langfuse_trace_id 列），收窄为 uuid
ALTER TABLE messages DROP CONSTRAINT messages_trace_id_fkey;
ALTER TABLE trace_stages DROP CONSTRAINT trace_stages_trace_id_fkey;

ALTER TABLE traces ALTER COLUMN id TYPE uuid USING id::uuid;
ALTER TABLE trace_stages ALTER COLUMN trace_id TYPE uuid USING trace_id::uuid;
ALTER TABLE messages ALTER COLUMN trace_id TYPE uuid USING trace_id::uuid;

ALTER TABLE messages ADD CONSTRAINT messages_trace_id_fkey FOREIGN KEY (trace_id) REFERENCES traces(id) ON DELETE SET NULL;
ALTER TABLE trace_stages ADD CONSTRAINT trace_stages_trace_id_fkey FOREIGN KEY (trace_id) REFERENCES traces(id) ON DELETE CASCADE;

-- migrate:down
ALTER TABLE messages DROP CONSTRAINT messages_trace_id_fkey;
ALTER TABLE trace_stages DROP CONSTRAINT trace_stages_trace_id_fkey;

ALTER TABLE traces ALTER COLUMN id TYPE text USING id::text;
ALTER TABLE trace_stages ALTER COLUMN trace_id TYPE text USING trace_id::text;
ALTER TABLE messages ALTER COLUMN trace_id TYPE text USING trace_id::text;

ALTER TABLE messages ADD CONSTRAINT messages_trace_id_fkey FOREIGN KEY (trace_id) REFERENCES traces(id) ON DELETE SET NULL;
ALTER TABLE trace_stages ADD CONSTRAINT trace_stages_trace_id_fkey FOREIGN KEY (trace_id) REFERENCES traces(id) ON DELETE CASCADE;
