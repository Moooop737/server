-- migrate:up

UPDATE pipeline_defs
SET nodes = (
  SELECT jsonb_agg(Node)
  FROM jsonb_array_elements(nodes) AS Node
  WHERE Node->>'id' <> 'dimension_check'
),
updated_at = now()
WHERE id = 'default';

-- migrate:down

-- dimension_check 组件已从代码删除，回填节点会让装配失败；本迁移不回滚。
