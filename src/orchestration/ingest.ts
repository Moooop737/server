import type { Embedder } from '../ports/embedder'
import type { Repository } from '../ports/repository'
import type { Resource } from '../types/types'
import type {
  Chunker,
  Fetcher,
  IngestContext,
  IngestInput,
  Parser,
} from '../pipeline/contracts'

// 执行器依赖：stage 走端口抽象，embed 需要模型名落库（Embedder 端口不暴露 model）
export interface IngestDeps {
  parse: Parser
  chunk: Chunker
  embedder: Embedder
  repo: Repository
  embeddingModel: string
  fetch?: Fetcher // Story 1.2 URL 抓取时注入；文本入库不需要
}

export interface IngestResult {
  resource: Resource
  chunkCount: number
}

// 入库前校验失败（不该建 Resource）用它；带 code 供路由映射 4xx
export class IngestError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'IngestError'
    this.code = code
  }
}

// 串起 parse → chunk → embed → 写。文本入库跳过 fetch。
// 失败语义（对齐 Story 1.2/1.3 AC）：
//   输入非法/空        → 抛 IngestError，不建 Resource
//   解析后 0 块        → Resource 转 失败(内容为空)
//   embed 失败         → Resource 转 失败(embedding_error)，不留残余 chunk
//   abort / 未预期错误 → 清残余 chunk、转 失败，再抛出
export async function runIngest(
  deps: IngestDeps,
  input: IngestInput,
  signal?: AbortSignal,
): Promise<IngestResult> {
  if (input.kind === 'text') {
    if (input.content_type !== 'markdown' && input.content_type !== 'plaintext') {
      throw new IngestError('E_BAD_CONTENT_TYPE', `不支持的类型: ${input.content_type}`)
    }
    if (!input.content || input.content.trim() === '') {
      throw new IngestError('E_EMPTY_CONTENT', '内容为空，拒绝入库')
    }
  }

  const ctx: IngestContext = { input }

  if (input.kind === 'url') {
    if (!deps.fetch) throw new IngestError('E_NO_FETCHER', '缺少 fetch stage')
    await deps.fetch.run(ctx, signal)
  }

  deps.parse.run(ctx)
  const parsed = ctx.parsed
  if (!parsed || parsed.text.trim() === '') {
    throw new IngestError('E_EMPTY_CONTENT', '解析后无正文，拒绝入库')
  }

  // 过了输入校验，正式进入入库：建 Resource(processing)
  const isUrl = input.kind === 'url'
  const dataUri = isUrl ? input.url! : `urn:kc:paste:${globalThis.crypto.randomUUID()}`
  const resource = await deps.repo.createResource({
    title: parsed.title,
    source: isUrl ? input.url! : null,
    data_uri: dataUri,
    content_type: input.content_type,
    status: 'processing',
  })

  const fail = async (reason: string): Promise<IngestResult> => {
    await deps.repo.deleteChunksByResource(resource.id).catch(() => {})
    await deps.repo.updateResourceStatus(resource.id, 'failed', reason)
    return { resource: { ...resource, status: 'failed', error_reason: reason }, chunkCount: 0 }
  }

  try {
    deps.chunk.run(ctx)
    const plans = ctx.chunks ?? []
    if (plans.length === 0) return await fail('内容为空')
    if (signal?.aborted) throw new IngestError('E_ABORTED', '入库已取消')

    // 先算向量：此时还没写 chunk，embed 失败则库内干净
    let vectors: number[][]
    try {
      vectors = await deps.embedder.embed(plans.map((p) => p.content))
    } catch (err) {
      console.error(JSON.stringify({ code: 'E_EMBED', message: String(err) }))
      return await fail('embedding_error')
    }
    if (vectors.length !== plans.length) return await fail('embedding_error')
    if (signal?.aborted) throw new IngestError('E_ABORTED', '入库已取消')

    const chunks = await deps.repo.createChunks(
      resource.id,
      plans.map((p) => ({
        chunk_index: p.chunk_index,
        content: p.content,
        start_offset: p.start_offset,
        end_offset: p.end_offset,
      })),
    )
    const idByIndex = new Map(chunks.map((c) => [c.chunk_index, c.id]))

    try {
      await deps.repo.createEmbeddings(
        plans.map((p, i) => ({
          source_id: idByIndex.get(p.chunk_index)!,
          source_type: 'chunk' as const,
          dimension: vectors[i]!.length,
          model: deps.embeddingModel,
          embedding: vectors[i]!,
        })),
      )
    } catch (err) {
      console.error(JSON.stringify({ code: 'E_EMBED_WRITE', message: String(err) }))
      return await fail('embedding_error')
    }

    await deps.repo.updateResourceStatus(resource.id, 'ready')
    return { resource: { ...resource, status: 'ready', error_reason: null }, chunkCount: chunks.length }
  } catch (err) {
    const reason = err instanceof IngestError && err.code === 'E_ABORTED' ? '入库取消' : '入库失败'
    await fail(reason).catch(() => {})
    throw err
  }
}
