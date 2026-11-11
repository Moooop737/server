-- migrate:up
-- T2 B0：embeddings.model 从裸 modelId 统一为模型键（${provider.name}:${model_id}）。
-- 安全阀：仅当真实嵌入模型行恰好 1 条且默认行指向它时回填；多嵌入模型环境跳过，避免错误归属。
-- 回填不可逆；执行前备份 id, model（见 handoff / spec B0）。

CREATE INDEX IF NOT EXISTS embeddings_model_dimension_idx ON embeddings (model, dimension);

UPDATE embeddings e
SET model = m.id
FROM models m
JOIN models d
  ON d.kind = 'default'
 AND d.id = 'embedding'
 AND d.provider_id = m.provider_id
 AND d.model_id = m.model_id
WHERE m.kind = 'embedding'
  AND e.model <> m.id
  AND (SELECT count(*) FROM models WHERE kind = 'embedding') = 1;

-- migrate:down
DROP INDEX IF EXISTS embeddings_model_dimension_idx;
-- model 旧值不回滚：走备份表恢复
