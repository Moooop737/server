/**
 * 问答路由 —— POST /chat，body { query, sessionId, model? }。薄一层：校验 body、确认会话存在、把提问交给 ChatWorker、把结果转成 UI message stream。
 * model 可选：body 给了以 body 为准；没给就用会话行记录的 model；都没有才用 CHAT_MODEL。
 *   body 给了但不在册→400 E_UNKNOWN_MODEL，响应带在册清单；会话记录的那只不在册（缺 Key 整行缺席）→ 回落 CHAT_MODEL 并打 W_SESSION_MODEL。
 *   /chat 只读会话的 model，不写：下单一位是前端（建会话/换模型时 PATCH）。
 * 历史由 ChatWorker 按 sessionId 读库（服务端真源），模型自己看历史决定检索词；本路由不收 messages、不做查询改写。
 * 检索发生在工具里（agent/tool/retrieve.ts），由模型自己决定调不调、检索什么词、要几条；本路由因此不装配 Retriever，
 *   也没有维度相关的状态码：工具一执行就在 SSE 首帧之后，状态码是一次性的，库中混维只能作为工具的结构化 error 交给模型。
 * 失败映射：body 缺 query/sessionId 或类型不对→400 E_BAD_BODY；query trim 后为空→400 E_EMPTY_QUERY；sessionId 非 UUID→400 E_BAD_ID；model 不在册→400 E_UNKNOWN_MODEL；
 *   会话不存在或已软删→404 E_SESSION_NOT_FOUND；未预期→500 E_CHAT；流内错误按类型记 E_CHAT_PROVIDER / E_CHAT_PARSE / E_CHAT_STREAM，客户端只收固定文案。
 * 与 /retrieve 的分工：那边只回原始融合结果、供单独验检索；这边的命中由模型经工具自取。
 */

import 'reflect-metadata'
import { Hono } from 'hono'
import { inject, injectable } from 'tsyringe'
import { ChatHandle, PostgresRepo } from '../adapter/contract'
import { ChatWorker } from '../agent/worker/chat'
import { logError, logWarn } from '../trace/systemtrace/log'

export { ChatRoute }

import type { Repo } from '../adapter/contract'

@injectable()
class ChatRoute {
  private readonly chat: ChatWorker
  private readonly repo: Repo
  private readonly handle: ChatHandle

  constructor(
    @inject(ChatWorker) Chat: ChatWorker,
    @inject(PostgresRepo) Repo: Repo,
    @inject(ChatHandle) Handle: ChatHandle) {
    this.chat = Chat
    this.repo = Repo
    this.handle = Handle
  }

  build(): Hono {
    const app = new Hono()

    app.post('/', async (c) => {
      const body = (await c.req.json().catch(() => null)) as { query?: unknown; sessionId?: unknown; model?: unknown } | null
      if (!body || typeof body.query !== 'string' || typeof body.sessionId !== 'string') {
        return c.json({ code: 'E_BAD_BODY', message: 'body 需为 { query, sessionId, model? }' }, 400)
      }
      if (body.model !== undefined && typeof body.model !== 'string') {
        return c.json({ code: 'E_BAD_BODY', message: 'body.model 需为字符串' }, 400)
      }
      const query = body.query.trim()
      if (!query) {
        return c.json({ code: 'E_EMPTY_QUERY', message: '提问不能为空' }, 400)
      }
      if (!uuidOk(body.sessionId)) {
        return c.json({ code: 'E_BAD_ID', message: 'sessionId 需为 UUID' }, 400)
      }
      const Requested = body.model === undefined ? undefined : this.handle.resolve(body.model)
      if (body.model !== undefined && Requested === undefined) {
        return c.json({ code: 'E_UNKNOWN_MODEL', message: `模型 ${body.model} 不在册`, models: this.handle.catalog() }, 400)
      }

      try {
        const Session = await this.repo.getSession(body.sessionId)
        if (!Session) {
          return c.json({ code: 'E_SESSION_NOT_FOUND', message: '会话不存在或已删除' }, 404)
        }
        const Model = Requested ?? (Session.model === null ? undefined : this.handle.resolve(Session.model))
        if (Requested === undefined && Session.model !== null && Model === undefined) {
          logWarn('W_SESSION_MODEL', `会话 ${Session.id} 记录的模型 ${Session.model} 不在册，本轮回落 CHAT_MODEL`)
        }
        return await this.chat.ask(query, body.sessionId, c.req.raw.signal, Model)
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
