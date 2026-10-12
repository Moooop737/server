/**
 * 入库编排 —— runIngest() 串起 parse → chunk → embed → 写；文本入库跳过 fetch。
 * 失败语义（对齐 Story 1.2/1.3 AC）：
 *   输入非法/空        → 抛 IngestError，不建 Resource
 *   解析后 0 块        → Resource 转 failed(内容为空)
 *   embed 失败         → Resource 转 failed(embedding_error)，不留残余 chunk
 *   abort / 未预期错误 → 清残余 chunk、转 failed，再抛出
 */

export { runIngest }

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

export interface IngestDeps {
  parse: Parser
  chunk: Chunker
  embedder: Embedder
  repo: Repository
  embeddingModel: string
  fetch?: Fetcher // url only
}

export interface IngestResult {
  resource: Resource
  chunkCount: number
}

export class IngestError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'IngestError'
    this.code = code
  }
}

async function runIngest(
  Deps: IngestDeps,
  Input: IngestInput,
  Signal?: AbortSignal,
): Promise<IngestResult> {
  if (Input.kind === 'text') {
    if (Input.content_type !== 'markdown' && Input.content_type !== 'plaintext') {
      throw new IngestError('E_BAD_CONTENT_TYPE', `不支持的类型: ${Input.content_type}`)
    }
    if (!Input.content || Input.content.trim() === '') {
      throw new IngestError('E_EMPTY_CONTENT', '内容为空，拒绝入库')
    }
  }

  const ctx: IngestContext = { input: Input }

  if (Input.kind === 'url') {
    if (!Deps.fetch) throw new IngestError('E_NO_FETCHER', '缺少 fetch stage')
    await Deps.fetch.run(ctx, Signal)
  }

  Deps.parse.run(ctx)
  const parsed = ctx.parsed
  if (!parsed || parsed.text.trim() === '') {
    throw new IngestError('E_EMPTY_CONTENT', '解析后无正文，拒绝入库')
  }

  const isUrl = Input.kind === 'url'
  const dataUri = isUrl ? Input.url! : `urn:kc:paste:${globalThis.crypto.randomUUID()}`
  const resource = await Deps.repo.createResource({
    title: parsed.title,
    source: isUrl ? Input.url! : null,
    data_uri: dataUri,
    content_type: Input.content_type,
    status: 'processing',
  })

  const fail = async (reason: string): Promise<IngestResult> => {
    await Deps.repo.deleteChunksByResource(resource.id).catch(() => {})
    await Deps.repo.updateResourceStatus(resource.id, 'failed', reason)
    return { resource: { ...resource, status: 'failed', error_reason: reason }, chunkCount: 0 }
  }

  try {
    Deps.chunk.run(ctx)
    const plans = ctx.chunks ?? []
    if (plans.length === 0) return await fail('内容为空')
    if (Signal?.aborted) throw new IngestError('E_ABORTED', '入库已取消')

    let vectors: number[][]
    try {
      vectors = await Deps.embedder.embed(plans.map((p) => p.content))
    } catch (err) {
      console.error(JSON.stringify({ code: 'E_EMBED', message: String(err) }))
      return await fail('embedding_error')
    }
    if (vectors.length !== plans.length) return await fail('embedding_error')
    if (Signal?.aborted) throw new IngestError('E_ABORTED', '入库已取消')

    const chunks = await Deps.repo.createChunks(
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
      await Deps.repo.createEmbeddings(
        plans.map((p, i) => ({
          source_id: idByIndex.get(p.chunk_index)!,
          source_type: 'chunk' as const,
          dimension: vectors[i]!.length,
          model: Deps.embeddingModel,
          embedding: vectors[i]!,
        })),
      )
    } catch (err) {
      console.error(JSON.stringify({ code: 'E_EMBED_WRITE', message: String(err) }))
      return await fail('embedding_error')
    }

    await Deps.repo.updateResourceStatus(resource.id, 'ready')
    return { resource: { ...resource, status: 'ready', error_reason: null }, chunkCount: chunks.length }
  } catch (err) {
    const reason = err instanceof IngestError && err.code === 'E_ABORTED' ? '入库取消' : '入库失败'
    await fail(reason).catch(() => {})
    throw err
  }
}
