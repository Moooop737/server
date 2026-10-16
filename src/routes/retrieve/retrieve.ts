/**
 * 检索路由 —— POST /retrieve，body { query, limit? }，返回混合检索的融合结果。只检索、不生成（问答交后续 story）。
 * limit 缺省或不是正整数时忽略，回落 config.defaultLimit（融合后送进上下文的条数）。
 * 与入库路由同一条装配规矩：本路由只校验 body + 装 Recipe，真正的检索交 Factory.assemble(recipe).search(query)；工厂是进程级单例，Recipe 每请求装一次。
 * getVectorDimensions 是**函数**不是数组：库中维度由 startServer 在 serve() 之前才填进 Deps，路由若在挂载时把它解构下来就永远拿到空数组，
 * 混维判定会静默失效（AC:186 那条就没人守）。
 * 失败映射：body 缺 query / 类型不对→400 E_BAD_BODY；空或纯空白提问→400 E_EMPTY_QUERY；
 * 库中混着别的维度→409 E_DIMENSION_MISMATCH；维度体检未跑成→409 E_DIMENSION_UNKNOWN（与库状态冲突，Lynx 2026-10-14 定）；
 * 装配名不识别(E_UNKNOWN_STAGE)→400；未预期（含 embedding 上游故障）→500 E_RETRIEVE。
 * 0 命中不是错误：200 + 空 hits + 两条 count，由调用方判「未找到」——空库／全无 ready 同理走 200 答案体。
 */

import { Hono } from 'hono'
import { RetrieverError } from '../../retrieve/retrievers'
import { RETRIEVER_RECIPE_NAMES } from '../../retrieve/recipes'

export { createRetrieveRoute }

import type { Deps } from '../../bootstrap'
import type { RetrieverRecipe } from '../../retrieve/contracts'

function createRetrieveRoute(AppDeps: Deps): Hono {
  const app = new Hono()
  const { repo, embedding, retrieverConfig: config, retrieverFactory: factory } = AppDeps

  app.post('/', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { query?: unknown; limit?: unknown } | null
    if (!body || typeof body.query !== 'string') {
      return c.json({ code: 'E_BAD_BODY', message: 'body.query 需为字符串' }, 400)
    }
    const limit = typeof body.limit === 'number' && Number.isInteger(body.limit) && body.limit > 0 ? body.limit : undefined

    const recipe: RetrieverRecipe = {
      ...RETRIEVER_RECIPE_NAMES,
      deps: { repo, embedding, config, vectorDimensions: AppDeps.vectorDimensions },
    }

    try {
      const result = await factory.assemble(recipe).search(body.query, limit === undefined ? undefined : { limit })
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
        if (err.code === 'E_EMPTY_QUERY' || err.code === 'E_UNKNOWN_STAGE') {
          return c.json({ code: err.code, message: err.message }, 400)
        }
        if (err.code === 'E_DIMENSION_MISMATCH' || err.code === 'E_DIMENSION_UNKNOWN') {
          return c.json({ code: err.code, message: err.message }, 409)
        }
      }
      console.error(JSON.stringify({ code: 'E_RETRIEVE', message: String(err) }))
      return c.json({ code: 'E_RETRIEVE', message: '检索失败' }, 500)
    }
  })

  return app
}
