import type { Embedder } from '../ports/embedder'
import type { Repository } from '../ports/repository'
import type { Resource } from '../types/types'

// ── stage 之间传的数据 ──

export interface IngestInput {
  kind: 'url' | 'text'
  content_type: Resource['content_type'] // 'url' | 'markdown' | 'plaintext'
  url?: string
  content?: string
  title?: string
}

export interface ChunkPlan {
  chunk_index: number
  content: string
  start_offset: number // JS 字符串索引，保证 text.slice(start,end) === content
  end_offset: number
  // 扩展位，现在都不填
  contextHeader?: string
  tokenCount?: number
  strategy?: string // 算法自己写名字，不在这里定枚举
  metadata?: Record<string, unknown>
}

// 执行器边跑边填的运行时容器；cfg 全程只读，故两者分开传
export interface IngestContext {
  input: IngestInput
  fetched?: Fetched
  parsed?: Parsed
  chunks?: ChunkPlan[]
}

// ── 拼好的 pipeline：选算法 + 注入端口 + 待处理输入 ──

export interface IngestConfig {
  fetch: Fetcher
  parse: Parser
  chunk: Chunker
  embedder: Embedder
  repo: Repository
  input: IngestInput
}

// ── 三个 stage 的接口 ──

export interface Fetcher {
  readonly name: string
  run(ctx: IngestContext, signal?: AbortSignal): Promise<void>
}

export interface Fetched {
  raw: string
  title?: string
  warning?: string // 如 '可能抓不全'
}

export interface Parser {
  readonly name: string
  run(ctx: IngestContext): void
}

export interface Parsed {
  title: string
  text: string
}

export interface Chunker {
  readonly name: string
  run(ctx: IngestContext): void
}

