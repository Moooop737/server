/**
 * 检索编排层类型。与 pipeline/contracts.ts 同构：Recipe 是装配规格（策略名 + 活依赖 + 旋钮，不含业务数据），可执行对象只在 search 时才吃问句。
 * 与 pipeline 的两处形状差异：
 * · 注册表构造函数统一吃 RetrieverDeps（pool + config + vectorDimensions），因为 vector/lexical 两路真要读库；
 *   pipeline 的 stage 不碰库，repo 由 assemble 自己捆，所以那边只需要 Config。embedder 与 fusion 忽略用不到的字段。
 * · Retriever / RetrievalResult / RetrievedChunk 这三个「可执行契约」也住这里 —— 对齐 pipeline 的 Pipeline/IngestResult，
 *   ports/ 只放协作者接口（Repository / Embedder / ChatModel）。
 */

import type { Pool } from 'pg'
import type { Embedder } from '../ports/embedder'
import type { Chunk } from '../types/types'

export type {
  RetrieverConfig, RetrieverDeps, RetrieverRecipe, RetrieverStageRegistry,
  VectorSearcher, LexicalSearcher, Fuser,
  Retriever, RetrievalResult, RetrievedChunk,
}

interface RetrieverConfig {
  dimension: number       // 本进程检索的维度，来自 EMBEDDING_DIMENSIONS；库里存的其它维度由 search 期按 vectorDimensions 拒绝
  vectorTopK: number
  lexicalTopK: number
  minSimilarity: number   // 余弦相似度下限（pg 的 <=> 是距离，换算见 vector stage）
  rrfK: number            // RRF 的 k，标准取 60
  defaultLimit: number    // 融合后送进上下文的条数
  ollamaBaseUrl: string
  embeddingModel: string
}

interface RetrieverDeps {
  pool: Pool
  config: RetrieverConfig
  // 启动体检 probeVectorDimensions() 的三态结果，检索前必须先认它：
  //   number[] 且含异维 ⇒ 拒绝作答；[] = 库里真的一条向量都没有（正常空库，放行）；
  //   null = 体检没跑成（库不可达/查询失败），此时**无法排除混维**，一律拒绝 —— 绝不退回 BM25-only 静默作答（AC:186）。
  vectorDimensions: number[] | null
}

interface RetrieverRecipe {
  vectorSearch: string
  lexicalSearch?: string // 不填则单走向量路、lexicalCount 恒 0；当前两条路由都填 'paradedb-bm25'
  fusion: string
  embedder: string
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
  embedder(Name: string, Deps: RetrieverDeps): Embedder | undefined
}

interface RetrievedChunk {
  chunk: Chunk
  docTitle: string
  source: string | null
  dataUri: string
  score: number
  similarity: number | null
  lexicalScore: number | null
}

interface RetrievalResult {
  hits: RetrievedChunk[]
  vectorCount: number // 向量路**过阈值后**的条数（不是召回条数）；判「未找到」用它与 lexicalCount，别用 hits.length —— hits 已被 limit 截过
  lexicalCount: number
}

interface Retriever {
  search(Query: string, Options?: { limit?: number }): Promise<RetrievalResult>
}
