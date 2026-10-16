/**
 * 健康探针定义 —— createHealthProbes() 按基础层交出的 repo 与配置组装探针清单，每项是 {name, ping}；
 * ping 只产出 ProbeResult{ok, detail?}，抛错交由 routes/health 的聚合器接住转 ok:false。本文件无 HTTP 语义、也不碰连接池。
 * ollama 模型名带 tag（如 qwenembed:latest）而 EMBEDDING_MODEL 是裸名，故就绪判定须同时匹配裸名与 `${emb}:` 前缀。
 * 依赖：adapter/contract 的 repo.ping() 与三个 Ollama 只读探针、config 的 AppConfig。
 */

import { ollamaHealthCheck, ollamaModelList, ollamaStatusList } from '../../adapter/contract'

export { createHealthProbes }
export type { HealthCheck, ProbeResult }

import type { AppConfig } from '../../config'
import type { Repo } from '../../adapter/contract'

interface ProbeResult {
  ok: boolean
  detail?: unknown
}

interface HealthCheck {
  name: string
  ping: () => Promise<ProbeResult>
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
