/**
 * 会话路由 —— GET / 列表、POST / 建会话（body 可选 {title}）、GET /:id/messages 取该会话的消息。
 * 只做 body/ID 校验与错误码映射；会话与消息的 SQL 在 adapter/repo/read-content.ts。
 * 失败映射：body 非对象或 title 非字符串→400 E_BAD_BODY；id 非 UUID→400 E_BAD_ID；
 *   会话不存在或已软删→404 E_SESSION_NOT_FOUND；未预期→500 E_SESSION_LIST / E_SESSION_CREATE / E_SESSION_READ。
 */

import 'reflect-metadata'
import { Hono } from 'hono'
import { inject, injectable } from 'tsyringe'
import { PostgresRepo } from '../../adapter/contract'

export { SessionsRoute }

import type { Repo } from '../../adapter/contract'

@injectable()
class SessionsRoute {
  private readonly repo: Repo

  constructor(@inject(PostgresRepo) Repo: Repo) {
    this.repo = Repo
  }

  build(): Hono {
    const app = new Hono()
    const repo = this.repo

    app.get('/', async (c) => {
      try {
        return c.json({ sessions: await repo.listSessions() })
      } catch (err) {
        console.error(JSON.stringify({ code: 'E_SESSION_LIST', message: String(err) }))
        return c.json({ code: 'E_SESSION_LIST', message: '读取会话列表失败' }, 500)
      }
    })

    app.post('/', async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return c.json({ code: 'E_BAD_BODY', message: 'body 需为 JSON 对象' }, 400)
      }
      if (body.title !== undefined && typeof body.title !== 'string') {
        return c.json({ code: 'E_BAD_BODY', message: 'body.title 需为字符串' }, 400)
      }

      try {
        const title = typeof body.title === 'string' ? body.title.trim() : ''
        return c.json(await repo.createSession(title || undefined), 201)
      } catch (err) {
        console.error(JSON.stringify({ code: 'E_SESSION_CREATE', message: String(err) }))
        return c.json({ code: 'E_SESSION_CREATE', message: '创建会话失败' }, 500)
      }
    })

    app.get('/:id/messages', async (c) => {
      const id = c.req.param('id')
      if (!uuidOk(id)) {
        return c.json({ code: 'E_BAD_ID', message: 'id 需为 UUID' }, 400)
      }

      try {
        if (!(await repo.getSession(id))) {
          return c.json({ code: 'E_SESSION_NOT_FOUND', message: '会话不存在或已删除' }, 404)
        }
        return c.json({ session_id: id, messages: await repo.getMessagesBySession(id) })
      } catch (err) {
        console.error(JSON.stringify({ code: 'E_SESSION_READ', message: String(err) }))
        return c.json({ code: 'E_SESSION_READ', message: '读取会话失败' }, 500)
      }
    })

    return app
  }
}

function uuidOk(Id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(Id)
}
