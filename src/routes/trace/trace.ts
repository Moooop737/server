/**
 * 观测读接口 —— GET /traces 列表、GET /traces/:traceId 单条。
 * 只读 traces 公共行：stage 明细由 3.3 追加，chat 的 Langfuse 外链由 3.2 写入 langfuse_trace_id。
 * limit 缺省或非法回落 50，上限 200；列表按 started_at 倒序（由 Repo 保证）。
 * 失败映射：traceId 不存在→404 E_TRACE_NOT_FOUND；读库失败→500 E_TRACE_READ。
 * 本路由被端点壳按 /traces* 跳过：读 trace 不会自己再生成 trace 行。
 */

import 'reflect-metadata'
import { Hono } from 'hono'
import { inject, singleton } from 'tsyringe'
import { PostgresRepo } from '../../adapter/contract'
import { logError } from '../../trace/systemtrace/log'

export { TraceRoute }

import type { Repo } from '../../adapter/contract'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

@singleton()
class TraceRoute {
  private readonly repo: Repo

  constructor(@inject(PostgresRepo) Repo: Repo) {
    this.repo = Repo
  }

  build(): Hono {
    const app = new Hono()
    const repo = this.repo

    app.get('/', async (c) => {
      try {
        return c.json({ traces: await repo.listTraces(limitOf(c.req.query('limit'))) })
      } catch (err) {
        logError('E_TRACE_READ', `读取 trace 列表失败: ${String(err)}`)
        return c.json({ code: 'E_TRACE_READ', message: '读取观测失败' }, 500)
      }
    })

    app.get('/:traceId', async (c) => {
      try {
        const trace = await repo.getTrace(c.req.param('traceId'))
        return trace
          ? c.json({ trace })
          : c.json({ code: 'E_TRACE_NOT_FOUND', message: '观测不存在' }, 404)
      } catch (err) {
        logError('E_TRACE_READ', `读取 trace 失败: ${String(err)}`)
        return c.json({ code: 'E_TRACE_READ', message: '读取观测失败' }, 500)
      }
    })

    return app
  }
}

function limitOf(Raw: string | undefined): number {
  const n = Number(Raw)
  if (!Number.isInteger(n) || n < 1) return DEFAULT_LIMIT
  return Math.min(n, MAX_LIMIT)
}
