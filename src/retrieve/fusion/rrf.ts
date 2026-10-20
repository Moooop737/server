/**
 * RRF（Reciprocal Rank Fusion）—— 只按各路名次融合，不吃原始分数：
 * 实测 cosine 相似度分布被压得很扁（无意义串也有 0.406、正常问句 0.47~0.58），绝对分数没有跨路可比性，名次才有。
 * 同一个 chunk 被两路都命中时分数相加（各 contribution = 1/(k + rank)），similarity 与 lexicalScore 各自补全，不互相覆盖。
 */

export { RrfFuser }

import type { RetrievedChunk, RetrievalResult } from '../contracts'
import type { Fuser, RetrieverDeps } from '../contracts'

class RrfFuser implements Fuser {
  private readonly k: number
  private readonly defaultLimit: number

  constructor(Deps: RetrieverDeps) {
    this.k = Deps.config.retrievalRrfK
    this.defaultLimit = Deps.config.retrievalDefaultLimit
  }

  fuse(
    Lists: { vector: RetrievedChunk[]; lexical: RetrievedChunk[] },
    Limit?: number
  ): RetrievalResult {
    const merged = new Map<string, RetrievedChunk>()

    for (const list of [Lists.vector, Lists.lexical]) {
      list.forEach((hit, index) => {
        const contribution = 1 / (this.k + index + 1)
        const prev = merged.get(hit.chunk.id)
        if (prev) {
          prev.score += contribution
          prev.similarity ??= hit.similarity
          prev.lexicalScore ??= hit.lexicalScore
        } else {
          merged.set(hit.chunk.id, { ...hit, score: contribution })
        }
      })
    }

    const hits = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, Limit ?? this.defaultLimit)

    return { hits, vectorCount: Lists.vector.length, lexicalCount: Lists.lexical.length }
  }
}
