-- migrate:up
ALTER TABLE traces ADD COLUMN payloads jsonb;

-- migrate:down
ALTER TABLE traces DROP COLUMN payloads;
