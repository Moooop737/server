/**
 * 向量候选查询 —— 只交候选行，不做阈值过滤、不排名次分（那些归 retrieve/，AD-3）。
 * 三条硬约束，改这段 SQL 之前先读：
 * 1. pg 的 `<=>` 返回**余弦距离**（0~2），相似度 = 1 − 距离；阈值换算放到 TS 侧做，
 *    写进 SQL 的 `WHERE 1 - dist >= x` 实测会挡掉 HNSW 的 top-k 通道。
 * 2. 排序表达式必须与 embeddings_hnsw 的 partial 表达式索引定义**逐字同形** `embedding::halfvec(N) <=> $1::halfvec(N)`，
 *    并且**必须留着 `WHERE e.dimension = N` 这条谓词** —— 实测摘掉任一个即退 Seq Scan（partial 索引要同时匹配表达式与谓词）。
 * 3. `::halfvec(N)` 的 N 是类型修饰符，只接受 SQL 字面量、不能用绑定参数 ⇒ Dim 经整数校验后拼进文本，
 *    这道 Number.isInteger 校验是该处唯一的注入防线（AD-9）。
 * 软删谓词只加 `r.deleted_at IS NULL`；另加 `r.status = 'ready'`（T2 B0：只检索写完的资源，防御直接写库/历史数据）。
 * model 谓词是 T2 B0 的身份线：向量只属于产它的模型键（`${provider.name}:${model_id}`），旧模型向量不参与检索。
 * dimensionsInStore 传 ModelKey 时只数该模型的维度（检索前混维判定）；不传则数全库（启动日志）。
 */

export { vectorCandidates, dimensionsInStore }

import type { Pool } from 'pg'
import type { ChunkCandidate } from '../contract'
import { rowToChunk } from './chunk'

async function vectorCandidates(
  Db: Pool,
  QueryVector: number[],
  Limit: number,
  Dim: number,
  ModelKey: string,
): Promise<ChunkCandidate[]> {
  if (!Number.isInteger(Dim) || Dim <= 0) {
    throw new Error(`vectorCandidates: dimension 需为正整数，收到 ${Dim}`)
  }
  if (QueryVector.length !== Dim) {
    throw new Error(`vectorCandidates: 查询向量 ${QueryVector.length} 维与检索维度 ${Dim} 不符`)
  }
  if (!ModelKey.trim()) {
    throw new Error('vectorCandidates: modelKey 不能为空')
  }

  const { rows } = await Db.query(
    `SELECT c.*, r.title AS doc_title, r.source AS source, r.data_uri AS data_uri,
            (1 - (e.embedding::halfvec(${Dim}) <=> $1::halfvec(${Dim})))::float8 AS similarity
       FROM embeddings e
       JOIN chunks c    ON c.id = e.source_id
       JOIN resources r ON r.id = c.resource_id AND r.deleted_at IS NULL AND r.status = 'ready'
      WHERE e.dimension = ${Dim}
        AND e.model = $3
      ORDER BY e.embedding::halfvec(${Dim}) <=> $1::halfvec(${Dim})
      LIMIT $2`,
    [`[${QueryVector.join(',')}]`, Limit, ModelKey],
  )

  return rows.map((row: Record<string, unknown>) => ({
    chunk: rowToChunk(row),
    docTitle: String(row.doc_title),
    source: row.source === null ? null : String(row.source),
    dataUri: String(row.data_uri),
    similarity: Number(row.similarity),
    lexicalScore: null,
  }))
}

async function dimensionsInStore(Db: Pool, ModelKey?: string): Promise<number[]> {
  const { rows } = ModelKey === undefined
    ? await Db.query('SELECT DISTINCT dimension FROM embeddings ORDER BY dimension')
    : await Db.query('SELECT DISTINCT dimension FROM embeddings WHERE model = $1 ORDER BY dimension', [ModelKey])
  return rows.map((row: { dimension: number }) => Number(row.dimension))
}
