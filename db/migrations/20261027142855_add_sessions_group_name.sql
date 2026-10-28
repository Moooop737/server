-- migrate:up

-- NULL = 未分组；组名由前端按字符串筛选
ALTER TABLE sessions ADD COLUMN group_name text;

-- migrate:down

ALTER TABLE sessions DROP COLUMN IF EXISTS group_name;
