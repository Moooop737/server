import { Hono } from 'hono'

export interface ProbeResult {
  ok: boolean
  detail?: unknown
}

export interface HealthCheck {
  name: string
  ping: () => Promise<ProbeResult>
}

interface CachedResponse {
  at: number
  code: number
  body: { status: string; checks: Record<string, ProbeResult> }
}

/* 注册式健康检查：并发探测、逐个 try/catch；整份结果缓存 cacheTtlMs，期内直接复用，避免频繁真实探测 */
export function createHealthRoute(checks: HealthCheck[], cacheTtlMs = 5000): Hono {
  const app = new Hono()
  let cache: CachedResponse | null = null

  app.get('/health', async (c) => {
    const now = Date.now()
    if (cache && now - cache.at < cacheTtlMs) {
      return c.json(cache.body, cache.code as 200 | 503)
    }

    const results = await Promise.all(
      checks.map(async (chk) => {
        try {
          return [chk.name, await chk.ping()] as const
        } catch (err) {
          return [chk.name, { ok: false, detail: String(err) } as ProbeResult] as const
        }
      }),
    )
    const ok = results.every(([, r]) => r.ok)
    const body = {
      status: ok ? 'ok' : 'degraded',
      checks: Object.fromEntries(results) as Record<string, ProbeResult>,
    }
    const code = ok ? 200 : 503
    cache = { at: now, code, body }
    return c.json(body, code)
  })

  return app
}
