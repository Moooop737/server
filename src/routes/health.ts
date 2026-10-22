/**
 * /health 端点与探针定义 —— createHealthProbes() 按 repo/config 组装探针；createHealthRoute() 只做聚合与缓存。
 * 并发跑全部探针、逐个 try/catch：单项抛错转 ok:false 并留 detail，不炸掉整体响应。
 * 整份结果缓存 CacheTtlMs（默认 5s），期内直接复用缓存体与状态码，避免频繁真实探测；未做并发去重。
 * 全绿 → 200 status:'ok'；任一失败 → 503 status:'degraded'。
 * ollama 模型名带 tag（如 qwenembed:latest）而 EMBEDDING_MODEL 是裸名，故就绪判定须同时匹配裸名与 `${emb}:` 前缀。
 */

import { Hono } from 'hono'
import { ollamaHealthCheck, ollamaModelList, ollamaStatusList } from '../adapter/contract'

export { createHealthRoute, createHealthProbes }
export type { HealthCheck, ProbeResult }

import type { AppConfig } from '../config'
import type { Repo } from '../adapter/contract'

interface ProbeResult {
  ok: boolean
  detail?: unknown
}

interface HealthCheck {
  name: string
  ping: () => Promise<ProbeResult>
}

interface CachedResponse {
  at: number
  code: 200 | 503
  body: { status: 'ok' | 'degraded'; checks: Record<string, ProbeResult> }
}

function createHealthProbes(Config: AppConfig, Repo: Repo): HealthCheck[] {
  const base = Config.ollamaBaseUrl
  const emb = Config.embeddingModel

  return [
    {
      name: 'db',
      ping: async () => ({ ok: await Repo.ping() }),
    },
    {
      name: 'ollama',
      ping: async () => ({ ok: await ollamaHealthCheck(base) }),
    },
    {
      name: 'ollama_models',
      ping: async () => {
        const models = await ollamaModelList(base)
        return {
          ok: models.some((m) => m.name === emb || m.name.startsWith(`${emb}:`)),
          detail: models.map((m) => m.name),
        }
      },
    },
    {
      name: 'ollama_running',
      ping: async () => {
        const ps = await ollamaStatusList(base)
        return {
          ok: true,
          detail: ps.map((m) => ({ name: m.name, expires_at: m.expires_at, size_vram: m.size_vram })),
        }
      },
    },
  ]
}

function createHealthRoute(Probes: HealthCheck[], CacheTtlMs = 5000): Hono {
  const app = new Hono()
  let cache: CachedResponse | null = null

  app.get('/', async (c) => {
    const now = Date.now()
    if (cache && now - cache.at < CacheTtlMs) {
      return c.json(cache.body, cache.code)
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
    const body: CachedResponse['body'] = {
      status: ok ? 'ok' : 'degraded',
      checks: Object.fromEntries(results) as Record<string, ProbeResult>,
    }
    const code: 200 | 503 = ok ? 200 : 503
    cache = { at: now, code, body }
    return c.json(body, code)
  })

  return app
}
