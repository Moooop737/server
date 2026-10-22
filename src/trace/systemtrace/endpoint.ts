/**
 * 端点观测壳 —— 每个业务请求一行 traces：入口写 running，出口补耗时/状态/错误码，响应头带 X-Trace-Id。
 * 跳过：/health*、/traces*、/doc*，以及没有匹配到 handler 的路径（末条路由是 `/*`，没有模板可记）。
 * route 取 Hono 匹配到的路由模板（POST /chat、GET /resources/:id/chunks），不记带 id 的原始 path。
 * 出口：非 SSE 按响应收口，>=400 记 error 并尽量从 JSON 错误体取 code 写 error_code；
 *   SSE 只按「到响应头」收口为 ok，流结束/中断后的最终值由 3.2 覆盖同一行。
 * trace 写失败不影响业务：只记 E_TRACE_WRITE，不把 500 冒给客户端。
 * 单位：duration_ms 为毫秒整数；时间一律 ISO 8601 字符串。
 */

export { createEndpointTrace }

import { randomUUID } from 'node:crypto'
import { routePath } from 'hono/route'
import { logError, runWithTrace } from './log'

import type { MiddlewareHandler } from 'hono'
import type { Repo } from '../../adapter/contract'

const SKIP_PREFIXES = ['/health', '/traces', '/doc']

function createEndpointTrace(Writer: Pick<Repo, 'insertTrace' | 'finishTrace'>): MiddlewareHandler {
  return async (c, next) => {
    if (SKIP_PREFIXES.some((Prefix) => c.req.path === Prefix || c.req.path.startsWith(Prefix + '/'))) return next()
    const Route = routePath(c, -1)
    if (Route === '/*' || Route === '') return next()

    const TraceId = randomUUID()
    const StartedMs = Date.now()

    return runWithTrace(TraceId, async () => {
      try {
        await Writer.insertTrace({
          trace_id: TraceId,
          route: `${c.req.method} ${Route}`,
          started_at: new Date(StartedMs).toISOString(),
        })
      } catch (err) {
        logError('E_TRACE_WRITE', `写入 trace 失败: ${String(err)}`)
      }

      await next()
      const Res = c.res
      Res.headers.set('X-Trace-Id', TraceId)
      await closeTrace(Writer, TraceId, Res, StartedMs)
    })
  }
}

async function closeTrace(
  Writer: Pick<Repo, 'finishTrace'>,
  TraceId: string,
  Res: Response,
  StartedMs: number,
): Promise<void> {
  const EndedMs = Date.now()
  const IsSse = Res.headers.get('content-type')?.includes('text/event-stream') ?? false
  const ErrorCode = !IsSse && Res.status >= 400 ? await readErrorCode(Res) : null
  try {
    await Writer.finishTrace(TraceId, {
      ended_at: new Date(EndedMs).toISOString(),
      duration_ms: EndedMs - StartedMs,
      http_status: Res.status,
      status: IsSse || Res.status < 400 ? 'ok' : 'error',
      error_code: ErrorCode,
    })
  } catch (err) {
    logError('E_TRACE_WRITE', `更新 trace 失败: ${String(err)}`)
  }
}

async function readErrorCode(Res: Response): Promise<string | null> {
  if (!Res.headers.get('content-type')?.includes('application/json')) return null
  try {
    const Body = (await Res.clone().json()) as { code?: unknown }
    return typeof Body.code === 'string' ? Body.code : null
  } catch {
    return null
  }
}
