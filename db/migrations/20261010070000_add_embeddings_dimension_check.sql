-- migrate:up
-- NFR-6 最硬一道闸：dimension 必须等于向量真实长度。
-- AD-4 把 embedding 改为不定长 halfvec 后，"撒谎的 dimension"（如 768 未建索引档）可静默入库，
-- 检索期一致性校验读的就是这个自报值 → 形同虚设。用 vector_dims() 让库自己兜住真值。
ALTER TABLE embeddings ADD CONSTRAINT embeddings_dimension_matches
  CHECK (dimension = vector_dims(embedding));

-- migrate:down
ALTER TABLE embeddings DROP CONSTRAINT IF EXISTS embeddings_dimension_matches;
