/**
 * 单条观测读 —— GET /traces/:id，返回 { trace, stages }。
 * trace 的公共字段 + payloads 来自 traces；stages 来自 trace_stages，按 created_at 正序。
 * 原先这条 GET 由 hono-crud 的 read 提供，只返回 trace；3.3 起改成本路由，才能把 stages 一起带回。
 * 失败映射：不存在→404 E_TRACE_NOT_FOUND；读库失败→500 E_TRACE_READ。
 * 本路由被端点壳按 /traces* 跳过，不会自己生 trace。
 */

import 'reflect-metadata'
import { Hono } from 'hono'
import { inject, injectable } from 'tsyringe'
import { PostgresRepo } from '../adapter/contract'
import { logError } from '../trace/systemtrace/log'

export { TracesRoute }

import type { Repo } from '../adapter/contract'

@injectable()
class TracesRoute {
  private readonly repo: Repo

  constructor(@inject(PostgresRepo) Repo: Repo) {
    this.repo = Repo
  }

  build(): Hono {
    const app = new Hono()
    const repo = this.repo

    app.get('/:id', async (c) => {
      const id = c.req.param('id')
      try {
        const trace = await repo.getTrace(id)
        if (!trace) return c.json({ code: 'E_TRACE_NOT_FOUND', message: '观测不存在' }, 404)
        return c.json({ trace, stages: await repo.listTraceStages(id) })
      } catch (err) {
        logError('E_TRACE_READ', `读取观测失败: ${String(err)}`)
        return c.json({ code: 'E_TRACE_READ', message: '读取观测失败' }, 500)
      }
    })

    return app
  }
}
