/**
 * 问答路由 —— POST /chat，body { query }。薄一层：校验 body、把提问交给 ChatService、把结果转成 UI message stream。
 * 检索发生在工具里（agent/tool/retrieve.ts），由模型自己决定调不调、检索什么词、要几条；本路由因此不再装配 Retriever，
 *   也没有维度相关的状态码：工具一执行就在 SSE 首帧之后，状态码是一次性的，库中混维只能作为工具的结构化 error 交给模型。
 * body.limit 已删：条数归模型的 topK（工具 inputSchema），服务端不再收这个旋钮。
 * 失败映射：body 缺 query / 类型不对→400 E_BAD_BODY；trim 后为空→400 E_EMPTY_QUERY；未预期→500 E_CHAT；
 *   流内错误交给 streamText 的 onError 记一行 E_CHAT_STREAM，客户端只收固定文案。
 * 与 /retrieve 的分工：那边只回原始融合结果、供单独验检索；这边的命中由模型经工具自取。
 */

import 'reflect-metadata'
import { Hono } from 'hono'
import { inject, injectable } from 'tsyringe'
import { ChatService } from '../../agent/chat/chat'

export { ChatRoute }

@injectable()
class ChatRoute {
  private readonly chat: ChatService

  constructor(@inject(ChatService) Chat: ChatService) {
    this.chat = Chat
  }

  build(): Hono {
    const app = new Hono()

    app.post('/', async (c) => {
      const body = (await c.req.json().catch(() => null)) as { query?: unknown } | null
      if (!body || typeof body.query !== 'string') {
        return c.json({ code: 'E_BAD_BODY', message: 'body.query 需为字符串' }, 400)
      }
      const query = body.query.trim()
      if (!query) {
        return c.json({ code: 'E_EMPTY_QUERY', message: '提问不能为空' }, 400)
      }

      try {
        return this.chat.ask(query, c.req.raw.signal).toUIMessageStreamResponse({
          onError: () => '问答失败',
        })
      } catch (err) {
        console.error(JSON.stringify({ code: 'E_CHAT', message: String(err) }))
        return c.json({ code: 'E_CHAT', message: '问答失败' }, 500)
      }
    })

    return app
  }
}
