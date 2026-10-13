/**
 * 入库管线工厂 —— PipelineFactory.assemble(Recipe) 把策略名兑换成实例、捆 repo，产出一个数据无关的可执行对象 Pipeline。
 * run(KBData, Signal) 跑单条；batch(KBData[], Signal) 用同一台机器跑多条，每条独立（一条失败或抛出都不阻断其余，abort 后未开始的不再建行、也不出结果）。
 * 生命周期：查重 → 建 processing 行(title 占位) → 登记 in-flight controller → fetch → parse → 回填真标题 → chunk → embed → 同事务写 chunk+向量并把行转 ready → finally 注销登记。
 * 建行之后的失败都留在那条行上(failed) 并带原因；建行之前的拒绝(查重命中)返回 resource:null。
 * 取消信号的持有者是本管线，不是 HTTP 连接：runOne 自己 new AbortController 并按 resourceId 登记，任意请求都能通过 InflightRegistry.abort(id) 按下它；
 * 调用方另可传一个自己的信号（batch 的整批中止、未来 worker 的停机），两者任一触发即掐。客户端断连不再是取消来源。
 * 硬约束：Signal 只喂 fetch/embed 这类长操作；fail() 落库改状态绝不复用 Signal（aborted signal 会连"失败留痕"一起杀掉）。
 * 依赖：contracts(类型) / ports(Repository,Embedder) / inflight(取消登记处) / recipes(注册表经构造注入)。
 */

export { PipelineFactory, IngestError }

import type { Recipe, KBData, Pipeline, IngestResult, IngestContext, StageRegistry } from './contracts'
import type { InflightRegistry } from './inflight'
import type { Resource } from '../types/types'

class IngestError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'IngestError'
    this.code = code
  }
}

class PipelineFactory {
  private readonly reg: StageRegistry
  private readonly inflight: InflightRegistry

  constructor(Registry: StageRegistry, Inflight: InflightRegistry) {
    this.reg = Registry
    this.inflight = Inflight
  }

  assemble(Recipe: Recipe): Pipeline {
    const fetcher = need(this.reg.fetcher(Recipe.fetcher, Recipe.config), 'fetcher', Recipe.fetcher)
    const parser = need(this.reg.parser(Recipe.parser, Recipe.config), 'parser', Recipe.parser)
    const chunker = need(this.reg.chunker(Recipe.chunker, Recipe.config), 'chunker', Recipe.chunker)
    const embedder = need(this.reg.embedder(Recipe.embedder, Recipe.config), 'embedder', Recipe.embedder)
    const repo = Recipe.repo
    const inflight = this.inflight
    const model = Recipe.config.embeddingModel

    const runOne = async (Data: KBData, CallerSignal?: AbortSignal): Promise<IngestResult> => {
      if (Data.url) {
        const dup = await repo.findActiveBySource(Data.url)
        if (dup) return { resource: null, chunkCount: 0, failure: { code: 'E_DUPLICATE', reason: '同 URL 已有 ready/processing 资源' } }
      }

      const isUrl = !!Data.url
      const givenTitle = Data.title?.trim() ?? ''
      const resource = await repo.createResource({
        title: givenTitle || (isUrl ? hostnameOf(Data.url!) : '未命名'),
        source: isUrl ? Data.url! : null,
        data_uri: isUrl ? Data.url! : `urn:kc:paste:${globalThis.crypto.randomUUID()}`,
        content_type: Data.content_type,
        status: 'processing',
      })

      // 取消开关由服务端持有：登记后才能被任意请求按下；调用方自带的信号（batch 整批中止/worker 停机）并进来，任一触发即掐
      const ctrl = new AbortController()
      inflight.add(resource.id, ctrl)
      const Signal = CallerSignal ? AbortSignal.any([ctrl.signal, CallerSignal]) : ctrl.signal

      const fail = async (Reason: string): Promise<IngestResult> => {
        logError('E_INGEST_FAIL', new Error(`${resource.id} → ${Reason}`))
        await repo.deleteChunksByResource(resource.id).catch((err) => logError('E_FAIL_CLEAN', err))
        await repo.updateResourceStatus(resource.id, 'failed', Reason).catch((err) => logError('E_FAIL_MARK', err)) // 不复用 Signal
        return { resource: { ...resource, status: 'failed', error_reason: Reason }, chunkCount: 0, failure: { code: 'E_INGEST_FAILED', reason: Reason } }
      }

      const ctx: IngestContext = { data: Data }
      try {
        await fetcher.run(ctx, Signal)
        parser.run(ctx)
        const parsed = ctx.parsed
        if (!parsed || parsed.text.trim() === '') return await fail('解析后无正文')

        if (!givenTitle && parsed.title && parsed.title !== resource.title) {
          await repo.updateResourceTitle(resource.id, parsed.title)
          resource.title = parsed.title
        }

        chunker.run(ctx)
        const plans = ctx.chunks ?? []
        if (plans.length === 0) return await fail('内容为空')
        if (Signal.aborted) return await fail('入库取消')

        let vectors: number[][]
        try {
          vectors = await embedder.embed(plans.map((p) => p.content), { signal: Signal })
        } catch (err) {
          if (Signal.aborted) return await fail('入库取消')
          logError('E_EMBED', err)
          return await fail('embedding_error')
        }
        if (vectors.length !== plans.length) return await fail('embedding_error')
        if (Signal.aborted) return await fail('入库取消')

        try {
          const chunkCount = await repo.writeChunksWithEmbeddings(
            resource.id,
            plans.map((p) => ({ chunk_index: p.chunk_index, content: p.content, start_offset: p.start_offset, end_offset: p.end_offset })),
            vectors.map((v) => ({ dimension: v.length, model, embedding: v })),
          )
          const warning = thinPage(ctx.fetched?.raw, parsed.text)
          return { resource: { ...resource, status: 'ready', error_reason: null }, chunkCount, ...(warning ? { warning } : {}) }
        } catch (err) {
          logError('E_EMBED_WRITE', err)
          if (Signal.aborted) return await fail('入库取消')
          return await fail('embedding_error')
        }
      } catch (err) {
        logError('E_INGEST', err)
        return await fail(Signal.aborted ? '入库取消' : '入库失败')
      } finally {
        inflight.remove(resource.id)
      }
    }

    return {
      run: runOne,
      batch: async (Data, Signal) => {
        const out: IngestResult[] = []
        for (const d of Data) {
          if (Signal?.aborted) break // 未开始的不再建行
          out.push(await runOne(d, Signal).catch(notStarted))
        }
        return out
      },
    }
  }
}

function need<T>(Inst: T | undefined, Kind: string, Name: string): T {
  if (!Inst) throw new IngestError('E_UNKNOWN_STAGE', `未知 ${Kind}: ${Name}`)
  return Inst
}

function hostnameOf(Url: string): string {
  try {
    return new URL(Url).hostname
  } catch {
    return Url.slice(0, 40)
  }
}

const THIN_RAW_MIN_CHARS = 2000
const THIN_TEXT_MIN_CHARS = 200

// 原页不小、抽出的正文却很短 ⇒ 大概率是 JS 渲染壳页/反爬占位。按 AC 给提示但不阻断入库（行仍 ready）
function thinPage(Raw: string | undefined, Text: string): string | undefined {
  if (!Raw || Raw.length < THIN_RAW_MIN_CHARS) return undefined
  if (Text.length >= THIN_TEXT_MIN_CHARS) return undefined
  return `可能抓不全：原页 ${Raw.length} 字符只抽出 ${Text.length} 字符，疑为 JS 渲染或反爬来源`
}

// 建行之前就抛出（查重/建行本身失败）：没有行可留痕，只能报 resource:null + failure
function notStarted(Err: unknown): IngestResult {
  logError('E_NOT_STARTED', Err)
  return { resource: null, chunkCount: 0, failure: { code: 'E_INGEST_FAILED', reason: errMessage(Err) } }
}

function errMessage(Err: unknown): string {
  return Err instanceof Error ? Err.message : String(Err)
}

function logError(Code: string, Err: unknown) {
  console.error(JSON.stringify({ code: Code, message: errMessage(Err) }))
}
