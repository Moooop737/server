/**
 * 会话消息路由 —— 会话 list/read/create/update/delete 由 routes/crud.ts 统一注册到 hono-crud；
 * 本文件只保留 GET /:id/messages 取该会话的消息。
 * 只做 ID 校验与错误码映射；消息 SQL 在 adapter/repo/message.ts。
 * 失败映射：id 非 UUID→400 E_BAD_ID；会话不存在或已软删→404 E_SESSION_NOT_FOUND；未预期→500 E_SESSION_READ。
 */

import 'reflect-metadata'
import { Hono } from 'hono'
import { inject, injectable } from 'tsyringe'
import { PostgresRepo } from '../adapter/contract'
import { logError } from '../trace/systemtrace/log'

export { SessionsRoute }

import type { Repo } from '../adapter/contract'

@injectable()
class SessionsRoute {
  private readonly repo: Repo

  constructor(@inject(PostgresRepo) Repo: Repo) {
    this.repo = Repo
  }

  build(): Hono {
    const app = new Hono()
    const repo = this.repo

    app.get('/:id/messages', async (c) => {
      const id = c.req.param('id')
      if (!uuidOk(id)) {
        return c.json({ code: 'E_BAD_ID', message: 'id 需为 UUID' }, 400)
      }

      try {
        if (!(await repo.getSession(id))) {
          return c.json({ code: 'E_SESSION_NOT_FOUND', message: '会话不存在或已删除' }, 404)
        }
        return c.json({ id, messages: await repo.getMessagesBySession(id) })
      } catch (err) {
        logError('E_SESSION_READ', String(err))
        return c.json({ code: 'E_SESSION_READ', message: '读取会话失败' }, 500)
      }
    })

    return app
  }
}

function uuidOk(Id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(Id)
}
