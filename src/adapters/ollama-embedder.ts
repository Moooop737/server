import type { Embedder } from '../ports/embedder'

export interface OllamaEmbedderOptions {
  baseUrl: string
  model: string
  dimensions?: number
}

export class OllamaEmbedder implements Embedder {
  readonly dimensions: number
  private readonly model: string
  private readonly baseUrl: string

  constructor(opts: OllamaEmbedderOptions) {
    this.model = opts.model
    this.dimensions = opts.dimensions ?? 1024
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
  }

  async embed(texts: string[], options?: { dimensions?: number }): Promise<number[][]> {
    const dims = options?.dimensions ?? this.dimensions
    const res = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts, dimensions: dims }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      throw new Error(`OllamaEmbedder HTTP ${res.status}: ${await res.text()}`)
    }
    const json = (await res.json()) as { data?: { embedding: number[] }[] }
    if (!Array.isArray(json.data) || json.data.length !== texts.length) {
      throw new Error(`OllamaEmbedder: expected ${texts.length} vectors`)
    }
    return json.data.map((d) => d.embedding)
  }
}