/**
 * 向量候选的薄适配器 —— SQL 住 adapter/repo/search-vector.ts，本类只做三件事：拿 Deps.repo、调具名方法、补 score。
 * 留在本层的两件事有明确归属：相似度阈值过滤（retrieve/ 的旋钮，只兜字符噪声）与名次分占位（真 score 由 Fuser 融合后覆盖）。
 * 维度来自当前嵌入快照（Deps.embedding.dimensions），每次 search 现取；不再读 env / 构造期锁死。
 * 拼进 SQL 字面量前的那道 Number.isInteger 防线在 repo 的候选查询里（AD-9），查询向量长度与维度的一致性也在那儿判。
 */

export { ParadeDbVectorSearch }

import type { Repo } from '../../adapter/contract'
import type { RetrievedChunk, RetrieverDeps, VectorSearcher } from '../contracts'

class ParadeDbVectorSearch implements VectorSearcher {
  private readonly deps: RetrieverDeps
  private readonly minSimilarity: number

  constructor(Deps: RetrieverDeps) {
    this.deps = Deps
    this.minSimilarity = Deps.config.retrievalMinSimilarity
  }

  async search(QueryVector: number[], Limit: number, MinSimilarity?: number): Promise<RetrievedChunk[]> {
    const Dimension = this.deps.embedding.dimensions
    if (!Number.isInteger(Dimension) || Dimension <= 0) {
      throw new Error(`ParadeDbVectorSearch: dimension 需为正整数，收到 ${Dimension}`)
    }
    const Threshold = MinSimilarity ?? this.minSimilarity
    const candidates = await this.deps.repo.vectorCandidates(QueryVector, Limit, Dimension)
    return candidates
      .filter((candidate) => candidate.similarity !== null && candidate.similarity >= Threshold)
      .map((candidate) => ({ ...candidate, score: 0 }))
  }
}
