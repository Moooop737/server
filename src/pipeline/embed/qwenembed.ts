/**
 * qwenembed —— 本地 Ollama 的 OpenAI 兼容 /v1/embeddings 端点，实现 ports 的 Embedder 契约。
 * 形状与 fetch/parse/chunk 各 stage 对称：类文件住 pipeline 层、自己发 fetch、config 在构造时吃进来，由注册表按名字兑换。
 * 名字位是校验位不是选择位：全库只允许一个 embedding 模型（检索期 query 必须与被检索行同模型同维度），P1 注册表里只有这一项。
 * dimensions 走 MRL 截维（实测不带返回 4096、带 dimensions:1024 返回 1024）。
 * Options.signal 是入库管线的取消信号，与本类自带的 EMBED_TIMEOUT_MS 超时合成一个信号，任一触发即中断请求；
 * 中断只掐网络请求，落库改状态那一步绝不复用这个信号（见 pipelines.ts 的 fail()）。
 */

export { QwenEmbedder }

import type { Embedder } from '../../ports/embedder'
import type { PipelineConfig } from '../contracts'

const EMBED_TIMEOUT_MS = 30_000

class QwenEmbedder implements Embedder {
  readonly dimensions: number
  private readonly baseUrl: string
  private readonly model: string

  constructor(Config: PipelineConfig) {
    this.baseUrl = Config.ollamaBaseUrl.replace(/\/+$/, '')
    this.model = Config.embeddingModel
    this.dimensions = Config.embeddingDimensions
  }

  async embed(Texts: string[], Options?: { dimensions?: number; signal?: AbortSignal }): Promise<number[][]> {
    const signals = [AbortSignal.timeout(EMBED_TIMEOUT_MS)]
    if (Options?.signal) signals.push(Options.signal)

    const res = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: Texts, dimensions: Options?.dimensions ?? this.dimensions }),
      signal: AbortSignal.any(signals),
    })
    if (!res.ok) throw new Error(`QwenEmbedder HTTP ${res.status}: ${await res.text()}`)

    const json = (await res.json()) as { data?: { embedding: number[] }[] }
    if (!Array.isArray(json.data) || json.data.length !== Texts.length) {
      throw new Error(`QwenEmbedder: expected ${Texts.length} vectors`)
    }
    return json.data.map((d) => d.embedding)
  }
}
