/**
 * 检索路由 —— POST /retrieve，body { query, model? }，返回混合检索的融合结果。只检索、不生成（生成走 /chat）。
 * 条数与两路参数只认管线自身 config；model 是可选的嵌入模型键（执行身份），不传走管线引脚默认 / 全局默认。
 * 检索实例每请求从 RuntimeRetrievalRegistry.retriever() 取（主世界）；评测世界由 EvalAssembly.retriever() 提供；不在这里拼管线。
 * 失败映射：body 缺 query / 类型不对→400 E_BAD_BODY；空或纯空白提问→400 E_EMPTY_QUERY；
 * 库中混着别的维度→409 E_DIMENSION_MISMATCH（维度是每请求现查的，见 retrieve/pipeline/components/vector-recall.ts）；
 * 未配置可用嵌入→409 E_NO_EMBEDDING_MODEL；
 * 未预期（含 embedding 上游故障）→500 E_RETRIEVE。装配名不识别(E_UNKNOWN_STAGE) 现在只可能在启动时发生，不再是本端点的错误码。
 * 0 命中不是错误：200 + 空 hits + 两条 count，由调用方判「未找到」——空库／全无 ready 同理走 200 答案体。
 */

import 'reflect-metadata'
import { Hono } from 'hono'
import { inject, injectable } from 'tsyringe'
import { RetrieverError } from '../retrieve/contracts'
import { PostgresRepo, RuntimeRetrievalRegistry } from '../adapter/contract';
import { createDbStageSink } from '../trace/systemtrace/stage-sink'
import { logError } from '../trace/systemtrace/log'

export { RetrieveRoute }

import type { Repo } from '../adapter/contract'
import type { Retriever } from '../retrieve/contracts'

interface RetrieverSource {
  retriever(): Retriever
}

@injectable()
class RetrieveRoute {
  private readonly retrieval: RetrieverSource
  private readonly repo: Repo

  constructor(
    @inject(RuntimeRetrievalRegistry) Retrieval: RetrieverSource,
    @inject(PostgresRepo) Repo: Repo) {
    this.retrieval = Retrieval
    this.repo = Repo
  }

  build(): Hono {
    const app = new Hono()
    app.post('/', async (c) => {
      const body = (await c.req.json().catch(() => null)) as { query?: unknown; model?: unknown } | null
      if (!body || typeof body.query !== 'string') {
        return c.json({ code: 'E_BAD_BODY', message: 'body.query 需为字符串' }, 400)
      }
      if (body.model !== undefined && typeof body.model !== 'string') {
        return c.json({ code: 'E_BAD_BODY', message: 'body.model 需为字符串' }, 400)
      }
      const Model = body.model?.trim()

      try {
        const Sink = createDbStageSink(this.repo)
        const result = await this.retrieval.retriever().search(body.query, {
          sink: Sink,
          ...(Model === undefined || Model === '' ? {} : { model: Model }),
        })
        return c.json({
          hits: result.hits.map((hit) => ({
            chunkId: hit.chunk.id,
            resourceId: hit.chunk.resource_id,
            chunkIndex: hit.chunk.chunk_index,
            startOffset: hit.chunk.start_offset,
            endOffset: hit.chunk.end_offset,
            docTitle: hit.docTitle,
            source: hit.source,
            dataUri: hit.dataUri,
            score: hit.score,
            similarity: hit.similarity,
            lexicalScore: hit.lexicalScore,
            content: hit.chunk.content,
          })),
          vectorCount: result.vectorCount,
          lexicalCount: result.lexicalCount,
        })
      } catch (err) {
        if (err instanceof RetrieverError) {
          if (err.code === 'E_EMPTY_QUERY') {
            return c.json({ code: err.code, message: err.message }, 400)
          }
          if (err.code === 'E_DIMENSION_MISMATCH') {
            return c.json({ code: err.code, message: err.message }, 409)
          }
          if (err.code === 'E_NO_EMBEDDING_MODEL') {
            return c.json({ code: err.code, message: err.message }, 409)
          }
        }
        logError('E_RETRIEVE', String(err))
        return c.json({ code: 'E_RETRIEVE', message: '检索失败' }, 500)
      }
    })

    return app
  }
}
