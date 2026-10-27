/**
 * 入库工厂 —— IngestFactory.assemble(Recipe) 把策略名兑换成实例、捆 repo，产出一个可执行对象 Ingest。
 * run(KBData) 是旧同步入口（自己建行 + http/passthrough）；runExisting(Resource) 处理已归档行：set processing → 从 data_uri 读 → 复算 hash 比对 → parse → chunk → embed → write。
 * batch 仍走 run；每条独立，一条失败或抛出都不阻断其余，abort 后未开始的不再建行、也不出结果。
 * 生命周期：登记 in-flight controller → fetch → parse → 回填真标题 → chunk → embed → 同事务写 chunk+向量并把行转 ready → finally 注销登记。
 * 建行/取行之后的失败都留在那条行上(process_failed) 并带原因；建行之前的拒绝(查重命中/进来就已取消)返回 resource:null。
 * 取消信号的持有者是本管线，不是 HTTP 连接：execute 自己 new AbortController 并按 resourceId 登记；
 * 调用方另可传一个自己的信号（batch 的整批中止、未来 worker 的停机），两者任一触发即掐。客户端断连不再是取消来源。
 * 取消延迟有下限：parse 与 chunk 是同步的，pg 写入也不吃 signal ⇒ 只能在异步边界上观测到取消，最坏要等当前那一段同步/写事务跑完。
 * 结果码：E_DUPLICATE 查重 / E_CANCELLED 取消 / E_TIMEOUT stage 超时 / E_HASH_MISMATCH 对象字节与归档 hash 不符 / E_RESOURCE_GONE 写入期间资源被删 / E_INGEST_FAILED 其余。
 * 硬约束：Signal 只喂 fetch/embed 这类长操作；fail() 落库改状态绝不复用 Signal（aborted signal 会连"失败留痕"一起杀掉）。
 * 依赖：contracts(类型) / adapter 的门(Repo,EmbeddingHandle,embedChunks,ObjectStoreHandle) / inflight / recipes。
 */

import 'reflect-metadata'
import { embedChunks, ObjectStoreHandle } from '../adapter/contract'
import { AppConfig } from '../config'
import { NoopStageSink, runStage } from '../trace/systemtrace/stage'
import { logInfo, logError } from '../trace/systemtrace/log'

export { IngestFactory, IngestError }

import type { Recipe, KBData, Ingest, IngestResult, IngestContext, StageRegistry, IngestOptions } from './contracts'
import type { Resource } from '../adapter/contract'
import { InflightRegistry } from './inflight'
import { container, inject, singleton } from 'tsyringe';
import { createStageRegistry } from './recipes';

class IngestError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'IngestError'
    this.code = code
  }
}

@singleton()
class IngestFactory {
  private readonly reg: StageRegistry
  private readonly inflight: InflightRegistry

  constructor(@inject(ObjectStoreHandle) Store: ObjectStoreHandle, @inject(AppConfig) Config: AppConfig) {
    this.reg = createStageRegistry(Store, Config.s3Bucket)
    this.inflight = container.resolve(InflightRegistry)
  }

  assemble(Recipe: Recipe): Ingest {
    const fetcher = need(this.reg.fetcher(Recipe.fetcher), 'fetcher', Recipe.fetcher)
    const parser = need(this.reg.parser(Recipe.parser), 'parser', Recipe.parser)
    const chunker = need(this.reg.chunker(Recipe.chunker), 'chunker', Recipe.chunker)
    const repo = Recipe.repo
    const embedding = Recipe.embedding
    const inflight = this.inflight

    const execute = async (
      Resource: Resource,
      Data: KBData,
      FetchInput: unknown,
      GivenTitle: string,
      CallerSignal?: AbortSignal,
      Options?: IngestOptions,
    ): Promise<IngestResult> => {
      const Sink = Options?.sink ?? NoopStageSink

      // 取消开关由服务端持有：登记后才能被任意请求按下；调用方自带的信号并进来，任一触发即掐
      const ctrl = new AbortController()
      const Signal = CallerSignal ? AbortSignal.any([ctrl.signal, CallerSignal]) : ctrl.signal

      // 一次故障只留一行日志：code 给人分支、reason 进库、cause 只进日志。主动取消不算错误，用 log 级不用 error 级
      const fail = async (Reason: string, Code = 'E_INGEST_FAILED', Cause?: unknown): Promise<IngestResult> => {
        const extra = { resource_id: Resource.id, reason: Reason, ...(Cause ? { cause: errMessage(Cause) } : {}) }
        if (Code === 'E_INGEST_FAILED') logError(Code, Reason, extra)
        else logInfo(Code, Reason, extra)
        await repo.deleteChunksByResource(Resource.id).catch((err) => logError('E_FAIL_CLEAN', errMessage(err)))
        await repo.updateResourceStatus(Resource.id, 'process_failed', Reason).catch((err) => logError('E_FAIL_MARK', errMessage(err))) // 不复用 Signal
        return { resource: { ...Resource, status: 'process_failed', error_reason: Reason }, chunkCount: 0, failure: { code: Code, reason: Reason } }
      }

      const cancelled = () => fail('入库取消', 'E_CANCELLED')
      // 取消、超时、真错误三件事不能塌成同一个 reason：各 stage 自带 30s 超时，它炸时 Signal 并不会 abort
      const failFrom = (Cause: unknown, Fallback: string) =>
        Signal.aborted ? cancelled() : isTimeout(Cause) ? fail('操作超时', 'E_TIMEOUT', Cause) : fail(Fallback, 'E_INGEST_FAILED', Cause)

      const ctx: IngestContext = { data: Data }
      try {
        inflight.add(Resource.id, ctrl)

        const fetched = await runStage(
          Sink,
          'fetch',
          FetchInput,
          async () => {
            await fetcher.run(ctx, Signal)
            return ctx.fetched ?? { raw: '' }
          },
          (Fetched) => ({
            final_url: Fetched.final_url ?? null,
            content_type: Fetched.content_type || Data.content_type,
            content_length: Buffer.byteLength(Fetched.raw, 'utf8'),
            http_status: Fetched.http_status ?? null,
          }),
        )
        if (Signal.aborted) return await cancelled() // parse/chunk 是同步的，过了这个点就再也观测不到取消，直到它们跑完
        if (Data.content_hash !== undefined && fetched.sha256 !== Data.content_hash) {
          return await fail('内容 hash 与归档时不一致', 'E_HASH_MISMATCH')
        }
        const parsed = await runStage(
          Sink,
          'parse',
          { content_type: fetched.content_type || Data.content_type, content_length: Buffer.byteLength(fetched.raw, 'utf8') },
          async () => {
            parser.run(ctx)
            return ctx.parsed
          },
          (Parsed) => ({ title: Parsed?.title ?? '', markdown_length: Parsed?.text.length ?? 0 }),
        )
        if (!parsed || parsed.text.trim() === '') return await fail('解析后无正文')

        if (!GivenTitle && parsed.title && parsed.title !== Resource.title) {
          await repo.updateResourceTitle(Resource.id, parsed.title)
          Resource.title = parsed.title
        }

        const plans = await runStage(
          Sink,
          'chunk',
          { markdown_length: parsed.text.length },
          async () => {
            chunker.run(ctx)
            return ctx.chunks ?? []
          },
          (Chunks) => ({ chunk_count: Chunks.length, total_chars: Chunks.reduce((Sum, Chunk) => Sum + Chunk.content.length, 0) }),
        )
        if (plans.length === 0) return await fail('内容为空')
        if (Signal.aborted) return await cancelled()

        let vectors: number[][]
        try {
          vectors = await runStage(
            Sink,
            'embed',
            { chunk_count: plans.length, model_id: embedding.modelId, dimensions: embedding.dimensions },
            () => embedChunks(plans.map((p) => p.content), embedding, Signal),
            (Embeddings) => ({ embedding_count: Embeddings.length, dimension: Embeddings[0]?.length ?? null }),
          )
        } catch (err) {
          return await failFrom(err, 'embedding_error')
        }
        if (vectors.length !== plans.length) return await fail('embedding_error')
        if (Signal.aborted) return await cancelled()

        try {
          const chunkCount = await runStage(
            Sink,
            'write',
            { chunk_count: plans.length },
            () => repo.writeChunksWithEmbeddings(
              Resource.id,
              plans.map((p) => ({ chunk_index: p.chunk_index, content: p.content, start_offset: p.start_offset, end_offset: p.end_offset })),
              vectors.map((v) => ({ dimension: v.length, model: embedding.modelId, embedding: v })),
            ),
            (Count) => ({ chunk_count: Count }),
          )
          // 写入不是可中断的：取消若落在 INSERT/UPDATE 期间，事务已提交成 ready，这里必须把那一笔撤回来
          if (Signal.aborted) return await cancelled()

          const warning = thinPage(ctx.fetched?.raw, parsed.text)
          return { resource: { ...Resource, status: 'ready', error_reason: null }, chunkCount, ...(warning ? { warning } : {}) }
        } catch (err) {
          if ((err as { code?: string }).code === 'E_RESOURCE_GONE') return await fail('已删除，写入中止', 'E_RESOURCE_GONE', err)
          return await failFrom(err, 'embedding_error')
        }
      } catch (err) {
        return await failFrom(err, '入库失败')
      } finally {
        inflight.remove(Resource.id, ctrl)
      }
    }

    const runOne = async (Data: KBData, CallerSignal?: AbortSignal, Options?: IngestOptions): Promise<IngestResult> => {
      if (CallerSignal?.aborted) return { resource: null, chunkCount: 0, failure: { code: 'E_CANCELLED', reason: '入库取消' } }

      if (Data.url) {
        const dup = await repo.findActiveBySource(Data.url)
        if (dup) return { resource: null, chunkCount: 0, failure: { code: 'E_DUPLICATE', reason: '同 URL 已有未删除资源' } }
      }

      const isUrl = !!Data.url
      const givenTitle = Data.title?.trim() ?? ''
      const resource = await repo.createResource({
        title: givenTitle || (isUrl ? hostnameOf(Data.url!) : '未命名'),
        source: isUrl ? Data.url! : null,
        data_uri: isUrl ? Data.url! : `urn:kc:paste:${globalThis.crypto.randomUUID()}`,
        content_type: mimeForLegacyContentType(Data.content_type),
        status: 'processing',
      })

      return execute(resource, Data, { url: Data.url ?? null }, givenTitle, CallerSignal, Options)
    }

    const runExisting = async (Resource: Resource, Options?: IngestOptions): Promise<IngestResult> => {
      const data: KBData = {
        content_type: Resource.content_type,
        data_uri: Resource.data_uri,
        ...(Resource.content_hash === null ? {} : { content_hash: Resource.content_hash }),
      }
      await repo.updateResourceStatus(Resource.id, 'processing')
      return execute({ ...Resource, status: 'processing' }, data, { data_uri: Resource.data_uri }, Resource.title, undefined, Options)
    }

    return {
      run: runOne,
      runExisting,
      batch: async (Data, Signal, Options) => {
        const out: IngestResult[] = []
        for (const d of Data) {
          if (Signal?.aborted) break // 未开始的不再建行
          out.push(await runOne(d, Signal, Options).catch(notStarted))
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

function mimeForLegacyContentType(ContentType: string): string {
  if (ContentType === 'url') return 'text/html'
  if (ContentType === 'markdown') return 'text/markdown'
  if (ContentType === 'plaintext') return 'text/plain'
  return ContentType
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
  logError('E_NOT_STARTED', errMessage(Err))
  return { resource: null, chunkCount: 0, failure: { code: 'E_INGEST_FAILED', reason: errMessage(Err) } }
}

function errMessage(Err: unknown): string {
  return Err instanceof Error ? Err.message : String(Err)
}

// AbortSignal.timeout() 触发时抛的是 name='TimeoutError' 的 DOMException（不保证是 Error 子类，所以只取 name）
function isTimeout(Err: unknown): boolean {
  return typeof Err === 'object' && Err !== null && (Err as { name?: string }).name === 'TimeoutError'
}
