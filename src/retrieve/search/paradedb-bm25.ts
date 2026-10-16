/**
 * 词法候选的薄适配器 —— SQL 住 adapter/repo/search-lexical.ts（含 match_disjunction 的成因与实测），本类只做三件事：拿 Deps.repo、调具名方法、补 score。
 * 留在本层的是「命中」的定义：lexicalScore > 0 才算命中（P1 的词路负责别漏，不负责够不够好，挡噪音是生成侧的事）。
 * 名次分归融合侧：score 这一位由 Fuser 覆盖，本 stage 只填 lexicalScore。
 */

export { ParadeDbBm25Search }

import type { Repo } from '../../adapter/contract'
import type { RetrievedChunk, RetrieverDeps, LexicalSearcher } from '../contracts'

class ParadeDbBm25Search implements LexicalSearcher {
  private readonly repo: Repo

  constructor(Deps: RetrieverDeps) {
    this.repo = Deps.repo
  }

  async search(QueryText: string, Limit: number): Promise<RetrievedChunk[]> {
    const candidates = await this.repo.lexicalCandidates(QueryText, Limit)
    return candidates
      .filter((candidate) => candidate.lexicalScore !== null && candidate.lexicalScore > 0)
      .map((candidate) => ({ ...candidate, score: 0 }))
  }
}
