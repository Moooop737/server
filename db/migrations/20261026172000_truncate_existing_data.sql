-- migrate:up

-- 清空全部业务数据，保留 schema_migrations 与扩展表；执行前请备份，不可逆
TRUNCATE TABLE embeddings, chunks, resources, trace_stages, traces RESTART IDENTITY;

-- migrate:down

-- 数据删除无法逆向恢复；不做假回滚，明确让 dbmate down 失败
DO $$
BEGIN
  RAISE EXCEPTION '20261026172000 清空数据不可逆；请从备份恢复';
END $$;
