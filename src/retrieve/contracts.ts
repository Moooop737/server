/**
 * 检索编排层类型。与 ingest/contracts.ts 同构：Recipe 是装配规格（策略名 + 活依赖 + 旋钮，不含业务数据），可执行对象只在 search 时才吃问句。
 * 与 ingest 的两处形状差异：
 * · 注册表构造函数统一吃 RetrieverDeps（repo + embedding + config），因为 vector/lexical 两路真要读库；
 *   config 就是根 config.ts 那个 AppConfig 整袋，本层不再自己声明一份改名的旋钮子集（2026-10-20 Lynx 定，字段名以 config.ts 为唯一出处）。
 *   ingest 的 stage 不碰库，repo 由 assemble 自己捆，所以那边只需要策略名。
 * · Retriever / RetrievalResult / RetrievedChunk 这三个「可执行契约」也住这里 —— 对齐 ingest 的 Ingest/IngestResult。
 *   RetrievedChunk 直接 extends 门里的 ChunkCandidate 再加 score，字段清单不在本层重抄一遍（改一侧必然要同步另一侧的那种）。
 *   协作者（Repo 与 EmbeddingHandle）一律来自 adapter/contract.ts 那道门，本层不再自己声明端口；embed 不在注册表里，它是装配选定的一行句柄。
 */

import type { ChunkCandidate, EmbeddingHandle, Repo } from '../adapter/contract'
import type { AppConfig } from '../config'

export type {
  RetrieverDeps, RetrieverRecipe, RetrieverStageRegistry,
  VectorSearcher, LexicalSearcher, Fuser,
  Retriever, RetrievalResult, RetrievedChunk,
}

interface RetrieverDeps {
  repo: Repo
  embedding: EmbeddingHandle
  config: AppConfig
}

interface RetrieverRecipe {
  vectorSearch: string
  lexicalSearch?: string // 不填则单走向量路、lexicalCount 恒 0；当前两条路由都填 'paradedb-bm25'
  fusion: string
  deps: RetrieverDeps
}

interface VectorSearcher {
  search(QueryVector: number[], Limit: number): Promise<RetrievedChunk[]>
}

interface LexicalSearcher {
  search(QueryText: string, Limit: number): Promise<RetrievedChunk[]>
}

interface Fuser {
  fuse(Lists: { vector: RetrievedChunk[]; lexical: RetrievedChunk[] }, Limit?: number): RetrievalResult
}

interface RetrieverStageRegistry {
  vectorSearch(Name: string, Deps: RetrieverDeps): VectorSearcher | undefined
  lexicalSearch(Name: string, Deps: RetrieverDeps): LexicalSearcher | undefined
  fusion(Name: string, Deps: RetrieverDeps): Fuser | undefined
}

interface RetrievedChunk extends ChunkCandidate {
  score: number // RRF 名次分，由 Fuser 覆盖；候选层（ChunkCandidate）不产出它
}

interface RetrievalResult {
  hits: RetrievedChunk[]
  vectorCount: number // 向量路**过阈值后**的条数（不是召回条数）；判「未找到」用它与 lexicalCount，别用 hits.length —— hits 已被 limit 截过
  lexicalCount: number
}

interface Retriever {
  search(Query: string, Options?: { limit?: number }): Promise<RetrievalResult>
}
