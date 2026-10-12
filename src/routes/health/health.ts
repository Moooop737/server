/**
 * /health 端点 —— 只做聚合与缓存，不含任何探针判定（探针定义见 health/probes.ts）。
 * 并发跑全部探针、逐个 try/catch：单项抛错转 ok:false 并留 detail，不炸掉整体响应。
 * 整份结果缓存 CacheTtlMs（默认 5s），期内直接复用缓存体与状态码，避免频繁真实探测；未做并发去重。
 * 全绿 → 200 status:'ok'；任一失败 → 503 status:'degraded'。
 */

import { Hono } from 'hono'

export { createHealthRoute }

import type { HealthCheck, ProbeResult } from './probes'

interface CachedResponse {
  at: number
  code: number
  body: { status: string; checks: Record<string, ProbeResult> }
}

function createHealthRoute(Probes: HealthCheck[], CacheTtlMs = 5000): Hono {
  const app = new Hono()
  let cache: CachedResponse | null = null

  app.get('/health', async (c) => {
    const now = Date.now()
    if (cache && now - cache.at < CacheTtlMs) {
      return c.json(cache.body, cache.code as 200 | 503)
    }

    const results = await Promise.all(
      Probes.map(async (probe) => {
        try {
          return [probe.name, await probe.ping()] as const
        } catch (err) {
          return [probe.name, { ok: false, detail: String(err) } as ProbeResult] as const
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
