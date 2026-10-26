/**
 * 问答路由 —— POST /chat，body { query, sessionId }。薄一层：校验 body、确认会话存在、把提问交给 ChatService、把结果转成 UI message stream。
 * 历史由 ChatService 按 sessionId 读库（服务端真源），模型自己看历史决定检索词；本路由不收 messages、不做查询改写。
 * 检索发生在工具里（agent/tool/retrieve.ts），由模型自己决定调不调、检索什么词、要几条；本路由因此不装配 Retriever，
 *   也没有维度相关的状态码：工具一执行就在 SSE 首帧之后，状态码是一次性的，库中混维只能作为工具的结构化 error 交给模型。
 * 失败映射：body 缺 query/sessionId 或类型不对→400 E_BAD_BODY；query trim 后为空→400 E_EMPTY_QUERY；sessionId 非 UUID→400 E_BAD_ID；
 *   会话不存在或已软删→404 E_SESSION_NOT_FOUND；未预期→500 E_CHAT；流内错误按类型记 E_CHAT_PROVIDER / E_CHAT_PARSE / E_CHAT_STREAM，客户端只收固定文案。
 * 与 /retrieve 的分工：那边只回原始融合结果、供单独验检索；这边的命中由模型经工具自取。
 */

import 'reflect-metadata'
import { Hono } from 'hono'
import { inject, injectable } from 'tsyringe'
import { PostgresRepo } from '../adapter/contract'
import { ChatService } from '../agent/chat/chat'
import { logError } from '../trace/systemtrace/log'

export { ChatRoute }

import type { Repo } from '../adapter/contract'

@injectable()
class ChatRoute {
  private readonly chat: ChatService
  private readonly repo: Repo

  constructor(
    @inject(ChatService) Chat: ChatService,
    @inject(PostgresRepo) Repo: Repo) {
    this.chat = Chat
    this.repo = Repo
  }

  build(): Hono {
    const app = new Hono()

    app.post('/', async (c) => {
      const body = (await c.req.json().catch(() => null)) as { query?: unknown; sessionId?: unknown } | null
      if (!body || typeof body.query !== 'string' || typeof body.sessionId !== 'string') {
        return c.json({ code: 'E_BAD_BODY', message: 'body 需为 { query, sessionId }' }, 400)
      }
      const query = body.query.trim()
      if (!query) {
        return c.json({ code: 'E_EMPTY_QUERY', message: '提问不能为空' }, 400)
      }
      if (!uuidOk(body.sessionId)) {
        return c.json({ code: 'E_BAD_ID', message: 'sessionId 需为 UUID' }, 400)
      }

      try {
        if (!(await this.repo.getSession(body.sessionId))) {
          return c.json({ code: 'E_SESSION_NOT_FOUND', message: '会话不存在或已删除' }, 404)
        }
        return await this.chat.ask(query, body.sessionId, c.req.raw.signal)
      } catch (err) {
        logError('E_CHAT', String(err))
        return c.json({ code: 'E_CHAT', message: '问答失败' }, 500)
      }
    })

    return app
  }
}

function uuidOk(Id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(Id)
}
