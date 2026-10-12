import { bootstrap, startServer } from "./pipeline/bootstrap"
import { createResourcesRoute } from "./routes/resources"
import { createHealthRoute, type HealthCheck } from "./routes/health"
import { pingDb } from "./adapters/paradedb"
import { ollamaHealthCheck, ollamaModelList, ollamaStatusList } from "./adapters/ollama"

// bootstrap 交出空 app + deps，路由在外面装配，全装配完再启动
const { app, deps } = bootstrap()

const base = deps.config.ollamaBaseUrl

// 把每个已接入的服务包成探针注册给 health；将来加服务 = 往这个数组加一项
const healthChecks: HealthCheck[] = [
  { name: 'db', ping: async () => ({ ok: await pingDb(deps.pool) }) },
  { name: 'ollama', ping: async () => ({ ok: await ollamaHealthCheck(base) }) },
  {
    name: 'ollama_models',
    ping: async () => {
      const models = await ollamaModelList(base)
      const emb = deps.config.embeddingModel
      // Ollama name 带 tag（qwenembed:latest），裸名等价 :latest，按 base 或 'emb:' 前缀匹配
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

app.route('/', createHealthRoute(healthChecks))
app.route('/', createResourcesRoute(deps.ingestDeps))
// 后续路由在此继续 app.route(...)

void startServer(app, deps)
