-- migrate:up

-- NULL = 未记录，回落 CHAT_MODEL；只是记录，不构成限制
ALTER TABLE sessions ADD COLUMN model text;

-- migrate:down

ALTER TABLE sessions DROP COLUMN IF EXISTS model;
