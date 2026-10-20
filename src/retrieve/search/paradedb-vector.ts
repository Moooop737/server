/**
 * 向量候选的薄适配器 —— SQL 住 adapter/repo/search-vector.ts，本类只做三件事：拿 Deps.repo、调具名方法、补 score。
 * 留在本层的两件事有明确归属：相似度阈值过滤（retrieve/ 的旋钮，只兜字符噪声）与名次分占位（真 score 由 Fuser 融合后覆盖）。
 * 维度在本类只校验到「config.embeddingDimensions 是正整数」，好让装配错误在 assemble 时就炸；
 * 拼进 SQL 字面量前的那道 Number.isInteger 防线在 repo 的候选查询里（AD-9），查询向量长度与维度的一致性也在那儿判。
 */

export { ParadeDbVectorSearch }

import type { Repo } from '../../adapter/contract'
import type { RetrievedChunk, RetrieverDeps, VectorSearcher } from '../contracts'

class ParadeDbVectorSearch implements VectorSearcher {
  private readonly repo: Repo
  private readonly dimension: number
  private readonly minSimilarity: number

  constructor(Deps: RetrieverDeps) {
    const { embeddingDimensions: dimension, retrievalMinSimilarity: minSimilarity } = Deps.config
    if (!Number.isInteger(dimension) || dimension <= 0) {
      throw new Error(`ParadeDbVectorSearch: dimension 需为正整数，收到 ${dimension}`)
    }
    this.repo = Deps.repo
    this.dimension = dimension
    this.minSimilarity = minSimilarity
  }

  async search(QueryVector: number[], Limit: number): Promise<RetrievedChunk[]> {
    const candidates = await this.repo.vectorCandidates(QueryVector, Limit, this.dimension)
    return candidates
      .filter((candidate) => candidate.similarity !== null && candidate.similarity >= this.minSimilarity)
      .map((candidate) => ({ ...candidate, score: 0 }))
  }
}
