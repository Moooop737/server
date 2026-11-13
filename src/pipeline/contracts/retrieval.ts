/**
 * 检索编排层对外契约 —— Retriever / RetrievalResult / RetrievedChunk / SearchOptions。
 * 装配与执行细节住 retrieve/pipeline/；本文件只留路由、工具、eval 共用的可执行形状。
 * 检索参数只认管线自身 config；调用方只可传模型身份（执行身份，不是调参）与观测 sink。
 */

export { RetrieverError }
export type { Retriever, RetrievalResult, RetrievedChunk, SearchOptions }

import type { ChunkCandidate } from '../adapter/contract'
import type { StageSink } from '../trace/systemtrace/stage'

class RetrieverError extends Error {
  readonly code: string

  constructor(Code: string, Message: string) {
    super(Message)
    this.name = 'RetrieverError'
    this.code = Code
  }
}

interface RetrievedChunk extends ChunkCandidate {
  score: number // RRF 名次分，由融合侧覆盖；候选层（ChunkCandidate）不产出它
}

interface RetrievalResult {
  hits: RetrievedChunk[]
  vectorCount: number // 向量路**过阈值后**的条数（不是召回条数）；判「未找到」用它与 lexicalCount，别用 hits.length —— hits 已被管线结果节点截过
  lexicalCount: number
}

interface Retriever {
  search(Query: string, Options?: SearchOptions): Promise<RetrievalResult>
}

interface SearchOptions {
  sink?: StageSink
  model?: string // 嵌入模型键 provider:model_id；不传则走管线引脚默认 / 全局默认
}
