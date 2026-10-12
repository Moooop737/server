/**
 * 入口 / 装配 —— bootstrap() 交出空 app + deps，在此把已接入服务包成 health 探针、挂各业务路由，全部装配完再 startServer 监听。
 * 加服务 = 往 healthProbes 加一项；加路由 = 在此再 app.route(...)。URL 入库端点待 Story 1.2 接线后追加。
 */

import { bootstrap, startServer } from "./pipeline/bootstrap"
import { createResourcesRoute } from "./routes/resources"
import { createHealthRoute } from "./routes/health"
import { pingDb } from "./adapters/paradedb"
import { ollamaHealthCheck, ollamaModelList, ollamaStatusList } from "./adapters/ollama"

import type { HealthCheck } from "./routes/health"

const { app, deps } = bootstrap()

const base = deps.config.ollamaBaseUrl
const emb = deps.config.embeddingModel

const healthProbes: HealthCheck[] = [
  { name: 'db', ping: async () => ({ ok: await pingDb(deps.pool) }) },
  { name: 'ollama', ping: async () => ({ ok: await ollamaHealthCheck(base) }) },
  {
    name: 'ollama_models',
    ping: async () => {
      const models = await ollamaModelList(base)
      // ollama name carries a tag (qwenembed:latest); match base or `${emb}:` prefix
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

app.route('/', createHealthRoute(healthProbes))
app.route('/', createResourcesRoute(deps.ingestDeps))

void startServer(app, deps)
