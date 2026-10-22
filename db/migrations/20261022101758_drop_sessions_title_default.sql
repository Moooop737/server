-- migrate:up
-- 未命名标题的空串由 createSession(Title ?? '') 提供；DB 不再重复兜底
ALTER TABLE sessions ALTER COLUMN title DROP DEFAULT;

-- migrate:down
ALTER TABLE sessions ALTER COLUMN title SET DEFAULT '';
