/**
 * ParadeDbVectorSearch —— 向量检索 stage。三条硬约束：
 * 1. pg 的 `<=>` 返回**余弦距离**（0~2），相似度 = 1 − 距离；阈值换算与过滤在 TS 侧做，
 *    写进 SQL 的 `WHERE 1 - dist >= x` 会让排序走不进 HNSW 的 top-k 路径。
 * 2. 排序表达式必须与 embeddings_hnsw 的 partial 表达式索引定义**逐字同形** `embedding::halfvec(N) <=> $1::halfvec(N)`，
 *    否则优化器不走该索引（实测形式对上时 `Index Scan using embeddings_hnsw`）。
 * 3. `::halfvec(N)` 的 N 是类型修饰符，只接受 SQL 字面量、不能用绑定参数 ⇒ 维度经整数校验后拼进文本。
 * 软删谓词只加 `r.deleted_at IS NULL`（Story 2.1 定）：chunks 物理删、embeddings 经 FK CASCADE 随之消失。
 */

export { ParadeDbVectorSearch }

import type { Pool } from 'pg'
import type { RetrievedChunk, RetrieverDeps, VectorSearcher } from '../contracts'
import { rowToChunk } from '../../adapters/paradedb-repository'

class ParadeDbVectorSearch implements VectorSearcher {
  private readonly pool: Pool
  private readonly dimension: number
  private readonly minSimilarity: number

  constructor(Deps: RetrieverDeps) {
    const { dimension, minSimilarity } = Deps.config
    if (!Number.isInteger(dimension) || dimension <= 0) {
      throw new Error(`ParadeDbVectorSearch: dimension 需为正整数，收到 ${dimension}`)
    }
    this.pool = Deps.pool
    this.dimension = dimension
    this.minSimilarity = minSimilarity
  }

  async search(QueryVector: number[], Limit: number): Promise<RetrievedChunk[]> {
    if (QueryVector.length !== this.dimension) {
      throw new Error(
        `ParadeDbVectorSearch: 查询向量 ${QueryVector.length} 维与检索维度 ${this.dimension} 不符`
      )
    }

    const Dim = this.dimension
    const { rows } = await this.pool.query(
      `SELECT c.*, r.title AS doc_title, r.source AS source, r.data_uri AS data_uri,
              (1 - (e.embedding::halfvec(${Dim}) <=> $1::halfvec(${Dim})))::float8 AS similarity
         FROM embeddings e
         JOIN chunks c    ON c.id = e.source_id
         JOIN resources r ON r.id = c.resource_id AND r.deleted_at IS NULL
        WHERE e.dimension = ${Dim}
        ORDER BY e.embedding::halfvec(${Dim}) <=> $1::halfvec(${Dim})
        LIMIT $2`,
      [`[${QueryVector.join(',')}]`, Limit]
    )

    return rows.map((row: Record<string, unknown>) => ({
      chunk: rowToChunk(row),
      docTitle: String(row.doc_title),
      source: row.source === null ? null : String(row.source),
      dataUri: String(row.data_uri),
      score: 0, // 融合前没有名次分，由 Fuser 填
      similarity: Number(row.similarity),
      lexicalScore: null,
    })).filter((hit) => hit.similarity >= this.minSimilarity)
  }
}
