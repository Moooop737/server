/**
 * 健康探针定义 —— createHealthProbes() 按已建好的连接池与配置组装探针清单，每项是 {name, ping}；
 * ping 只产出 ProbeResult{ok, detail?}，抛错交由 routes/health 的聚合器接住转 ok:false。本文件无 HTTP 语义。
 * ollama 模型名带 tag（如 qwenembed:latest）而 EMBEDDING_MODEL 是裸名，故就绪判定须同时匹配裸名与 `${emb}:` 前缀。
 * 依赖：adapters/paradedb 的 pingDb、adapters/ollama 的三个只读 API、config 的 AppConfig。
 */

import { pingDb } from '../../adapters/paradedb'
import { ollamaHealthCheck, ollamaModelList, ollamaStatusList } from '../../adapters/ollama'

export { createHealthProbes }
export type { HealthCheck, ProbeResult }

import type { AppConfig } from '../../config'
import type { Pool } from 'pg'

interface ProbeResult {
  ok: boolean
  detail?: unknown
}

interface HealthCheck {
  name: string
  ping: () => Promise<ProbeResult>
}

function createHealthProbes(Config: AppConfig, Db: Pool): HealthCheck[] {
  const base = Config.ollamaBaseUrl
  const emb = Config.embeddingModel

  return [
    {
      name: 'db',
      ping: async () => ({ ok: await pingDb(Db) }),
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
