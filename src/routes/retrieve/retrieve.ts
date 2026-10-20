/**
 * 检索路由 —— POST /retrieve，body { query, limit? }，返回混合检索的融合结果。只检索、不生成（生成走 /chat）。
 * limit 缺省或不是正整数时忽略，回落 config.retrievalDefaultLimit（融合后送进上下文的条数）。
 * Retriever 由 RetrieverHandle 持有（进程级唯一一只，装配口径见 retrieve/retrievers.ts）：本路由不再拼 Recipe，只校验 body + 映射错误码。
 * 失败映射：body 缺 query / 类型不对→400 E_BAD_BODY；空或纯空白提问→400 E_EMPTY_QUERY；
 * 库中混着别的维度→409 E_DIMENSION_MISMATCH（维度是每请求现查的，见 retrieve/retrievers.ts）；
 * 未预期（含 embedding 上游故障）→500 E_RETRIEVE。装配名不识别(E_UNKNOWN_STAGE) 现在只可能在启动时发生，不再是本端点的错误码。
 * 0 命中不是错误：200 + 空 hits + 两条 count，由调用方判「未找到」——空库／全无 ready 同理走 200 答案体。
 */

import 'reflect-metadata'
import { Hono } from 'hono'
import { inject, injectable } from 'tsyringe'
import { RetrieverError } from '../../retrieve/retrievers'
import { RetrieverHandle } from '../../adapter/contract';

export { RetrieveRoute }

@injectable()
class RetrieveRoute {
  private readonly handle: RetrieverHandle

  constructor(@inject(RetrieverHandle) Handle: RetrieverHandle) {
    this.handle = Handle
  }

  build(): Hono {
    const app = new Hono()
    app.post('/', async (c) => {
      const body = (await c.req.json().catch(() => null)) as { query?: unknown; limit?: unknown } | null
      if (!body || typeof body.query !== 'string') {
        return c.json({ code: 'E_BAD_BODY', message: 'body.query 需为字符串' }, 400)
      }
      const limit = typeof body.limit === 'number' && Number.isInteger(body.limit) && body.limit > 0 ? body.limit : undefined

      try {
        const result = await this.handle.retriever.search(body.query, limit === undefined ? undefined : { limit })
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
        }
        console.error(JSON.stringify({ code: 'E_RETRIEVE', message: String(err) }))
        return c.json({ code: 'E_RETRIEVE', message: '检索失败' }, 500)
      }
    })

    return app
  }
}
