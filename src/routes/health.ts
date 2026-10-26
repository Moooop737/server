/**
 * /health 端点与探针定义 —— createHealthServices() 按实际外部服务分组组装探针；createHealthRoute() 只做聚合与缓存。
 * 两层判定只有一条链：叶子全通过 → 服务 ok；服务全 ok → 顶层 ok / 200，否则 degraded / 503。
 * 并发跑全部叶子、逐个 try/catch：单项抛错转 ok:false 并留 detail，不炸掉整体响应。
 * 整份结果缓存 CacheTtlMs（默认 5s），期内直接复用缓存体与状态码，避免频繁真实探测；未做并发去重。
 * ollama 模型名带 tag（如 qwenembed:latest）而 EMBEDDING_MODEL 是裸名，故就绪判定须同时匹配裸名与 `${emb}:` 前缀。
 */

import { Hono } from 'hono'
import { ollamaHealthCheck, ollamaModelList, ollamaStatusList } from '../adapter/contract'

export { createHealthRoute, createHealthServices }
export type { HealthCheck, HealthService, ProbeResult }

import type { AppConfig } from '../config'
import type { ObjectStore, Repo } from '../adapter/contract'
import { json, map } from 'zod';

interface ProbeResult {
  ok: boolean
  detail?: unknown
}

interface HealthCheck {
  name: string
  ping: () => Promise<ProbeResult>
}

interface HealthService {
  name: string
  checks: HealthCheck[]
}

interface ServiceResult {
  ok: boolean
  checks: Record<string, ProbeResult>
}

interface CachedResponse {
  at: number
  code: 200 | 503
  body: { status: 'ok' | 'degraded'; services: Record<string, ServiceResult> }
}

function createHealthServices(Config: AppConfig, Repo: Repo, Store: ObjectStore): HealthService[] {
  const base = Config.ollamaBaseUrl
  const emb = Config.embeddingModel

  return [
    {
      name: 'postgres',
      checks: [
        {
          name: 'ping',
          ping: async () => ({ ok: await Repo.ping() }),
        },
      ],
    },
    {
      name: 'ollama',
      checks: [
        {
          name: 'version',
          ping: async () => {
            const rep = await ollamaHealthCheck(base)
            return {
              ok: await (rep !== 'error'),
              detail: rep
            }
          },
        },
        {
          name: 'models',
          ping: async () => {
            const models = await ollamaModelList(base)
            return {
              ok: models.some((m) => m.name === emb || m.name.startsWith(`${emb}:`)),
              detail: models.map((m) => m.name),
            }
          },
        },
        {
          name: 'running',
          ping: async () => {
            const ps = await ollamaStatusList(base)
            return {
              ok: true,
              detail: ps.map((m) => ({ name: m.name, expires_at: m.expires_at, size_vram: m.size_vram })),
            }
          },
        },
      ],
    },
    {
      name: 's3',
      checks: [
        {
          name: 'bucket',
          ping: async () => {
            await Store.ping()
            return { ok: true }
          },
        },
      ],
    },
  ]
}

function createHealthRoute(Services: HealthService[], CacheTtlMs = 5000): Hono {
  const app = new Hono()
  let cache: CachedResponse | null = null

  app.get('/', async (c) => {
    const now = Date.now()
    if (cache && now - cache.at < CacheTtlMs) {
      return c.json(cache.body, cache.code)
    }

    const results = await Promise.all(
      Services.map(async (service) => {
        const checks = await Promise.all(
          service.checks.map(async (probe) => {
            try {
              return [probe.name, await probe.ping()] as const
            } catch (err) {
              return [probe.name, { ok: false, detail: String(err) } as ProbeResult] as const
            }
          }),
        )
        return [
          service.name,
          { ok: checks.every(([, result]) => result.ok), checks: Object.fromEntries(checks) } as ServiceResult,
        ] as const
      }),
    )
    const ok = results.every(([, service]) => service.ok)
    const body: CachedResponse['body'] = {
      status: ok ? 'ok' : 'degraded',
      services: Object.fromEntries(results) as Record<string, ServiceResult>,
    }
    const code: 200 | 503 = ok ? 200 : 503
    cache = { at: now, code, body }
    return c.json(body, code)
  })

  return app
}
