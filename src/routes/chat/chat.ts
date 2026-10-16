/**
 * 问答路由 —— POST /chat，body { query, limit? }。薄一层：校验 body、按请求装配 Retriever、把编排层的判定映射成 HTTP，不含业务判定本身（见 agent/chat/chat.ts）。
 * 三条确定性提示（空库／全无 ready／未找到）都是 **200 答案体**、不是错误：2.2 的 useChat 会把非 2xx 走成错误通道，那样就没法把它们渲染成正常对话气泡。
 * 失败映射：body 缺 query / 类型不对→400 E_BAD_BODY；空或纯空白提问→400 E_EMPTY_QUERY；
 * 库中混着别的维度→409 E_DIMENSION_MISMATCH；维度体检未跑成→409 E_DIMENSION_UNKNOWN；装配名不识别(E_UNKNOWN_STAGE)→400；未预期→500 E_CHAT。
 * 与 /retrieve 的分工：本端点带库状态判定（空库／全无 ready），/retrieve 只回原始融合结果、供单独验检索。
 */

import { Hono } from 'hono'
import { createChat } from '../../agent/chat/chat'
import { RetrieverError } from '../../retrieve/retrievers'
import { RETRIEVER_RECIPE_NAMES } from '../../retrieve/recipes'

export { createChatRoute }

import type { Deps } from '../../bootstrap'
import type { LanguageModelId } from '../../adapter/contract'
import type { RetrieverRecipe } from '../../retrieve/contracts'

function createChatRoute(AppDeps: Deps): Hono {
  const app = new Hono()
  const { repo, embedding, retrieverConfig: config, retrieverFactory } = AppDeps

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
      const retriever = retrieverFactory.assemble(recipe)
      const chat = createChat({ models: AppDeps.models, chatModel: AppDeps.config.chatModel as LanguageModelId })
      const result = await chat.ask(body.query, c.req.raw.signal)
      return result.toUIMessageStreamResponse()
    } catch (err) {
      if (err instanceof RetrieverError) {
        if (err.code === 'E_EMPTY_QUERY' || err.code === 'E_UNKNOWN_STAGE') {
          return c.json({ code: err.code, message: err.message }, 400)
        }
        if (err.code === 'E_DIMENSION_MISMATCH' || err.code === 'E_DIMENSION_UNKNOWN') {
          return c.json({ code: err.code, message: err.message }, 409)
        }
      }
      console.error(JSON.stringify({ code: 'E_CHAT', message: String(err) }))
      return c.json({ code: 'E_CHAT', message: '问答失败' }, 500)
    }
  })

  return app
}
