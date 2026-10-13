import type { Embedder } from '../ports/embedder'
import type { Repository } from '../ports/repository'
import type { Resource } from '../types/types'

// ── 工厂输入：装配规格（无数据）──
export interface Recipe {
  fetcher: string   // 'http' | 'passthrough'
  parser: string    // 'html' | 'text'
  chunker: string   // 'legacy'
  embedder: string  // 'qwenembed'
  repo: Repository
  config: PipelineConfig
}

// 微调各策略的旋钮，不含业务数据；bootstrap 从 AppConfig 派生。只列真有消费者读取的字段
export interface PipelineConfig {
  ollamaBaseUrl: string
  embeddingModel: string  // 写进 embeddings.model 的模型标识，不是注册表里的策略名
  embeddingDimensions: number
}

// ── run/batch 输入：业务数据 ──
export interface KBData {
  content_type: Resource['content_type'] // 'url' | 'markdown' | 'plaintext'
  url?: string
  content?: string
  title?: string
}

// ── 工厂输出：可执行对象 ──
export interface Pipeline {
  run(Data: KBData, Signal?: AbortSignal): Promise<IngestResult>
  batch(Data: KBData[], Signal?: AbortSignal): Promise<IngestResult[]>
}

export interface IngestResult {
  resource: Resource | null // null = 建行之前的拒绝（如查重命中）
  chunkCount: number
  failure?: { code: string; reason: string }
  warning?: string // 入库成功但可疑（如正文相对原页过短 ⇒ 可能 JS 渲染/反爬），不阻断
}

// ── 名字→实例 的注册表（纯目录，查无返回 undefined，由工厂抛 E_UNKNOWN_STAGE）──
export interface StageRegistry {
  fetcher(Name: string, Config: PipelineConfig): Fetcher | undefined
  parser(Name: string, Config: PipelineConfig): Parser | undefined
  chunker(Name: string, Config: PipelineConfig): Chunker | undefined
  embedder(Name: string, Config: PipelineConfig): Embedder | undefined
}

// ── stage 之间传的数据 ──
export interface IngestContext {
  data: KBData
  fetched?: Fetched
  parsed?: Parsed
  chunks?: ChunkPlan[]
}

export interface ChunkPlan {
  chunk_index: number
  content: string
  start_offset: number // JS 字符串索引，保证 text.slice(start,end) === content
  end_offset: number
  contextHeader?: string
  tokenCount?: number
  strategy?: string
  metadata?: Record<string, unknown>
}

// ── 三个 stage 接口 ──
export interface Fetcher {
  readonly name: string
  run(ctx: IngestContext, signal?: AbortSignal): Promise<void>
}
export interface Fetched {
  raw: string
  title?: string
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
