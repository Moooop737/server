/**
 * /health 端点与探针定义 —— createHealthServices() 按实际外部服务分组组装探针；createHealthRoute() 只做聚合与缓存。
 * 两层判定只有一条链：叶子全通过 → 服务 ok；服务全 ok → 顶层 ok / 200，否则 degraded / 503。
 * 并发跑全部叶子、逐个 try/catch：单项抛错转 ok:false 并留 detail，不炸掉整体响应。
 * 整份结果缓存 CacheTtlMs（默认 5s），期内直接复用缓存体与状态码，避免频繁真实探测；未做并发去重。
 * ollama 组只认 kind='ollama' 的 provider（D2 拍）：每次 ping 现读快照选目标（默认嵌入优先、其次默认语言），
 *   base 去掉末尾 /v1；模型名带 tag（如 qwenembed:latest）时裸名与 `${name}:` 前缀都算就绪。
 * 没有 ollama 系 provider 时三只探针恒 ok:true + detail 'no ollama provider'（Runtime&Boot #11）。
 * eval 组：共享模式恒 ok 并标 mode=shared（主库同一池已由 postgres 组覆盖，不重复探）；隔离模式才真 ping 评测库。
 */

import { Hono } from 'hono'
import { ollamaHealthCheck, ollamaModelList, ollamaStatusList } from '../adapter/contract'

export { createHealthRoute, createHealthServices }
export type { EvalProbe, HealthCheck, HealthService, ProbeResult }

import type { RuntimeModelRegistry } from '../adapter/model/runtime-registry'
import type { ObjectStore, Repo } from '../adapter/contract'

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

interface EvalProbe {
  mode: 'shared' | 'isolated'
  ping: () => Promise<boolean>
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

function createHealthServices(Runtime: RuntimeModelRegistry, Repo: Repo, Store: ObjectStore, Eval: EvalProbe): HealthService[] {
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
      name: 'eval',
      checks: [
        {
          name: 'connection',
          ping: async () => {
            if (Eval.mode === 'shared') {
              return { ok: true, detail: ['mode=shared', 'same db as postgres'] }
            }
            const reachable = await Eval.ping()
            return { ok: reachable, detail: ['mode=isolated', reachable ? 'reachable' : 'unreachable'] }
          },
        },
      ],
    },
    {
      name: 'ollama',
      checks: [
        {
          name: 'version',
          ping: async () => {
            const Target = ollamaProbeTarget(Runtime)
            if (Target === null) return { ok: true, detail: ['no ollama provider'] }
            const rep = await ollamaHealthCheck(Target.base)
            return {
              ok: await (rep !== 'error'),
              detail: rep
            }
          },
        },
        {
          name: 'models',
          ping: async () => {
            const Target = ollamaProbeTarget(Runtime)
            if (Target === null) return { ok: true, detail: ['no ollama provider'] }
            const models = await ollamaModelList(Target.base)
            return {
              ok: models.some((m) => m.name === Target.modelId || m.name.startsWith(`${Target.modelId}:`)),
              detail: models.map((m) => m.name),
            }
          },
        },
        {
          name: 'running',
          ping: async () => {
            const Target = ollamaProbeTarget(Runtime)
            if (Target === null) return { ok: true, detail: ['no ollama provider'] }
            const ps = await ollamaStatusList(Target.base)
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

function ollamaProbeTarget(Runtime: RuntimeModelRegistry): { base: string; modelId: string } | null {
  const Snap = Runtime.current()
  for (const Kind of ['embedding', 'language'] as const) {
    const Model = Snap.config.models.find((Item) => Item.isDefault && Item.kind === Kind)
    if (Model === undefined) continue
    const Provider = Snap.config.providers.find((Item) => Item.name === Model.provider_name && Item.available)
    if (Provider === undefined || Provider.base_url === null) continue
    if (Provider.kind !== 'ollama') continue
    return {
      base: Provider.base_url.replace(/\/v1\/?$/, '').replace(/\/+$/, ''),
      modelId: Model.model_id,
    }
  }
  return null
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
