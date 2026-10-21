-- migrate:up
ALTER TABLE sessions RENAME COLUMN id TO session_id;
ALTER TABLE sessions DROP COLUMN user_id;

ALTER TABLE messages RENAME COLUMN id TO message_id;
ALTER TABLE messages DROP COLUMN sources;
ALTER TABLE messages ADD COLUMN parts jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE messages ADD COLUMN sequence bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE messages DROP CONSTRAINT messages_role_check;
ALTER TABLE messages ADD CONSTRAINT messages_role_check CHECK (role IN ('user','assistant'));

DROP INDEX IF EXISTS messages_session_idx;
CREATE INDEX messages_session_sequence_index ON messages(session_id, sequence);

-- migrate:down
DROP INDEX IF EXISTS messages_session_sequence_index;
CREATE INDEX messages_session_idx ON messages(session_id);

ALTER TABLE messages DROP CONSTRAINT messages_role_check;
ALTER TABLE messages ADD CONSTRAINT messages_role_check CHECK (role IN ('user','assistant','tool'));

ALTER TABLE messages DROP COLUMN sequence;
ALTER TABLE messages DROP COLUMN parts;
ALTER TABLE messages ADD COLUMN sources jsonb;
ALTER TABLE messages RENAME COLUMN message_id TO id;

ALTER TABLE sessions ADD COLUMN user_id text NOT NULL DEFAULT 'local';
ALTER TABLE sessions RENAME COLUMN session_id TO id;
